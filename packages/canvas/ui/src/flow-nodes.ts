import type { Node } from '@xyflow/react'
import type { NodeView } from '@vis/protocol'
import type { Layout, NodeDecoration } from './CanvasView'

export type VisNodeData = { view: NodeView; deco: NodeDecoration | undefined }
export type VisNode = Node<VisNodeData>

export function selectFlowNodes(nodes: VisNode[], ids: ReadonlySet<string>): VisNode[] {
  let changed = false
  const next = nodes.map(node => {
    const selected = ids.has(node.id)
    if (Boolean(node.selected) === selected) return node
    changed = true
    return { ...node, selected }
  })
  return changed ? next : nodes
}

export function moveFlowNodes(nodes: VisNode[], positions: ReadonlyMap<string, { x: number; y: number }>): VisNode[] {
  let changed = false
  const next = nodes.map(node => {
    const position = positions.get(node.id)
    if (!position || node.position.x === position.x && node.position.y === position.y) return node
    changed = true
    return { ...node, position: { x: position.x, y: position.y } }
  })
  return changed ? next : nodes
}

export function toFlowNode(view: NodeView, layout: Layout | undefined, selected: boolean, deco: NodeDecoration | undefined, previous?: VisNode): VisNode {
  const l = layout ?? view
  if (previous && previous.data.view === view && previous.data.deco === deco && previous.selected === selected
    && previous.position.x === l.x && previous.position.y === l.y && previous.width === l.w && previous.height === l.h) return previous
  return {
    // Losing measured also clears React Flow's handle bounds and restarts its resize observation.
    ...previous,
    id: view.nodeId,
    type: view.kind,
    position: previous?.position.x === l.x && previous.position.y === l.y ? previous.position : { x: l.x, y: l.y },
    width: l.w,
    height: l.h,
    zIndex: view.kind === 'frame' ? -1000 : Math.max(0, view.z),
    ...(view.kind === 'frame' ? { dragHandle: '.vis-frame-header', className: 'vis-flow-frame' } : {}),
    selected,
    data: previous?.data.view === view && previous.data.deco === deco ? previous.data : { view, deco },
  }
}
