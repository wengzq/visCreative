import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAssetStore } from '@vis/assets'
import { openSpaceDb } from '@vis/storage'
import { expect, it, vi } from 'vitest'
import { createMockProvider } from './providers/mock'
import { ProviderError } from './providers/types'
import { DEFAULT_GENERATION_LIMITS } from './quota'
import { JobRunner } from './runner'
import { createGenerationService } from './service'

it.each([undefined, 15_000])('uses provider polling interval %s for submit, pending/running and quota waits, preserving retry backoff', async pollIntervalMs => {
  const dir = await mkdtemp(join(tmpdir(), 'vis-runner-poll-'))
  const db = openSpaceDb(':memory:')
  const assets = createAssetStore({ blobsDir: join(dir, 'blobs') })
  const delivery = { deliverOutput: () => { throw new Error('This test never completes a task') } }
  const getTask = vi.fn(async () => ({ state: 'pending' as 'pending' | 'running' }))
  const adapter = { ...createMockProvider(), type: 'poll-fixture', ...(pollIntervalMs !== undefined ? { pollIntervalMs } : {}), getTask }
  const service = createGenerationService({ db, assets, delivery, providers: [adapter], defaults: { image: { provider: 'mock' } } })
  let available = true
  const runner = new JobRunner({
    db, assets, delivery, providers: new Map([[adapter.id, adapter]]), now: Date.now,
    pollIntervalMs: 2000, maxRetries: 3, queryFailureWindowMs: 60_000,
    limits: () => DEFAULT_GENERATION_LIMITS, onJobChanged: () => {},
    quota: { reserve: () => {}, rollback: () => {}, tryStart: () => available, release: () => {}, usage: () => ({ date: 'today', image: 0, video: 0, audio: 0, agent: { image: 0, video: 0, audio: 0 } }) },
  })
  try {
    const { jobId } = service.submit({ sessionId: null, turnId: null, inputSnapshotId: null }, { requestId: 'poll', kind: 'image', prompt: 'A tree' })
    const delayMs = pollIntervalMs ?? 2000
    available = false
    expect(await runner.step(jobId)).toEqual({ next: 'poll', delayMs })
    expect(getTask).not.toHaveBeenCalled()
    available = true
    expect(await runner.step(jobId)).toEqual({ next: 'poll', delayMs })
    expect(getTask).not.toHaveBeenCalled()
    expect(await runner.step(jobId)).toEqual({ next: 'poll', delayMs })
    getTask.mockResolvedValue({ state: 'running' })
    expect(await runner.step(jobId)).toEqual({ next: 'poll', delayMs })
    getTask.mockRejectedValueOnce(new ProviderError('transient', 'Temporary query failure'))
    expect(await runner.step(jobId)).toEqual({ next: 'retry', delayMs: 1000 })
  } finally { await service.stop(); db.$client.close(); await rm(dir, { recursive: true, force: true }) }
})

it('persists a render library failure with its structured reason and filename in the job view', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vis-runner-library-'))
  const db = openSpaceDb(':memory:')
  let clock = 1_000
  const error = {
    code: 'render.lib_missing', message: 'The author library is missing',
    data: { reason: 'render.lib_missing', params: { name: 'gsap.js' } },
  }
  const adapter = { ...createMockProvider(), getTask: async () => ({ state: 'failed' as const, error }) }
  const service = createGenerationService({
    db, assets: createAssetStore({ blobsDir: join(dir, 'blobs') }),
    delivery: { deliverOutput: () => { throw new Error('A failed task must not deliver output') } },
    providers: [adapter], defaults: { image: { provider: adapter.id } }, now: () => clock,
  })
  try {
    const { jobId } = service.submit({ sessionId: null, turnId: null, inputSnapshotId: null }, { requestId: 'missing-library', kind: 'image', prompt: 'A square' })
    await service.pump()
    clock += 2000
    await service.pump()
    expect(await service.get({ jobId })).toMatchObject({ status: 'failed', error })
  } finally {
    await service.stop()
    db.$client.close()
    await rm(dir, { recursive: true, force: true })
  }
})
