import { messagesFor, type Locale } from '@vis/ui-kit'
import { messages } from './messages'
import { type Edge, MarkerType, Position } from '@xyflow/react'
import type { CanvasOp, FrameColor, NodeKind, NodeView } from '@vis/protocol'

export const NODE_GAP = 80
export const nodeSize = (kind: NodeKind) => kind === 'previz' || kind === 'scene' ? { w: 360, h: 280 } : kind === 'timeline' ? { w: 360, h: 300 } : kind === 'script' ? { w: 480, h: 320 } : ({ w: kind === 'audio' ? 360 : 320, h: kind === 'audio' ? 140 : kind === 'text' ? 200 : kind === 'image' ? 320 : 180 })

export function inputEdges(nodes: NodeView[], selected: ReadonlySet<string> = new Set(), locale: Locale = 'zh-CN', previous: Edge[] = []): Edge[] {
  const m = messagesFor(messages, locale)
  const byId = new Map(nodes.map(node => [node.nodeId, node]))
  const oldEdges = new Map(previous.map(edge => [edge.id, edge]))
  const next = nodes.flatMap(node => {
    const sources = new Set(node.slots.flatMap(slot => slot.source?.inputNodeIds ?? []))
    return [...new Set([...sources, ...(node.inputs ?? [])])]
      .filter(id => byId.has(id) && id !== node.nodeId)
      .map(source => {
        const highlighted = selected.has(source) || selected.has(node.nodeId)
        const color = highlighted ? 'var(--vis-accent)' : sources.has(source) ? 'var(--vis-edge)' : 'var(--vis-input-edge)'
        const edge: Edge = {
          id: `${sources.has(source) ? 'source' : 'input'}-${source}-${node.nodeId}`, source, target: node.nodeId,
          ...edgeSides(byId.get(source)!, node),
          selectable: false, deletable: false, focusable: false, zIndex: -1,
          className: 'vis-relation-edge',
          ariaLabel: m.edgeLabel(sources.has(source), highlighted, source, node.nodeId),
          style: { stroke: color, strokeWidth: highlighted ? 2.5 : 1, ...(sources.has(source) ? { strokeDasharray: '6 4' } : {}), ...(selected.size ? { opacity: highlighted ? 1 : 0.2 } : {}) },
          markerEnd: { type: MarkerType.ArrowClosed, color },
        }
        const old = oldEdges.get(edge.id)
        return old && old.sourceHandle === edge.sourceHandle && old.targetHandle === edge.targetHandle && old.ariaLabel === edge.ariaLabel
          && old.style?.stroke === edge.style?.stroke && old.style?.strokeWidth === edge.style?.strokeWidth
          && old.style?.strokeDasharray === edge.style?.strokeDasharray && old.style?.opacity === edge.style?.opacity ? old : edge
      })
  })
  return next.length === previous.length && next.every((edge, index) => edge === previous[index]) ? previous : next
}

/** Choose connection sides from the relative positions of the two nodes, without detours */
function edgeSides(from: NodeView, to: NodeView): { sourceHandle: string; targetHandle: string } {
  const dx = to.x + to.w / 2 - (from.x + from.w / 2)
  const dy = to.y + to.h / 2 - (from.y + from.h / 2)
  const [out, into] = Math.abs(dx) >= Math.abs(dy)
    ? dx >= 0 ? [Position.Right, Position.Left] : [Position.Left, Position.Right]
    : dy >= 0 ? [Position.Bottom, Position.Top] : [Position.Top, Position.Bottom]
  return { sourceHandle: `out-${out}`, targetHandle: `in-${into}` }
}

export function freePosition(at: { x: number; y: number }, size: { w: number; h: number }, nodes: NodeView[], axis: 'x' | 'y') {
  const position = { x: Math.round(at.x), y: Math.round(at.y) }
  for (;;) {
    const collisions = nodes.filter(node => node.kind !== 'frame' && position.x < node.x + node.w + NODE_GAP && node.x < position.x + size.w + NODE_GAP
      && position.y < node.y + node.h + NODE_GAP && node.y < position.y + size.h + NODE_GAP)
    if (!collisions.length) return position
    position[axis] = Math.ceil(Math.max(...collisions.map(node => node[axis] + (axis === 'x' ? node.w : node.h) + NODE_GAP)))
  }
}

