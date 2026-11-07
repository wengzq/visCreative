import { describe, expect, it } from 'vitest'
import type { NodeView, TimelineClip, TimelineDoc } from '@vis/protocol'
import { canCreateTimeline, latestTimelineExport, miniTimelineTracks, timelineExportRequest, timelineOutOfDate, timelineReadingOrder, timelineSummary } from './timeline-card'

const node = (nodeId: string, x = 0, y = 0, h = 100): NodeView => ({
  nodeId, kind: 'video', x, y, w: 160, h, z: 1, layoutRevision: 1,
  slots: [{ slotId: `${nodeId}-main`, slotKey: 'main', contentType: 'video', revision: 1, content: { type: 'asset', assetVersionId: `${nodeId}-asset`, mime: 'video/mp4' } }],
})
const ids = (nodes: NodeView[]) => timelineReadingOrder(nodes).map(item => item.nodeId)
const clip = (id: string, startMs: number, inMs = 0, outMs = 2000): TimelineClip => ({
  id, source: { nodeId: id, assetVersionId: `${id}-asset` }, startMs, inMs, outMs, volume: 1, fadeInMs: 0, fadeOutMs: 0,
})

describe('Timeline reading order', () => {
  it('sorts a single column top to bottom without changing the original array', () => {
    const nodes = [node('third', 0, 400), node('first', 0, 0), node('second', 0, 200)]
    expect(ids(nodes)).toEqual(['first', 'second', 'third'])
    expect(nodes[0]!.nodeId).toBe('third')
  })
  it('sorts grids by row then by x', () => {
    expect(ids([node('d', 220, 200), node('b', 220, 0), node('c', 0, 200), node('a')])).toEqual(['a', 'b', 'c', 'd'])
  })
  it('groups ragged centers using half the median height and prevents chained rows', () => {
    expect(ids([node('b', 200, -20), node('a', 0, 10), node('d', 200, 210), node('c', 0, 190)])).toEqual(['a', 'b', 'c', 'd'])
    expect(ids([node('c', 0, 100), node('b', 200, 50), node('a', 400, 0)])).toEqual(['b', 'a', 'c'])
    expect(ids([])).toEqual([])
  })
})

describe('Timeline exports', () => {
  const exported = (id: string, revision: number, z = 1): NodeView => ({ ...node(id), z, exportOf: { timelineNodeId: 'timeline', timelineRevision: revision } })
  it('considers only live asset outputs and chooses revision, then stacking order, then node order', () => {
    const old = exported('old', 1, 99)
    const recent = exported('recent', 3, 5)
    const tie = exported('tie', 3, 8)
    const last = exported('last', 3, 8)
    expect(latestTimelineExport('timeline', [old, tie, recent, last])?.nodeId).toBe('last')
    expect(latestTimelineExport('timeline', [old, recent])?.nodeId).toBe('recent')
    expect(latestTimelineExport('timeline', [old])?.nodeId).toBe('old')
    expect(latestTimelineExport('timeline', [{ ...tie, slots: [] }, { ...old, exportOf: { timelineNodeId: 'other', timelineRevision: 10 } }])).toBeUndefined()
    expect(timelineOutOfDate(4, recent)).toBe(true)
    expect(timelineOutOfDate(3, recent)).toBe(false)
    expect(timelineOutOfDate(2, recent)).toBe(false)
    expect(timelineOutOfDate(9, undefined)).toBe(false)
  })
  it('pins the main slot revision in the local export request', () => {
    expect(timelineExportRequest('timeline', { slotId: 'main', revision: 7 })).toEqual({
      operation: 'timeline.export', nodeId: 'timeline', slotId: 'main', expectedRevision: 7, params: {},
    })
  })
})

it('positions video and audio blocks against the whole duration, colors audio by position and dims muted tracks', () => {
  const doc: TimelineDoc = { version: 1, tracks: [
    { id: 'v', kind: 'video', volume: 1, muted: false, clips: [clip('v1', 0), clip('v2', 2000, 1000, 3000)] },
    ...[0, 1, 2, 3].map(index => ({ id: `a${index}`, kind: 'audio' as const, name: 'Music', volume: 1, muted: index === 1, clips: [clip(`a${index}-clip`, 4000, 0, 4000)] })),
  ] }
  const tracks = miniTimelineTracks(doc)
  expect(tracks.map(track => track.color)).toEqual(['var(--vis-text-faint)', 'var(--vis-frame-teal)', 'var(--vis-frame-amber)', 'var(--vis-frame-violet)', 'var(--vis-frame-blue)'])
  expect(tracks.map(track => track.opacity)).toEqual([1, 1, 0.4, 1, 1])
  expect(tracks[0]!.clips.map(({ left, width }) => ({ left, width }))).toEqual([{ left: 0, width: 25 }, { left: 25, width: 25 }])
  expect(tracks[1]!.clips[0]).toMatchObject({ left: 50, width: 50 })
  expect(timelineSummary(doc, 'en')).toBe('6 clips · 00:08')
  expect(timelineSummary({ version: 1, tracks: [] }, 'zh-CN')).toBe('0 个片段 · 00:00')
})

it('0024e: overlay rows share one color, dim when hidden and size clips by their timeline length', () => {
  const doc: TimelineDoc = { version: 1, tracks: [
    { id: 'v', kind: 'video', volume: 1, muted: false, clips: [{ ...clip('v1', 0, 0, 4000), speed: 2 }] },
    { id: 'o1', kind: 'overlay', volume: 1, muted: true, clips: [{ ...clip('o1-clip', 0, 0, 1000), overlay: { x: 0.5, y: 0.5, width: 0.2, opacity: 1 } }] },
    { id: 'o2', kind: 'overlay', volume: 1, muted: false, hidden: true, clips: [] },
    { id: 'a', kind: 'audio', volume: 1, muted: false, clips: [] },
  ] }
  const tracks = miniTimelineTracks(doc)
  expect(tracks.map(track => track.color)).toEqual(['var(--vis-text-faint)', 'var(--vis-frame-orange)', 'var(--vis-frame-orange)', 'var(--vis-frame-teal)'])
  expect(tracks.map(track => track.opacity)).toEqual([1, 1, 0.4, 1])
  expect(tracks[0]!.clips[0]).toMatchObject({ left: 0, width: 100 })
  expect(tracks[1]!.clips[0]).toMatchObject({ left: 0, width: 50 })
})

it('shows creation only for nonempty asset-backed media selections, including single shots and audio', () => {
  const video = node('video')
  const audio: NodeView = { ...node('audio'), kind: 'audio' }
  expect(canCreateTimeline([video])).toBe(true)
  expect(canCreateTimeline([audio])).toBe(true)
  expect(canCreateTimeline([video, audio, { ...node('image'), kind: 'image' }])).toBe(true)
  expect(canCreateTimeline([video, { ...node('text'), kind: 'text' }])).toBe(false)
  expect(canCreateTimeline([video, { ...node('empty'), slots: [] }])).toBe(false)
  expect(canCreateTimeline([])).toBe(false)
})
