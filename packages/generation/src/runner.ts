// Job execution state machine (0001 "End-to-end creation flow" and "Failure handling and recovery").
//
// Each step reads current database state before acting, so process restarts can resume from any point.
// Paid-call rule: query unknown outcomes without resending; resubmit only when it is provable that the provider did not receive the request.
//
//   queued --create Attempt--> running(submitting) --obtain external job ID--> running --> finalizing --> succeeded
//                                   │                                    │              │
//                                   └──────────────▶ failed / unknown ◀──┴──────────────┘

import type { AssetStore } from '@vis/assets'
import { type CanvasDeliveryPort, newId } from '@vis/domain'
import { isMediaKind, type GenerationLimits, type JobStatus } from '@vis/protocol'
import { and, appendEvent, desc, eq, inArray, spaceSchema as s, sql, type SpaceDb, type SpaceTx } from '@vis/storage'
import { ProviderError, type ProviderAdapter, type ProviderInput, type ProviderOutputRef } from './providers/types'
import { localRunningCount, type GenerationQuota } from './quota'
import { isRecheckable, readJobView } from './view'
import { sceneModelVersionIds } from './providers/render/scene'

export type RunnerDeps = {
  db: SpaceDb
  assets: AssetStore
  delivery: CanvasDeliveryPort<SpaceTx>
  providers: ReadonlyMap<string, ProviderAdapter>
  resolveProvider?: (id: string, configuration: unknown) => ProviderAdapter | undefined
  now: () => number
  pollIntervalMs: number
  /** Consecutive retryable error limit; exceeding it yields failed or unknown as appropriate */
  maxRetries: number
  /** Queries and downloads are read-only and free: consecutive failures must also last this long before unknown (do not give up too soon after sleep or disconnection) */
  queryFailureWindowMs: number
  limits: () => GenerationLimits
  quota?: GenerationQuota
  onJobChanged: (jobId: string) => void
}

/** Next action after this step: delay before running again, or a terminal state */
export type StepResult = { next: 'done' } | { next: 'retry'; delayMs: number } | { next: 'poll'; delayMs: number }

type Job = typeof s.generationJobs.$inferSelect
type Attempt = typeof s.generationAttempts.$inferSelect

const MAX_BACKOFF_MS = 30_000

export function backoffMs(retries: number): number {
  return Math.min(1000 * 2 ** retries, MAX_BACKOFF_MS)
}

export class JobRunner {
  /** Consecutive retryable error counts in this process, per Job */
  private readonly retries = new Map<string, number>()
  /** Start time of consecutive query or download failures, per Job; reset alongside retries */
  private readonly failingSince = new Map<string, number>()
  /** Attempts created in this process but not yet submitted; only these can submit directly to Providers without lookup support */
  private readonly freshAttempts = new Set<string>()
  private readonly controllers = new Map<string, AbortController>()
  private readonly cancellations = new Map<string, Promise<void>>()

  constructor(private readonly deps: RunnerDeps) {}

  activeJobIds(): string[] {
    return this.deps.db
      .select({ id: s.generationJobs.id })
      .from(s.generationJobs)
      .where(inArray(s.generationJobs.status, ['queued', 'running', 'finalizing']))
      .all()
      .map(r => r.id)
  }

  terminalCleanupJobIds(): string[] {
    return this.deps.db.select().from(s.generationJobs).where(inArray(s.generationJobs.status, ['succeeded', 'failed', 'cancelled', 'unknown'])).all().flatMap(job => {
      try { return this.adapterFor(job)?.cleanup ? [job.id] : [] } catch { return [] }
    })
  }

  async step(jobId: string): Promise<StepResult> {
    const controller = new AbortController()
    this.controllers.set(jobId, controller)
    try {
      return await this.stepJob(jobId)
    } finally {
      if (this.controllers.get(jobId) === controller) this.controllers.delete(jobId)
      await this.cleanup(jobId)
    }
  }

  private async cleanup(jobId: string): Promise<void> {
    const job = this.deps.db.select().from(s.generationJobs).where(eq(s.generationJobs.id, jobId)).get()
    if (!job || (job.status !== 'succeeded' && job.status !== 'failed' && job.status !== 'cancelled' && job.status !== 'unknown')) return
    const attempt = this.latestAttempt(jobId)
    if (!attempt) return
    try { await this.adapterFor(job)?.cleanup?.({ idempotencyKey: attempt.id, status: job.status }) }
    catch { console.warn('Generation staging cleanup failed; terminal job outcome is unchanged') }
  }

