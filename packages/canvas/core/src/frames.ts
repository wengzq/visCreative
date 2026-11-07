import { newId, VisError } from '@vis/domain'
import type { FrameColor } from '@vis/protocol'
import { and, appendEvent, eq, inArray, isNull, min, spaceSchema as s, type SpaceTx } from '@vis/storage'
import { NODE_GAP, type Rect } from './placement'
import type { UndoStep } from './undo'
import { readNodes } from './views'

export type FrameMembership = { nodeId: string, frameId: string | null }
export type FramePosition = { nodeId: string, x: number, y: number }
type FrameNode = Rect & { id: string, kind: string }

/** Include the frame itself and all active descendants for whole-frame moves. */
export function frameMemberIds(tx: SpaceTx, frameNodeId: string): string[] {
  const nodes = tx.select({ id: s.nodes.id, kind: s.nodes.kind, frameId: s.nodes.frameId }).from(s.nodes).where(isNull(s.nodes.deletedAt)).all()
  const frame = nodes.find(node => node.id === frameNodeId)
  if (!frame) throw VisError.of('not_found', 'canvas.node_not_found', { nodeId: frameNodeId }, `Node ${frameNodeId} does not exist or has been deleted`)
  if (frame.kind !== 'frame') throw VisError.of('invalid_params', 'canvas.not_frame', {}, 'The target node is not a frame')
  const children = new Map<string, string[]>()
  for (const node of nodes) {
    if (node.frameId === null) continue
    const ids = children.get(node.frameId) ?? []
    ids.push(node.id)
    children.set(node.frameId, ids)
  }
  const ids = new Set([frameNodeId])
  for (const id of ids) {
    for (const child of children.get(id) ?? []) ids.add(child)
  }
  return [...ids]
}

/** Whole-frame translation does not reassign membership, so intermediate layouts cannot eject unmoved members. */
export function writeFramePositions(tx: SpaceTx, positions: FramePosition[], operationId: string, now: number): FramePosition[] {
  const nodes = tx.select().from(s.nodes).where(and(inArray(s.nodes.id, positions.map(position => position.nodeId)), isNull(s.nodes.deletedAt))).all()
  const byId = new Map(nodes.map(node => [node.id, node]))
  const previous = positions.map(position => {
    const node = byId.get(position.nodeId)
    if (!node) throw VisError.of('revision_conflict', 'canvas.frame_member_deleted', {}, 'A node in the frame has been deleted; cannot move')
    return { nodeId: node.id, x: node.x, y: node.y }
  })
  for (const position of positions) {
    tx.update(s.nodes).set({ x: position.x, y: position.y, layoutRevision: byId.get(position.nodeId)!.layoutRevision + 1 }).where(eq(s.nodes.id, position.nodeId)).run()
  }
  for (const view of readNodes(tx, positions.map(position => position.nodeId))) {
    appendEvent(tx, { type: 'node.updated', entityType: 'node', entityId: view.nodeId, payload: view, operationId }, now)
  }
  return previous
}

/** Choose the smallest containing frame by center point; frames can only belong to larger frames to avoid cycles in recursive moves. */
function innermostFrameId(node: FrameNode, frames: FrameNode[]): string | null {
  const x = node.x + node.w / 2
  const y = node.y + node.h / 2
  return frames.filter(frame => frame.id !== node.id
    && (node.kind !== 'frame' || frame.w * frame.h > node.w * node.h)
    && x >= frame.x && x <= frame.x + frame.w && y >= frame.y && y <= frame.y + frame.h)
    .sort((a, b) => a.w * a.h - b.w * b.h || a.id.localeCompare(b.id))[0]?.id ?? null
}

export function frameIdAt(tx: SpaceTx, node: FrameNode): string | null {
  const frames = tx.select().from(s.nodes).where(and(eq(s.nodes.kind, 'frame'), isNull(s.nodes.deletedAt))).all()
  return innermostFrameId(node, frames)
}

export function writeFrameMembership(tx: SpaceTx, membership: FrameMembership, operationId: string, now: number): void {
  tx.update(s.nodes).set({ frameId: membership.frameId }).where(eq(s.nodes.id, membership.nodeId)).run()
  const view = readNodes(tx, [membership.nodeId])[0]
  if (view) appendEvent(tx, { type: 'node.updated', entityType: 'node', entityId: membership.nodeId, payload: view, operationId }, now)
}

