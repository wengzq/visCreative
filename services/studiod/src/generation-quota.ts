import { VisError } from '@vis/domain'
import { localDate, type GenerationQuota } from '@vis/generation'
import { DAILY_LIMIT_KEY, type GenerationLimits, type JobStatus, type MediaKind } from '@vis/protocol'
import { and, appSchema, eq, sql, type AppDb } from '@vis/storage'

type PaidJob = {
  jobId: string
  spaceId: string
  kind: MediaKind
  status: JobStatus
  createdAt: number
  quotaDate?: string | null
}

/** All spaces share one app.db ledger; each check and reservation occurs in the same write transaction. */
// shortcut: A crash between database commits conservatively retains daily quota; add commit confirmation and full job reconciliation when exact reclamation is needed.
export function createGlobalGenerationQuota(deps: { db: AppDb; limits: () => GenerationLimits }) {
  const { db } = deps
  const ledger = appSchema.generationQuota

  function usage(now: number) {
    const date = localDate(now)
    const count = (kind: MediaKind, byAgent = false) => db.select({ count: sql<number>`count(*)` }).from(ledger)
      .where(and(eq(ledger.date, date), eq(ledger.kind, kind), byAgent ? eq(ledger.byAgent, true) : undefined)).get()!.count
    return { date, image: count('image'), video: count('video'), audio: count('audio'), agent: { image: count('image', true), video: count('video', true), audio: count('audio', true) } }
  }

  return {
    usage,
    forSpace(spaceId: string): GenerationQuota {
      const owned = (jobId: string) => and(eq(ledger.jobId, jobId), eq(ledger.spaceId, spaceId))
      return {
        usage,
        reserve({ jobId, kind, now, byAgent }) {
          db.transaction(tx => {
            const existing = tx.select().from(ledger).where(eq(ledger.jobId, jobId)).get()
            if (existing) {
              if (existing.spaceId !== spaceId || existing.kind !== kind || existing.byAgent !== byAgent) throw VisError.of('idempotency_conflict', 'generation.quota_conflict', { jobId }, `Generation job ${jobId} already holds another quota reservation`)
              return
            }
            const date = localDate(now)
            const count = tx.select({ count: sql<number>`count(*)` }).from(ledger)
              .where(and(eq(ledger.date, date), eq(ledger.kind, kind), eq(ledger.byAgent, true))).get()!.count
            const limits = deps.limits()
            const limit = limits[DAILY_LIMIT_KEY[kind]]
            if (byAgent && limit > 0 && count >= limit) {
              throw VisError.of('quota_exceeded', 'generation.daily_limit', { kind, count, limit }, `Daily paid ${{ image: 'image', video: 'video', audio: 'audio' }[kind]} job limit ${limit} reached`, undefined, { kind, count, limit })
            }
            tx.insert(ledger).values({ jobId, spaceId, kind, byAgent, date, state: 'queued', createdAt: now }).run()
          }, { behavior: 'immediate' })
        },
        rollback(jobId) {
          db.delete(ledger).where(and(owned(jobId), eq(ledger.state, 'queued'))).run()
        },
        tryStart(jobId) {
          return db.transaction(tx => {
            const row = tx.select().from(ledger).where(owned(jobId)).get()
            if (!row || row.state === 'released') return false
            if (row.state === 'active') return true
            const occupied = tx.select({ count: sql<number>`count(*)` }).from(ledger).where(eq(ledger.state, 'active')).get()!.count
            const limit = deps.limits().maxConcurrent
            if (limit > 0 && occupied >= limit) return false
            tx.update(ledger).set({ state: 'active' }).where(owned(jobId)).run()
            return true
          }, { behavior: 'immediate' })
        },
        release(jobId) {
          db.update(ledger).set({ state: 'released' }).where(owned(jobId)).run()
        },
      }
    },
    /** Call after scanning all projects and before starting any job; conservatively retain daily counts left by cross-database crashes. */
    reconcile(jobs: PaidJob[]) {
      db.transaction(tx => {
        tx.update(ledger).set({ state: 'released' }).run()
        for (const job of jobs) {
          const state = job.status === 'queued' ? 'queued' : ['running', 'finalizing'].includes(job.status) ? 'active' : 'released'
          tx.insert(ledger).values({
            jobId: job.jobId, spaceId: job.spaceId, kind: job.kind,
            date: job.quotaDate ?? localDate(job.createdAt), state, createdAt: job.createdAt,
          }).onConflictDoUpdate({ target: ledger.jobId, set: { state } }).run()
        }
      }, { behavior: 'immediate' })
    },
  }
}
