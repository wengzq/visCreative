import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_GENERATION_LIMITS, localDate } from '@vis/generation'
import { appSchema, openAppDb, type AppDb } from '@vis/storage'
import type { GenerationLimits, MediaKind } from '@vis/protocol'
import { createGlobalGenerationQuota } from './generation-quota'

const now = new Date(2026, 9, 27, 12).getTime()
let dir: string
let db: AppDb
let limits: GenerationLimits

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vis-generation-quota-'))
  db = openAppDb(join(dir, 'app.db'))
  limits = { ...DEFAULT_GENERATION_LIMITS }
  for (const id of ['space_a', 'space_b']) db.insert(appSchema.spaces).values({ id, name: id, dir: id, createdAt: now }).run()
})
afterEach(() => { if (db.$client.open) db.$client.close(); rmSync(dir, { recursive: true, force: true }) })

const create = () => createGlobalGenerationQuota({ db, limits: () => limits })
const reservation = (jobId: string, kind: MediaKind = 'image', at = now, byAgent = true) => ({ jobId, kind, now: at, byAgent })

describe('Global paid generation quota', () => {
  it('shares default daily image and video limits across projects without counting repeated reservations twice', () => {
    const quota = create()
    const a = quota.forSpace('space_a')
    const b = quota.forSpace('space_b')
    for (let i = 0; i < 50; i++) a.reserve(reservation(`image_${i}`))
    a.reserve(reservation('image_0'))
    expect(() => b.reserve(reservation('extra_image'))).toThrowError(expect.objectContaining({
      code: 'quota_exceeded', quota: { kind: 'image', count: 50, limit: 50 },
      message: 'Daily paid image job limit 50 reached',
      details: { reason: 'generation.daily_limit', params: { kind: 'image', count: 50, limit: 50 } },
    }))
    for (let i = 0; i < 10; i++) b.reserve(reservation(`video_${i}`, 'video'))
    expect(() => a.reserve(reservation('extra_video', 'video'))).toThrowError(expect.objectContaining({ code: 'quota_exceeded' }))
    expect(quota.usage(now)).toEqual({ date: localDate(now), image: 50, video: 10, audio: 0, agent: { image: 50, video: 10, audio: 0 } })
    expect(() => b.reserve(reservation('image_0'))).toThrowError(expect.objectContaining({ code: 'idempotency_conflict' }))
  })

  it('shares concurrency slots across projects; cancellation or failure releases slots without refunding daily counts', () => {
    const quota = create()
    const a = quota.forSpace('space_a')
    const b = quota.forSpace('space_b')
    for (let i = 0; i < 4; i++) a.reserve(reservation(`job_${i}`))
    expect([0, 1, 2, 3].map(i => a.tryStart(`job_${i}`))).toEqual([true, true, true, false])
    expect(a.tryStart('job_0')).toBe(true)
    b.release('job_0')
    expect(a.tryStart('job_3')).toBe(false)
    a.release('job_0')
    expect(a.tryStart('job_0')).toBe(false)
    expect(a.tryStart('job_3')).toBe(true)
    a.release('job_1')
    expect(quota.usage(now).image).toBe(4)
    expect(a.tryStart('missing')).toBe(false)
  })

  it('UI submissions bypass daily limits but occupy concurrency slots; 0 means unlimited and configuration takes effect immediately', () => {
    limits = { maxConcurrent: 1, dailyImage: 1, dailyVideo: 1, dailyAudio: 1 }
    const quota = create()
    const a = quota.forSpace('space_a')
    a.reserve(reservation('first'))
    a.reserve(reservation('confirmed', 'image', now, false))
    expect(a.tryStart('first')).toBe(true)
    expect(a.tryStart('confirmed')).toBe(false)
    limits = { maxConcurrent: 0, dailyImage: 0, dailyVideo: 0, dailyAudio: 0 }
    a.reserve(reservation('unlimited'))
    a.reserve(reservation('unlimited_video', 'video'))
    expect(a.tryStart('confirmed')).toBe(true)
    expect(a.tryStart('unlimited')).toBe(true)
    expect(quota.usage(now)).toMatchObject({ image: 3, video: 1 })
  })

  it('resets daily counts at local midnight while retaining active slots across days', () => {
    limits = { maxConcurrent: 1, dailyImage: 1, dailyVideo: 1, dailyAudio: 1 }
    const quota = create()
    const a = quota.forSpace('space_a')
    const beforeMidnight = new Date(2026, 9, 27, 23, 59, 59).getTime()
    const afterMidnight = new Date(2026, 9, 28, 0, 0, 0).getTime()
    a.reserve(reservation('yesterday', 'image', beforeMidnight))
    expect(a.tryStart('yesterday')).toBe(true)
    a.reserve(reservation('today', 'image', afterMidnight))
    expect(quota.usage(afterMidnight)).toEqual({ date: '2026-10-28', image: 1, video: 0, audio: 0, agent: { image: 1, video: 0, audio: 0 } })
    expect(a.tryStart('today')).toBe(false)
  })

  it('only explicitly rolled-back submissions that have not started refund counts; reservations cannot be deleted across projects', () => {
    const quota = create()
    const a = quota.forSpace('space_a')
    const b = quota.forSpace('space_b')
    a.reserve(reservation('rollback'))
    b.rollback('rollback')
    expect(quota.usage(now).image).toBe(1)
    a.rollback('rollback')
    a.rollback('rollback')
    expect(quota.usage(now).image).toBe(0)
    a.reserve(reservation('running'))
    a.tryStart('running')
    a.rollback('running')
    expect(quota.usage(now).image).toBe(1)
  })

  it('reopening the database preserves daily counts, recovers running jobs without duplicate charges and cleans stale slots', () => {
    const quota = create()
    const a = quota.forSpace('space_a')
    a.reserve(reservation('running'))
    a.tryStart('running')
    a.reserve(reservation('finished'))
    a.tryStart('finished')
    a.reserve(reservation('orphan'))
    db.$client.close()
    db = openAppDb(join(dir, 'app.db'))
    const reopened = create()
    const recovered = [
      { jobId: 'running', spaceId: 'space_a', kind: 'image' as const, status: 'running' as const, createdAt: now },
      { jobId: 'finalizing', spaceId: 'space_b', kind: 'video' as const, status: 'finalizing' as const, createdAt: now },
      { jobId: 'waiting', spaceId: 'space_b', kind: 'image' as const, status: 'queued' as const, createdAt: now },
    ]
    reopened.reconcile(recovered)
    reopened.reconcile(recovered)
    expect(reopened.usage(now)).toMatchObject({ image: 4, video: 1 })
    const b = reopened.forSpace('space_b')
    b.reserve(reservation('last_slot'))
    expect(b.tryStart('last_slot')).toBe(true)
    expect(b.tryStart('waiting')).toBe(false)
    expect(reopened.forSpace('space_a').tryStart('finished')).toBe(false)
    expect(reopened.forSpace('space_a').tryStart('orphan')).toBe(false)
  })

  it('two database connections still see the latest daily counts and reservations', () => {
    limits = { maxConcurrent: 1, dailyImage: 2, dailyVideo: 1, dailyAudio: 1 }
    const other = openAppDb(join(dir, 'app.db'))
    try {
      const a = create().forSpace('space_a')
      const b = createGlobalGenerationQuota({ db: other, limits: () => limits }).forSpace('space_b')
      a.reserve(reservation('a'))
      b.reserve(reservation('b'))
      expect(() => a.reserve(reservation('c'))).toThrowError(expect.objectContaining({ code: 'quota_exceeded' }))
      expect(a.tryStart('a')).toBe(true)
      expect(b.tryStart('b')).toBe(false)
      a.release('a')
      expect(b.tryStart('b')).toBe(true)
      expect(b.usage(now).image).toBe(2)
    } finally { other.$client.close() }
  })

  it('upgrade backfills daily counts for completed paid jobs, preserving dates without occupying concurrency slots', () => {
    limits = { maxConcurrent: 1, dailyImage: 2, dailyVideo: 1, dailyAudio: 1 }
    const quota = create()
    const jobs = [
      { jobId: 'succeeded', spaceId: 'space_a', kind: 'image' as const, status: 'succeeded' as const, createdAt: now },
      { jobId: 'failed', spaceId: 'space_b', kind: 'image' as const, status: 'failed' as const, createdAt: now },
      { jobId: 'cancelled', spaceId: 'space_a', kind: 'video' as const, status: 'cancelled' as const, createdAt: now },
      { jobId: 'yesterday', spaceId: 'space_b', kind: 'video' as const, status: 'unknown' as const, createdAt: now, quotaDate: '2026-10-26' },
    ]
    quota.reconcile(jobs)
    quota.reconcile(jobs)
    expect(quota.usage(now)).toEqual({ date: localDate(now), image: 2, video: 1, audio: 0, agent: { image: 0, video: 0, audio: 0 } })
    expect(quota.usage(new Date(2026, 9, 26, 12).getTime()).video).toBe(1)
    for (const job of jobs) expect(quota.forSpace(job.spaceId).tryStart(job.jobId)).toBe(false)
    const a = quota.forSpace('space_a')
    a.reserve(reservation('agent_1'))
    a.reserve(reservation('agent_2'))
    expect(() => a.reserve(reservation('over_limit'))).toThrowError(expect.objectContaining({ code: 'quota_exceeded' }))
    a.reserve(reservation('confirmed', 'image', now, false))
    expect(a.tryStart('confirmed')).toBe(true)
  })

  it.each(['image', 'video', 'audio'] as const)('%s UI does not consume Agent quota; Agent counts are separate and identity survives restarts', kind => {
    limits = { maxConcurrent: 1, dailyImage: 1, dailyVideo: 1, dailyAudio: 1 }
    const quota = create()
    const a = quota.forSpace('space_a')
    a.reserve(reservation('ui_first', kind, now, false))
    a.reserve(reservation('ui_second', kind, now, false))
    expect(quota.usage(now).agent[kind]).toBe(0)
    a.reserve(reservation('agent', kind))
    a.release('agent')
    expect(() => a.reserve(reservation('agent_extra', kind))).toThrowError(expect.objectContaining({ code: 'quota_exceeded', quota: { kind, count: 1, limit: 1 } }))
    a.reserve(reservation('ui_after_limit', kind, now, false))
    quota.reconcile([{ jobId: 'agent', spaceId: 'space_a', kind, status: 'failed', createdAt: now }])
    expect(quota.usage(now)[kind]).toBe(4)
    expect(quota.usage(now).agent[kind]).toBe(1)
    expect(() => a.reserve(reservation('agent', kind, now, false))).toThrowError(expect.objectContaining({ code: 'idempotency_conflict' }))
  })

})
