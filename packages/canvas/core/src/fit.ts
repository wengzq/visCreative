import { and, appendEvent, eq, isNull, spaceSchema as s, type SpaceTx } from '@vis/storage'
import { expandFrameToFit, recomputeFrameMemberships } from './frames'
import { NODE_GAP } from './placement'
import type { UndoStep } from './undo'
import { readNodes } from './views'
import { assetVersionKind } from './write'

/** Asset writes and resizing share a transaction and operation; return the old height for user undo. */
export function fitNodeToAsset(tx: SpaceTx, nodeId: string, assetVersionId: string, operationId: string, now: number, inverse: UndoStep[] = []): { h: number } | undefined {
  const node = tx.select().from(s.nodes).where(eq(s.nodes.id, nodeId)).get()!
  if (node.kind !== 'image' && node.kind !== 'video') return
  const { width, height } = assetVersionKind(tx, assetVersionId)
  if (!width || !height) return
  const h = Math.max(80, Math.min(4 * node.w, Math.round(node.w * height / width)))
  if (Math.abs(h - node.h) <= 2) return
  tx.update(s.nodes).set({ h, layoutRevision: node.layoutRevision + 1 }).where(eq(s.nodes.id, nodeId)).run()
  const pushed = h > node.h ? pushColumnDown(tx, node, h, inverse) : []
  if (node.frameId) {
    const rects = [{ x: node.x, y: node.y, w: node.w, h }, ...pushed]
    const x = Math.min(...rects.map(rect => rect.x))
    const y = Math.min(...rects.map(rect => rect.y))
    const bounds = { x, y, w: Math.max(...rects.map(rect => rect.x + rect.w)) - x, h: Math.max(...rects.map(rect => rect.y + rect.h)) - y }
    expandFrameToFit(tx, node.frameId, bounds, operationId, now, inverse)
  }
  for (const id of [node.id, ...pushed.map(rect => rect.id)]) {
    inverse.push(...recomputeFrameMemberships(tx, operationId, now, id, id).map(member => ({ kind: 'frameId' as const, ...member })))
  }
  for (const view of readNodes(tx, [nodeId, ...pushed.map(rect => rect.id)])) {
    appendEvent(tx, { type: 'node.updated', entityType: 'node', entityId: view.nodeId, payload: view, operationId }, now)
  }
  return { h: node.h }
}

type NodeRow = typeof s.nodes.$inferSelect

/**
 * A card that grows to its asset (often a placeholder after Organize) would cover the cards laid out below it. Push the cards
 * it newly reaches down by the same growth, cascading down the column, so spacing is kept. Cards beside it or already
 * overlapping it are the author's arrangement and stay put. Only siblings inside the same frame move, which then grows to hold
 * them; on the open canvas, or when a pushed card would land on a nested frame, the layout is left to the author.
 */
function pushColumnDown(tx: SpaceTx, node: NodeRow, h: number, inverse: UndoStep[]) {
  if (!node.frameId) return []
  const members = tx.select().from(s.nodes).where(and(eq(s.nodes.frameId, node.frameId), isNull(s.nodes.deletedAt))).all()
  const frames = members.filter(other => other.kind === 'frame')
  const siblings = members.filter(other => other.kind !== 'frame' && other.id !== node.id)
  const moved = new Map<string, NodeRow & { dy: number }>()
  const queue = [{ x: node.x, w: node.w, oldBottom: node.y + node.h, newBottom: node.y + h }]
  for (let pusher = queue.shift(); pusher; pusher = queue.shift()) {
    const dy = pusher.newBottom - pusher.oldBottom
    for (const other of siblings) {
      if (moved.has(other.id) || other.x >= pusher.x + pusher.w || pusher.x >= other.x + other.w) continue
      if (other.y < pusher.oldBottom || other.y >= pusher.newBottom + NODE_GAP) continue
      moved.set(other.id, { ...other, dy })
      queue.push({ x: other.x, w: other.w, oldBottom: other.y + other.h, newBottom: other.y + other.h + dy })
    }
  }
  const lands = (other: NodeRow & { dy: number }) => frames.some(frame => other.x < frame.x + frame.w && frame.x < other.x + other.w
    && other.y + other.dy < frame.y + frame.h && frame.y < other.y + other.dy + other.h)
  if ([...moved.values()].some(lands)) return []
  return [...moved.values()].map(other => {
    inverse.push({ kind: 'layout', nodeId: other.id, layout: { x: other.x, y: other.y, w: other.w, h: other.h, z: other.z } })
    tx.update(s.nodes).set({ y: other.y + other.dy, layoutRevision: other.layoutRevision + 1 }).where(eq(s.nodes.id, other.id)).run()
    return { id: other.id, x: other.x, y: other.y + other.dy, w: other.w, h: other.h }
  })
}
