import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAssetStore, type MediaTools } from '@vis/assets'
import { openSpaceDb } from '@vis/storage'
import { listFonts } from './fonts'
import { assetView, importAgentFile, importAsset } from './media'
import type { SpaceHost } from './space-host'

const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).reverse().forEach(clean => clean()) })

function fontBytes(cff = false) {
  const name = Buffer.from('Project Caption Font', 'utf16le').swap16()
  const bytes = Buffer.alloc(46 + name.length)
  if (cff) bytes.write('OTTO')
  else bytes.writeUInt32BE(0x00010000)
  bytes.writeUInt16BE(1, 4)
  bytes.write('name', 12)
  bytes.writeUInt32BE(28, 20)
  bytes.writeUInt32BE(18 + name.length, 24)
  bytes.writeUInt16BE(1, 30)
  bytes.writeUInt16BE(18, 32)
  bytes.writeUInt16BE(3, 34)
  bytes.writeUInt16BE(1, 36)
  bytes.writeUInt16BE(0x409, 38)
  bytes.writeUInt16BE(16, 40)
  bytes.writeUInt16BE(name.length, 42)
  name.copy(bytes, 46)
  return bytes
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'vis-font-import-'))
  const db = openSpaceDb(':memory:')
  const assets = createAssetStore({ blobsDir: join(dir, 'blobs') })
  const workDir = join(dir, 'session')
  mkdirSync(workDir)
  mkdirSync(join(dir, 'assets'))
  const host = { db, assets, rootPath: dir, workDir: () => workDir } as unknown as SpaceHost
  const probe = vi.fn(async () => { throw new Error('Fonts must never be sent to ffprobe') })
  const media = { probe } as unknown as MediaTools
  cleanups.push(() => { db.$client.close(); rmSync(dir, { recursive: true, force: true }) })
  return { dir, db, assets, host, media, probe, workDir }
}

describe('project font imports and discovery', () => {
  it.each(['ttf', 'otf'])('imports a %s font without ffprobe and includes its family in the asset view', async ext => {
    const f = fixture()
    const path = join(f.dir, `uploaded.${ext}`)
    writeFileSync(path, fontBytes(ext === 'otf'))
    const params = { requestId: 'import-font', path, displayName: 'My caption font' }
    const imported = await importAsset(f.host, f.media, params)
    expect(imported).toMatchObject({ kind: 'font', mime: `font/${ext}`, fontFamily: 'Project Caption Font', displayName: 'My caption font' })
    expect(f.probe).not.toHaveBeenCalled()
    expect(assetView(f.host, f.db, imported.assetVersionId)).toEqual(imported)
    expect(await importAsset(f.host, f.media, params)).toEqual(imported)
    expect(listFonts(f.db).fonts).toContainEqual({ font: { assetVersionId: imported.assetVersionId }, family: 'Project Caption Font', label: 'My caption font' })
    expect(f.db.query.nodes.findMany().sync()).toEqual([])
  })
  it('lists the latest version of each font asset after the four built-ins', async () => {
    const f = fixture()
    const first = f.assets.registerVersion(f.db, { staged: await f.assets.stageBytes(fontBytes()), kind: 'font', mime: 'font/ttf', fontFamily: 'Old family', origin: 'import', displayName: 'Caption family' })
    const latest = f.assets.registerVersion(f.db, { staged: await f.assets.stageBytes(fontBytes(true)), assetId: first.assetId, kind: 'font', mime: 'font/otf', fontFamily: 'New family', origin: 'import' })
    const list = listFonts(f.db).fonts
    expect(list).toHaveLength(5)
    expect(list[0]).toMatchObject({ font: { builtin: 'noto-sans-sc' }, label: 'Noto Sans SC' })
    expect(list[4]).toEqual({ font: { assetVersionId: latest.assetVersionId }, family: 'New family', label: 'Caption family' })
  })
  it('accepts an Agent font inside its working directory and rejects fonts outside it', async () => {
    const f = fixture()
    const path = join(f.workDir, 'caption.ttf')
    writeFileSync(path, fontBytes())
    expect(await importAgentFile(f.host, f.media, 'session', { requestId: 'agent-font', path })).toMatchObject({ kind: 'font', fontFamily: 'Project Caption Font' })
    const outside = join(f.dir, 'outside.ttf')
    writeFileSync(outside, fontBytes())
    await expect(importAgentFile(f.host, f.media, 'session', { requestId: 'outside', path: outside })).rejects.toMatchObject({ code: 'forbidden' })
    expect(f.probe).not.toHaveBeenCalled()
  })
  it('returns font-specific errors for invalid and oversized uploads before staging', async () => {
    const f = fixture()
    const path = join(f.dir, 'invalid.ttf')
    writeFileSync(path, 'Not a font')
    await expect(importAsset(f.host, f.media, { requestId: 'invalid', path })).rejects.toMatchObject({ code: 'invalid_params', details: { reason: 'asset.font_invalid' } })
    truncateSync(path, 50 * 1024 ** 2 + 1)
    await expect(importAsset(f.host, f.media, { requestId: 'oversize', path })).rejects.toMatchObject({ code: 'invalid_params', details: { reason: 'asset.font_too_large' } })
    expect(f.db.query.assets.findMany().sync()).toEqual([])
    expect(f.probe).not.toHaveBeenCalled()
  })
})
