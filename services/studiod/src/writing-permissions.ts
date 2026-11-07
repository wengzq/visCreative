import { VisError } from '@vis/domain'
import type { CanvasOp } from '@vis/protocol'
import { and, eq, spaceSchema as s, type SpaceTx } from '@vis/storage'

/** Child text stays available for review without becoming an author-selected deliverable. */
export function childTextOps(tx: SpaceTx, sessionId: string, ops: readonly CanvasOp[]): CanvasOp[] {
  const child = tx.select({ parentId: s.workItems.parentId }).from(s.sessions)
    .innerJoin(s.workItems, eq(s.workItems.id, s.sessions.workItemId)).where(eq(s.sessions.id, sessionId)).get()
  if (!child?.parentId) return [...ops]
  const createdText = new Set(ops.flatMap(op => op.op === 'node.create' && op.kind === 'text' ? [op.tempId] : []))
  return ops.map(op => {
    if (op.op === 'node.create' && op.kind === 'text') return { ...op, purpose: 'working' }
    if (op.op === 'node.setMeta' && op.purpose === 'artifact') {
      const node = tx.select({ kind: s.nodes.kind }).from(s.nodes).where(eq(s.nodes.id, op.nodeId)).get()
      if (node?.kind === 'text' || createdText.has(op.nodeId)) throw VisError.of('forbidden', 'writing.child_artifact_forbidden', {}, 'Child text is a working document. Send results with work_report; the parent or user can make the text a deliverable')
    }
    return op
  })
}

/** Read the latest revision's operation, not the node creator or the turn's input snapshot. */
export function assertAgentTextWrites(tx: SpaceTx, ops: readonly CanvasOp[]) {
  const protectedSlots = new Set<string>()
  const protectedNodes = new Set<string>()
  const rows = tx.select({ slotId: s.slots.id, nodeId: s.nodes.id, kind: s.nodes.kind, format: s.nodes.format, actor: s.operations.actorKind }).from(s.slots)
    .innerJoin(s.nodes, eq(s.nodes.id, s.slots.nodeId))
    .innerJoin(s.slotRevisions, and(eq(s.slotRevisions.slotId, s.slots.id), eq(s.slotRevisions.revision, s.slots.currentRevision)))
    .innerJoin(s.operations, eq(s.operations.id, s.slotRevisions.operationId)).all()
  for (const row of rows) if (row.kind === 'text' && row.format !== 'code' && row.actor === 'user') {
    protectedSlots.add(row.slotId)
    protectedNodes.add(row.nodeId)
  }
  for (const op of ops) {
    if (op.op === 'node.delete' && protectedNodes.has(op.nodeId)) throw VisError.of('forbidden', 'writing.delete_protected', { nodeId: op.nodeId }, 'The user last edited this text. If they asked to delete it, call text.requestDelete now to show them an approval card. Tell them in plain words to approve the card or delete it themselves; never name this tool')
    if (((op.op === 'slot.setText' || op.op === 'slot.clear') && protectedSlots.has(op.slotId))
      || (op.op === 'node.setMeta' && op.format === 'code' && protectedNodes.has(op.nodeId))) {
      throw VisError.of('forbidden', 'writing.propose_required', {}, 'The writer owns this text; use text.propose for reviewable edits')
    }
  }
}