  private async stepJob(jobId: string): Promise<StepResult> {
    const job = this.deps.db.select().from(s.generationJobs).where(eq(s.generationJobs.id, jobId)).get()
    if (!job) return { next: 'done' }
    const active = job.status === 'queued' || job.status === 'running' || job.status === 'finalizing'
    if (!active) return { next: 'done' }
    let adapter: ProviderAdapter | undefined
    try {
      adapter = this.adapterFor(job)
    } catch {
      // The saved service configuration is unusable and retries cannot fix it; terminate instead of requeuing forever
      return this.settle(job, 'unknown', { code: 'provider_config_invalid', message: `Generation service ${job.provider} configuration is invalid; cannot confirm the job result` })
    }
    if (!adapter) {
      return this.settle(job, 'unknown', { code: 'provider_missing', message: `Generation service ${job.provider} is unavailable; cannot confirm the job result` })
    }
    switch (job.status) {
      case 'queued':
        if (job.quotaDate !== null) {
          const maxConcurrent = this.deps.limits().maxConcurrent
          const available = this.deps.quota ? this.deps.quota.tryStart(job.id) : maxConcurrent === 0 || localRunningCount(this.deps.db) < maxConcurrent
          if (!available) {
            if (!job.queueReason) {
              this.deps.db.transaction(tx => {
                tx.update(s.generationJobs).set({ queueReason: 'concurrency_limit' }).where(eq(s.generationJobs.id, job.id)).run()
                this.setJobStatus(tx, job.id, 'queued', this.deps.now())
              }, { behavior: 'immediate' })
              this.deps.onJobChanged(job.id)
            }
            return { next: 'poll', delayMs: adapter.pollIntervalMs ?? this.deps.pollIntervalMs }
          }
        }
        this.createAttempt(job)
        return this.submitStep(job, adapter!)
      case 'running':
        return this.latestAttempt(job.id)?.externalTaskId ? this.pollStep(job, adapter!) : this.submitStep(job, adapter!)
      case 'finalizing':
        return this.finalizeStep(job, adapter!)
      default:
        return { next: 'done' }
    }
  }

  /** Commit local terminal state before any provider await; all late callbacks defer to this record. */
  requestCancel(tx: SpaceTx, jobId: string): void {
    const job = tx.select().from(s.generationJobs).where(eq(s.generationJobs.id, jobId)).get()!
    if (job.status === 'cancelled') return
    const t = this.deps.now()
    const attempt = this.latestAttempt(jobId, tx)
    tx.update(s.generationJobs).set({ cancelRequestedAt: t, providerCancelled: !attempt || this.freshAttempts.has(attempt.id), queueReason: null }).where(eq(s.generationJobs.id, jobId)).run()
    if (attempt) tx.update(s.generationAttempts).set({ status: 'cancelled', endedAt: t }).where(eq(s.generationAttempts.id, attempt.id)).run()
    tx.update(s.deliveryBindings).set({ status: 'no_output' }).where(and(eq(s.deliveryBindings.jobId, jobId), eq(s.deliveryBindings.status, 'pending'))).run()
    this.setJobStatus(tx, jobId, 'cancelled', t)
    this.retries.delete(jobId)
    this.failingSince.delete(jobId)
    if (attempt) this.freshAttempts.delete(attempt.id)
  }

  async cancelProvider(jobId: string): Promise<void> {
    try { await this.cancelProviderRequest(jobId) }
    finally { if (!this.controllers.has(jobId)) await this.cleanup(jobId) }
  }

  private async cancelProviderRequest(jobId: string): Promise<void> {
    this.controllers.get(jobId)?.abort()
    const job = this.deps.db.select().from(s.generationJobs).where(eq(s.generationJobs.id, jobId)).get()
    if (!job || job.status !== 'cancelled') return
    this.deps.quota?.release(jobId)
    if (job.providerCancelled) return
    let adapter: ProviderAdapter | undefined
    try { adapter = this.adapterFor(job) } catch { return }
    if (!adapter?.cancel) return
    const attempt = this.latestAttempt(jobId)
    if (!attempt) return
    let externalTaskId = attempt.externalTaskId
    if (!externalTaskId && adapter.findTaskByIdempotencyKey) {
      try {
        externalTaskId = (await adapter.findTaskByIdempotencyKey(attempt.id))?.externalTaskId ?? null
        if (externalTaskId) this.deps.db.update(s.generationAttempts).set({ externalTaskId }).where(eq(s.generationAttempts.id, attempt.id)).run()
      } catch { return }
    }
    if (externalTaskId) await this.cancelExternal(jobId, adapter, externalTaskId)
  }

