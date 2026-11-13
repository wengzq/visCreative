import { EMPTY_SCENE, type NodeView } from '@vis/protocol'
import { describe, expect, it, vi } from 'vitest'
import { RpcError } from './rpc'
import { registerSceneDraft, resolveSceneProposal } from './scene-proposals'
import { emptyState } from './store'
import type { SpaceConnection } from './space'

function fixture() {
  const node: NodeView = { nodeId: 'scene', kind: 'scene', x: 0, y: 0, w: 360, h: 280, z: 1, layoutRevision: 1, slots: [{ slotId: 'slot', slotKey: 'main', contentType: 'scene', revision: 1, content: { type: 'scene', doc: EMPTY_SCENE } }] }
  const state = emptyState()
  state.nodes.set(node.nodeId, node)
  const view = { ready: true, space: { spaceId: 'project' }, state }
  const order: string[] = []
  const call = vi.fn(async (_method: string, _params: unknown) => { order.push('resolve'); node.slots[0]!.revision = 3; return { proposals: [] } })
  const refreshNodes = vi.fn(async () => { order.push('read') })
  const conn = { getView: () => view, rpc: { call }, refreshNodes } as unknown as SpaceConnection
  const handle = { flush: vi.fn(async () => { order.push('flush'); node.slots[0]!.revision = 2; return 2 as number | null }), adopt: vi.fn() }
  return { node, view, conn, call, handle, order, refreshNodes }
}
const changes = [{ proposalId: 'proposal', changeId: 'change' }]

describe('scene proposal host', () => {
  it('flushes the mounted draft before reading the saved revision and adopts the accepted document', async () => {
    const { conn, call, handle, order } = fixture()
    const dispose = registerSceneDraft(conn, 'slot', handle)
    await resolveSceneProposal(conn, 'project', 'en', 'slot', 'accept', changes)
    expect(order).toEqual(['flush', 'read', 'resolve', 'read'])
    expect(call).toHaveBeenCalledWith('scene.proposal.resolve', expect.objectContaining({ action: 'accept', expectedRevision: 2, changes }))
    expect(handle.adopt).toHaveBeenCalledWith(EMPTY_SCENE, 3, 2)
    dispose()
  })
  it('rereads a revision conflict once and leaves acceptance for the author to retry', async () => {
    const { node, conn, call, handle, refreshNodes } = fixture()
    const dispose = registerSceneDraft(conn, 'slot', handle)
    call.mockImplementationOnce(async () => { node.slots[0]!.revision = 3; throw new RpcError('revision_conflict', 'Scene changed') })
    await expect(resolveSceneProposal(conn, 'project', 'en', 'slot', 'accept', changes)).rejects.toMatchObject({ code: 'revision_conflict' })
    expect(call).toHaveBeenCalledTimes(1)
    expect(refreshNodes).toHaveBeenCalledTimes(2)
    expect(handle.adopt).toHaveBeenCalledWith(EMPTY_SCENE, 3, 2)
    dispose()
  })
  it('rejects without flushing or sending a content revision and refuses acceptance if flush conflicts', async () => {
    const { conn, call, handle } = fixture()
    const dispose = registerSceneDraft(conn, 'slot', handle)
    await resolveSceneProposal(conn, 'project', 'en', 'slot', 'reject', changes)
    expect(handle.flush).not.toHaveBeenCalled()
    expect(call.mock.calls[0]?.[1]).not.toHaveProperty('expectedRevision')
    call.mockClear()
    handle.flush.mockResolvedValueOnce(null)
    await expect(resolveSceneProposal(conn, 'project', 'en', 'slot', 'accept', changes)).rejects.toThrow('Resolve the scene save conflict')
    expect(call).not.toHaveBeenCalled()
    dispose()
  })
})

it.each(['en', 'zh-CN'] as const)('shows the localized save-before-accept reason for a rejected flush in %s', async locale => {
  const { conn, call, handle } = fixture()
  const dispose = registerSceneDraft(conn, 'slot', handle)
  handle.flush.mockRejectedValueOnce(new Error('Disconnected'))
  const { messagesFor } = await import('@vis/ui-kit')
  const { sceneHostMessages } = await import('./scene-messages')
  await expect(resolveSceneProposal(conn, 'project', locale, 'slot', 'accept', changes)).rejects.toThrow(messagesFor(sceneHostMessages, locale).saveBeforeAccept)
  expect(handle.flush).toHaveBeenCalledTimes(1)
  expect(call).not.toHaveBeenCalled()
  dispose()
})

it('renders the merged scene ID mismatch reason in both UI locales', async () => {
  const { describeError } = await import('@vis/ui-kit')
  const error = new RpcError('invalid_params', 'Fallback', { code: 'invalid_params', reason: 'scene.change_id_mismatch' })
  const english = describeError(error, 'en')
  const chinese = describeError(error, 'zh-CN')
  expect(english).toBe('The proposed content ID must match the target ID')
  expect(chinese).not.toBe(english)
  expect(chinese).not.toContain('scene.change_id_mismatch')
  expect(chinese).not.toBe('Fallback')
})
