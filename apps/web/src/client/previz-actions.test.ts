import { EMPTY_PREVIZ, type NodeView } from '@vis/protocol'
import { expect, it, vi } from 'vitest'
import { previzCanvasActions } from './previz-actions'
import { RpcError } from './rpc'

const node = (revision: number) => ({ nodeId: 'board', slots: [{ slotId: 'main', slotKey: 'main', revision, content: { type: 'previz', doc: EMPTY_PREVIZ } }] }) as NodeView

it('stops after the second extraction conflict and never retries other errors', async () => {
  for (const code of ['revision_conflict', 'invalid_params']) {
    let reads = 0
    const call = vi.fn(async <T = any>(method: string): Promise<T> => {
      if (method === 'canvas.get') return { nodes: [node(++reads)] } as T
      throw new RpcError(code, 'Extraction failed')
    })
    const action = previzCanvasActions(async <T = any>(method: string) => call(method) as Promise<T>, vi.fn(), () => null)
    await expect(action.onPrevizExtract!('board', 'video')).rejects.toMatchObject({ code })
    expect(reads).toBe(code === 'revision_conflict' ? 2 : 1)
    expect(call.mock.calls.filter(([method]) => method === 'previz.extractBlockout')).toHaveLength(reads)
  }
})