  private adapterFor(job: Job): ProviderAdapter | undefined {
    return this.deps.resolveProvider ? this.deps.resolveProvider(job.provider, (job.params as Record<string, unknown>).providerConfiguration) : this.deps.providers.get(job.provider)
  }

  private async cancelExternal(jobId: string, adapter: ProviderAdapter, externalTaskId: string): Promise<void> {
    const existing = this.cancellations.get(jobId)
    if (existing) return existing
    const operation = (async () => {
      try {
        const result = await adapter.cancel?.(externalTaskId)
        if (!result?.cancelled) return
        this.deps.db.transaction(tx => {
          if (!this.cancelled(jobId, tx)) return
          tx.update(s.generationJobs).set({ providerCancelled: true }).where(eq(s.generationJobs.id, jobId)).run()
          this.setJobStatus(tx, jobId, 'cancelled', this.deps.now())
        }, { behavior: 'immediate' })
        this.deps.onJobChanged(jobId)
      } catch {
        // Already cancelled locally; keep false if the provider cannot confirm, and never claim remote execution stopped or a refund occurred.
      }
    })().finally(() => this.cancellations.delete(jobId))
    this.cancellations.set(jobId, operation)
    return operation
  }

  private cancelled(jobId: string, tx: SpaceTx = this.deps.db): boolean {
    const job = tx.select({ status: s.generationJobs.status, cancelRequestedAt: s.generationJobs.cancelRequestedAt }).from(s.generationJobs).where(eq(s.generationJobs.id, jobId)).get()
    return !job || job.status === 'cancelled' || job.cancelRequestedAt !== null
  }

  private signal(jobId: string): AbortSignal | undefined {
    return this.controllers.get(jobId)?.signal
  }

  // -- Submission -------------------------------------------------

  private createAttempt(job: Job): void {
    const { db, now } = this.deps
    const t = now()
    db.transaction(
      tx => {
        const last = this.latestAttempt(job.id, tx)
        const id = newId('attempt', t)
        tx.insert(s.generationAttempts).values({ id, jobId: job.id, attemptNo: (last?.attemptNo ?? 0) + 1, status: 'submitting', startedAt: t }).run()
        tx.update(s.generationJobs).set({ queueReason: null }).where(eq(s.generationJobs.id, job.id)).run()
        this.setJobStatus(tx, job.id, 'running', t)
        this.freshAttempts.add(id)
      },
      { behavior: 'immediate' },
    )
    this.deps.onJobChanged(job.id)
  }

  private async submitStep(job: Job, adapter: ProviderAdapter): Promise<StepResult> {
    const attempt = this.latestAttempt(job.id)!
    const key = attempt.id

    // First check whether the provider already has this job, covering lost responses and process crashes around submission
    if (adapter.findTaskByIdempotencyKey) {
      try {
        const found = await adapter.findTaskByIdempotencyKey(key)
        if (found) return this.recordExternalTask(job, attempt, found.externalTaskId, adapter)
      } catch (error) {
        return this.retryOr(job, error, 'unknown')
      }
    } else if (!this.freshAttempts.has(attempt.id)) {
      // No lookup and not an Attempt newly created in this process: cannot prove the provider did not receive it, so cannot resend
      return this.settle(job, 'unknown', { code: 'submit_unconfirmed', message: 'Cannot confirm submission result; not resubmitted to avoid duplicate generation' }, attempt)
    }

    if (this.cancelled(job.id)) return { next: 'done' }
    this.freshAttempts.delete(attempt.id)
    try {
      const original = this.buildRequest(job)
      const request = adapter.prepareRequest?.(original) ?? original
      if (adapter.prepareRequest) {
        this.deps.db.update(s.generationJobs).set({ params: { ...(job.params as Record<string, unknown>), actualPrompt: request.prompt } })
          .where(eq(s.generationJobs.id, job.id)).run()
      }
      const signal = this.signal(job.id)
      const { externalTaskId } = await adapter.submit(request, { idempotencyKey: key, ...(signal ? { signal } : {}) })
      return this.recordExternalTask(job, attempt, externalTaskId, adapter)
    } catch (error) {
      if (this.cancelled(job.id)) return { next: 'done' }
      if (error instanceof ProviderError && error.kind === 'rejected') {
        return this.settle(job, 'failed', { code: 'provider_rejected', message: error.message, ...(error.reason ? { data: { reason: error.reason, ...(error.params ? { params: error.params } : {}) } } : {}) }, attempt)
      }
      if (error instanceof ProviderError && error.kind === 'transient') {
        // Confirmed to have had no effect: can resubmit with the same key
        this.freshAttempts.add(attempt.id)
        return this.retryOr(job, error, 'failed')
      }
      // Timeout or unknown error means unknown outcome; query later if supported, otherwise mark unknown
      if (adapter.findTaskByIdempotencyKey) return this.retryOr(job, error, 'unknown')
      return this.settle(job, 'unknown', { code: 'submit_unconfirmed', message: errorMessage(error) }, attempt)
    }
  }

