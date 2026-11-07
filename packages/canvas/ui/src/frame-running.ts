import type { NodeView } from '@vis/protocol'
import type { NodeDecoration } from './CanvasView'

export function frameRunningStates(nodes: readonly NodeView[], decorations: ReadonlyMap<string, NodeDecoration> | undefined): ReadonlyMap<string, boolean> {
  const running = new Map<string, boolean>()
  const parents = new Map(nodes.map(node => [node.nodeId, node.frameId]))
  for (const node of nodes) {
    if (!decorations?.get(node.nodeId)?.running) continue
    let frameId = node.frameId
    while (frameId && !running.has(frameId)) {
      running.set(frameId, true)
      frameId = parents.get(frameId)
    }
  }
  return running
}
