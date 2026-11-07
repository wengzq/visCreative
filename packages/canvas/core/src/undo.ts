import { VisError } from '@vis/domain'
import type { FrameView, MethodResult, NodeGeneration } from '@vis/protocol'
import { and, appendEvent, asc, desc, eq, spaceSchema as s, type SpaceTx } from '@vis/storage'
import { readNodes } from './views'
import { detachFrame, recomputeFrameMemberships, writeFrameMembership, writeFramePositions, type FramePosition } from './frames'
import { insertOperation, writeSlotRevision, type SlotContentWrite } from './write'
import { restoreScriptCast } from './script-entities'

type Layout = Pick<typeof s.nodes.$inferSelect, 'x' | 'y' | 'w' | 'h' | 'z'>
type MembershipState = Pick<typeof s.nodes.$inferSelect, 'frameId' | 'x' | 'y' | 'w' | 'h'>
export type UndoStep =
  | { kind: 'presence'; nodeId: string; deleted: boolean }
  | { kind: 'layout'; nodeId: string; layout: Layout }
  | { kind: 'inputs'; nodeId: string; inputs: string[] }
  | { kind: 'meta'; nodeId: string; meta: Partial<Pick<typeof s.nodes.$inferSelect, 'title' | 'category' | 'purpose' | 'format' | 'shot'>> }
  | { kind: 'generation'; nodeId: string; generation: NodeGeneration | null }
  | { kind: 'frame'; nodeId: string; frame: Partial<Pick<FrameView, 'title' | 'color'>> }
  | { kind: 'frameId'; nodeId: string; frameId: string | null }
  | { kind: 'frameMove'; nodeId: string; positions: FramePosition[] }
  | { kind: 'slot'; nodeId: string; slotId: string; revision: number; content: SlotContentWrite }
type History = { steps: UndoStep[]; nodes: Record<string, boolean>; slots: Record<string, number>; memberships?: Record<string, MembershipState> }

export function previousSlot(tx: SpaceTx, slotId: string): Extract<UndoStep, { kind: 'slot' }> {
  const slot = tx.select().from(s.slots).where(eq(s.slots.id, slotId)).get()!
  const row = tx.select().from(s.slotRevisions).where(and(eq(s.slotRevisions.slotId, slotId), eq(s.slotRevisions.revision, slot.currentRevision))).get()
  return { kind: 'slot', nodeId: slot.nodeId, slotId, revision: slot.currentRevision,
    content: row?.scriptDoc ? { script: row.scriptDoc } : row?.timelineDoc ? { timeline: row.timelineDoc } : row?.previzDoc ? { previz: row.previzDoc } : row?.sceneDoc ? { scene: row.sceneDoc } : row?.assetVersionId ? { assetVersionId: row.assetVersionId } : row?.textBody != null ? { text: row.textBody } : { clear: true } }
}

export function previousInputs(tx: SpaceTx, nodeId: string): string[] {
  return tx.select().from(s.nodeInputs).where(eq(s.nodeInputs.nodeId, nodeId)).orderBy(s.nodeInputs.ordinal).all().map(r => r.inputNodeId)
}

function historyOf(tx: SpaceTx, steps: UndoStep[]): History {
  const nodes: History['nodes'] = {}
  const slots: History['slots'] = {}
  const memberships: Record<string, MembershipState> = {}
  for (const step of steps) {
    nodes[step.nodeId] = tx.select().from(s.nodes).where(eq(s.nodes.id, step.nodeId)).get()!.deletedAt !== null
    if (step.kind === 'slot') slots[step.slotId] = previousSlot(tx, step.slotId).revision
    if (step.kind === 'frameId' || step.kind === 'frameMove') {
      for (const nodeId of step.kind === 'frameMove' ? step.positions.map(position => position.nodeId) : [step.nodeId]) {
        const { frameId, x, y, w, h, deletedAt } = tx.select().from(s.nodes).where(eq(s.nodes.id, nodeId)).get()!
        memberships[nodeId] = { frameId, x, y, w, h }
        nodes[nodeId] = deletedAt !== null
      }
    }
    if (step.kind === 'presence') {
      for (const slot of tx.select().from(s.slots).where(eq(s.slots.nodeId, step.nodeId)).all()) slots[slot.id] = slot.currentRevision
    }
  }
  return { steps, nodes, slots, memberships }
}

