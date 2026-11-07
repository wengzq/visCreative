import { ulid, VisError } from '@vis/domain'
import { clipEndMs, imageMaxMs, isOverlayTrack, TIMELINE_LIMITS, TimelineDoc, type TimelineTrack, type TimelineTrackKind } from '@vis/protocol'
import { and, eq, spaceSchema as s, type SpaceTx } from '@vis/storage'

const shortId = () => ulid().slice(-12)

function invalid(reason: string, message: string, params: Record<string, string> = {}): never {
  throw VisError.of('invalid_params', `timeline.${reason}`, params, `${message}. See guide "timeline".`)
}

// Asset kinds each track accepts; overlay video is further limited to step E2 below
const TRACK_SOURCES: Record<TimelineTrackKind, string[]> = { video: ['video', 'image'], overlay: ['image', 'video'], audio: ['audio', 'video'] }

export function emptyTimeline(): TimelineDoc {
  return {
    version: 1,
    tracks: (['video', 'audio'] as const).map(kind => ({ id: shortId(), kind, muted: false, volume: 1, clips: [] })),
  }
}

/** Only this project's database can resolve sources; documents never carry filesystem paths. */
export function validateTimeline(tx: SpaceTx, doc: TimelineDoc, timelineNodeId?: string): string[] {
  if (!TimelineDoc.safeParse(doc).success) invalid('invalid_doc', 'The timeline document is invalid')
  const inputs = new Set<string>()
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      const { nodeId, assetVersionId } = clip.source
      const node = tx.select().from(s.nodes).where(eq(s.nodes.id, nodeId)).get()
      if (!node) invalid('source_node_missing', 'The timeline source node does not exist in this project', { nodeId })
      const asset = tx.select({ kind: s.assets.kind, durationMs: s.assetVersions.durationMs })
        .from(s.assetVersions).innerJoin(s.assets, eq(s.assets.id, s.assetVersions.assetId))
        .where(eq(s.assetVersions.id, assetVersionId)).get()
      if (!asset) invalid('source_missing', 'The timeline source asset version does not exist in this project', { assetVersionId })
      const allowed = TRACK_SOURCES[track.kind]
      if (!allowed.includes(asset.kind)) invalid('source_kind', 'The source asset kind does not match its timeline track')
      if (asset.kind === 'image') {
        if (clip.speed !== undefined) invalid('speed_image', 'Image clips cannot change speed', { clipId: clip.id })
        if (clip.inMs !== 0) invalid('image_in_point', 'Image clips must start at source time zero')
        if (clip.outMs < TIMELINE_LIMITS.imageMinMs || clip.outMs > imageMaxMs(track)) {
          invalid('image_duration', isOverlayTrack(track)
            ? 'Overlay image duration must be between 500 milliseconds and the timeline limit'
            : 'Image clip duration must be between 500 and 30000 milliseconds')
        }
      } else {
        if (asset.durationMs === null || asset.durationMs <= 0) invalid('duration_missing', 'The source asset has no registered duration')
        if (clip.outMs > asset.durationMs + 50) invalid('source_range', 'The clip range exceeds the registered source duration')
      }
      // Tombstoned sources remain valid pins, but do not create visible canvas edges.
      if (node.deletedAt === null && nodeId !== timelineNodeId) inputs.add(nodeId)
    }
  }
  for (const track of doc.textTracks ?? []) for (const clip of track.clips) {
    const font = clip.style.font
    if (!font || !('assetVersionId' in font)) continue
    const asset = tx.select({ kind: s.assets.kind })
      .from(s.assetVersions).innerJoin(s.assets, eq(s.assets.id, s.assetVersions.assetId))
      .where(eq(s.assetVersions.id, font.assetVersionId)).get()
    if (asset?.kind !== 'font') invalid('font_missing', 'The caption font is not a font asset of this project', { assetVersionId: font.assetVersionId })
  }
  return [...inputs]
}

export function timelineFromNodes(tx: SpaceTx, items: { nodeId: string; durationMs?: number | undefined }[]): TimelineDoc {
  const doc = emptyTimeline()
  for (const { nodeId, durationMs } of items) {
    const node = tx.select().from(s.nodes).where(eq(s.nodes.id, nodeId)).get()
    if (!node || node.deletedAt !== null) invalid('source_node_missing', 'The timeline source node does not exist or has been deleted', { nodeId })
    if (node.kind !== 'video' && node.kind !== 'image' && node.kind !== 'audio') {
      invalid('source_node_kind', 'Only video, image, and audio nodes can initialize a timeline', { nodeId })
    }
    const source = tx.select({ assetVersionId: s.assetVersions.id, durationMs: s.assetVersions.durationMs })
      .from(s.slots)
      .innerJoin(s.slotRevisions, and(eq(s.slotRevisions.slotId, s.slots.id), eq(s.slotRevisions.revision, s.slots.currentRevision)))
      .innerJoin(s.assetVersions, eq(s.assetVersions.id, s.slotRevisions.assetVersionId))
      .where(and(eq(s.slots.nodeId, nodeId), eq(s.slots.slotKey, 'main'))).get()
    if (!source) invalid('source_asset_required', 'The timeline source node has no current main-slot asset', { nodeId })
    if (durationMs !== undefined && node.kind !== 'image') invalid('duration_image_only', 'Only image sources accept a display duration', { nodeId })
    const duration = node.kind === 'image' ? durationMs ?? 3000 : source.durationMs
    if (duration === null || duration <= 0) invalid('duration_missing', 'The source asset has no registered duration', { nodeId })
    const track = doc.tracks[node.kind === 'audio' ? 1 : 0] as TimelineTrack
    track.clips.push({
      id: shortId(), source: { nodeId, assetVersionId: source.assetVersionId },
      startMs: track.clips.length ? clipEndMs(track.clips[track.clips.length - 1]!) : 0,
      inMs: 0, outMs: duration, volume: 1, fadeInMs: 0, fadeOutMs: 0,
    })
  }
  validateTimeline(tx, doc)
  return doc
}
