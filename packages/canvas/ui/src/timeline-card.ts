import { clipDurationMs, timelineDurationMs, type NodeView, type SlotView, type TimelineDoc } from '@vis/protocol'
import { formatter, messagesFor, type Locale } from '@vis/ui-kit'
import { timelineMessages } from './timeline-messages'

export function timelineClipCount(doc: TimelineDoc): number {
  return [...doc.tracks, ...(doc.textTracks ?? [])].reduce((count, track) => count + track.clips.length, 0)
}

export function timelineTimecode(ms: number, number: (value: number) => string): string {
  const seconds = Math.floor(ms / 1000)
  return [Math.floor(seconds / 60), seconds % 60].map(value => number(value).padStart(2, number(0))).join(':')
}

export function timelineSummary(doc: TimelineDoc, locale: Locale): string {
  const format = formatter(locale)
  return messagesFor(timelineMessages, locale).summary(format.number(timelineClipCount(doc)), timelineTimecode(timelineDurationMs(doc), value => format.number(value)))
}

export function latestTimelineExport(nodeId: string, nodes: readonly NodeView[]): NodeView | undefined {
  return nodes.filter(node => node.exportOf?.timelineNodeId === nodeId && (node.kind === 'video' || node.kind === 'audio')
    && node.slots.some(slot => slot.slotKey === 'main' && slot.content.type === 'asset'))
    .reduce<NodeView | undefined>((latest, node) => !latest
      || node.exportOf!.timelineRevision > latest.exportOf!.timelineRevision
      || node.exportOf!.timelineRevision === latest.exportOf!.timelineRevision && node.z >= latest.z ? node : latest, undefined)
}

export function timelineOutOfDate(revision: number, exported: NodeView | undefined): boolean {
  return exported?.exportOf !== undefined && exported.exportOf !== null && exported.exportOf.timelineRevision < revision
}

export function canCreateTimeline(nodes: readonly NodeView[]): boolean {
  return nodes.length > 0 && nodes.length <= 200 && nodes.every(node => ['video', 'image', 'audio'].includes(node.kind)
    && node.slots.some(slot => slot.slotKey === 'main' && slot.content.type === 'asset'))
}

/** Anchor each row to its first center so a staggered column cannot chain into one row. */
export function timelineReadingOrder<T extends Pick<NodeView, 'nodeId' | 'x' | 'y' | 'h'>>(nodes: readonly T[]): T[] {
  if (!nodes.length) return []
  const heights = nodes.map(node => node.h).sort((a, b) => a - b)
  const middle = Math.floor(heights.length / 2)
  const tolerance = (heights.length % 2 ? heights[middle]! : (heights[middle - 1]! + heights[middle]!) / 2) / 2
  const sorted = [...nodes].sort((a, b) => a.y + a.h / 2 - b.y - b.h / 2 || a.x - b.x || a.nodeId.localeCompare(b.nodeId))
  const rows: { center: number; nodes: T[] }[] = []
  for (const node of sorted) {
    const center = node.y + node.h / 2
    const row = rows.at(-1)
    if (row && center - row.center <= tolerance) row.nodes.push(node)
    else rows.push({ center, nodes: [node] })
  }
  return rows.flatMap(row => row.nodes.sort((a, b) => a.x - b.x || a.y - b.y || a.nodeId.localeCompare(b.nodeId)))
}

export function miniTimelineTracks(doc: TimelineDoc) {
  const duration = timelineDurationMs(doc)
  let audio = 0
  const colors = ['teal', 'amber', 'violet', 'blue'] as const
  return doc.tracks.map(track => ({
    id: track.id,
    kind: track.kind,
    // Overlays share one color; audio colors follow the audio track's position
    color: track.kind === 'video' ? 'var(--vis-text-faint)' : track.kind === 'overlay' ? 'var(--vis-frame-orange)' : `var(--vis-frame-${colors[audio++ % colors.length]})`,
    opacity: track.muted && track.kind === 'audio' || track.hidden ? 0.4 : 1,
    clips: track.clips.map(clip => ({
      id: clip.id,
      nodeId: clip.source.nodeId,
      left: duration ? clip.startMs / duration * 100 : 0,
      width: duration ? clipDurationMs(clip) / duration * 100 : 0,
    })),
  }))
}

export function timelineExportRequest(nodeId: string, slot: Pick<SlotView, 'slotId' | 'revision'>) {
  return { operation: 'timeline.export' as const, nodeId, slotId: slot.slotId, expectedRevision: slot.revision, params: {} }
}
