import { newId, VisError } from '@vis/domain'
import { ApprovalPayload, type MethodParams } from '@vis/protocol'
import { and, appendEvent, eq, runIdempotent, spaceSchema as s, type SpaceDb, type SpaceTx } from '@vis/storage'
import { appendNotice, readSessionSummary, upsertItem } from '@vis/workbench-core'
import type { WorkService, WorkServiceActor } from './work-service'

const TTL_MS = 10 * 60_000
type Target = NonNullable<ApprovalPayload['workDelete']>
const approvals = (tx: SpaceTx) => tx.select().from(s.transcriptEntries).where(eq(s.transcriptEntries.kind, 'approval')).all()
const deleteId = (approvalId: string, workItemId: string) => `${approvalId}:delete:${workItemId}`

function update(tx: SpaceTx, row: typeof s.transcriptEntries.$inferSelect, payload: ApprovalPayload, at: number) {
  upsertItem(tx, { sessionId: row.sessionId, turnId: row.turnId, itemId: row.itemId, revision: row.revision + 1, kind: 'approval', payload }, at)
  appendEvent(tx, { type: 'session.updated', entityType: 'session', entityId: row.sessionId, payload: readSessionSummary(tx, row.sessionId) }, at)
}

export function createWorkDeletionService(db: SpaceDb, work: WorkService, now = Date.now) {
  let timer: ReturnType<typeof setTimeout> | undefined

  function requester(tx: SpaceTx, sessionId: string) {
    const session = tx.select().from(s.sessions).where(eq(s.sessions.id, sessionId)).get()
    const item = session?.workItemId ? tx.select().from(s.workItems).where(eq(s.workItems.id, session.workItemId)).get() : undefined
    return session?.archivedAt === null && item?.archivedAt === null && item.parentId === null && item.status !== 'done' ? item : undefined
  }

  function targets(tx: SpaceTx, ids: string[], parentId: string) {
    return ids.map(id => {
      const item = tx.select().from(s.workItems).where(eq(s.workItems.id, id)).get()
      if (!item || item.archivedAt !== null || item.parentId !== parentId || work.isDeleting(id)) throw VisError.of('forbidden', 'work.delete_not_child', {}, 'Every deletion target must be a live direct child of the requesting root workspace')
      return { workItemId: id, title: item.title }
    })
  }

  function totals(items: Target['items']) {
    const total = { runningTurns: 0, unfinishedJobs: 0, childrenTotal: 0, unresolvedMessages: 0, hasUnreviewedReport: false }
    for (const item of items) {
      const plan = work.deletePlan({ workItemId: item.workItemId })
      for (const field of ['runningTurns', 'unfinishedJobs', 'childrenTotal', 'unresolvedMessages'] as const) total[field] += plan[field]
      total.hasUnreviewedReport ||= plan.hasUnreviewedReport
    }
    return total
  }

  function valid(tx: SpaceTx, sessionId: string, target?: Target, bindPlan = true) {
    const parent = requester(tx, sessionId)
    if (!parent || !target || target.expiresAt <= now()) return false
    try {
      const items = targets(tx, target.items.map(item => item.workItemId), parent.id)
      if (!bindPlan) return true
      const current = totals(items)
      return (!current.hasUnreviewedReport || target.hasUnreviewedReport) && (['runningTurns', 'unfinishedJobs', 'childrenTotal', 'unresolvedMessages'] as const).every(field => current[field] <= target[field])
    } catch (error) {
      if (error instanceof VisError && ['work.delete_not_child', 'work.not_found'].includes(String(error.details?.reason))) return false
      throw error
    }
  }

  function expire() {
    db.transaction(tx => {
      for (const row of approvals(tx)) {
        const parsed = ApprovalPayload.safeParse(row.payload)
        if (parsed.success && parsed.data.kind === 'work_delete' && parsed.data.status === 'pending' && !valid(tx, row.sessionId, parsed.data.workDelete, false)) update(tx, row, { ...parsed.data, status: 'expired' }, now())
      }
    }, { behavior: 'immediate' })
  }

  function schedule() {
    clearTimeout(timer)
    const deadlines = approvals(db).flatMap(row => {
      const parsed = ApprovalPayload.safeParse(row.payload)
      return parsed.success && parsed.data.kind === 'work_delete' && parsed.data.status === 'pending' && parsed.data.workDelete ? [parsed.data.workDelete.expiresAt] : []
    })
    if (!deadlines.length) return
    timer = setTimeout(() => { expire(); schedule() }, Math.max(1, Math.min(...deadlines) - now()))
    timer.unref()
  }

  function failure(row: typeof s.transcriptEntries.$inferSelect, item: Target['items'][number]) {
    runIdempotent(db, { requestId: `${deleteId(row.itemId, item.workItemId)}:failure`, method: 'work.delete.failure', params: item }, tx => {
      appendNotice(tx, row.sessionId, row.turnId, 'work_delete_failed', `Could not delete “${item.title}”; other approved targets are unaffected`, now(), { reason: 'work.delete_failed', params: { title: item.title } })
      return { failed: true }
    }, now)
  }

  // The prepared work.delete plans and approved status commit together. Recovery uses those same
  // durable IDs; it never rebuilds a larger plan after the author's click or repeats a completed delete.
  async function execute(row: typeof s.transcriptEntries.$inferSelect) {
    const payload = ApprovalPayload.parse(row.payload)
    await Promise.all(payload.workDelete!.items.map(async item => {
      const requestId = deleteId(row.itemId, item.workItemId)
      const prepared = db.select().from(s.idempotencyKeys).where(eq(s.idempotencyKeys.requestId, requestId)).get()
      if (!prepared && db.select().from(s.idempotencyKeys).where(eq(s.idempotencyKeys.requestId, `${requestId}:failure`)).get()) return
      try {
        const result = await work.delete({ requestId, workItemId: item.workItemId })
        if (result.cancelledJobs.length) runIdempotent(db, { requestId: `${requestId}:notice`, method: 'work.delete.notice', params: item }, tx => {
          const params = { title: item.title, jobs: result.cancelledJobs.length, confirmed: result.cancelledJobs.filter(job => job.providerCancelled).length }
          appendNotice(tx, row.sessionId, row.turnId, 'work_delete_cancelled_jobs', `Deleted “${item.title}”: ${params.jobs} jobs cancelled, provider cancellation confirmed for ${params.confirmed}; cancellation is not a refund`, now(), { reason: 'work.delete_cancelled_jobs', params })
          return { notified: true }
        }, now)
      } catch { failure(row, item) }
    }))
  }

  schedule()
  return {
    request(params: MethodParams<'work.requestDelete'>, actor: WorkServiceActor, turnId: string) {
      const result = runIdempotent(db, { requestId: params.requestId, method: 'work.requestDelete', params: { ...params, sessionId: actor.sessionId } }, tx => {
        const parent = requester(tx, actor.sessionId)
        if (!parent || parent.id !== actor.workItemId) throw VisError.of('forbidden', 'work.delete_root_required', {}, 'Only a linked, unarchived root workspace session can request child deletion')
        const items = targets(tx, params.workItemIds, parent.id)
        const at = now(), approvalId = newId('transcriptItem', at)
        const payload: ApprovalPayload = { approvalId, kind: 'work_delete', summary: items.map(item => item.title).join(', '), detail: '', status: 'pending', workDelete: { items, ...totals(items), expiresAt: at + TTL_MS } }
        upsertItem(tx, { sessionId: actor.sessionId, turnId, itemId: approvalId, revision: 1, kind: 'approval', payload }, at)
        appendEvent(tx, { type: 'session.updated', entityType: 'session', entityId: actor.sessionId, payload: readSessionSummary(tx, actor.sessionId) }, at)
        return { approvalId, status: 'pending' as const }
      }, now)
      schedule()
      return result
    },
    respond(params: MethodParams<'session.respondApproval'>) {
      const row = db.select().from(s.transcriptEntries).where(and(eq(s.transcriptEntries.itemId, params.approvalId), eq(s.transcriptEntries.kind, 'approval'))).get()
      const parsed = ApprovalPayload.safeParse(row?.payload)
      if (!row || !parsed.success || parsed.data.kind !== 'work_delete') return undefined
      const result = runIdempotent(db, { requestId: params.requestId, method: 'session.respondApproval', params }, tx => {
        const fresh = tx.select().from(s.transcriptEntries).where(and(eq(s.transcriptEntries.sessionId, row.sessionId), eq(s.transcriptEntries.itemId, row.itemId))).get()!
        const payload = ApprovalPayload.parse(fresh.payload)
        if (params.decision === 'allow_session') throw VisError.of('invalid_params', 'work.delete_once_only', {}, 'Work item deletion can only be authorized once for these targets')
        if (payload.status !== 'pending') return { status: payload.status }
        const status = !valid(tx, row.sessionId, payload.workDelete) ? 'expired' as const : params.decision === 'deny' ? 'denied' as const : 'approved' as const
        update(tx, fresh, { ...payload, status, ...(status === 'expired' ? {} : { decision: params.decision }) }, now())
        if (status === 'approved') for (const item of payload.workDelete!.items) {
          try { work.prepareDelete({ requestId: deleteId(row.itemId, item.workItemId), workItemId: item.workItemId }) }
          catch { failure(row, item) }
        }
        return { status }
      }, now)
      schedule()
      return (async () => {
        if (result.status === 'approved') await execute(row)
        return result
      })()
    },
    async recover() {
      for (const row of approvals(db)) {
        const parsed = ApprovalPayload.safeParse(row.payload)
        if (parsed.success && parsed.data.kind === 'work_delete' && parsed.data.status === 'approved') await execute(row)
      }
      expire()
      schedule()
    },
    expire,
    close() { clearTimeout(timer) },
  }
}
