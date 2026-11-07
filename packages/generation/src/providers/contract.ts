import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspect } from 'node:util'
import { createAssetStore } from '@vis/assets'
import { openSpaceDb, spaceSchema } from '@vis/storage'
import { describe, expect, it, vi } from 'vitest'
import { createGenerationService } from '../service'
import { ProviderError, type ProviderAdapter, type ProviderOutputRef, type ProviderRequest } from './types'

export type ContractScenario = 'normal' | 'lost' | 'cancel-confirmed' | 'cancel-unconfirmed' | 'wrong-mime' | 'oversized' | 'moderation' | 'secret-error'
export type ProviderContractHarness = {
  adapter: ProviderAdapter
  request: ProviderRequest
  secret: string
  /** Number of creates accepted by the fake server, not local submit invocations. */
  creates(): number
  /** True only when the fake supports recovering the accepted task after a lost response. */
  recoversLost: boolean
  output: ProviderOutputRef
  close(): Promise<void>
}

/** Each scenario gets a fresh fake server and adapter; the suite owns runner state and observations. */
export function providerContract(name: string, factory: (scenario: ContractScenario) => Promise<ProviderContractHarness>) {
  describe(`${name} shared provider contract`, () => {
    async function run(scenario: ContractScenario, test: (harness: ProviderContractHarness, observed: unknown[]) => Promise<void>) {
      const harness = await factory(scenario)
      const observed: unknown[] = []
      const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(method => vi.spyOn(console, method).mockImplementation((...args) => { observed.push(args) }))
      try { await test(harness, observed) }
      finally {
        spies.forEach(spy => spy.mockRestore())
        await harness.close()
        const text = inspect(observed, { depth: 20 })
        expect(text).not.toContain(harness.secret)
        expect(text).not.toContain(encodeURIComponent(harness.secret))
        expect(text).not.toMatch(/Bearer\s+(?!\[REDACTED\])[^\s'"]+/i)
        expect(text.replaceAll('Authorization: [REDACTED]', '')).not.toMatch(/Authorization["']?\s*[:=]/i)
      }
    }

    it('reuses one external task for repeated and concurrent idempotency keys', async () => run('normal', async ({ adapter, request, creates }) => {
      const options = { idempotencyKey: 'contract-repeat' }
      const [first, second] = await Promise.all([adapter.submit(request, options), adapter.submit(request, options)])
      expect(first).toEqual(second)
      expect(await adapter.submit(request, options)).toEqual(first)
      expect(creates()).toBe(1)
    }))

    it.each([false, true])('queries a lost submit without a second paid create (lookup disabled: %s)', async withoutLookup => run('lost', async ({ adapter: original, request, creates, recoversLost }, observed) => {
      const adapter = { ...original }
      if (withoutLookup) delete adapter.findTaskByIdempotencyKey
      const recovered = recoversLost && !withoutLookup
      const dir = await mkdtemp(join(tmpdir(), 'vis-contract-runner-'))
      const db = openSpaceDb(':memory:')
      let clock = 1_800_000_000_000
      const service = createGenerationService({
        db, assets: createAssetStore({ blobsDir: join(dir, 'blobs'), now: () => clock }),
        delivery: { deliverOutput: () => { throw new Error('Contract fixture should remain pending after recovery') } },
        providers: [adapter], defaults: { image: { provider: adapter.id }, video: { provider: adapter.id }, audio: { provider: adapter.id }, [request.kind]: { provider: adapter.id, model: request.model } },
        now: () => clock, pollIntervalMs: 1, maxRetries: 1, queryFailureWindowMs: 0,
      })
      try {
        const { jobId } = service.submit({ sessionId: null, turnId: null, inputSnapshotId: null }, { requestId: 'contract-lost', kind: request.kind, provider: adapter.id, model: request.model, prompt: request.prompt, params: request.params })
        for (let index = 0; index < 6; index++) { await service.pump(); clock += 60_000 }
        const job = await service.get({ jobId })
        observed.push(job, db.select().from(spaceSchema.events).all())
        expect(job.status).toBe(recovered ? 'running' : 'unknown')
        const attempts = db.select().from(spaceSchema.generationAttempts).all()
        expect(attempts).toHaveLength(1)
        if (recovered) expect(attempts[0]?.externalTaskId).toBeTruthy()
        else if (!adapter.findTaskByIdempotencyKey) expect(job.error).toMatchObject({ code: 'submit_unconfirmed' })
        expect(creates()).toBe(1)
      } finally { await service.stop(); await rm(dir, { recursive: true, force: true }) }
    }))

    it.each(['cancel-confirmed', 'cancel-unconfirmed'] as const)('reports cancellation honestly: %s', async scenario => run(scenario, async ({ adapter, request }) => {
      const { externalTaskId } = await adapter.submit(request, { idempotencyKey: 'contract-cancel' })
      const result = await adapter.cancel?.(externalTaskId)
      expect(result?.cancelled ?? false).toBe(scenario === 'cancel-confirmed' && Boolean(adapter.cancel))
    }))

    it.each(['wrong-mime', 'oversized'] as const)('rejects unsafe download: %s', async scenario => run(scenario, async ({ adapter, output }, observed) => {
      const error = await adapter.download(output).catch(error => error)
      observed.push(error)
      expect(error).toBeInstanceOf(ProviderError)
      expect(error.kind).toBe('rejected')
    }))

    it('maps moderation to rejection with a reason', async () => run('moderation', async ({ adapter, request }, observed) => {
      const error = await adapter.submit(request, { idempotencyKey: 'contract-moderation' }).catch(error => error)
      observed.push(error)
      expect(error).toBeInstanceOf(ProviderError)
      expect(error.kind).toBe('rejected')
      expect(error.reason).toBeTruthy()
      const dir = await mkdtemp(join(tmpdir(), 'vis-contract-moderation-'))
      const db = openSpaceDb(':memory:')
      const service = createGenerationService({
        db, assets: createAssetStore({ blobsDir: join(dir, 'blobs') }),
        delivery: { deliverOutput: () => { throw new Error('Moderated jobs cannot deliver') } },
        providers: [adapter], defaults: { [request.kind]: { provider: adapter.id, model: request.model } },
      })
      try {
        const { jobId } = service.submit({ sessionId: null, turnId: null, inputSnapshotId: null }, { requestId: 'moderation-runner', kind: request.kind, prompt: request.prompt, params: request.params })
        await service.pump()
        const job = await service.get({ jobId })
        expect(job).toMatchObject({ status: 'failed', error: { code: 'provider_rejected', data: { reason: error.reason } } })
        observed.push(job, db.select().from(spaceSchema.events).all())
      } finally { await service.stop(); db.$client.close(); await rm(dir, { recursive: true, force: true }) }
    }))

    it('redacts errors and runner events even when the vendor echoes credentials', async () => run('secret-error', async ({ adapter, request }, observed) => {
      const error = await adapter.submit(request, { idempotencyKey: 'contract-secret' }).catch(error => error)
      observed.push(error)
      expect(error).toBeInstanceOf(ProviderError)
      const dir = await mkdtemp(join(tmpdir(), 'vis-contract-secret-'))
      const db = openSpaceDb(':memory:')
      const service = createGenerationService({
        db, assets: createAssetStore({ blobsDir: join(dir, 'blobs') }),
        delivery: { deliverOutput: () => { throw new Error('Rejected jobs cannot deliver') } },
        providers: [adapter], defaults: { image: { provider: adapter.id }, video: { provider: adapter.id }, audio: { provider: adapter.id }, [request.kind]: { provider: adapter.id, model: request.model } },
      })
      try {
        service.submit({ sessionId: null, turnId: null, inputSnapshotId: null }, { requestId: 'secret-runner', kind: request.kind, prompt: request.prompt, params: request.params })
        await service.pump()
        observed.push(db.select().from(spaceSchema.events).all(), db.select().from(spaceSchema.generationJobs).all())
      } finally { await service.stop(); await rm(dir, { recursive: true, force: true }) }
    }))
  })
}
