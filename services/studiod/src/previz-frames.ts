import { placeNewNode } from '@vis/canvas-core'
import type { CanvasOp, NodeView, PrevizPanel } from '@vis/protocol'

export function linkedPrevizPanels(nodes: NodeView[], scriptNodeId: string, shotId?: string) {
  return nodes.flatMap(node => {
    const content = node.slots.find(slot => slot.slotKey === 'main')?.content
    return content?.type === 'previz' ? content.doc.panels.flatMap((panel, index) => panel.shot?.scriptNodeId === scriptNodeId && (!shotId || panel.shot.shotId === shotId) ? [{ node, panel, panelNumber: index + 1 }] : []) : []
  })
}

/** One first candidate and one last candidate per shot, in document reading order. */
export function panelFrameCandidates(nodes: NodeView[], scriptNodeId: string, shotIds: readonly string[]) {
  const seen = new Set<string>()
  return linkedPrevizPanels(nodes, scriptNodeId).filter(({ panel }) => {
    if (!panel.image || !panel.shot || !shotIds.includes(panel.shot.shotId)) return false
    const role = panel.use === 'frame' && panel.frameRole === 'last' ? 'last' : 'first'
    const key = `${panel.shot.shotId}:${role}`
    if (seen.has(key)) return false
    seen.add(key)
    return panel.use === 'frame'
  })
}

export function previzFrameOps(node: NodeView, panel: PrevizPanel, tempId: string, nodes: NodeView[]): CanvasOp[] {
  if (!panel.image || !panel.shot) return []
  const content = node.slots.find(slot => slot.slotKey === 'main')?.content
  const [rw, rh] = (content?.type === 'previz' ? content.doc.aspectRatio : '16:9').split(':').map(Number)
  const size = { w: 320, h: Math.max(80, Math.round(320 * rh! / rw!)) }
  const at = placeNewNode(size, nodes.filter(node => node.kind !== 'frame'), node)
  return [
    { op: 'node.create', tempId, kind: 'image', ...at, ...size, content: { assetVersionId: panel.image } },
    { op: 'node.setMeta', nodeId: tempId, shot: { ...panel.shot, role: panel.frameRole === 'last' ? 'last' : 'first' } },
  ]
}
