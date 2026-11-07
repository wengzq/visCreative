import { describe, expect, it, vi } from 'vitest'
import type { CanvasActions } from '@vis/canvas-ui'
import type { NodeView, SessionSummary, TimelineDoc } from '@vis/protocol'
import { timelineEditorHost } from './timeline-editor'
import { emptyState } from './store'
import { RpcError } from './rpc'
import type { SpaceConnection } from './space'

const doc: TimelineDoc = { version: 1, tracks: [] }
const node: NodeView = { nodeId: 'timeline', kind: 'timeline', x: 0, y: 0, w: 320, h: 240, z: 1, layoutRevision: 1, slots: [
  { slotId: 'main', slotKey: 'main', contentType: 'timeline', revision: 4, content: { type: 'timeline', doc } },
] }

function fixture() {
  const state = emptyState()
  state.nodes.set(node.nodeId, node)
  const view = { space: { spaceId: 'project' }, ready: true, state }
  const call = vi.fn(async (method: string) => method === 'asset.get'
    ? { kind: 'video', version: 2, durationMs: 2000, width: 160, height: 90, fps: 29.97, url: '/private-media', path: 'private-path' }
    : { kind: 'peaks', peaks: [], durationMs: 0, binsPerSecond: 10 })
  const refreshNodes = vi.fn(async () => {})
  const conn = { getView: () => view, token: 'token', rpc: { call }, refreshNodes } as unknown as SpaceConnection
  const onApply = vi.fn(async () => {})
  const onMediaProcess = vi.fn(async () => ({}))
  const onDownload = vi.fn()
  const close = vi.fn()
  const focus = vi.fn()
  const host = timelineEditorHost({ conn, node, nodes: [node], actions: { onApply, onMediaProcess, onDownload } as unknown as CanvasActions, locale: 'en', close, focus, upload: vi.fn() })
  return { host, view, onApply, onMediaProcess, call, close, focus, refreshNodes }
}

describe('Timeline editor host', () => {
  it('pins commit and export to the passed revision and maps conflicts only', async () => {
    const { host, onApply, onMediaProcess, refreshNodes } = fixture()
    expect(await host.commit(doc, 4)).toBe('ok')
    expect(onApply.mock.calls[0]).toEqual([[{ op: 'timeline.set', slotId: 'main', expectedRevision: 4, doc }], 'Edit timeline'])
    onApply.mockRejectedValueOnce(new RpcError('revision_conflict', 'Stale revision'))
    expect(await host.commit(doc, 4)).toBe('conflict')
    expect(refreshNodes).toHaveBeenCalledWith(['timeline'])
    onApply.mockRejectedValueOnce(new RpcError('unavailable', 'Disconnected'))
    await expect(host.commit(doc, 4)).rejects.toThrow('Disconnected')
    await host.export(5)
    expect(onMediaProcess).toHaveBeenCalledWith({ operation: 'timeline.export', nodeId: 'timeline', slotId: 'main', expectedRevision: 5, params: {} })
  })
  it('uses authenticated preview routes and closes before focusing exports', async () => {
    const { host, call, close, focus } = fixture()
    expect(host.assetUrl('clip /1')).toBe('/assets/project/clip%20%2F1?t=token')
    expect(host.filmstripUrl('clip /1')).toBe('/previews/project/clip%20%2F1/filmstrip?t=token')
    await host.preview('asset', 'peaks')
    expect(call).toHaveBeenCalledWith('media.preview', { assetVersionId: 'asset', kind: 'peaks' })
    host.showOnCanvas('export')
    expect(close.mock.invocationCallOrder[0]).toBeLessThan(focus.mock.invocationCallOrder[0]!)
    expect(focus).toHaveBeenCalledWith('export')
  })
  it('rejects editor mutations after the project changes', async () => {
    const { host, view, onApply, onMediaProcess } = fixture()
    view.space.spaceId = 'other'
    await expect(host.commit(doc, 4)).rejects.toThrow('project')
    await expect(host.export(4)).rejects.toThrow('project')
    expect(onApply).not.toHaveBeenCalled()
    expect(onMediaProcess).not.toHaveBeenCalled()
  })
  it('deduplicates immutable asset metadata and returns only editor fields', async () => {
    const { host, call } = fixture()
    const results = await Promise.all([host.assetInfo('asset'), host.assetInfo('asset')])
    expect(results).toEqual([{ kind: 'video', version: 2, durationMs: 2000, width: 160, height: 90, fps: 29.97 }, { kind: 'video', version: 2, durationMs: 2000, width: 160, height: 90, fps: 29.97 }])
    await host.assetInfo('asset')
    expect(call.mock.calls.filter(([method]) => method === 'asset.get')).toHaveLength(1)
  })
  it('reads the latest agent writer and session title from the live project view', () => {
    const { host, view } = fixture()
    const write = (writer: NodeView['slots'][number]['writer']) => {
      const slot = { ...node.slots[0]! }
      if (writer) slot.writer = writer
      view.state.nodes.set(node.nodeId, { ...node, slots: [slot] })
    }
    expect(host.lastWriter?.()).toBeUndefined()
    view.state.sessions.set('agent', { sessionId: 'agent', title: 'Rough cut assistant' } as SessionSummary)
    write({ actor: 'agent', sessionId: 'agent' })
    expect(host.lastWriter?.()).toBe('Rough cut assistant')
    view.state.sessions.set('agent', { sessionId: 'agent', title: 'Renamed assistant' } as SessionSummary)
    expect(host.lastWriter?.()).toBe('Renamed assistant')
    for (const writer of [{ actor: 'user' }, { actor: 'system' }, { actor: 'agent' }, { actor: 'agent', sessionId: 'missing' }] as const) {
      write(writer)
      expect(host.lastWriter?.()).toBeUndefined()
    }
    write({ actor: 'agent', sessionId: 'agent' })
    view.space.spaceId = 'other'
    expect(host.lastWriter?.()).toBeUndefined()
  })
})
