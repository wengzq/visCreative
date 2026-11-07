import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createAssetStore, type renderTimeline } from '@vis/assets'
import type { TimelineDoc } from '@vis/protocol'
import { eq, openSpaceDb, spaceSchema as s } from '@vis/storage'
import { createNodeWithSlot, insertOperation } from '../../../packages/canvas/core/src/write'
import { exportTimeline } from './timeline-export'

const cleanups: (() => void)[] = []
afterEach(() => { vi.unstubAllEnvs(); cleanups.splice(0).reverse().forEach(clean => clean()) })

function fontBytes(family: string) {
  const name = Buffer.from(family, 'utf16le').swap16()
  const bytes = Buffer.alloc(46 + name.length)
  bytes.writeUInt32BE(0x00010000)
  bytes.writeUInt16BE(1, 4)
  bytes.write('name', 12)
  bytes.writeUInt32BE(28, 20)
  bytes.writeUInt32BE(18 + name.length, 24)
  bytes.writeUInt16BE(1, 30)
  bytes.writeUInt16BE(18, 32)
  bytes.writeUInt16BE(3, 34)
  bytes.writeUInt16BE(1, 36)
  bytes.writeUInt16BE(0x409, 38)
  bytes.writeUInt16BE(1, 40)
  bytes.writeUInt16BE(name.length, 42)
  name.copy(bytes, 46)
  return bytes
}

function fixture(doc: TimelineDoc) {
  const dir = mkdtempSync(join(tmpdir(), 'vis-caption-export-'))
  const db = openSpaceDb(':memory:')
  const assets = createAssetStore({ blobsDir: join(dir, 'blobs') })
  const fontDir = join(dir, 'fonts')
  mkdirSync(fontDir)
  vi.stubEnv('VIS_FONTS_DIR', fontDir)
  insertOperation(db, { id: 'seed', actor: { kind: 'user' } }, 1)
  const node = createNodeWithSlot(db, { kind: 'timeline', x: 0, y: 0, w: 320, h: 200, content: { timeline: doc } }, 'seed', 1)
  const render = vi.fn<typeof renderTimeline>(async () => ({ path: join(dir, 'result.mp4'), kind: 'video', mime: 'video/mp4', durationMs: 1000, width: 1920, height: 1080, mode: 'encode', dispose: async () => {} }))
  const encoder = { name: 'libx264', args: [], hardware: false }
  const detectEncoder = vi.fn(async () => encoder)
  const run = () => exportTimeline(db, assets, { slotId: node.slotId, expectedRevision: 1 }, {}, { render, detectEncoder })
  cleanups.push(() => { db.$client.close(); rmSync(dir, { recursive: true, force: true }) })
  return { dir, db, assets, fontDir, render, detectEncoder, run }
}
const textDoc = (): TimelineDoc => ({ version: 1, tracks: [], textTracks: [{ id: 'text', hidden: false, clips: [{ id: 'caption', startMs: 0, durationMs: 1000, text: 'Caption', style: { preset: 'subtitle' }, fadeInMs: 0, fadeOutMs: 0 }] }] })

it('resolves the preset font and selects a video encoder for text-only export', async () => {
  const f = fixture(textDoc())
  const path = join(f.fontDir, 'noto-sans-sc.otf')
  writeFileSync(path, fontBytes('Noto Sans SC'))
  await f.run()
  expect(f.detectEncoder).toHaveBeenCalledOnce()
  expect(f.render.mock.calls[0]![2].fonts?.get('builtin:noto-sans-sc')).toEqual({ path, family: 'Noto Sans SC' })
})

it('returns media.font_missing before rendering when a used bundled font is absent', async () => {
  const f = fixture(textDoc())
  await expect(f.run()).rejects.toMatchObject({ code: 'unavailable', details: { reason: 'media.font_missing' } })
  expect(f.render).not.toHaveBeenCalled()
})

it('resolves a project font blob and rejects unknown or media font versions', async () => {
  const doc = textDoc()
  const f = fixture(doc)
  const staged = await f.assets.stageBytes(fontBytes('Uploaded family'))
  const font = f.assets.registerVersion(f.db, { staged, kind: 'font', mime: 'font/otf', fontFamily: 'Public family', origin: 'import' })
  // The stored revision is intentionally replaced directly so validation and resolution are independent.
  const revision = f.db.query.slotRevisions.findFirst().sync()!
  doc.textTracks![0]!.clips[0]!.style.font = { assetVersionId: font.assetVersionId }
  f.db.update(s.slotRevisions).set({ timelineDoc: doc }).where(eq(s.slotRevisions.slotId, revision.slotId)).run()
  await f.run()
  expect(f.render.mock.calls[0]![2].fonts?.get(`asset:${font.assetVersionId}`)).toEqual({ path: f.assets.blobPath(staged.hash), family: 'Uploaded family' })
  expect(f.assets.getVersion(f.db, font.assetVersionId)?.fontFamily).toBe('Public family')
  const media = f.assets.registerVersion(f.db, { staged, kind: 'video', mime: 'video/mp4', origin: 'import' })
  for (const assetVersionId of [media.assetVersionId, 'unknown-font-version']) {
    doc.textTracks![0]!.clips[0]!.style.font = { assetVersionId }
    f.db.update(s.slotRevisions).set({ timelineDoc: doc }).where(eq(s.slotRevisions.slotId, revision.slotId)).run()
    await expect(f.run()).rejects.toMatchObject({ code: 'invalid_params', details: { reason: 'timeline.font_missing' } })
  }
})
