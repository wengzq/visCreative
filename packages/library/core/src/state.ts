import { VisError } from '@vis/domain'
import type { LibraryStateView } from '@vis/protocol'
import { appendEvent, eq, spaceSchema as s, sql, type SpaceTx } from '@vis/storage'
import type { LibraryReadContext } from './assets'
import { LABEL_WHITESPACE, libraryFacts, libraryVisibility } from './queries'

export function emitLibraryChanged(tx: SpaceTx, now: number) {
  appendEvent(tx, { type: 'library.changed', entityType: 'library', entityId: 'library', payload: {} }, now)
}

// Agent writes that carry a runId (labels, merge proposals) must belong to the caller's own active run of that kind.
export function requireActiveLibraryRun(tx: SpaceTx, runId: string, kind: 'label' | 'merge', sessionId: string) {
  const run = tx.select().from(s.libraryRuns).where(eq(s.libraryRuns.id, runId)).get()
  if (!run) throw VisError.of('not_found', 'library.run_not_found', { runId }, 'Library run does not exist')
  if (run.kind !== kind || run.revertedAt !== null) throw VisError.of('invalid_transition', 'library.run_not_active', { kind }, `Library run is not an active ${kind} run`)
  if (run.sessionId !== sessionId) throw VisError.of('forbidden', 'library.run_session_mismatch', {}, 'Library run belongs to another session')
  return run
}

export function readLibraryState(tx: SpaceTx, _ctx: LibraryReadContext): LibraryStateView {
  const counts = tx.select({ total: sql<number>`total`, needsViewing: sql<number>`needsViewing` })
    .from(sql`(${libraryFacts(sql`archived_at is null and labeled_by is null`)}
    select count(*) as total, coalesce(sum(case when kind != 'audio' and has_title = 0
      and not exists (
        select 1 from asset_versions av join generation_jobs j on j.id = av.source_job_id
        where av.asset_id = facts.id
          and av.version = (select max(latest.version) from asset_versions latest where latest.asset_id = facts.id)
          and json_type(j.params, '$.prompt') = 'text' and trim(json_extract(j.params, '$.prompt'), ${LABEL_WHITESPACE}) != ''
      ) then 1 else 0 end), 0) as needsViewing
    from facts where ${libraryVisibility('all')})`).get()!
  return {
    sessionId: usableLibrarySession(tx),
    unlabeled: counts,
    pendingProposals: tx.select({ count: sql<number>`count(*)` }).from(s.entityProposals).where(eq(s.entityProposals.status, 'pending')).get()!.count,
  }
}

export function requireLibrarySession(tx: SpaceTx, sessionId: string) {
  const exists = tx.select({ id: s.sessions.id }).from(s.sessions).where(eq(s.sessions.id, sessionId)).get()
  if (!exists) throw VisError.of('not_found', 'library.session_not_found', { sessionId }, 'Library session does not exist in this project')
  return requireAgentWriteSession(tx, sessionId)
}

// Gateway turns and library selection share persistent eligibility; a live turn is checked separately.
export function requireAgentSession(tx: SpaceTx, sessionId: string) {
  const session = tx.select().from(s.sessions).where(eq(s.sessions.id, sessionId)).get()
  if (!session || session.archivedAt !== null) throw VisError.of('forbidden', 'runtime.session_inactive', {}, 'The token session does not exist or is archived')
  if (!session.workItemId) return session
  const deleting = tx.select().from(s.idempotencyKeys).where(eq(s.idempotencyKeys.method, 'work.delete')).all()
    .some(key => {
      const plan = key.result as { finished: boolean; workItemIds: string[] }
      return !plan.finished && plan.workItemIds.includes(session.workItemId!)
    })
  if (deleting) throw VisError.of('forbidden', 'work.deleting', {}, 'Work item is being deleted')
  const work = tx.select().from(s.workItems).where(eq(s.workItems.id, session.workItemId)).get()
  if (work && (work.archivedAt !== null || work.status !== 'in_progress')) throw VisError.of('forbidden', 'work.execution_forbidden', {}, 'Work item cannot continue execution in its current state')
  return session
}

export function requireAgentWriteSession(tx: SpaceTx, sessionId: string) {
  const session = requireAgentSession(tx, sessionId)
  if (!session.workItemId) throw VisError.of('forbidden', 'runtime.work_item_required', {}, 'Session is not linked to a work item')
  return { ...session, workItemId: session.workItemId }
}

export function usableLibrarySession(tx: SpaceTx): string | null {
  const sessionId = tx.select().from(s.libraryState).get()?.sessionId
  if (!sessionId) return null
  try {
    requireAgentWriteSession(tx, sessionId)
    return sessionId
  } catch (error) {
    if (error instanceof VisError && error.code === 'forbidden') return null
    throw error
  }
}

export function setLibrarySession(tx: SpaceTx, sessionId: string | null, ctx: LibraryReadContext, now: number): LibraryStateView {
  if (sessionId !== null) requireLibrarySession(tx, sessionId)
  tx.insert(s.libraryState).values({ id: 1, sessionId }).onConflictDoUpdate({ target: s.libraryState.id, set: { sessionId } }).run()
  emitLibraryChanged(tx, now)
  return readLibraryState(tx, ctx)
}
