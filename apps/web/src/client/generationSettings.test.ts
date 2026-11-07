import type { NodeView } from '@vis/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { migrateGenerationSettings } from './generationSettings'
import type { RpcClient } from './rpc'

const generation = { provider: 'ark', model: 'image', params: { size: '4K', watermark: false } }
const node = (nodeId: string, saved?: NodeView['generation']) => ({ nodeId, kind: 'image', generation: saved }) as NodeView

function setup(entries: Record<string, string>) {
  const storage = new Map(Object.entries(entries))
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, removeItem: (key: string) => storage.delete(key) })
  const call = vi.fn(async (method: string, params: any) => method === 'canvas.get' ? { nodes: params.nodeIds.map((id: string) => node(id)) } : {})
  return { storage, call, rpc: { call } as unknown as RpcClient }
}

afterEach(() => vi.unstubAllGlobals())

describe('Node generation settings migration', () => {
  it('processes only nodes in the current snapshot, migrates unchanged, and deletes only on success; does not migrate recent-use preferences', async () => {
    const valid = JSON.stringify(generation)
    const { rpc, call, storage } = setup({ 'vis.gen.space.existing': valid, 'vis.gen.space.orphan': valid, 'vis.gen.other.existing': valid, 'vis.gen.last.image': valid, 'vis.gen.space.malformed': '{', 'vis.gen.space.array': '{"provider":"ark","model":"image","params":[]}' })
    expect(await migrateGenerationSettings(rpc, 'space', [node('existing'), node('malformed'), node('array')], () => true)).toBe(true)
    expect(call.mock.calls).toEqual([
      ['canvas.get', { nodeIds: ['existing'] }],
      ['canvas.apply', { requestId: expect.any(String), ops: [{ op: 'node.setGeneration', nodeId: 'existing', generation, onlyIfUnset: true }] }],
    ])
    expect(storage.has('vis.gen.space.existing')).toBe(false)
    expect([...storage.keys()]).toHaveLength(5)
  })

  it('latest database settings take precedence; deletes resolved legacy records without sending writes', async () => {
    const { rpc, call, storage } = setup({ 'vis.gen.space.existing': JSON.stringify(generation) })
    call.mockResolvedValueOnce({ nodes: [node('existing', { provider: 'mock' })] })
    expect(await migrateGenerationSettings(rpc, 'space', [node('existing', generation)], () => true)).toBe(true)
    expect(call).toHaveBeenCalledTimes(1)
    expect(storage.size).toBe(0)
  })

  it('individual failures do not block later nodes; retains failed records for the next retry', async () => {
    const valid = JSON.stringify(generation)
    const { rpc, call, storage } = setup({ 'vis.gen.space.first': valid, 'vis.gen.space.second': valid })
    call.mockResolvedValueOnce({ nodes: [node('first')] }).mockRejectedValueOnce(new Error('offline'))
    expect(await migrateGenerationSettings(rpc, 'space', [node('first'), node('second')], () => true)).toBe(false)
    expect(storage.has('vis.gen.space.first')).toBe(true)
    expect(storage.has('vis.gen.space.second')).toBe(false)
    expect(call).toHaveBeenCalledTimes(4)
  })

  it('does not write after switching projects or deleting nodes; does not delete legacy records changed during migration', async () => {
    const valid = JSON.stringify(generation)
    const { rpc, call, storage } = setup({ 'vis.gen.space.existing': valid })
    let current = true
    call.mockImplementationOnce(async () => { current = false; return { nodes: [node('existing')] } })
    expect(await migrateGenerationSettings(rpc, 'space', [node('existing')], () => current)).toBe(false)
    expect(call).toHaveBeenCalledTimes(1)
    expect(storage.get('vis.gen.space.existing')).toBe(valid)
    current = true
    call.mockResolvedValueOnce({ nodes: [] })
    await migrateGenerationSettings(rpc, 'space', [node('existing')], () => current)
    expect(call).toHaveBeenCalledTimes(2)
    call.mockResolvedValueOnce({ nodes: [node('existing')] }).mockImplementationOnce(async () => { storage.set('vis.gen.space.existing', JSON.stringify({ ...generation, model: 'new' })); return {} })
    await migrateGenerationSettings(rpc, 'space', [node('existing')], () => current)
    expect(storage.get('vis.gen.space.existing')).toContain('new')
  })
})