export function recordUndo(tx: SpaceTx, operationId: string, steps: UndoStep[], now: number): void {
  tx.delete(s.undoEntries).where(eq(s.undoEntries.state, 'undone')).run()
  tx.insert(s.undoEntries).values({ id: operationId, operationId, state: 'done', inverse: historyOf(tx, steps.reverse()), createdAt: now }).run()
}

export function changeHistory(tx: SpaceTx, direction: 'undo' | 'redo', operationId: string, now: number): MethodResult<'canvas.undo'> {
  const entry = tx.select().from(s.undoEntries).where(eq(s.undoEntries.state, direction === 'undo' ? 'done' : 'undone'))
    .orderBy(direction === 'undo' ? desc(s.undoEntries.seq) : asc(s.undoEntries.seq)).get()
  if (!entry) return { nothing: true }
  const history = entry.inverse as History
  const conflict = () => { throw VisError.of('revision_conflict', 'canvas.history_conflict', {}, 'Content has been changed by someone else; cannot undo or redo') }
  for (const [nodeId, deleted] of Object.entries(history.nodes)) {
    const node = tx.select().from(s.nodes).where(eq(s.nodes.id, nodeId)).get()
    if (!node || (node.deletedAt !== null) !== deleted) conflict()
  }
  for (const [slotId, revision] of Object.entries(history.slots)) {
    if (previousSlot(tx, slotId).revision !== revision) conflict()
  }
  for (const [nodeId, expected] of Object.entries(history.memberships ?? {})) {
    const node = tx.select().from(s.nodes).where(eq(s.nodes.id, nodeId)).get()!
    if (node.frameId !== expected.frameId || node.x !== expected.x || node.y !== expected.y || node.w !== expected.w || node.h !== expected.h) conflict()
  }
  const original = tx.select().from(s.operations).where(eq(s.operations.id, entry.operationId)).get()!
  const description = `${direction === 'undo' ? '撤销' : '重做'}：${original.description ?? '画布操作'}`
  insertOperation(tx, { id: operationId, actor: { kind: 'user' }, description }, now)
  const opposite: UndoStep[] = []
  const restored: { slotId: string; from: number; to: number }[] = []
  for (const step of history.steps) {
    const node = tx.select().from(s.nodes).where(eq(s.nodes.id, step.nodeId)).get()!
    switch (step.kind) {
      case 'presence': {
        opposite.push({ kind: 'presence', nodeId: node.id, deleted: node.deletedAt !== null })
        if (step.deleted && node.kind === 'frame') {
          const detached = detachFrame(tx, node.id, operationId, now)
          opposite.push(...detached.map(member => ({ kind: 'frameId' as const, ...member })))
        }
        tx.update(s.nodes).set({ deletedAt: step.deleted ? now : null }).where(eq(s.nodes.id, node.id)).run()
        tx.update(s.slots).set({ deletedAt: step.deleted ? now : null }).where(eq(s.slots.nodeId, node.id)).run()
        appendEvent(tx, { type: step.deleted ? 'node.deleted' : 'node.created', entityType: 'node', entityId: node.id,
          payload: step.deleted ? { nodeId: node.id } : readNodes(tx, [node.id])[0], operationId }, now)
        if (!step.deleted) {
          const dependentIds = tx.select({ id: s.nodeInputs.nodeId }).from(s.nodeInputs).where(eq(s.nodeInputs.inputNodeId, node.id)).all().map(row => row.id)
          for (const dependent of readNodes(tx, dependentIds)) {
            appendEvent(tx, { type: 'node.updated', entityType: 'node', entityId: dependent.nodeId, payload: dependent, operationId }, now)
          }
        }
        break
      }
      case 'frameId': {
        opposite.push({ kind: 'frameId', nodeId: node.id, frameId: node.frameId })
        writeFrameMembership(tx, step, operationId, now)
        break
      }
      case 'frameMove': {
        opposite.push({ kind: 'frameMove', nodeId: step.nodeId, positions: writeFramePositions(tx, step.positions, operationId, now) })
        break
      }
      case 'slot': {
        const previous = previousSlot(tx, step.slotId)
        opposite.push(previous)
        const content = 'script' in step.content ? { script: restoreScriptCast(tx, step.content.script, step.slotId, now) } : step.content
        const revision = writeSlotRevision(tx, step.slotId, previous.revision, content, operationId, now)
        restored.push({ slotId: step.slotId, from: step.revision, to: revision })
        break
      }
      case 'layout':
      case 'inputs':
      case 'meta':
      case 'generation':
      case 'frame': {
        if (step.kind === 'layout') {
          const { x, y, w, h, z } = node
          opposite.push({ kind: 'layout', nodeId: node.id, layout: { x, y, w, h, z } })
          tx.update(s.nodes).set(step.layout).where(eq(s.nodes.id, node.id)).run()
          recomputeFrameMemberships(tx, operationId, now, node.kind === 'frame' ? undefined : node.id, node.id)
        } else if (step.kind === 'meta') {
          opposite.push({ kind: 'meta', nodeId: node.id, meta: Object.fromEntries(Object.keys(step.meta).map(key => [key, node[key as keyof typeof step.meta]])) })
          tx.update(s.nodes).set(step.meta).where(eq(s.nodes.id, node.id)).run()
        } else if (step.kind === 'inputs') {
          opposite.push({ kind: 'inputs', nodeId: node.id, inputs: previousInputs(tx, node.id) })
          // Preserve original references, including deleted inputs; views still show only active inputs.
          tx.delete(s.nodeInputs).where(eq(s.nodeInputs.nodeId, node.id)).run()
          if (step.inputs.length) tx.insert(s.nodeInputs).values(step.inputs.map((inputNodeId, ordinal) => ({ nodeId: node.id, inputNodeId, ordinal }))).run()
        } else if (step.kind === 'frame') {
          if (!node.frame) conflict()
          opposite.push({ kind: 'frame', nodeId: node.id, frame: { ...(step.frame.title !== undefined ? { title: node.frame!.title } : {}), ...(step.frame.color !== undefined ? { color: node.frame!.color } : {}) } })
          tx.update(s.nodes).set({ frame: { ...node.frame!, ...step.frame } }).where(eq(s.nodes.id, node.id)).run()
        } else {
          opposite.push({ kind: 'generation', nodeId: node.id, generation: node.generation })
          tx.update(s.nodes).set({ generation: step.generation }).where(eq(s.nodes.id, node.id)).run()
        }
        tx.update(s.nodes).set({ layoutRevision: node.layoutRevision + 1 }).where(eq(s.nodes.id, node.id)).run()
        appendEvent(tx, { type: 'node.updated', entityType: 'node', entityId: node.id, payload: readNodes(tx, [node.id])[0], operationId }, now)
      }
    }
  }
  // Our inverse writes create new revisions: migrate only conditions pointing to the same historical content, without relaxing external-write checks.
  for (const other of tx.select().from(s.undoEntries).all()) {
    if (other.id === entry.id) continue
    const inverse = other.inverse as History
    let changed = false
    for (const change of restored) {
      if (inverse.slots[change.slotId] === change.from) {
        inverse.slots[change.slotId] = change.to
        changed = true
      }
      for (const step of inverse.steps) {
        if (step.kind === 'slot' && step.slotId === change.slotId && step.revision === change.from) {
          step.revision = change.to
          changed = true
        }
      }
    }
    if (changed) tx.update(s.undoEntries).set({ inverse }).where(eq(s.undoEntries.id, other.id)).run()
  }
  tx.update(s.undoEntries).set({ state: direction === 'undo' ? 'undone' : 'done', inverse: historyOf(tx, opposite.reverse()) }).where(eq(s.undoEntries.id, entry.id)).run()
  return { operationId, description }
}
