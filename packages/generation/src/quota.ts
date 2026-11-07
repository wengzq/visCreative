import { VisError } from '@vis/domain'
import { DAILY_LIMIT_KEY, type GenerationLimits, type JobView, type MediaKind } from '@vis/protocol'
import { and, eq, inArray, isNotNull, spaceSchema as s, type SpaceTx } from '@vis/storage'
import type { ProviderAdapter } from './providers/types'

export const DEFAULT_GENERATION_LIMITS: GenerationLimits = { maxConcurrent: 3, dailyImage: 50, dailyVideo: 10, dailyAudio: 20 }

/** Runtime injects the global app.db ledger; without it, standalone spaces use their own persisted job ledgers. */
export interface GenerationQuota {
  reserve(input: { jobId: string; kind: MediaKind; now: number; byAgent: boolean }): void
  rollback(jobId: string): void
  tryStart(jobId: string): boolean
  release(jobId: string): void
  usage(now: number): { date: string; image: number; video: number; audio: number; agent: Record<MediaKind, number>; jobs?: JobView[] }
}

export function localDate(now: number): string {
  const date = new Date(now)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export function isPaidProvider(adapter: ProviderAdapter): boolean {
  const type = adapter.type ?? adapter.configuration?.type
  return type !== 'mock' && type !== 'render'
}

export function paidJobCount(tx: SpaceTx, date: string, kind: MediaKind, byAgent = false): number {
  return tx.select({ id: s.generationJobs.id }).from(s.generationJobs)
    .where(and(eq(s.generationJobs.quotaDate, date), eq(s.generationJobs.kind, kind), byAgent ? isNotNull(s.generationJobs.sessionId) : undefined)).all().length
}

export function checkLocalQuota(tx: SpaceTx, kind: MediaKind, now: number, limits: GenerationLimits): void {
  const count = paidJobCount(tx, localDate(now), kind, true)
  const limit = limits[DAILY_LIMIT_KEY[kind]]
  if (limit > 0 && count >= limit) throw VisError.of('quota_exceeded', 'generation.agent_daily_limit', { kind, count, limit }, `Daily agent paid ${{ image: 'image', video: 'video', audio: 'audio' }[kind]} job limit ${limit} reached`, undefined, { kind, count, limit })
}

export function localRunningCount(tx: SpaceTx): number {
  return tx.select({ id: s.generationJobs.id, quotaDate: s.generationJobs.quotaDate }).from(s.generationJobs)
    .where(inArray(s.generationJobs.status, ['running', 'finalizing'])).all().filter(job => job.quotaDate !== null).length
}
