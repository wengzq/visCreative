import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createAssetStore, type MediaTools } from '@vis/assets'
import { applyOps, readNodes } from '@vis/canvas-core'
import { EMPTY_PREVIZ, emptyPrevizPanel, type CanvasOp } from '@vis/protocol'
import { eq, openSpaceDb, spaceSchema as s } from '@vis/storage'
import { extractBlockout } from './previz-blockout'
import type { SpaceHost } from './space-host'

const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).forEach(dispose => dispose()))

it('clears scene provenance when a video extraction replaces the panel blockout', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vis-blockout-test-'))
  const db = openSpaceDb(':memory:')
  cleanup.push(() => { db.$client.close(); rmSync(dir, { recursive: true, force: true }) })
  const assets = createAssetStore({ blobsDir: join(dir, 'blobs') })
  const host = { db, assets } as SpaceHost
  const apply = (ops: CanvasOp[]) => db.transaction(tx => applyOps(tx, { kind: 'user' }, { requestId: crypto.randomUUID(), ops }, Date.now()))
  const image = assets.registerVersion(db, { staged: await assets.stageBytes(Buffer.from('old image')), kind: 'image', mime: 'image/png', origin: 'import' }).assetVersionId
  const video = assets.registerVersion(db, { staged: await assets.stageBytes(Buffer.from('video')), kind: 'video', mime: 'video/mp4', origin: 'import', durationMs: 1000 }).assetVersionId
  apply([{ op: 'node.create', tempId: 'previz', kind: 'previz' }])
  const slot = readNodes(db)[0]!.slots[0]!
  const panel = {
    ...emptyPrevizPanel('first'), durationSec: 1, blockout: image, underlay: image, sketch: image,
    sceneRef: { sceneNodeId: 'scene', viewId: 'wide', sceneRev: 4 },
  }
  apply([{ op: 'previz.set', slotId: slot.slotId, expectedRevision: 1, doc: { ...EMPTY_PREVIZ, panels: [panel] } }])
  const extractFrames = vi.fn(async () => [{ atMs: 0, data: Buffer.from('new image'), mime: 'image/png', width: 320, height: 180 }])
  const media = { probe: async () => ({ kind: 'video', durationMs: 1000, fps: 24 }), extractFrames } as unknown as MediaTools
  const params = { requestId: 'extract', slotId: slot.slotId, expectedRevision: 2, assetVersionId: video }
  db.insert(s.sessions).values({ id: 'review-session', agentKind: 'codex', title: 'Reviewer', createdAt: 1 }).run()
  db.insert(s.transcriptEntries).values({ sessionId: 'review-session', itemId: 'expired-review', revision: 1, createdSeq: 1, kind: 'approval', createdAt: 1, updatedAt: 1,
    payload: { approvalId: 'expired-review', kind: 'text_delete', summary: 'Delete', detail: '', status: 'pending', textDelete: { nodeId: 'book', slotId: 'book-main', revision: 1, title: 'Book', expiresAt: 0 } } }).run()
  const result = await extractBlockout(host, media, params)
  expect(db.select().from(s.transcriptEntries).where(eq(s.transcriptEntries.itemId, 'expired-review')).get()!.payload).toMatchObject({ status: 'expired' })
  const content = readNodes(db)[0]!.slots[0]!.content
  expect(content).toMatchObject({ type: 'previz', doc: { panels: [{
    blockout: result.frames[0]!.assetVersionId, sceneRef: null, underlay: image, sketch: image,
  }] } })
  expect(result.frames[0]!.assetVersionId).not.toBe(image)
  expect(await extractBlockout(host, media, params)).toEqual(result)
  expect(extractFrames).toHaveBeenCalledOnce()
})