  private async recordExternalTask(job: Job, attempt: Attempt, externalTaskId: string, adapter: ProviderAdapter): Promise<StepResult> {
    if (this.cancelled(job.id)) {
      this.deps.db.update(s.generationAttempts).set({ externalTaskId }).where(eq(s.generationAttempts.id, attempt.id)).run()
      await this.cancelExternal(job.id, adapter, externalTaskId)
      return { next: 'done' }
    }
    this.deps.db
      .update(s.generationAttempts)
      .set({ externalTaskId, status: 'running' })
      .where(eq(s.generationAttempts.id, attempt.id))
      .run()
    this.retries.delete(job.id)
    this.failingSince.delete(job.id)
    return { next: 'poll', delayMs: adapter.pollIntervalMs ?? this.deps.pollIntervalMs }
  }

  private buildRequest(job: Job) {
    const { prompt, resolvedPrompt, frameRefs, providerConfiguration: _configuration, actualPrompt: _actualPrompt, revisedPrompt: _revisedPrompt, ...params } = job.params as { prompt: string; resolvedPrompt?: string; frameRefs?: { last?: unknown } } & Record<string, unknown>
    const inputs = this.readInputs(job.id)
    const frames = frameRefs ? inputs.splice(-(frameRefs.last ? 2 : 1)) : []
    return { kind: job.kind, operation: job.operation, model: job.model, prompt: resolvedPrompt ?? prompt, params, inputs, ...(frames[0] ? { frames: { first: frames[0], ...(frames[1] ? { last: frames[1] } : {}) } } : {}) }
  }

  /** Inputs are pinned to revisions recorded in job_inputs; do not fetch the latest again */
  private readInputs(jobId: string): ProviderInput[] {
    const rows = this.deps.db
      .select({
        textBody: s.slotRevisions.textBody,
        sceneDoc: s.slotRevisions.sceneDoc,
        assetVersionId: s.assetVersions.id,
        mime: s.assetVersions.mime,
        blobHash: s.assetVersions.blobHash,
        kind: s.assets.kind,
        durationMs: s.assetVersions.durationMs,
        width: s.assetVersions.width,
        height: s.assetVersions.height,
        fps: s.assetVersions.fps,
        bytes: s.blobs.byteSize,
      })
      .from(s.jobInputs)
      .leftJoin(s.slotRevisions, and(eq(s.slotRevisions.slotId, s.jobInputs.slotId), eq(s.slotRevisions.revision, s.jobInputs.slotRevision)))
      .leftJoin(s.assetVersions, eq(s.assetVersions.id, sql`coalesce(${s.jobInputs.assetVersionId}, ${s.slotRevisions.assetVersionId})`))
      .leftJoin(s.assets, eq(s.assets.id, s.assetVersions.assetId))
      .leftJoin(s.blobs, eq(s.blobs.hash, s.assetVersions.blobHash))
      .where(eq(s.jobInputs.jobId, jobId))
      .orderBy(s.jobInputs.ordinal)
      .all()
    return rows.flatMap((r): ProviderInput[] => {
      if (r.sceneDoc) {
        const models = sceneModelVersionIds(r.sceneDoc).flatMap(id => {
          const model = rows.find(row => row.assetVersionId === id && row.kind === 'model')
          return model?.blobHash && model.mime ? [{ assetVersionId: id, mime: model.mime, path: this.deps.assets.blobPath(model.blobHash) }] : []
        })
        return [{ type: 'scene', doc: r.sceneDoc, models }]
      }
      if (r.blobHash && r.mime && r.kind && isMediaKind(r.kind)) return [{ type: 'asset', kind: r.kind, mime: r.mime, path: this.deps.assets.blobPath(r.blobHash), ...(r.durationMs !== null ? { durationMs: r.durationMs } : {}), ...(r.width !== null ? { width: r.width } : {}), ...(r.height !== null ? { height: r.height } : {}), ...(r.fps !== null ? { fps: r.fps } : {}), ...(r.bytes !== null ? { bytes: r.bytes } : {}) }]
      if (r.textBody !== null) return [{ type: 'text', text: r.textBody }]
      return []
    })
  }

