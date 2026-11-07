import type { AssetStore } from '@vis/assets'
import { type CanvasDeliveryPort, VisError } from '@vis/domain'
import { GENERATION_MAX_WAIT_MS, type GenerationLimits, type GenerationTarget, type MethodParams, type MethodResult } from '@vis/protocol'
import { and, eq, runIdempotent, spaceSchema as s, type SpaceDb, type SpaceTx } from '@vis/storage'
import type { ProviderAdapter } from './providers/types'
import { DEFAULT_GENERATION_LIMITS, localDate, paidJobCount, type GenerationQuota } from './quota'
import { JobRunner } from './runner'
import { type ProviderDefaults, type SubmitCaller, type SubmitContext, submitJob } from './submit'
import { readJobView, TERMINAL_STATUSES } from './view'

export type GenerationServiceDeps = {
  db: SpaceDb
  assets: AssetStore
  delivery: CanvasDeliveryPort<SpaceTx>
  providers: ProviderAdapter[]
  resolveProvider?: (id: string, configuration: unknown) => ProviderAdapter | undefined
  defaults: ProviderDefaults
  now?: () => number
  pollIntervalMs?: number
  maxRetries?: number
  queryFailureWindowMs?: number
  limits?: GenerationLimits
  quota?: GenerationQuota
}

export interface GenerationService {
  configure(providers: ProviderAdapter[], defaults: ProviderDefaults, limits?: GenerationLimits): void
  submit(caller: SubmitCaller, params: MethodParams<'generation.submit'>, authorize?: (tx: SpaceTx, result: MethodResult<'generation.submit'>) => void): MethodResult<'generation.submit'>
  cancel(caller: SubmitCaller, params: MethodParams<'generation.cancel'>): Promise<MethodResult<'generation.cancel'>>
  regenerate(caller: SubmitCaller, params: MethodParams<'generation.regenerate'>): MethodResult<'generation.regenerate'>
  recheck(caller: SubmitCaller, params: MethodParams<'generation.recheck'>): MethodResult<'generation.recheck'>
  usage(): MethodResult<'generation.usage'>
  get(params: MethodParams<'generation.get'>): Promise<MethodResult<'generation.get'>>
  /** Executes all due steps until no due work remains. Called directly with fake clocks in tests */
  pump(): Promise<void>
  /** Restores unfinished Jobs and starts background scheduling */
  start(): void
  stop(): Promise<void>
}

type Schedule = { dueAt: number; running: boolean }

