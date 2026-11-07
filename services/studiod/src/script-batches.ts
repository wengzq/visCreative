import { panelFrameCandidates, previzFrameOps } from './previz-frames'
import { currentShotNode } from './script-batch-plan'
import type { CanvasService } from '@vis/canvas-core'
import { newId, VisError } from '@vis/domain'
import { readEntity } from '@vis/library-core'
import { isPaidProvider, referenceImageLimit, type GenerationService, type ProviderAdapter, type ProviderDefaults } from '@vis/generation'
import { BATCH_APPROVAL_TTL_MS, DAILY_LIMIT_KEY, type ApprovalPayload, type BatchStep, type BatchView, type MethodParams } from '@vis/protocol'
import { and, appendEvent, eq, inArray, isNull, runIdempotent, sql, spaceSchema as s, type SpaceDb, type SpaceTx } from '@vis/storage'
import { readSessionSummary, upsertItem } from '@vis/workbench-core'
import type { MediaTaskService } from './media-tasks'
import { planScriptBatch, type BatchCatalog, type BatchParams, type BatchPlan, type NodeSource, type PlannedStep } from './script-batch-plan'

type Execution = {
  params: BatchParams
  plan: BatchPlan
  approvalId?: string
  turnId?: string
  submissions: Record<string, MethodParams<'generation.submit'>>
  extractions: Record<string, MethodParams<'media.process'>>
}
type RecordView = { view: BatchView; execution: Execution }
type PumpState = { active: boolean; approvalAt: number }
const POLLING_STATUSES: BatchView['status'][] = ['pending_approval', 'running']
const ACTIVE_STATUSES: BatchView['status'][] = [...POLLING_STATUSES, 'paused']
const active = (view: BatchView) => ACTIVE_STATUSES.includes(view.status)
const done = (step: BatchStep) => ['succeeded', 'failed', 'skipped', 'cancelled'].includes(step.status)
const user = { sessionId: null, turnId: null, inputSnapshotId: null, settingsResolved: true }

