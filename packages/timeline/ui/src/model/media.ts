import { isAudioTrack, isMainVideoTrack, timelineDurationMs, type NodeView, type TimelineClip, type TimelineDoc, type TimelineTrackKind } from '@vis/protocol'
import { DEFAULT_OVERLAY, addAudioTrack, canPlace, insertVideo, newId, placeAudio, type EditResult } from './edit'

export const MEDIA_DRAG_TYPE = 'application/x-vis-timeline-media'
export const TRACK_DRAG_TYPE = 'application/x-vis-timeline-track'
export type MediaKind = 'video' | 'audio' | 'image'
export type MediaFilter = MediaKind | 'all'

export function nodeAsset(node: NodeView) {
  const slot = node.slots.find(slot => slot.slotKey === 'main')
  return slot?.content.type === 'asset' ? { assetVersionId: slot.content.assetVersionId, revision: slot.revision } : null
}

export function mediaNodes(nodes: readonly NodeView[], filter: MediaFilter, query: string): NodeView[] {
  const search = query.trim().toLocaleLowerCase()
  return nodes.filter(node => ['video', 'image', 'audio'].includes(node.kind) && nodeAsset(node) &&
    (filter === 'all' || node.kind === filter) && (!search || (node.title ?? node.kind).toLocaleLowerCase().includes(search)))
}

export function acceptsMedia(track: TimelineTrackKind, media: string): boolean {
  if (track === 'overlay') return media === 'image' || media === 'video'
  return track === 'video' ? media === 'video' || media === 'image' : media === 'audio' || media === 'video'
}

/** Source kind assumed from the track while asset metadata is still loading */
export function trackSourceKind(track: TimelineTrackKind): MediaKind {
  return track === 'overlay' ? 'video' : track
}

export function mediaClip(doc: TimelineDoc, node: NodeView, durationMs?: number, targetKind?: TimelineTrackKind): TimelineClip | null {
  const asset = nodeAsset(node)
  if (!asset || !['video', 'audio', 'image'].includes(node.kind)) return null
  if (targetKind && !acceptsMedia(targetKind, node.kind)) return null
  const duration = node.kind === 'image' ? 5000 : durationMs
  if (!duration || !Number.isFinite(duration) || duration < 1) return null
  return { id: newId(doc), source: { nodeId: node.nodeId, assetVersionId: asset.assetVersionId }, startMs: 0, inMs: 0, outMs: Math.round(duration), volume: 1, fadeInMs: 0, fadeOutMs: 0, ...(targetKind === 'overlay' ? { overlay: { ...DEFAULT_OVERLAY } } : {}) }
}

export function appendMedia(doc: TimelineDoc, node: NodeView, durationMs: number | undefined, playhead: number): EditResult {
  const clip = mediaClip(doc, node, durationMs)
  if (!clip) return { ok: false, reason: 'duration' }
  if (node.kind !== 'audio') return insertVideo(doc, [clip], doc.tracks.find(isMainVideoTrack)?.clips.length ?? 0)
  const start = Math.max(0, Math.round(playhead))
  let next = doc
  let track = next.tracks.find(track => isAudioTrack(track) && canPlace(track, start, clip.outMs))
  if (!track) {
    const result = addAudioTrack(next)
    if (!result.ok) return result
    next = result.doc
    track = next.tracks.at(-1)!
  }
  return placeAudio(next, track.id, clip, start)
}

export function latestExport(nodes: readonly NodeView[], nodeId: string) {
  return nodes.filter(node => node.exportOf?.timelineNodeId === nodeId && nodeAsset(node))
    .sort((a, b) => (b.exportOf!.timelineRevision - a.exportOf!.timelineRevision) || b.z - a.z).at(0)
}

export function defaultTimelineEnd(doc: TimelineDoc): number { return Math.max(10_000, timelineDurationMs(doc)) }
