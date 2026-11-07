import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createAssetStore } from '@vis/assets'
import { openSpaceDb } from '@vis/storage'
import type { TimelineDoc } from '@vis/protocol'
import { validateTimeline } from './timeline'

it('validates text font versions separately from media sources, including hidden text tracks', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vis-font-validation-'))
  const db = openSpaceDb(':memory:')
  try {
    const assets = createAssetStore({ blobsDir: dir })
    const staged = await assets.stageBytes(Buffer.from('font validation fixture'))
    const font = assets.registerVersion(db, { staged, kind: 'font', mime: 'font/ttf', fontFamily: 'Family', origin: 'import' })
    const video = assets.registerVersion(db, { staged, kind: 'video', mime: 'video/mp4', origin: 'import' })
    const doc: TimelineDoc = { version: 1, tracks: [], textTracks: [{ id: 'text', hidden: true, clips: [{ id: 'caption', startMs: 0, durationMs: 1000, text: 'Hello', style: { preset: 'subtitle', font: { assetVersionId: font.assetVersionId } }, fadeInMs: 0, fadeOutMs: 0 }] }] }
    expect(validateTimeline(db, doc)).toEqual([])
    for (const assetVersionId of [video.assetVersionId, 'another-project-font']) {
      doc.textTracks![0]!.clips[0]!.style.font = { assetVersionId }
      expect(() => validateTimeline(db, doc)).toThrow(expect.objectContaining({ code: 'invalid_params', details: expect.objectContaining({ reason: 'timeline.font_missing' }) }))
    }
    doc.textTracks![0]!.clips[0]!.style.font = { builtin: 'noto-sans-sc' }
    expect(validateTimeline(db, doc)).toEqual([])
  } finally { db.$client.close(); rmSync(dir, { recursive: true, force: true }) }
})
