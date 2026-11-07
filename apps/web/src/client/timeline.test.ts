import { describe, expect, it, vi } from 'vitest'
import type { MediaTaskView, NodeView, SlotVersionView, TimelineDoc, WorkChange } from '@vis/protocol'
import { timelineExportRequest } from '@vis/canvas-ui'
import { canvasActions } from './actions'
import { nodeRefPreview } from './App'
import { messages } from './messages'
import type { SpaceConnection } from './space'
import { emptyState } from './store'
import { reviewChangePreview } from './WorkReview'

const doc: TimelineDoc = { version: 1, tracks: [{ id: 'video', kind: 'video', volume: 1, muted: false, clips: [
  { id: 'clip', source: { nodeId: 'source', assetVersionId: 'asset' }, startMs: 0, inMs: 1000, outMs: 6000, volume: 1, fadeInMs: 0, fadeOutMs: 0 },
] }] }
const timeline: NodeView = {
  nodeId: 'timeline', kind: 'timeline', title: 'Rough cut', x: 0, y: 0, w: 360, h: 300, z: 1, layoutRevision: 1,
  slots: [{ slotId: 'main', slotKey: 'main', contentType: 'timeline', revision: 3, content: { type: 'timeline', doc } }],
}
const output: NodeView = { ...timeline, nodeId: 'output', kind: 'video', exportOf: { timelineNodeId: 'timeline', timelineRevision: 2 }, slots: [
  { slotId: 'output-main', slotKey: 'main', contentType: 'video', revision: 1, content: { type: 'asset', assetVersionId: 'export', mime: 'video/mp4' } },
] }
const url = (id: string) => `/assets/${id}`

describe('Timeline host actions', () => {
  it('creates an empty document at the requested position and delegates ordered sources without a position', async () => {
    const call = vi.fn(async () => ({ idMap: { n: 'created' }, eventSeq: 1 }))
    const conn = { getView: () => ({ space: { spaceId: 'space' }, ready: true, state: emptyState(), providers: null }), rpc: { call } } as unknown as SpaceConnection
    const actions = canvasActions(conn, vi.fn(), 'en')
    expect(await actions.onCreateTimeline!({ x: 20, y: 40 })).toBe('created')
    expect(await actions.onCreateTimelineFrom!(['third', 'first', 'second'])).toBe('created')
    expect(call.mock.calls[0]).toEqual(['canvas.apply', { requestId: expect.any(String), description: 'Create timeline', ops: [{ op: 'node.create', tempId: 'n', kind: 'timeline', x: 20, y: 40 }] }])
    expect(call.mock.calls[1]).toEqual(['canvas.apply', { requestId: expect.any(String), description: 'Create timeline', ops: [{ op: 'node.create', tempId: 'n', kind: 'timeline', content: { timelineFrom: ['third', 'first', 'second'] } }] }])
  })
  it('submits the pinned revision through the media task lifecycle and records progress', async () => {
    const task: MediaTaskView = { taskId: 'export-task', operation: 'timeline.export', nodeId: 'timeline', slotId: 'main', status: 'queued', createdAt: 1 }
    const call = vi.fn(async (method: string) => method === 'media.process' ? task : { ...task, status: 'succeeded' })
    const recordMediaTask = vi.fn()
    const conn = { getView: () => ({ space: { spaceId: 'space' }, ready: true, state: emptyState(), providers: null }), rpc: { call }, recordMediaTask } as unknown as SpaceConnection
    await canvasActions(conn, vi.fn(), 'en').onMediaProcess!(timelineExportRequest(timeline.nodeId, timeline.slots[0]!))
    expect(call.mock.calls[0]).toEqual(['media.process', { operation: 'timeline.export', nodeId: 'timeline', slotId: 'main', expectedRevision: 3, params: {}, requestId: expect.any(String), waitMs: 0 }])
    expect(recordMediaTask.mock.calls.map(([value]) => value.status)).toEqual(['queued', 'succeeded'])
  })
})

it('previews timeline summaries and latest exports while keeping historical review revisions accurate', () => {
  expect(nodeRefPreview(timeline, url, messages.en)).toEqual({ kind: 'text', text: '1 clips · 00:05', label: 'Rough cut' })
  expect(nodeRefPreview(timeline, url, messages.en, [output])).toEqual({ kind: 'video', src: '/assets/export', label: 'Rough cut · 1 clips · 00:05' })
  const change: WorkChange = { nodeId: 'timeline', nodeKind: 'timeline', slotId: 'main', change: 'updated', fromRevision: 2, toRevision: 3, lastSeq: 4, sessionId: 'agent' }
  const versions: SlotVersionView[] = [2, 3].map(revision => ({ revision, createdAt: revision, actor: 'agent', isCurrent: revision === 3, content: { type: 'timeline', doc } }))
  const preview = reviewChangePreview(change, timeline, versions, url, undefined, 'en', [output])
  expect(preview.title).toBe('Rough cut')
  expect(preview.before).toEqual({ kind: 'video', src: '/assets/export', label: 'Rough cut · 1 clips · 00:05' })
  expect(preview.after).toEqual({ kind: 'text', text: '1 clips · 00:05', label: 'Rough cut' })
})