export function createGenerationService(deps: GenerationServiceDeps): GenerationService {
  const { db } = deps
  const now = deps.now ?? Date.now
  const providers = new Map(deps.providers.map(p => [p.id, p]))
  let defaults = deps.defaults
  let limits = deps.limits ?? DEFAULT_GENERATION_LIMITS
  const waiters = new Map<string, Set<() => void>>()
  const schedules = new Map<string, Schedule>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let started = false

  const notify = (jobId: string) => {
    const set = waiters.get(jobId)
    if (!set) return
    waiters.delete(jobId)
    for (const wake of set) wake()
  }

  const runner = new JobRunner({
    db,
    assets: deps.assets,
    delivery: deps.delivery,
    providers,
    ...(deps.resolveProvider ? { resolveProvider: deps.resolveProvider } : {}),
    now,
    pollIntervalMs: deps.pollIntervalMs ?? 2000,
    maxRetries: deps.maxRetries ?? 8,
    // Ark video output URLs are valid for 24 hours, so recovery within 12 hours is still timely
    queryFailureWindowMs: deps.queryFailureWindowMs ?? 12 * 60 * 60_000,
    limits: () => limits,
    ...(deps.quota ? { quota: deps.quota } : {}),
    onJobChanged: notify,
  })

  const schedule = (jobId: string, delayMs: number) => {
    const current = schedules.get(jobId)
    schedules.set(jobId, { dueAt: now() + delayMs, running: current?.running ?? false })
  }

  async function runJob(jobId: string): Promise<void> {
    const entry = schedules.get(jobId)!
    entry.running = true
    try {
      const result = await runner.step(jobId)
      if (result.next === 'done') schedules.delete(jobId)
      else schedule(jobId, result.delayMs)
    } catch (error) {
      // Unexpected errors (such as disk write failures) preserve current persisted state and retry this step later
      console.error(`[generation] job ${jobId} step failed`, error)
      schedule(jobId, 5000)
    } finally {
      const after = schedules.get(jobId)
      if (after) after.running = false
    }
  }

  // Execute due steps independently: slow requests (such as Ark downloads) do not block other Jobs; running prevents concurrency within a Job
  const inflight = new Set<Promise<void>>()

  function launchDue(): number {
    const t = now()
    const due = [...schedules].filter(([, e]) => !e.running && e.dueAt <= t).map(([id]) => id)
    for (const id of due) {
      const run: Promise<void> = runJob(id).finally(() => {
        inflight.delete(run)
        wake()
      })
      inflight.add(run)
    }
    return due.length
  }

  async function pump(): Promise<void> {
    for (;;) {
      launchDue()
      if (inflight.size === 0) return
      await Promise.all(inflight)
    }
  }

  function wake(): void {
    if (!started) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(tick, 0)
  }

  function tick(): void {
    timer = undefined
    if (!started) return
    launchDue()
    const waiting = [...schedules.values()].filter(e => !e.running).map(e => e.dueAt)
    const next = Math.min(...waiting, now() + 1000)
    timer = setTimeout(tick, Math.max(10, next - now()))
  }

  function ownedJob(caller: SubmitCaller, jobId: string, tx: SpaceTx = db) {
    const job = tx.select().from(s.generationJobs).where(eq(s.generationJobs.id, jobId)).get()
    if (!job) throw VisError.of('not_found', 'generation.job_not_found', { jobId }, `Generation job ${jobId} does not exist`)
    if (caller.sessionId !== null && caller.sessionId !== job.sessionId) throw VisError.of('forbidden', 'generation.other_session_forbidden', {}, 'Can only operate on generation jobs in the current session')
    return job
  }

  function submitIdempotent(request: { requestId: string; method: string; params: unknown }, build: (tx: SpaceTx, ctx: SubmitContext) => MethodResult<'generation.submit'>) {
    let reservedJobId: string | undefined
    let result: MethodResult<'generation.submit'>
    try {
      result = runIdempotent(db, request, tx => build(tx, {
        providers, defaults, now: now(), limits,
        ...(deps.quota ? { reserve: (jobId, kind, byAgent) => {
          deps.quota!.reserve({ jobId, kind, now: now(), byAgent })
          reservedJobId = jobId
        } } : {}),
      }), now)
    } catch (error) {
      if (reservedJobId) deps.quota?.rollback(reservedJobId)
      throw error
    }
    if (!schedules.has(result.jobId) && readJobView(db, result.jobId)?.status === 'queued') {
      schedule(result.jobId, 0)
      wake()
    }
    return result
  }

  return {
    configure(next, nextDefaults, nextLimits) {
      providers.clear()
      for (const provider of next) providers.set(provider.id, provider)
      defaults = nextDefaults
      if (nextLimits) limits = nextLimits
      for (const [jobId, entry] of schedules) if (!entry.running) schedule(jobId, 0)
      wake()
    },
    submit(caller, params, authorize) {
      return submitIdempotent({ requestId: params.requestId, method: 'generation.submit', params }, (tx, ctx) => {
        const result = submitJob(tx, caller, params, ctx)
        authorize?.(tx, result)
        return result
      })
    },

    async cancel(caller, params) {
      ownedJob(caller, params.jobId)
      runIdempotent(db, { requestId: params.requestId, method: 'generation.cancel', params }, tx => {
        const job = ownedJob(caller, params.jobId, tx)
        if (TERMINAL_STATUSES.includes(job.status)) throw VisError.of('job_terminal', 'generation.job_terminal', {}, 'Job has already ended and cannot be cancelled')
        runner.requestCancel(tx, params.jobId)
        return { jobId: params.jobId }
      }, now)
      schedules.delete(params.jobId)
      notify(params.jobId)
      await runner.cancelProvider(params.jobId)
      for (const [jobId, entry] of schedules) if (!entry.running) schedule(jobId, 0)
      wake()
      return readJobView(db, params.jobId)!
    },

    recheck(caller, params) {
      ownedJob(caller, params.jobId)
      runIdempotent(db, { requestId: params.requestId, method: 'generation.recheck', params }, tx => {
        ownedJob(caller, params.jobId, tx)
        if (!runner.resumeQuery(tx, params.jobId)) throw VisError.of('invalid_params', 'generation.not_recheckable', {}, 'Only jobs with unknown outcomes and a generation service job ID can be rechecked')
        return { jobId: params.jobId }
      }, now)
      notify(params.jobId)
      schedule(params.jobId, 0)
      wake()
      return readJobView(db, params.jobId)!
    },

    regenerate(caller, params) {
      ownedJob(caller, params.jobId)
      return submitIdempotent({ requestId: params.requestId, method: 'generation.regenerate', params }, (tx, ctx) => {
        const original = ownedJob(caller, params.jobId, tx)
        if (!TERMINAL_STATUSES.includes(original.status)) throw VisError.of('invalid_params', 'generation.job_running', {}, 'Wait for the job to finish or cancel it before regenerating')
        const stored = original.params as { prompt: string; providerConfiguration?: unknown } & Record<string, unknown>
        let adapter: ProviderAdapter | undefined
        try { adapter = deps.resolveProvider?.(original.provider, stored.providerConfiguration) ?? providers.get(original.provider) } catch { /* Return an explicit error below */ }
        if (!adapter) throw VisError.of('invalid_params', 'generation.provider_unavailable', { providerId: original.provider }, `Original generation service ${original.provider} is unavailable`)
        const inputs = tx.select().from(s.jobInputs).where(eq(s.jobInputs.jobId, original.id)).orderBy(s.jobInputs.ordinal).all()
        const bindings = tx.select().from(s.deliveryBindings).where(eq(s.deliveryBindings.jobId, original.id)).orderBy(s.deliveryBindings.outputIndex).all()
        const outputCount = typeof stored.n === 'number' ? stored.n : 1
        const targets: GenerationTarget[] = bindings.filter(binding => binding.outputIndex < outputCount).map(binding => {
          if (binding.targetKind === 'slot') return { outputIndex: binding.outputIndex, kind: 'slot', slotId: binding.slotId! }
          const slot = binding.createdNodeId && tx.select({ id: s.slots.id }).from(s.slots)
            .where(and(eq(s.slots.nodeId, binding.createdNodeId), eq(s.slots.slotKey, 'main'))).get()
          if (slot) return { outputIndex: binding.outputIndex, kind: 'slot', slotId: slot.id }
          const nearNodeId = (binding.placement as { nearNodeId?: string } | null)?.nearNodeId
          return { outputIndex: binding.outputIndex, kind: 'new_node', ...(nearNodeId ? { nearNodeId } : {}) }
        })
        const { prompt, frameRefs, resolvedPrompt: _resolvedPrompt, providerConfiguration: _configuration, actualPrompt: _actualPrompt, ...providerParams } = stored
        const frames = frameRefs as MethodParams<'generation.submit'>['frames']
        return submitJob(tx, caller, {
          requestId: params.requestId, kind: original.kind, provider: original.provider, model: original.model,
          operation: original.operation,
          prompt, params: providerParams, inputs: (frames ? inputs.slice(0, -(frames.last ? 2 : 1)) : inputs).map(input => input.assetVersionId ? { assetVersionId: input.assetVersionId } : { slotId: input.slotId!, revision: input.slotRevision! }), ...(frames ? { frames } : {}), targets,
        }, { ...ctx, source: { job: original, adapter } })
      })
    },

    usage() {
      const date = localDate(now())
      const usage = deps.quota?.usage(now()) ?? {
        date, image: paidJobCount(db, date, 'image'), video: paidJobCount(db, date, 'video'), audio: paidJobCount(db, date, 'audio'),
        agent: { image: paidJobCount(db, date, 'image', true), video: paidJobCount(db, date, 'video', true), audio: paidJobCount(db, date, 'audio', true) },
      }
      const jobs = usage.jobs ?? db.select({ id: s.generationJobs.id }).from(s.generationJobs)
        .where(eq(s.generationJobs.quotaDate, date)).orderBy(s.generationJobs.createdAt).all().map(job => readJobView(db, job.id)!)
      return { ...usage, limits, jobs }
    },

    async get({ jobId, waitMs }) {
      const view = readJobView(db, jobId)
      if (!view) throw VisError.of('not_found', 'generation.job_not_found', { jobId }, `Generation job ${jobId} does not exist`)
      if (!waitMs || TERMINAL_STATUSES.includes(view.status)) return view
      await new Promise<void>(resolve => {
        const wakeUp = () => { clearTimeout(t); resolve() }
        const t = setTimeout(() => { waiters.get(jobId)?.delete(wakeUp); resolve() }, Math.min(waitMs, GENERATION_MAX_WAIT_MS))
        const set = waiters.get(jobId) ?? new Set()
        set.add(wakeUp)
        waiters.set(jobId, set)
      })
      return readJobView(db, jobId)!
    },

    pump,

    start() {
      if (started) return
      started = true
      for (const id of [...runner.activeJobIds(), ...runner.terminalCleanupJobIds()]) if (!schedules.has(id)) schedule(id, 0)
      wake()
    },

    async stop() {
      started = false
      if (timer) clearTimeout(timer)
      timer = undefined
      await Promise.all(inflight)
    },
  }
}
