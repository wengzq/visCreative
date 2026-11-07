import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAssetStore, createFfmpegMedia } from '@vis/assets'
import { openSpaceDb } from '@vis/storage'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { assetView, importAsset } from './media'
import type { SpaceHost } from './space-host'

const available = (() => {
  try { execFileSync('ffprobe', ['-version'], { stdio: 'ignore' }); return true } catch { return false }
})()

describe.skipIf(!available)('Asset frame rate registration', () => {
  let dir: string
  let host: SpaceHost
  const media = createFfmpegMedia()
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vis asset fps '))
    host = { db: openSpaceDb(':memory:'), assets: createAssetStore({ blobsDir: join(dir, 'blobs') }) } as SpaceHost
  })
  afterEach(() => { host.db.$client.close(); rmSync(dir, { recursive: true, force: true }) })

  it.each([['25', 25], ['30000/1001', 29.97]] as const)('imports and reads a %s fps video', async (rate, expected) => {
    const path = join(dir, 'source video.mp4')
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=64x48:rate=${rate}:duration=1`, '-c:v', 'libx264', '-y', path], { shell: false })
    const version = await importAsset(host, media, { requestId: 'video', path })
    expect(version.fps).toBe(expected)
    expect(assetView(host, host.db, version.assetVersionId).fps).toBe(expected)
    expect(host.assets.getVersion(host.db, version.assetVersionId)?.fps).toBe(expected)
  })

  it.each(['image', 'audio'] as const)('omits fps for an imported %s', async kind => {
    const path = join(dir, kind === 'image' ? 'still.png' : 'sound.wav')
    const args = kind === 'image' ? ['-i', 'color=size=64x48', '-frames:v', '1'] : ['-i', 'sine=duration=1']
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', ...args, '-y', path], { shell: false })
    const version = await importAsset(host, media, { requestId: kind, path })
    expect(version).not.toHaveProperty('fps')
    expect(host.assets.getVersion(host.db, version.assetVersionId)?.fps).toBeNull()
  })

  it('deduplicates content-addressed imports across temporary paths and rejects an incorrect hash', async () => {
    const first = join(dir, 'first.png')
    const second = join(dir, 'second.png')
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=size=64x48', '-frames:v', '1', '-y', first], { shell: false })
    copyFileSync(first, second)
    const contentHash = createHash('sha256').update(readFileSync(first)).digest('hex')
    const original = await importAsset(host, media, { requestId: 'hash-import', path: first, contentHash, displayName: 'first.png' })
    expect(await importAsset(host, media, { requestId: 'hash-import', path: second, contentHash, displayName: 'second.png' })).toEqual(original)
    await expect(importAsset(host, media, { requestId: 'wrong-hash', path: first, contentHash: '0'.repeat(64) })).rejects.toMatchObject({ code: 'invalid_params' })
  })

  it('reads legacy versions without inventing a source rate', async () => {
    const version = host.assets.registerVersion(host.db, { staged: await host.assets.stageBytes(Buffer.from('old video')), kind: 'video', mime: 'video/mp4', origin: 'import' })
    expect(assetView(host, host.db, version.assetVersionId)).not.toHaveProperty('fps')
  })
})
