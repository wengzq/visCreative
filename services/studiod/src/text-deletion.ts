import { textDeletionApprovals as approvals, currentTextDeletion as current, updateTextDeletion as update, refreshReviews, refreshTextDeletionApprovals } from './reviews'
export { refreshTextDeletionApprovals } from './reviews'
import { applyOps } from '@vis/canvas-core'
import { newId, VisError } from '@vis/domain'
import { ApprovalPayload, type ApprovalDecision, type MethodParams } from '@vis/protocol'
import { and, appendEvent, eq, isNull, runIdempotent, spaceSchema as s, type SpaceDb } from '@vis/storage'
import { readSessionSummary, upsertItem } from '@vis/workbench-core'

const TTL_MS = 10 * 60_000
export function createTextDeletionService(db: SpaceDb, now = Date.now) {
  let timer: ReturnType<typeof setTimeout> | undefined
  function schedule() {
    clearTimeout(timer)
    const deadlines = approvals(db).flatMap(row => {
      const payload = ApprovalPayload.safeParse(row.payload)
      return payload.success && payload.data.kind === 'text_delete' && payload.data.status === 'pending' && payload.data.textDelete ? [payload.data.textDelete.expiresAt] : []
    })
    if (!deadlines.length) return
    timer = setTimeout(() => { expire(); schedule() }, Math.max(1, Math.min(...deadlines) - now()))
    timer.unref()
  }
  function expire() { db.transaction(tx => refreshTextDeletionApprovals(tx, now()), { behavior: 'immediate' }) }
  return {
    request(params: MethodParams<'text.requestDelete'>, sessionId: string, turnId: string) {
      const result = runIdempotent(db, { requestId: params.requestId, method: 'text.requestDelete', params: { ...params, sessionId } }, tx => {
        const node = tx.select().from(s.nodes).where(and(eq(s.nodes.id, params.nodeId), isNull(s.nodes.deletedAt))).get()
        const slot = tx.select().from(s.slots).where(and(eq(s.slots.nodeId, params.nodeId), eq(s.slots.slotKey, 'main'), isNull(s.slots.deletedAt))).get()
        if (!node || node.kind !== 'text' || node.format === 'code' || !slot) throw VisError.of('invalid_params', 'writing.manuscript_required', {}, 'A live non-code manuscript is required')
        if (slot.currentRevision !== params.expectedRevision) throw VisError.of('revision_conflict', 'canvas.revision_conflict', {}, 'The manuscript revision changed; reread before requesting deletion')
        const at = now()
        const approvalId = newId('transcriptItem', at)
        const payload: ApprovalPayload = { approvalId, kind: 'text_delete', summary: node.title ?? node.id, detail: '', status: 'pending',
          textDelete: { nodeId: node.id, slotId: slot.id, revision: slot.currentRevision, title: node.title ?? node.id, expiresAt: at + TTL_MS } }
        upsertItem(tx, { sessionId, turnId, itemId: approvalId, revision: 1, kind: 'approval', payload }, at)
        appendEvent(tx, { type: 'session.updated', entityType: 'session', entityId: sessionId, payload: readSessionSummary(tx, sessionId) }, at)
        return { approvalId, status: 'pending' as const }
      }, now)
      schedule()
      return result
    },
    respond(params: MethodParams<'session.respondApproval'>) {
      const row = db.select().from(s.transcriptEntries).where(and(eq(s.transcriptEntries.itemId, params.approvalId), eq(s.transcriptEntries.kind, 'approval'))).get()
      const parsed = ApprovalPayload.safeParse(row?.payload)
      if (!row || !parsed.success || parsed.data.kind !== 'text_delete') return undefined
      return runIdempotent(db, { requestId: params.requestId, method: 'session.respondApproval', params }, tx => {
        const fresh = tx.select().from(s.transcriptEntries).where(and(eq(s.transcriptEntries.sessionId, row.sessionId), eq(s.transcriptEntries.itemId, row.itemId))).get()!
        const payload = ApprovalPayload.parse(fresh.payload)
        if (payload.status !== 'pending') return { status: payload.status }
        if (params.decision === 'allow_session') throw VisError.of('invalid_params', 'writing.delete_once_only', {}, 'Manuscript deletion can only be authorized once for this node and revision')
        const target = payload.textDelete
        const status = !target || target.expiresAt <= now() || !current(tx, target) ? 'expired' as const : params.decision === 'deny' ? 'denied' as const : 'approved' as const
        update(tx, fresh, { ...payload, status, ...(status === 'expired' ? {} : { decision: params.decision as ApprovalDecision }) }, now())
        if (status === 'approved') {
          applyOps(tx, { kind: 'user' }, { requestId: params.requestId, ops: [{ op: 'node.delete', nodeId: target!.nodeId }] }, now())
          refreshReviews(tx, now())
        }
        return { status }
      }, now)
    },
    expire,
    close() { clearTimeout(timer) },
  }
}