  // -- Querying ---------------------------------------------------

  private async pollStep(job: Job, adapter: ProviderAdapter): Promise<StepResult> {
    const attempt = this.latestAttempt(job.id)!
    let state
    try {
      const signal = this.signal(job.id)
      state = await adapter.getTask(attempt.externalTaskId!, signal ? { signal } : {})
    } catch (error) {
      if (error instanceof ProviderError && error.kind === 'not_found') {
        return this.settle(job, 'unknown', { code: 'external_task_missing', message: 'Generation service cannot find this job' }, attempt)
      }
      return this.retryQuery(job, error)
    }
    if (this.cancelled(job.id)) return { next: 'done' }
    this.retries.delete(job.id)
    this.failingSince.delete(job.id)
    if (state.state === 'cancelled') {
      this.deps.db.transaction(tx => {
        this.requestCancel(tx, job.id)
        tx.update(s.generationJobs).set({ providerCancelled: true }).where(eq(s.generationJobs.id, job.id)).run()
        this.setJobStatus(tx, job.id, 'cancelled', this.deps.now())
      }, { behavior: 'immediate' })
      this.deps.quota?.release(job.id)
      this.deps.onJobChanged(job.id)
      return { next: 'done' }
    }
    if (state.state === 'failed') return this.settle(job, 'failed', state.error, attempt)
    if (state.state !== 'succeeded') return { next: 'poll', delayMs: adapter.pollIntervalMs ?? this.deps.pollIntervalMs }

    this.deps.db.transaction(tx => {
      this.storeRevisedPrompt(tx, job.id, state.revisedPrompt)
      this.setJobStatus(tx, job.id, 'finalizing', this.deps.now())
    }, { behavior: 'immediate' })
    this.deps.onJobChanged(job.id)
    return this.finalizeOutputs({ ...job, status: 'finalizing' }, adapter, attempt, state.outputs)
  }

  // -- Delivery ---------------------------------------------------

  private storeRevisedPrompt(tx: SpaceTx, jobId: string, prompt?: string): void {
    if (prompt === undefined) return
    const params = tx.select({ params: s.generationJobs.params }).from(s.generationJobs).where(eq(s.generationJobs.id, jobId)).get()!.params as Record<string, unknown>
    tx.update(s.generationJobs).set({ params: { ...params, revisedPrompt: prompt.trim().slice(0, 20_000) } }).where(eq(s.generationJobs.id, jobId)).run()
  }

  private async finalizeStep(job: Job, adapter: ProviderAdapter): Promise<StepResult> {
    const attempt = this.latestAttempt(job.id)!
    try {
      const signal = this.signal(job.id)
      const state = await adapter.getTask(attempt.externalTaskId!, signal ? { signal } : {})
      if (this.cancelled(job.id)) return { next: 'done' }
      if (state.state !== 'succeeded') {
        return this.settle(job, 'unknown', { code: 'external_state_changed', message: `Generation service returned ${state.state}, inconsistent with the completed record` }, attempt)
      }
      // Do not reset retries here: successful queries are not progress, or persistent download failures would retry forever
      this.deps.db.transaction(tx => this.storeRevisedPrompt(tx, job.id, state.revisedPrompt), { behavior: 'immediate' })
      return this.finalizeOutputs(job, adapter, attempt, state.outputs)
    } catch (error) {
      if (error instanceof ProviderError && error.kind === 'not_found') {
        return this.settle(job, 'unknown', { code: 'external_task_missing', message: 'Generation service cannot find this job; outputs cannot be downloaded' }, attempt)
      }
      return this.retryQuery(job, error)
    }
  }

