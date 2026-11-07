import { mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createAssetStore, MAX_MODEL_BYTES, type MediaTools } from '@vis/assets'
import { isMediaKind } from '@vis/protocol'
import { openSpaceDb } from '@vis/storage'
import { assetView, importAgentFile, importAsset, listModels } from './media'
import type { SpaceHost } from './space-host'

let dir: string
let host: SpaceHost
let media: MediaTools
let probe: ReturnType<typeof vi.fn>
const glb = () => {
  const json = Buffer.from('{"asset":{"version":"2.0"}}')
  const length = Math.ceil(json.length / 4) * 4
  const bytes = Buffer.alloc(20 + length, 0x20)
  bytes.writeUInt32LE(0x46546c67, 0)
  bytes.writeUInt32LE(2, 4)
  bytes.writeUInt32LE(bytes.length, 8)
  bytes.writeUInt32LE(length, 12)
  bytes.writeUInt32LE(0x4e4f534a, 16)
  json.copy(bytes, 20)
  return bytes
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vis-model-import-'))
  mkdirSync(join(dir, 'session'))
  mkdirSync(join(dir, 'assets'))
  host = { db: openSpaceDb(':memory:'), assets: createAssetStore({ blobsDir: join(dir, 'blobs') }), rootPath: dir, workDir: () => join(dir, 'session') } as unknown as SpaceHost
  probe = vi.fn(async () => { throw new Error('Models must never be sent to ffprobe') })
  media = { probe } as unknown as MediaTools
})
afterEach(() => { host.db.$client.close(); rmSync(dir, { recursive: true, force: true }) })

it('imports GLBs idempotently as model assets without creating media nodes or probing them', async () => {
  const path = join(dir, 'stage.GLB')
  writeFileSync(path, glb())
  const params = { requestId: 'import-model', path, displayName: 'Stage' }
  const imported = await importAsset(host, media, params)
  expect(imported).toMatchObject({ kind: 'model', mime: 'model/gltf-binary', displayName: 'Stage' })
  expect(isMediaKind(imported.kind)).toBe(false)
  expect(assetView(host, host.db, imported.assetVersionId)).toEqual(imported)
  expect(await importAsset(host, media, params)).toEqual(imported)
  expect(host.db.query.nodes.findMany().sync()).toEqual([])
  expect(host.db.query.assets.findMany().sync()).toHaveLength(1)
  expect(probe).not.toHaveBeenCalled()
})

it('persists the validated model snapshot if the source file changes during staging', async () => {
  const path = join(dir, 'changing.glb')
  const original = glb()
  writeFileSync(path, original)
  const stage = host.assets.stageBytes
  vi.spyOn(host.assets, 'stageBytes').mockImplementationOnce(async bytes => {
    writeFileSync(path, 'Source changed after validation')
    return stage(bytes)
  })
  const imported = await importAsset(host, media, { requestId: 'changing-model', path })
  const version = host.assets.getVersion(host.db, imported.assetVersionId)!
  expect(readFileSync(host.assets.blobPath(version.blobHash))).toEqual(original)
})

it('discovers the latest version of every model independently of fonts and media', async () => {
  const staged = await host.assets.stageBytes(glb())
  const first = host.assets.registerVersion(host.db, { staged, kind: 'model', mime: 'model/gltf-binary', origin: 'import', displayName: 'Bench' })
  const latest = host.assets.registerVersion(host.db, { staged, assetId: first.assetId, kind: 'model', mime: 'model/gltf-binary', origin: 'import' })
  const other = host.assets.registerVersion(host.db, { staged, kind: 'model', mime: 'model/gltf-binary', origin: 'import', displayName: 'Table' })
  for (const kind of ['font', 'image', 'video', 'audio'] as const) host.assets.registerVersion(host.db, { staged, kind, mime: 'application/octet-stream', origin: 'import' })
  expect(listModels(host).models).toEqual(expect.arrayContaining([assetView(host, host.db, latest.assetVersionId), assetView(host, host.db, other.assetVersionId)]))
  expect(listModels(host).models).toHaveLength(2)
  expect(listModels(host).models.some(model => model.assetVersionId === first.assetVersionId)).toBe(false)
})

it('accepts session and project model files through importFile and preserves its directory restrictions', async () => {
  for (const root of ['session', 'assets']) {
    const path = join(dir, root, 'stage.glb')
    writeFileSync(path, glb())
    expect(await importAgentFile(host, media, 'session', { requestId: root, path })).toMatchObject({ kind: 'model' })
  }
  const outside = join(dir, 'outside.glb')
  writeFileSync(outside, glb())
  await expect(importAgentFile(host, media, 'session', { requestId: 'outside', path: outside })).rejects.toMatchObject({ code: 'forbidden' })
  expect(probe).not.toHaveBeenCalled()
})

it('rejects corrupt, oversized and nonbinary glTF imports before staging', async () => {
  const path = join(dir, 'session', 'invalid.glb')
  writeFileSync(path, 'Not a model')
  for (const imported of [
    () => importAsset(host, media, { requestId: 'invalid-ui', path }),
    () => importAgentFile(host, media, 'session', { requestId: 'invalid-agent', path }),
  ]) await expect(imported()).rejects.toMatchObject({ code: 'invalid_params', details: { reason: 'asset.model_invalid' } })
  truncateSync(path, MAX_MODEL_BYTES + 1)
  for (const imported of [
    () => importAsset(host, media, { requestId: 'large-ui', path }),
    () => importAgentFile(host, media, 'session', { requestId: 'large-agent', path }),
  ]) await expect(imported()).rejects.toMatchObject({ code: 'invalid_params', details: { reason: 'asset.model_too_large' } })
  const nonbinary = join(dir, 'session', 'stage.gltf')
  writeFileSync(nonbinary, '{"asset":{"version":"2.0"}}')
  for (const imported of [
    () => importAsset(host, media, { requestId: 'gltf-ui', path: nonbinary }),
    () => importAgentFile(host, media, 'session', { requestId: 'gltf-agent', path: nonbinary }),
  ]) await expect(imported()).rejects.toMatchObject({ code: 'invalid_params', details: { reason: 'asset.model_invalid' } })
  expect(host.db.query.assets.findMany().sync()).toEqual([])
  expect(await host.assets.findOrphanBlobs(host.db)).toEqual([])
  expect(probe).not.toHaveBeenCalled()
})
