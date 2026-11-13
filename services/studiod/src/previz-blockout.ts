import { refreshReviews } from './reviews'
import { applyOps, readNodes } from '@vis/canvas-core'
import { VisError } from '@vis/domain'
import type { CanvasOp, MethodParams, MethodResult } from '@vis/protocol'
import { eq, runIdempotent, spaceSchema as s, type SpaceTx } from '@vis/storage'
import type { MediaTools } from '@vis/assets'
import { prepareFrameExtraction } from './media'
import type { SpaceHost } from './space-host'

export async function extractBlockout(host: SpaceHost, media: MediaTools, p: MethodParams<'previz.extractBlockout'>): Promise<MethodResult<'previz.extractBlockout'>> {
  const request = { requestId: p.requestId, method: 'previz.extractBlockout', params: p }
  const previous = host.db.select().from(s.idempotencyKeys).where(eq(s.idempotencyKeys.requestId, p.requestId)).get()
  if (previous) return runIdempotent(host.db, request, () => previous.result as MethodResult<'previz.extractBlockout'>)

  const read = (tx: SpaceTx) => {
    const nodes = readNodes(tx)
    const slot = nodes.flatMap(node => node.slots).find(slot => slot.slotId === p.slotId)
    if (!slot) throw VisError.of('not_found', 'canvas.slot_not_found', { slotId: p.slotId }, 'The previz slot does not exist or has been deleted')
    if (slot.content.type !== 'previz') throw VisError.of('invalid_params', 'previz.slot_required', {}, 'Blockout extraction requires a previz slot')
    if (slot.revision !== p.expectedRevision) throw VisError.of('revision_conflict', 'canvas.revision_conflict', { slotId: p.slotId, expectedRevision: p.expectedRevision, currentRevision: slot.revision }, 'The previz changed; reread before extracting blockout frames', [{ slotId: p.slotId, expectedRevision: p.expectedRevision, currentRevision: slot.revision }])
    return { nodes, doc: slot.content.doc }
  }
  const { doc } = host.db.transaction(read)
  if (!doc.panels.length) throw VisError.of('invalid_params', 'previz.panels_required', {}, 'Blockout extraction requires at least one panel')
  const missing = doc.panels.filter(panel => panel.durationSec === null).map(panel => panel.id)
  const fill = p.fillDurations === true && missing.length === doc.panels.length
  if (missing.length && !fill) throw VisError.of('invalid_params', 'previz.duration_required', { panelIds: missing.join(', ') }, `Set durationSec for panels: ${missing.join(', ')}`)
  const video = host.assets.getVersion(host.db, p.assetVersionId)
  if (!video) throw VisError.of('not_found', 'asset.version_not_found', { assetVersionId: p.assetVersionId }, 'The blockout video does not exist')
  if (video.kind !== 'video') throw VisError.of('invalid_params', 'asset.video_required', { assetVersionId: p.assetVersionId }, 'Blockout extraction requires a video')
  // Probe the immutable source rather than guessing a rate for older assets without stored fps.
  const info = await media.probe(host.assets.blobPath(video.blobHash), video.mime)
  if (!info.durationMs || !info.fps) throw VisError.of('invalid_params', 'previz.video_timing_required', {}, 'The blockout video must have a measurable duration and frame rate')
  // Whole milliseconds keep the split exact; the last panel absorbs the rounding remainder.
  const share = Math.floor(info.durationMs / doc.panels.length)
  const durations = doc.panels.map((panel, i) => !fill ? panel.durationSec! : (i === doc.panels.length - 1 ? info.durationMs! - share * i : share) / 1000)
  let elapsedSec = 0
  const atMs = durations.map(durationSec => {
    const at = Math.round(elapsedSec * 1000)
    elapsedSec += durationSec
    return at
  })
  const durationMs = Math.round(elapsedSec * 1000)
  const toleranceMs = 1000 / info.fps
  if (Math.abs(durationMs - info.durationMs) > toleranceMs || atMs.some(at => at >= info.durationMs!)) {
    throw VisError.of('invalid_params', 'previz.duration_mismatch', { panelDurationMs: durationMs, videoDurationMs: info.durationMs, toleranceMs }, 'Panel durations must match the blockout video within one video frame, with every panel starting before its end')
  }
  const register = await prepareFrameExtraction(host, media, { assetVersionId: p.assetVersionId, atMs })
  return runIdempotent(host.db, request, tx => {
    // Reread so a concurrent editor save during a long extraction is a revision conflict, not a lost write.
    const current = read(tx)
    const extracted = register(tx)
    const next = { ...current.doc, rev: current.doc.rev + 1, panels: current.doc.panels.map((panel, i) => ({ ...panel, rev: panel.rev + 1, blockout: extracted.frames[i]!.assetVersionId, sceneRef: null, ...(fill ? { durationSec: durations[i]! } : {}) })) }
    const ops: CanvasOp[] = [{ op: 'previz.set', slotId: p.slotId, expectedRevision: p.expectedRevision, doc: next }]
    const at = Date.now()
    const applied = applyOps(tx, { kind: 'user' }, { requestId: p.requestId, ops }, at)
    refreshReviews(tx, at)
    return {
      revision: applied.slotRevisions[p.slotId]!,
      frames: extracted.frames.map((frame, i) => ({ panelId: current.doc.panels[i]!.id, atMs: frame.atMs, assetVersionId: frame.assetVersionId })),
    }
  })
}