export function createScriptBatchService(deps: {
  db: SpaceDb
  canvas: CanvasService
  generation: GenerationService
  mediaTasks: MediaTaskService
  providers: ProviderAdapter[]
  defaults: ProviderDefaults
  now?: () => number
}) {
  const { db, canvas, generation, mediaTasks } = deps
  const now = deps.now ?? Date.now
  let providers = deps.providers
  let defaults = deps.defaults
  let timer: ReturnType<typeof setTimeout> | undefined
  let started = false
  let inflight: Promise<void> | undefined
  let pendingImmediate = false
  const waiters = new Map<string, Set<() => void>>()
  const pendingRevisions = new Map<string, { revision: number | null; changedShotIds: string[] }>()

  function catalog(): BatchCatalog {
    return {
      defaults,
      providers: providers.map(provider => ({
        id: provider.id, paid: isPaidProvider(provider),
        defaultModels: provider.defaultModels,
        models: provider.kinds.flatMap(kind => provider.models
          .filter(model => provider.configuration ? provider.configuration[`${kind}Models`].some(entry => entry.id === model) : model === provider.defaultModels[kind])
          .map(id => ({ id, kind, frameModes: provider.frameModesFor?.(kind, id) ?? [],
            referenceImageLimit: referenceImageLimit(provider, kind, id) }))),
      })),
    }
  }
  function read(batchId: string, tx: SpaceTx = db): RecordView {
    const row = tx.select().from(s.scriptBatches).where(eq(s.scriptBatches.id, batchId)).get()
    if (!row) throw VisError.of('not_found', 'script.batch_not_found', {}, 'Script batch does not exist')
    return { view: row.view, execution: row.execution as Execution }
  }
  function records(tx: SpaceTx = db) {
    return tx.select().from(s.scriptBatches).orderBy(s.scriptBatches.updatedAt).all().map(row => ({ view: row.view, execution: row.execution as Execution }))
  }
  function pendingChanges(record: RecordView) {
    if (record.view.status !== 'pending_approval') return
    const revision = db.select({ revision: s.slots.currentRevision }).from(s.slots).innerJoin(s.nodes, eq(s.nodes.id, s.slots.nodeId))
      .where(and(eq(s.nodes.id, record.view.scriptNodeId), eq(s.slots.slotKey, 'main'), isNull(s.nodes.deletedAt), isNull(s.slots.deletedAt))).get()?.revision ?? null
    const cached = pendingRevisions.get(record.view.batchId)
    if (cached?.revision === revision) {
      record.view.changedShotIds = [...cached.changedShotIds]
      return
    }
    const node = canvas.get({ nodeIds: [record.view.scriptNodeId] }).nodes[0]
    const content = node?.slots.find(slot => slot.slotKey === 'main')?.content
    const selected = record.execution.params.shotIds
    const current = Object.fromEntries(content?.type === 'script'
      ? content.doc.shots.filter(shot => !selected || selected.includes(shot.id)).map(shot => [shot.id, shot.rev])
      : [])
    const requested = record.execution.plan.revisions
    record.view.changedShotIds = [...new Set([...Object.keys(requested), ...Object.keys(current)])].filter(id => requested[id] !== current[id])
    pendingRevisions.set(record.view.batchId, { revision, changedShotIds: [...record.view.changedShotIds] })
  }
  function write(record: RecordView, tx: SpaceTx = db, previous?: string) {
    if (record.view.status !== 'pending_approval') pendingRevisions.delete(record.view.batchId)
    const existing = previous ?? (() => {
      const row = tx.select().from(s.scriptBatches).where(eq(s.scriptBatches.id, record.view.batchId)).get()
      return row ? JSON.stringify({ view: row.view, execution: row.execution }) : undefined
    })()
    if (existing === JSON.stringify(record)) return
    tx.insert(s.scriptBatches).values({ id: record.view.batchId, view: record.view, execution: record.execution, updatedAt: now() })
      .onConflictDoUpdate({ target: s.scriptBatches.id, set: { view: record.view, execution: record.execution, updatedAt: now() } }).run()
    appendEvent(tx, { type: 'scriptBatch.stateChanged', entityType: 'scriptBatch', entityId: record.view.batchId, payload: record.view }, now())
    for (const wake of waiters.get(record.view.batchId) ?? []) wake()
    waiters.delete(record.view.batchId)
  }
  function persist(record: RecordView, expected: BatchView['status'] = 'running') {
    return db.transaction(tx => {
      const current = read(record.view.batchId, tx)
      if (current.view.status !== expected) {
        Object.assign(record, current)
        return false
      }
      write(record, tx, JSON.stringify(current))
      return true
    }, { behavior: 'immediate' })
  }
  function afterAwait(record: RecordView, update: () => void) {
    db.transaction(tx => {
      const current = read(record.view.batchId, tx)
      const previous = JSON.stringify(current)
      Object.assign(record, current)
      if (current.view.status !== 'running') return
      update()
      write(record, tx, previous)
    }, { behavior: 'immediate' })
  }
  function remaining(kind: 'image' | 'video') {
    const usage = generation.usage()
    const limit = usage.limits[DAILY_LIMIT_KEY[kind]]
    return limit > 0 ? Math.max(0, limit - usage[kind]) : null
  }
  function plan(params: BatchParams, refresh = false, materialize = false): BatchPlan {
    let nodes = canvas.get({}).nodes
    const node = nodes.find(node => node.nodeId === params.scriptNodeId)
    const slot = node?.slots.find(slot => slot.slotKey === 'main')
    if (node?.kind !== 'script' || slot?.content.type !== 'script') throw VisError.of('invalid_params', 'script.slot_required', {}, 'A script node is required')
    const ids = new Set(slot.content.doc.shots.map(shot => shot.id))
    const current = refresh ? {
      ...params,
      ...(params.shotIds ? { shotIds: params.shotIds.filter(id => ids.has(id)) } : {}),
      ...(params.strictShotIds ? { strictShotIds: params.strictShotIds.filter(id => ids.has(id) && slot.content.type === 'script' && slot.content.doc.shots.find(shot => shot.id === id)?.transition === 'continuous') } : {}),
    } : params
    const candidates = panelFrameCandidates(nodes, params.scriptNodeId, slot.content.doc.shots.filter(shot => !current.shotIds || current.shotIds.includes(shot.id)).map(shot => shot.id))
    for (const { node: previz, panel } of candidates) {
      const role = panel.frameRole === 'last' ? 'last' : 'first'
      const existing = currentShotNode(nodes, params.scriptNodeId, panel.shot!.shotId, role)
      const content = existing?.slots.find(slot => slot.slotKey === 'main')?.content
      if (content?.type === 'asset' && content.assetVersionId === panel.image) continue
      if (materialize) {
        canvas.apply({ kind: 'user' }, { requestId: `previz-frame-${newId('job')}`, ops: previzFrameOps(previz, panel, 'frame', nodes) })
        nodes = canvas.get({}).nodes
      } else {
        // Dry runs model the free materialization without changing the canvas.
        nodes = [...nodes.filter(node => node !== existing), { ...previz, nodeId: `node_zzzzzzzzzz_${panel.id}`, kind: 'image',
          shot: { ...panel.shot!, role }, slots: [{ slotId: `preview_${panel.id}`, slotKey: 'main', contentType: 'image', revision: 1,
            content: { type: 'asset', assetVersionId: panel.image!, mime: 'image/png' } }] }]
      }
    }
    const idsToRead = [...(slot.content.doc.castIds ?? []), ...(slot.content.doc.styleId ? [slot.content.doc.styleId] : [])]
    const settings = idsToRead.map(id => readEntity(db, id)).filter(setting => setting.deletedAt === undefined)
    return planScriptBatch(slot.content.doc, nodes, current, catalog(), remaining(params.media === 'frames' ? 'image' : 'video'), settings)
  }
  function approval(record: RecordView, status: ApprovalPayload['status'], tx: SpaceTx) {
    if (!record.execution.approvalId || !record.view.sessionId) return
    const existing = tx.select().from(s.transcriptEntries).where(and(eq(s.transcriptEntries.sessionId, record.view.sessionId), eq(s.transcriptEntries.itemId, record.execution.approvalId))).get()
    const payload: ApprovalPayload = {
      approvalId: record.execution.approvalId, kind: 'generation_batch', batchId: record.view.batchId,
      summary: `Generate ${record.view.estimate.jobs} jobs for ${record.view.estimate.shots} shots`,
      detail: JSON.stringify(record.view.estimate), status,
    }
    upsertItem(tx, {
      sessionId: record.view.sessionId, turnId: record.execution.turnId ?? null, itemId: payload.approvalId,
      revision: (existing?.revision ?? 0) + 1, kind: 'approval', payload,
    }, now())
    appendEvent(tx, { type: 'session.updated', entityType: 'session', entityId: record.view.sessionId, payload: readSessionSummary(tx, record.view.sessionId) }, now())
  }
  function expire(record: RecordView) {
    if (record.view.status !== 'pending_approval' || now() - record.view.createdAt < BATCH_APPROVAL_TTL_MS) return
    db.transaction(tx => {
      Object.assign(record, read(record.view.batchId, tx))
      if (record.view.status !== 'pending_approval' || now() - record.view.createdAt < BATCH_APPROVAL_TTL_MS) return
      record.view.status = 'expired'
      approval(record, 'expired', tx)
      write(record, tx)
    }, { behavior: 'immediate' })
    schedule()
  }
  function owned(batchId: string, sessionId?: string) {
    const record = read(batchId)
    if (sessionId && record.view.sessionId !== sessionId) throw VisError.of('forbidden', 'script.batch_other_session', {}, 'Agents can only cancel batches started by their own session')
    return record
  }
  function viewStep(record: RecordView, key: string): BatchStep {
    const step = record.execution.plan.steps.find(step => step.key === key)!
    return record.view.shots.find(shot => shot.shotId === step.shotId)!.steps.find(view => view.role === step.role)!
  }
  function resolveNode(record: RecordView, source: NodeSource) {
    const nodeId = 'nodeId' in source ? source.nodeId : viewStep(record, source.step).nodeId
    const node = canvas.get({ nodeIds: nodeId ? [nodeId] : [] }).nodes.find(node => node.nodeId === nodeId)
    if (!node) throw VisError.of('not_found', 'script.batch_input_missing', {}, 'A batch input node no longer exists')
    return node
  }
  function mainSlot(record: RecordView, source: NodeSource) {
    const slot = resolveNode(record, source).slots.find(slot => slot.slotKey === 'main')
    if (!slot) throw VisError.of('not_found', 'script.batch_input_missing', {}, 'A batch input slot no longer exists')
    return slot
  }
  function createTarget(record: RecordView, step: PlannedStep) {
    const view = viewStep(record, step.key)
    if (view.nodeId) return
    const requestId = `${record.view.batchId}:${step.key}:node`
    const existing = db.select().from(s.idempotencyKeys).where(eq(s.idempotencyKeys.requestId, requestId)).get()
    if (existing) {
      view.nodeId = (existing.result as { idMap: Record<string, string> }).idMap.target!
      return
    }
    const script = canvas.get({ nodeIds: [record.view.scriptNodeId] }).nodes[0]
    if (!script) throw VisError.of('not_found', 'script.batch_input_missing', {}, 'The batch script node no longer exists')
    const index = record.view.shots.findIndex(shot => shot.shotId === step.shotId)
    const content = script.slots.find(slot => slot.slotKey === 'main')?.content
    const shotNumber = content?.type === 'script' ? content.doc.shots.findIndex(shot => shot.id === step.shotId) + 1 : index + 1
    const result = canvas.apply({ kind: 'user' }, {
      requestId,
      ops: [{
        op: 'node.create', tempId: 'target', kind: step.role === 'video' ? 'video' : 'image',
        x: script.x + script.w + 80 + index * 400, y: script.y + { first: 0, last: 360, video: 720 }[step.role],
        // Backend has no locale context; these durable canvas titles follow the RFC's fixed Chinese fallback.
        category: '\u955c\u5934', title: `\u955c\u5934 ${shotNumber} \u00b7 ${{ first: '\u9996\u5e27', last: '\u5c3e\u5e27', video: '\u89c6\u9891' }[step.role]}`,
        shot: { scriptNodeId: record.view.scriptNodeId, shotId: step.shotId, role: step.role },
        prompt: step.prompt,
        inputNodeIds: [...new Set([...step.inputs, ...(step.frames ? [step.frames.first, ...(step.frames.last ? [step.frames.last] : [])] : []), ...(step.extractFrom ? [step.extractFrom] : [])].flatMap(source => 'assetVersionId' in source ? [] : [resolveNode(record, source).nodeId]))],
        ...(step.source === 'generate' ? { generation: { provider: step.provider, model: step.model } } : {}),
      }],
    })
    view.nodeId = result.idMap.target!
  }
  function fail(view: BatchStep, error: unknown) {
    view.status = 'failed'
    delete view.blockedBy
    view.error = error instanceof VisError
      ? { code: String(error.details?.reason ?? error.code), message: error.message }
      : { code: 'script.batch_step_failed', message: 'Batch step failed' }
  }
  async function advance(record: RecordView, step: PlannedStep) {
    let view = viewStep(record, step.key)
    if (done(view)) return
    const dependencies = step.dependencies.map(key => viewStep(record, key))
    if (dependencies.some(dependency => ['failed', 'skipped', 'cancelled'].includes(dependency.status))) {
      view.status = 'skipped'
      delete view.blockedBy
      persist(record)
      return
    }
    if (dependencies.some(dependency => dependency.status !== 'succeeded')) return
    delete view.blockedBy
    try {
      if (step.source === 'extract') {
        const source = step.extractFrom!
        const slot = mainSlot(record, source)
        if (!record.execution.extractions[step.key]) {
          if (slot.content.type !== 'asset') throw VisError.of('invalid_params', 'script.batch_input_missing', {}, 'The previous video has no asset')
          const asset = db.select().from(s.assetVersions).where(eq(s.assetVersions.id, slot.content.assetVersionId)).get()
          if (!asset?.durationMs) throw VisError.of('invalid_params', 'media.duration_missing', {}, 'The previous video has no duration')
          record.execution.extractions[step.key] = {
            requestId: `${record.view.batchId}:${step.key}:extract`, nodeId: resolveNode(record, source).nodeId,
            slotId: slot.slotId, expectedRevision: slot.revision, operation: 'video.frame',
            params: { atMs: asset.durationMs },
          }
        }
        if (!persist(record)) return
        const existingTask = db.select().from(s.mediaTasks).where(eq(s.mediaTasks.requestId, record.execution.extractions[step.key]!.requestId)).get()
        if (existingTask) mediaTasks.recoverInterrupted(existingTask.id)
        const task = await mediaTasks.process({ kind: 'user' }, record.execution.extractions[step.key]!)
        afterAwait(record, () => {
          view = viewStep(record, step.key)
          view.mediaTaskId = task.taskId
          view.status = task.status === 'succeeded' ? 'succeeded' : task.status === 'failed' ? 'failed' : 'running'
          if (task.error) view.error = task.error
          if (task.status === 'succeeded') {
            view.nodeId = task.nodeIds![0]!
            const requestId = `${record.view.batchId}:${step.key}:fill`
            if (!db.select().from(s.idempotencyKeys).where(eq(s.idempotencyKeys.requestId, requestId)).get()) {
              const script = canvas.get({ nodeIds: [record.view.scriptNodeId] }).nodes[0]
              if (!script) throw VisError.of('not_found', 'script.batch_input_missing', {}, 'The batch script node no longer exists')
              const content = script.slots.find(slot => slot.slotKey === 'main')?.content
              const index = record.view.shots.findIndex(shot => shot.shotId === step.shotId)
              const shotNumber = content?.type === 'script' ? content.doc.shots.findIndex(shot => shot.id === step.shotId) + 1 : index + 1
              canvas.apply({ kind: 'user' }, {
                requestId,
                ops: [
                  { op: 'node.setMeta', nodeId: view.nodeId, category: '\u955c\u5934', title: `\u955c\u5934 ${shotNumber} \u00b7 \u9996\u5e27`, shot: { scriptNodeId: record.view.scriptNodeId, shotId: step.shotId, role: 'first' } },
                  { op: 'node.layout', nodeId: view.nodeId, x: script.x + script.w + 80 + index * 400, y: script.y },
                ],
              })
            }
          }
        })
        return
      } else if (!view.jobId) {
        createTarget(record, step)
        if (!record.execution.submissions[step.key]) {
          const target = mainSlot(record, { nodeId: view.nodeId! })
          const ref = (source: NodeSource) => { const slot = mainSlot(record, source); return { slotId: slot.slotId, revision: slot.revision } }
          record.execution.submissions[step.key] = {
            requestId: `${record.view.batchId}:${step.key}`, kind: step.role === 'video' ? 'video' : 'image',
            provider: step.provider, model: step.model, prompt: step.prompt, params: { n: 1 },
            inputs: step.inputs.map(source => 'assetVersionId' in source ? { assetVersionId: source.assetVersionId } : ref(source)),
            ...(step.frames ? { frames: { first: ref(step.frames.first), ...(step.frames.last ? { last: ref(step.frames.last) } : {}) } } : {}),
            targets: [{ kind: 'slot', outputIndex: 0, slotId: target.slotId, expectedRevision: target.revision }],
          }
        }
        if (!persist(record)) return
        const submission = record.execution.submissions[step.key]!
        // A crash after submit but before saving jobId must replay before checking today's remaining quota.
        const submitted = db.select().from(s.idempotencyKeys).where(eq(s.idempotencyKeys.requestId, submission.requestId)).get()
        const provider = providers.find(provider => provider.id === step.provider)
        if (!submitted && (!provider || isPaidProvider(provider)) && remaining(submission.kind === 'video' ? 'video' : 'image') === 0) {
          record.view.status = 'paused'
          record.view.pausedReason = 'quota'
          view.status = 'queued'
          view.blockedBy = 'quota'
        } else {
          // User-approved batches count toward total usage, but reserve no Agent quota.
          const job = generation.submit(user, submission)
          view.jobId = job.jobId
          view.status = 'running'
        }
      } else {
        const job = await generation.get({ jobId: view.jobId })
        afterAwait(record, () => {
          view = viewStep(record, step.key)
          if (job.status === 'succeeded') {
            if (job.outputs.some(output => output.delivery.status === 'delivered')) view.status = 'succeeded'
            else fail(view, VisError.of('invalid_params', 'script.batch_delivery_failed', {}, 'The generated output could not be delivered to its target'))
          } else if (['failed', 'cancelled', 'unknown'].includes(job.status)) {
            view.status = 'failed'
            view.error = job.error ?? { code: 'script.batch_job_failed', message: 'Generation job did not succeed' }
          }
        })
        return
      }
    } catch (error) {
      if (error instanceof VisError && error.code === 'quota_exceeded') {
        record.view.status = 'paused'
        record.view.pausedReason = 'quota'
        view.status = 'queued'
        view.blockedBy = 'quota'
      } else fail(view, error)
    }
    persist(record)
  }
  function observe(state: PumpState, view: Pick<BatchView, 'status' | 'createdAt'>) {
    if (POLLING_STATUSES.includes(view.status)) state.active = true
    if (view.status === 'pending_approval') state.approvalAt = Math.min(state.approvalAt, view.createdAt + BATCH_APPROVAL_TTL_MS)
  }
  async function runPump(): Promise<PumpState> {
    const state: PumpState = { active: false, approvalAt: Infinity }
    const ids = db.select({ id: s.scriptBatches.id }).from(s.scriptBatches)
      .where(inArray(sql`json_extract(${s.scriptBatches.view}, '$.status')`, POLLING_STATUSES))
      .orderBy(s.scriptBatches.updatedAt).all()
    for (const { id } of ids) {
      const record = read(id)
      expire(record)
      if (record.view.status === 'pending_approval') {
        // Derived row changes need an event even when the approval itself is still pending.
        pendingChanges(record)
        persist(record, 'pending_approval')
      } else if (record.view.status === 'running') {
        for (const step of record.execution.plan.steps) {
          if (record.view.status !== 'running') break
          await advance(record, step)
        }
        if (record.view.status === 'running' && record.view.shots.every(shot => shot.steps.every(done))) {
          record.view.status = record.view.shots.some(shot => shot.steps.some(step => step.status === 'failed')) ? 'failed' : 'succeeded'
          persist(record)
        }
      }
      observe(state, record.view)
    }
    return state
  }
  function fallback(error: unknown) {
    console.error('[script-batch] scheduling failed', error)
    if (timer) clearTimeout(timer)
    timer = started ? setTimeout(tick, pendingImmediate ? 0 : 100) : undefined
    pendingImmediate = false
  }
  function pump(): Promise<void> {
    if (!inflight) {
      let state: PumpState | undefined
      let failure: unknown
      // Set inflight before expiry or other synchronous pump work can request another schedule.
      inflight = Promise.resolve().then(runPump)
        .then(result => { state = result }, error => { failure = error; throw error })
        .finally(() => {
          inflight = undefined
          if (state) schedule(false, state)
          else fallback(failure)
        })
    }
    return inflight
  }
  function schedule(immediate = false, state?: PumpState) {
    pendingImmediate ||= immediate
    if (timer) clearTimeout(timer)
    timer = undefined
    if (!started || inflight) return
    try {
      // Mutations during an await may add batches outside this pump's snapshot.
      if (!state || pendingImmediate) {
        state = { active: false, approvalAt: Infinity }
        const batches = db.select({
          status: sql<BatchView['status']>`json_extract(${s.scriptBatches.view}, '$.status')`,
          createdAt: sql<number>`json_extract(${s.scriptBatches.view}, '$.createdAt')`,
        }).from(s.scriptBatches)
          .where(inArray(sql`json_extract(${s.scriptBatches.view}, '$.status')`, POLLING_STATUSES)).all()
        for (const batch of batches) observe(state, batch)
      }
      if (state.active) timer = setTimeout(tick, pendingImmediate ? 0 : Math.max(0, Math.min(100, state.approvalAt - now())))
      pendingImmediate = false
    } catch (error) { fallback(error) }
  }
  function tick() {
    timer = undefined
    if (!started) return
    void pump().catch(() => {})
  }
  function action(method: 'approve' | 'reject' | 'resume', params: { batchId: string; requestId: string }) {
    expire(read(params.batchId))
    runIdempotent(db, { requestId: params.requestId, method: `script.batch.${method}`, params }, tx => {
      const record = read(params.batchId, tx)
      const expected = method === 'resume' ? 'paused' : 'pending_approval'
      if (record.view.status !== expected) throw VisError.of('invalid_params', 'script.batch_status', {}, 'The batch is not in the required state')
      if (method === 'approve') {
        const next = plan(record.execution.params, true, true)
        record.view.changedShotIds = [...new Set([...Object.keys(record.execution.plan.revisions), ...Object.keys(next.revisions)])].filter(id => record.execution.plan.revisions[id] !== next.revisions[id])
        record.execution.plan = next
        record.view.estimate = next.view.estimate
        record.view.shots = next.view.shots
        approval(record, 'approved', tx)
      } else if (method === 'reject') approval(record, 'denied', tx)
      record.view.status = method === 'reject' ? 'rejected' : 'running'
      delete record.view.pausedReason
      for (const shot of record.view.shots) for (const step of shot.steps) if (step.blockedBy === 'quota') delete step.blockedBy
      write(record, tx)
      return { batchId: params.batchId }
    }, now)
    schedule(true)
    return read(params.batchId).view
  }
  function cancelRecord(record: RecordView, tx: SpaceTx) {
    if (!active(record.view)) return
    if (record.view.status === 'pending_approval') approval(record, 'denied', tx)
    record.view.status = 'cancelled'
    delete record.view.pausedReason
    for (const shot of record.view.shots) for (const step of shot.steps) if (!done(step)) { step.status = 'cancelled'; delete step.blockedBy }
    write(record, tx)
  }
  async function cancelJobs(record: RecordView) {
    for (const shot of record.view.shots) for (const step of shot.steps) {
      if (step.status !== 'cancelled') continue
      const extraction = record.execution.extractions[`${shot.shotId}:${step.role}`]
      const taskId = step.mediaTaskId ?? (extraction ? db.select({ id: s.mediaTasks.id }).from(s.mediaTasks).where(eq(s.mediaTasks.requestId, extraction.requestId)).get()?.id : undefined)
      if (taskId) mediaTasks.cancelTask(taskId)
      if (step.jobId) {
        const job = await generation.get({ jobId: step.jobId })
        if (!['succeeded', 'failed', 'unknown', 'cancelled'].includes(job.status)) await generation.cancel(user, { requestId: `${record.view.batchId}:${step.jobId}:cancel`, jobId: step.jobId })
      }
    }
  }

  return {
    configure(next: ProviderAdapter[], nextDefaults: ProviderDefaults) { providers = next; defaults = nextDefaults },
    plan: (params: BatchParams) => plan(params).view,
    start(params: MethodParams<'script.batch.start'>, agent?: { sessionId: string; turnId: string }) {
      const { requestId, ...batchParams } = params
      const result = runIdempotent(db, { requestId, method: 'script.batch.start', params: { ...params, agent } }, tx => {
        const planned = plan(batchParams, false, !agent)
        const batchId = `batch_${newId('job').slice(4)}`
        const record: RecordView = {
          view: { ...planned.view, batchId, status: agent ? 'pending_approval' : 'running', origin: agent ? 'agent' : 'user', ...(agent ? { sessionId: agent.sessionId } : {}), media: params.media, createdAt: now() },
          execution: { params: batchParams, plan: planned, submissions: {}, extractions: {}, ...(agent ? { approvalId: newId('transcriptItem', now()), turnId: agent.turnId } : {}) },
        }
        if (agent) approval(record, 'pending', tx)
        write(record, tx)
        return { batchId }
      }, now)
      schedule(true)
      return read(result.batchId).view
    },
    async get(params: MethodParams<'script.batch.get'>) {
      const record = read(params.batchId)
      expire(record)
      if (params.waitMs && active(record.view)) await new Promise<void>(resolve => {
        const wake = () => { clearTimeout(timeout); waiters.get(params.batchId)?.delete(wake); resolve() }
        const timeout = setTimeout(wake, params.waitMs)
        const set = waiters.get(params.batchId) ?? new Set()
        set.add(wake)
        waiters.set(params.batchId, set)
      })
      const current = read(params.batchId)
      expire(current)
      pendingChanges(current)
      return current.view
    },
    list(params: MethodParams<'script.batch.list'>) {
      const all = records()
      for (const record of all) { expire(record); pendingChanges(record) }
      return { batches: all.map(record => record.view).filter(view => (!params.scriptNodeId || view.scriptNodeId === params.scriptNodeId) && (!params.activeOnly || active(view))) }
    },
    approve: (params: MethodParams<'script.batch.approve'>) => action('approve', params),
    reject: (params: MethodParams<'script.batch.reject'>) => action('reject', params),
    resume: (params: MethodParams<'script.batch.resume'>) => action('resume', params),
    async cancelSession(sessionId: string) {
      const cancelled = db.transaction(tx => {
        const rows = tx.select().from(s.scriptBatches).where(and(sql`json_extract(${s.scriptBatches.view}, '$.origin') = 'agent'
          and json_extract(${s.scriptBatches.view}, '$.sessionId') = ${sessionId}`,
        inArray(sql`json_extract(${s.scriptBatches.view}, '$.status')`, [...ACTIVE_STATUSES, 'cancelled']))).all()
        return rows.map(row => {
          const record = { view: row.view, execution: row.execution as Execution }
          cancelRecord(record, tx)
          return record
        })
      }, { behavior: 'immediate' })
      schedule(true)
      await Promise.all(cancelled.map(cancelJobs))
    },
    async cancel(params: MethodParams<'script.batch.cancel'>, sessionId?: string) {
      owned(params.batchId, sessionId)
      runIdempotent(db, { requestId: params.requestId, method: 'script.batch.cancel', params }, tx => {
        const record = read(params.batchId, tx)
        cancelRecord(record, tx)
        return { batchId: params.batchId }
      }, now)
      schedule(true)
      const record = read(params.batchId)
      await cancelJobs(record)
      return record.view
    },
    pump,
    startScheduler() { if (!started) { started = true; tick() } },
    async stop() {
      started = false
      if (timer) clearTimeout(timer)
      timer = undefined
      await inflight
      for (const set of waiters.values()) for (const wake of set) wake()
    },
  }
}
export type ScriptBatchService = ReturnType<typeof createScriptBatchService>
