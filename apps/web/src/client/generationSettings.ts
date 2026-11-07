import { readChoice } from '@vis/canvas-ui'
import type { NodeView } from '@vis/protocol'
import type { RpcClient } from './rpc'

/** Migrate only nodes in the first snapshot; retain browser records on failure to retry on the next open. */
export async function migrateGenerationSettings(rpc: RpcClient, spaceId: string, nodes: NodeView[], isCurrent: () => boolean) {
  let complete = true
  for (const node of nodes) {
    if (!isCurrent()) return false
    if (node.kind === 'text') continue
    const key = `vis.gen.${spaceId}.${node.nodeId}`
    const generation = readChoice(key)
    if (!generation) continue
    try {
      const latest = await rpc.call<{ nodes: NodeView[] }>('canvas.get', { nodeIds: [node.nodeId] })
      if (!isCurrent()) return false
      const current = latest.nodes.find(n => n.nodeId === node.nodeId)
      if (!current) continue
      if (current.generation === undefined) await rpc.call('canvas.apply', { requestId: `web-${crypto.randomUUID()}`, ops: [{ op: 'node.setGeneration', nodeId: node.nodeId, generation, onlyIfUnset: true }] })
      if (JSON.stringify(readChoice(key)) === JSON.stringify(generation)) localStorage.removeItem(key)
    } catch { complete = false }
  }
  return isCurrent() && complete
}
