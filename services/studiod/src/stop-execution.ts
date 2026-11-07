import type { GenerationService } from '@vis/generation'
import { and, eq, inArray, spaceSchema as s, type SpaceDb } from '@vis/storage'
import type { SessionService } from '@vis/workbench-core'

export const ACTIVE_TURNS = ['running', 'waiting_user'] as const
export const TERMINAL_JOBS = ['succeeded', 'failed', 'cancelled', 'unknown'] as const

// Commit all cancellation intents before waiting for slow stops/provider responses, preventing queued jobs from making paid submissions while waiting.
export async function stopExecution(db: SpaceDb, sessions: Pick<SessionService, 'stop'>, generation: Pick<GenerationService, 'cancel'>, requestId: string, plan: {
  stops: { sessionId: string; turnId: string }[]
  cancelledJobs: { jobId: string; providerCancelled: boolean }[]
}) {
  const cancellations = plan.cancelledJobs.map(async cancelled => {
    const job = db.select().from(s.generationJobs).where(eq(s.generationJobs.id, cancelled.jobId)).get()
    if (!job) return
    if (!(TERMINAL_JOBS as readonly string[]).includes(job.status)) {
      const result = await generation.cancel({ sessionId: null, turnId: null, inputSnapshotId: null }, { requestId: `${requestId}:${job.id}`, jobId: job.id })
      cancelled.providerCancelled = result.providerCancelled ?? false
    } else cancelled.providerCancelled = job.providerCancelled ?? false
  })
  const stops = plan.stops.map(async stop => {
    const active = db.select().from(s.turns).where(and(eq(s.turns.id, stop.turnId), inArray(s.turns.status, [...ACTIVE_TURNS]))).get()
    if (active) await sessions.stop({ requestId: `${requestId}:${stop.turnId}`, ...stop })
  })
  const outcomes = await Promise.allSettled([...stops, ...cancellations])
  const failure = outcomes.find(outcome => outcome.status === 'rejected')
  if (failure?.status === 'rejected') throw failure.reason
}