/** Moving, resizing, and creating frames affect other nodes, so updating only the operation target is insufficient. */
export function recomputeFrameMemberships(tx: SpaceTx, operationId: string, now: number, onlyNodeId?: string, omitEventFor?: string): FrameMembership[] {
  const previous: FrameMembership[] = []
  const nodes = tx.select().from(s.nodes).where(and(isNull(s.nodes.deletedAt), onlyNodeId ? eq(s.nodes.id, onlyNodeId) : undefined)).all()
  const frames = tx.select().from(s.nodes).where(and(eq(s.nodes.kind, 'frame'), isNull(s.nodes.deletedAt))).all()
  for (const node of nodes) {
    const frameId = innermostFrameId(node, frames)
    if (frameId === node.frameId) continue
    previous.push({ nodeId: node.id, frameId: node.frameId })
    tx.update(s.nodes).set({ frameId }).where(eq(s.nodes.id, node.id)).run()
    if (node.id !== omitEventFor) {
      appendEvent(tx, { type: 'node.updated', entityType: 'node', entityId: node.id, payload: readNodes(tx, [node.id])[0], operationId }, now)
    }
  }
  return previous
}

/** Frames only organize canvas content and have no slots. */
export function createFrameNode(tx: SpaceTx, input: Rect & { title: string, color?: FrameColor | undefined }, operationId: string, now: number): { nodeId: string, memberships: FrameMembership[] } {
  const nodeId = newId('node')
  const bottomZ = tx.select({ z: min(s.nodes.z) }).from(s.nodes).where(isNull(s.nodes.deletedAt)).get()?.z ?? 0
  tx.insert(s.nodes).values({ id: nodeId, kind: 'frame', x: input.x, y: input.y, w: input.w, h: input.h, z: bottomZ - 1,
    frame: { title: input.title, color: input.color ?? 'gray' }, createdAt: now }).run()
  const memberships = recomputeFrameMemberships(tx, operationId, now, undefined, nodeId)
  appendEvent(tx, { type: 'node.created', entityType: 'node', entityId: nodeId, payload: readNodes(tx, [nodeId])[0], operationId }, now)
  return { nodeId, memberships: memberships.filter(member => member.nodeId !== nodeId) }
}

export function detachFrame(tx: SpaceTx, nodeId: string, operationId: string, now: number): FrameMembership[] {
  const memberships = tx.select({ nodeId: s.nodes.id, frameId: s.nodes.frameId }).from(s.nodes)
    .where(and(eq(s.nodes.frameId, nodeId), isNull(s.nodes.deletedAt))).all()
  for (const member of memberships) writeFrameMembership(tx, { nodeId: member.nodeId, frameId: null }, operationId, now)
  return memberships
}

/** Expand existing ancestors before recalculating members; creation and media replacement share this rule. */
export function expandFrameToFit(tx: SpaceTx, frameId: string, bounds: Rect, operationId: string, now: number, inverse: UndoStep[] = []): void {
  const resized: string[] = []
  const liveFrame = (nodeId: string) => {
    const node = tx.select().from(s.nodes).where(and(eq(s.nodes.id, nodeId), isNull(s.nodes.deletedAt))).get()
    if (!node) throw VisError.of('not_found', 'canvas.node_not_found', { nodeId }, `Node ${nodeId} does not exist or has been deleted`)
    return node
  }
  let container = liveFrame(frameId)
  for (;;) {
    const x = Math.min(container.x, bounds.x - NODE_GAP)
    const y = Math.min(container.y, bounds.y - NODE_GAP)
    const w = Math.max(container.x + container.w, bounds.x + bounds.w + NODE_GAP) - x
    const h = Math.max(container.y + container.h, bounds.y + bounds.h + NODE_GAP) - y
    if (x === container.x && y === container.y && w === container.w && h === container.h) break
    inverse.push({ kind: 'layout', nodeId: container.id, layout: { x: container.x, y: container.y, w: container.w, h: container.h, z: container.z } })
    tx.update(s.nodes).set({ x, y, w, h, layoutRevision: container.layoutRevision + 1 }).where(eq(s.nodes.id, container.id)).run()
    resized.push(container.id)
    // Expand existing ancestors before reassessing membership so an enlarged child frame cannot swallow its parent.
    if (!container.frameId) break
    bounds = { x, y, w, h }
    container = liveFrame(container.frameId)
  }
  if (resized.length) {
    inverse.push(...recomputeFrameMemberships(tx, operationId, now).map(member => ({ kind: 'frameId' as const, ...member })))
    for (const view of readNodes(tx, resized)) appendEvent(tx, { type: 'node.updated', entityType: 'node', entityId: view.nodeId, payload: view, operationId }, now)
  }
}
