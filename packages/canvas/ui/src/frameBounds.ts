import type { CanvasOp, NodeView } from '@vis/protocol'
import { FRAME_MIN_SIZE, frameMembers, frameMoveBatch, frameMoveOps, NODE_GAP } from './graph'

export const FRAME_PADDING = 24
export const FRAME_HEADER = 56

type Move = { nodeId: string; x: number; y: number }

export function constrainedMoves(nodes: NodeView[], moves: Move[], escape = false): Move[] {
  if (escape) return moves
  const moving = new Set(moves.map(move => move.nodeId))
  return moves.map(move => {
    const node = nodes.find(node => node.nodeId === move.nodeId)
    const frame = nodes.find(frame => frame.nodeId === node?.frameId)
    if (!node || !frame || moving.has(frame.nodeId)) return move
    return { ...move,
      x: Math.round(Math.max(frame.x + FRAME_PADDING, Math.min(move.x, frame.x + frame.w - node.w - FRAME_PADDING))),
      y: Math.round(Math.max(frame.y + FRAME_HEADER, Math.min(move.y, frame.y + frame.h - node.h - FRAME_PADDING))),
    }
  })
}

/** Translate recursively before refreshing geometric frame membership; the last step does not move members again. */
export function memberMoveOps(nodes: NodeView[], moves: Move[]): CanvasOp[] {
  const ops: CanvasOp[] = frameMoveOps(nodes, moves)
  for (const op of [...ops]) {
    if (op.op !== 'frame.move') continue
    const node = nodes.find(node => node.nodeId === op.nodeId)!
    ops.push({ op: 'node.layout', nodeId: op.nodeId, x: node.x + op.dx, y: node.y + op.dy })
  }
  return ops
}

/** No persisted manual-size marker exists, so conservatively retain all existing dimensions and only expand outward. */
export function growFrames(nodes: NodeView[]): Extract<CanvasOp, { op: 'node.layout' }>[] {
  const updated = nodes.map(node => ({ ...node }))
  const frames = updated.filter(node => node.kind === 'frame').sort((a, b) => frameMembers(a.nodeId, updated).length - frameMembers(b.nodeId, updated).length)
  const ops: Extract<CanvasOp, { op: 'node.layout' }>[] = []
  for (const frame of frames) {
    const members = updated.filter(node => node.frameId === frame.nodeId)
    const x = Math.min(frame.x, ...members.map(node => node.x - FRAME_PADDING))
    const y = Math.min(frame.y, ...members.map(node => node.y - FRAME_HEADER))
    const w = Math.max(FRAME_MIN_SIZE.w, frame.x + frame.w - x, ...members.map(node => node.x + node.w + FRAME_PADDING - x))
    const h = Math.max(FRAME_MIN_SIZE.h, frame.y + frame.h - y, ...members.map(node => node.y + node.h + FRAME_PADDING - y))
    if (x === frame.x && y === frame.y && w === frame.w && h === frame.h) continue
    Object.assign(frame, { x, y, w, h })
    ops.push({ op: 'node.layout', nodeId: frame.nodeId, x, y, w, h })
  }
  return ops
}

export function leaveFrameOps(node: NodeView, nodes: NodeView[]): CanvasOp[] {
  const frame = nodes.find(frame => frame.nodeId === node.frameId)
  if (!frame) return []
  const descendants = new Set(frameMembers(node.nodeId, nodes).map(node => node.nodeId))
  const others = nodes.filter(other => other.nodeId !== node.nodeId && !descendants.has(other.nodeId))
  // Move to the right of all frames to avoid immediate reassignment caused by overlapping neighboring or ancestor frames.
  const x = Math.max(frame.x + frame.w, ...others.map(other => other.x + other.w)) + NODE_GAP
  return memberMoveOps(nodes, [{ nodeId: node.nodeId, x, y: node.y }])
}

export function movedFrameBounds(nodes: NodeView[], moves: Move[], escape = false) {
  return frameMoveBatch(nodes, constrainedMoves(nodes, moves, escape))
}