export function extensionPosition(node: NodeView, kind: NodeKind, nodes: NodeView[]) {
  const size = nodeSize(kind)
  return freePosition({
    x: kind === 'text' ? node.x - size.w - NODE_GAP : node.x + node.w + NODE_GAP,
    y: node.y + (node.h - size.h) / 2,
  }, size, nodes, 'y')
}

export const FRAME_MIN_SIZE = { w: 320, h: 200 }
export const FRAME_COLORS: Record<FrameColor, string> = {
  gray: 'var(--vis-frame-gray, var(--vis-text-dim))',
  blue: 'var(--vis-frame-blue, var(--vis-text-dim))',
  teal: 'var(--vis-frame-teal, var(--vis-ok))',
  green: 'var(--vis-frame-green, var(--vis-ok))',
  amber: 'var(--vis-frame-amber, var(--vis-warn))',
  orange: 'var(--vis-frame-orange, var(--vis-warn))',
  red: 'var(--vis-frame-red, var(--vis-danger))',
  violet: 'var(--vis-frame-violet, var(--vis-text-dim))',
}

/** Server membership is the sole authority; cycles or duplicate memberships still move each node only once. */
export function frameMembers(frameId: string, nodes: NodeView[]): NodeView[] {
  const ids = new Set([frameId])
  const members: NodeView[] = []
  for (const id of ids) {
    for (const node of nodes) {
      if (node.frameId !== id || ids.has(node.nodeId)) continue
      ids.add(node.nodeId)
      members.push(node)
    }
  }
  return members
}

export function frameMoveBatch(nodes: NodeView[], moves: { nodeId: string; x: number; y: number }[]) {
  const moved = new Map<string, NodeView>()
  for (const op of frameMoveOps(nodes, moves)) {
    const root = nodes.find(node => node.nodeId === op.nodeId)!
    const dx = op.op === 'frame.move' ? op.dx : op.x! - root.x
    const dy = op.op === 'frame.move' ? op.dy : op.y! - root.y
    for (const node of [root, ...(root.kind === 'frame' ? frameMembers(root.nodeId, nodes) : [])]) {
      if (!moved.has(node.nodeId)) moved.set(node.nodeId, { ...node, x: node.x + dx, y: node.y + dy })
    }
  }
  return [...moved.values()].map(({ nodeId, x, y, w, h }) => ({ nodeId, x, y, w, h }))
}

/** Delegate recursive frame moves to the server so member counts do not exhaust the batch operation limit. */
export function frameMoveOps(nodes: NodeView[], moves: { nodeId: string; x: number; y: number }[]): Extract<CanvasOp, { op: 'node.layout' | 'frame.move' }>[] {
  const frames = moves.filter(move => nodes.some(n => n.nodeId === move.nodeId && n.kind === 'frame'))
  const descendants = new Map(frames.map(frame => [frame.nodeId, frameMembers(frame.nodeId, nodes)]))
  const members = new Set<string>()
  const roots = new Set(frames.sort((a, b) => descendants.get(b.nodeId)!.length - descendants.get(a.nodeId)!.length).filter(frame => {
    if (members.has(frame.nodeId)) return false
    for (const member of descendants.get(frame.nodeId)!) members.add(member.nodeId)
    return true
  }).map(frame => frame.nodeId))
  return moves.filter(move => roots.has(move.nodeId) || !members.has(move.nodeId)).flatMap(move => {
    const node = nodes.find(n => n.nodeId === move.nodeId)
    if (!node) return []
    return [node.kind === 'frame'
      ? { op: 'frame.move' as const, nodeId: node.nodeId, dx: Math.round(move.x) - node.x, dy: Math.round(move.y) - node.y }
      : { op: 'node.layout' as const, nodeId: node.nodeId, x: Math.round(move.x), y: Math.round(move.y) }]
  })
}