  /** Downloads and saves outputs individually, registering and filling in one transaction; skips registered outputs and is repeatable */
  private async finalizeOutputs(job: Job, adapter: ProviderAdapter, attempt: Attempt, outputs: ProviderOutputRef[]): Promise<StepResult> {
    const { db, assets, delivery, now } = this.deps
    const done = new Set(db.select({ i: s.generationOutputs.outputIndex }).from(s.generationOutputs).where(eq(s.generationOutputs.jobId, job.id)).all().map(r => r.i))

    for (const output of [...outputs].sort((a, b) => a.outputIndex - b.outputIndex)) {
      if (this.cancelled(job.id)) return { next: 'done' }
      if (done.has(output.outputIndex)) continue
      let file
      try {
        const signal = this.signal(job.id)
        file = await adapter.download(output, signal ? { signal } : {})
      } catch (error) {
        if (error instanceof ProviderError && (error.kind === 'rejected' || error.kind === 'not_found')) {
          return this.settle(job, 'unknown', { code: 'download_failed', message: error.message }, attempt)
        }
        // Download failures retry fetching by default without regenerating
        return this.retryQuery(job, error)
      }
      if (this.cancelled(job.id)) return { next: 'done' }
      const staged = await assets.stageBytes(file.data)
      db.transaction(
        tx => {
          if (this.cancelled(job.id, tx)) return
          const t = now()
          const registered = tx.select().from(s.generationOutputs)
            .where(and(eq(s.generationOutputs.jobId, job.id), eq(s.generationOutputs.outputIndex, output.outputIndex))).get()
          if (registered) return
          const version = assets.registerVersion(tx, {
            staged,
            kind: job.kind,
            mime: file.mime,
            origin: 'generation',
            sourceJobId: job.id,
            ...(file.width !== undefined ? { width: file.width } : {}),
            ...(file.height !== undefined ? { height: file.height } : {}),
            ...(file.durationMs !== undefined ? { durationMs: file.durationMs } : {}),
            ...(file.hasAlpha !== undefined ? { hasAlpha: file.hasAlpha } : {}),
            ...(file.fps !== undefined ? { fps: file.fps } : {}),
          })
          tx.insert(s.generationOutputs).values({ jobId: job.id, outputIndex: output.outputIndex, assetVersionId: version.assetVersionId, createdAt: t }).run()
          const bindingId = this.bindingFor(tx, job.id, output.outputIndex)
          delivery.deliverOutput(tx, { bindingId, assetVersionId: version.assetVersionId })
        },
        { behavior: 'immediate' },
      )
      this.deps.onJobChanged(job.id)
    }
    return this.settle(job, 'succeeded', undefined, attempt)
  }

  /** When outputs exceed the submission count, create nodes for extras beside the first input node */
  private bindingFor(tx: SpaceTx, jobId: string, outputIndex: number): string {
    const existing = tx.select({ id: s.deliveryBindings.id }).from(s.deliveryBindings)
      .where(and(eq(s.deliveryBindings.jobId, jobId), eq(s.deliveryBindings.outputIndex, outputIndex))).get()
    if (existing) return existing.id
    const first = tx.select({ placement: s.deliveryBindings.placement, nodeId: s.deliveryBindings.nodeId })
      .from(s.deliveryBindings).where(eq(s.deliveryBindings.jobId, jobId)).orderBy(s.deliveryBindings.outputIndex).get()
    const nearNodeId = first?.nodeId ?? (first?.placement as { nearNodeId?: string } | null)?.nearNodeId
    const id = newId('binding', this.deps.now())
    tx.insert(s.deliveryBindings)
      .values({ id, jobId, outputIndex, targetKind: 'new_node', placement: nearNodeId ? { nearNodeId } : null, status: 'pending' })
      .run()
    return id
  }

  // -- State writes -----------------------------------------------

  private retryOr(job: Job, error: unknown, exhausted: 'failed' | 'unknown'): StepResult {
    if (this.cancelled(job.id)) return { next: 'done' }
    const n = (this.retries.get(job.id) ?? 0) + 1
    if (n > this.deps.maxRetries) {
      return this.settle(job, exhausted, { code: 'retries_exhausted', message: errorMessage(error) }, this.latestAttempt(job.id))
    }
    this.retries.set(job.id, n)
    return { next: 'retry', delayMs: backoffMs(n - 1) }
  }

