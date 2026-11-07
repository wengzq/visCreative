import { appendEvent, eq, spaceSchema as s, type SpaceTx } from '@vis/storage'
import { expandFrameToFit, recomputeFrameMemberships } from './frames'
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
  if (node.frameId) expandFrameToFit(tx, node.frameId, { x: node.x, y: node.y, w: node.w, h }, operationId, now, inverse)
  inverse.push(...recomputeFrameMemberships(tx, operationId, now, node.id, node.id).map(member => ({ kind: 'frameId' as const, ...member })))
  appendEvent(tx, { type: 'node.updated', entityType: 'node', entityId: nodeId, payload: readNodes(tx, [nodeId])[0], operationId }, now)
  return { h: node.h }
}
