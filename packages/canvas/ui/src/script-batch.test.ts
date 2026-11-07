import { describe, expect, it, vi } from 'vitest'
import type { BatchView, Shot } from '@vis/protocol'
import { batchAttempt, batchShotIds, shotBatchSteps } from './script-batch'

const batch = (overrides: Partial<BatchView> = {}): BatchView => ({
  batchId: 'batch', scriptNodeId: 'script', status: 'running', origin: 'user', media: 'frames', createdAt: 1,
  estimate: { shots: 1, jobs: 1, billedJobs: 0, provider: 'mock', model: 'mock-image-1', quotaRemaining: null, staleShots: 0, shotsMissingAssetImages: 0, shotsMissingFirstFrame: 0, shotsWithoutPrompt: 0 },
  shots: [{ shotId: 'one', steps: [{ role: 'first', status: 'waiting', blockedBy: 'waiting_previous' }] }], ...overrides,
})

describe('Script batch dialog state', () => {
  it('uses selected live shots in document order, otherwise all shots', () => {
    const shots = ['one', 'two', 'three'].map(id => ({ id }) as Shot)
    expect(batchShotIds(shots, new Set(['three', 'one', 'deleted']))).toEqual(['one', 'three'])
    expect(batchShotIds(shots, new Set(['deleted']))).toBeUndefined()
    expect(batchShotIds(shots, new Set())).toBeUndefined()
  })

  it('coalesces double clicks and retains the same request ID and options after an uncertain failure', async () => {
    let reject!: (error: Error) => void
    const start = vi.fn().mockImplementationOnce(() => new Promise((_, no) => { reject = no })).mockResolvedValue(batch())
    const attempt = batchAttempt(start, 'fixed-request')
    const params = { scriptNodeId: 'script', media: 'video' as const, strictShotIds: ['two'], missingFirstFrames: 'skip' as const }
    const first = attempt.run(params)
    expect(attempt.run(params)).toBe(first)
    expect(attempt.submitted).toBe(true)
    await Promise.resolve()
    expect(start).toHaveBeenCalledTimes(1)
    params.strictShotIds.push('three')
    reject(new Error('Connection lost after server accepted request'))
    await expect(first).rejects.toThrow('Connection lost')
    await attempt.run({ ...params, media: 'frames' })
    expect(start).toHaveBeenCalledTimes(2)
    expect(start.mock.calls[0]![0]).toEqual(start.mock.calls[1]![0])
    expect(start.mock.calls[1]![0]).toEqual({ ...params, strictShotIds: ['two'], requestId: 'fixed-request' })
    await attempt.run(params)
    expect(start).toHaveBeenCalledTimes(2)
  })

  it('keeps first, last and video steps from the newest batches without dropping failures and waiting reasons', () => {
    const old = batch()
    const next = batch({ batchId: 'next', createdAt: 2, shots: [{ shotId: 'one', steps: [
      { role: 'video', status: 'waiting', blockedBy: 'quota' },
      { role: 'last', status: 'failed', error: { code: 'provider_error', message: 'Unavailable' } },
      { role: 'first', status: 'succeeded', source: 'extract', nodeId: 'first-node' },
    ] }] })
    expect(shotBatchSteps([next, old], 'one').map(({ step }) => step)).toEqual([
      next.shots[0]!.steps[2], next.shots[0]!.steps[1], next.shots[0]!.steps[0],
    ])
    expect(shotBatchSteps([next], 'missing')).toEqual([])
    expect(shotBatchSteps([old, { ...next, status: 'rejected' }], 'one').map(({ step }) => step)).toEqual(old.shots[0]!.steps)
  })
})