  /**
   * Temporary query/download failures become unknown only after both count and duration limits. Count-only backoff totals about 2 minutes,
   * so brief sleep or disconnection would abandon paid jobs already generating. Explicit rejection (e.g. invalid keys) makes retries futile; use only counts.
   */
  private retryQuery(job: Job, error: unknown): StepResult {
    if (this.cancelled(job.id)) return { next: 'done' }
    const since = this.failingSince.get(job.id) ?? this.deps.now()
    this.failingSince.set(job.id, since)
    const n = (this.retries.get(job.id) ?? 0) + 1
    const windowMs = error instanceof ProviderError && error.kind === 'rejected' ? 0 : this.deps.queryFailureWindowMs
    if (n > this.deps.maxRetries && this.deps.now() - since >= windowMs) {
      return this.settle(job, 'unknown', { code: 'retries_exhausted', message: errorMessage(error) }, this.latestAttempt(job.id))
    }
    this.retries.set(job.id, n)
    return { next: 'retry', delayMs: backoffMs(Math.min(n, this.deps.maxRetries) - 1) }
  }

  /** Jobs with unknown outcomes but external job IDs return to running and only continue querying, never resubmitting. False means recovery is unavailable. */
  resumeQuery(tx: SpaceTx, jobId: string): boolean {
    const job = tx.select().from(s.generationJobs).where(eq(s.generationJobs.id, jobId)).get()
    if (!job || !isRecheckable(tx, job)) return false
    const attempt = this.latestAttempt(jobId, tx)!
    const t = this.deps.now()
    tx.update(s.generationAttempts).set({ status: 'running', endedAt: null, error: null }).where(eq(s.generationAttempts.id, attempt.id)).run()
    // settle marked undelivered positions no_output; resume waiting and still validate revisions on delivery
    tx.update(s.deliveryBindings).set({ status: 'pending' }).where(and(eq(s.deliveryBindings.jobId, jobId), eq(s.deliveryBindings.status, 'no_output'))).run()
    tx.update(s.generationJobs).set({ error: null }).where(eq(s.generationJobs.id, jobId)).run()
    this.setJobStatus(tx, jobId, 'running', t)
    this.retries.delete(jobId)
    this.failingSince.delete(jobId)
    return true
  }

  private settle(job: Job, status: Extract<JobStatus, 'succeeded' | 'failed' | 'unknown'>, error?: { code: string; message: string; data?: { reason: string; params?: Record<string, string | number> } }, attempt?: Attempt): StepResult {
    const t = this.deps.now()
    this.deps.db.transaction(
      tx => {
        if (this.cancelled(job.id, tx)) return
        if (attempt) tx.update(s.generationAttempts).set({ status, endedAt: t, error: error ?? null }).where(eq(s.generationAttempts.id, attempt.id)).run()
        // Bindings still undelivered at termination will receive no outputs; mark no_output so the UI and agents need not wait indefinitely
        tx.update(s.deliveryBindings).set({ status: 'no_output' })
          .where(and(eq(s.deliveryBindings.jobId, job.id), eq(s.deliveryBindings.status, 'pending'))).run()
        this.setJobStatus(tx, job.id, status, t, error)
      },
      { behavior: 'immediate' },
    )
    this.deps.quota?.release(job.id)
    this.retries.delete(job.id)
    this.failingSince.delete(job.id)
    if (attempt) this.freshAttempts.delete(attempt.id)
    this.deps.onJobChanged(job.id)
    return { next: 'done' }
  }

  private setJobStatus(tx: SpaceTx, jobId: string, status: JobStatus, t: number, error?: { code: string; message: string }): void {
    if (status !== 'cancelled' && this.cancelled(jobId, tx)) return
    tx.update(s.generationJobs).set({ status, updatedAt: t, ...(error ? { error } : {}) }).where(eq(s.generationJobs.id, jobId)).run()
    // Payload includes the full job view (including delivery targets), avoiding another UI read
    appendEvent(tx, { type: 'job.stateChanged', entityType: 'job', entityId: jobId, payload: { jobId, status, ...(error ? { error } : {}), job: readJobView(tx, jobId) } }, t)
  }

  private latestAttempt(jobId: string, tx: SpaceTx = this.deps.db): Attempt | undefined {
    return tx.select().from(s.generationAttempts).where(eq(s.generationAttempts.jobId, jobId)).orderBy(desc(s.generationAttempts.attemptNo)).get()
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
