import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { copyFile, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { createFfmpegMedia, type AssetStore, type MediaTools, type ProcessedMedia, type StagedBlob } from '@vis/assets'
import { applyOps, readNodes, type Actor } from '@vis/canvas-core'
import { newId, ulid, VisError } from '@vis/domain'
import { LOCAL_OPERATION_OUTPUT, MEDIA_EXPORT_RETENTION_MS, MEDIA_MAX_WAIT_MS, MEDIA_TASK_TIMEOUT_MS, operationKind, type CanvasOp, type MediaTaskProgress, type MediaTaskView, type MethodParams } from '@vis/protocol'
import { and, appendEvent, eq, inArray, isNotNull, runIdempotent, spaceSchema as s, type SpaceDb, type SpaceTx } from '@vis/storage'
import { findInstanceTurn } from './auth'
import { exportTimeline, type TimelineExportTools } from './timeline-export'

type Task = typeof s.mediaTasks.$inferSelect

const cancelled = () => VisError.of('unavailable', 'media.cancelled', {}, 'Local media processing was cancelled because its turn is no longer active')

/** Each scheduler shares its slots across spaces, independently of generation and agent execution. */
export class MediaScheduler {
  private running = 0
  private readonly queue: { owner: object; run: () => Promise<void>; resolve: () => void }[] = []

  constructor(private readonly concurrency = 2) {}

  enqueue(owner: object, run: () => Promise<void>): Promise<void> {
    return new Promise(resolve => {
      this.queue.push({ owner, run, resolve })
      queueMicrotask(() => this.drain())
    })
  }

  remove(owner: object) {
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (this.queue[i]!.owner === owner) this.queue.splice(i, 1)[0]!.resolve()
    }
  }

  private drain() {
    while (this.running < this.concurrency && this.queue.length) {
      const entry = this.queue.shift()!
      this.running++
      const done = () => {
        this.running--
        entry.resolve()
        this.drain()
      }
      void entry.run().then(done, done)
    }
  }
}

export function createMediaLimiter(slots: MediaScheduler, owner: object, isStopped: () => boolean, interrupted: () => VisError) {
  const inflight = new Set<Promise<void>>()
  function enqueue(task: () => Promise<void>) {
    const pending = slots.enqueue(owner, task)
    inflight.add(pending)
    void pending.then(() => { inflight.delete(pending) })
    return pending
  }
  return {
    enqueue,
    async limit<T>(task: () => Promise<T>): Promise<T> {
      if (isStopped()) throw interrupted()
      let outcome: { value: T } | { error: unknown } | undefined
      await enqueue(async () => {
        if (isStopped()) return
        try { outcome = { value: await task() } } catch (error) { outcome = { error } }
      })
      if (!outcome) throw interrupted()
      if ('error' in outcome) throw outcome.error
      return outcome.value
    },
    async drain() {
      slots.remove(owner)
      await Promise.all(inflight)
    },
  }
}

const scheduler = new MediaScheduler()

export function readMediaTask(tx: SpaceTx, taskId: string): MediaTaskView {
  const task = tx.select().from(s.mediaTasks).where(eq(s.mediaTasks.id, taskId)).get()
  if (!task) throw VisError.of('not_found', 'media.task_not_found', {}, 'Local media task does not exist')
  return {
    taskId: task.id, ...(task.sessionId ? { sessionId: task.sessionId } : {}), status: task.status, operation: task.operation, nodeId: task.nodeId, slotId: task.slotId, createdAt: task.createdAt,
    ...(task.progress !== null ? { progress: task.progress } : {}),
    ...(task.assetVersionIds ? { assetVersionIds: task.assetVersionIds } : {}),
    ...(task.nodeIds ? { nodeIds: task.nodeIds } : {}),
    ...(task.download ? { download: task.download } : {}),
    ...(task.operationId ? { operationId: task.operationId } : {}),
    ...(task.error ? { error: task.error } : {}),
  }
}

export function readActiveMediaTasks(tx: SpaceTx): MediaTaskView[] {
  return tx.select({ id: s.mediaTasks.id }).from(s.mediaTasks).where(inArray(s.mediaTasks.status, ['queued', 'running']))
    .orderBy(s.mediaTasks.createdAt).all().map(task => readMediaTask(tx, task.id))
}

export function hasActiveMediaTasks(tx: SpaceTx): boolean {
  return tx.select({ id: s.mediaTasks.id }).from(s.mediaTasks).where(inArray(s.mediaTasks.status, ['queued', 'running'])).limit(1).get() !== undefined
}

export function createMediaTaskService(deps: { db: SpaceDb; assets: AssetStore; exportDir?: string; media?: MediaTools; timeline?: TimelineExportTools; now?: () => number; timeoutMs?: number; scheduler?: MediaScheduler; isTurnStopping?: (turnId: string) => boolean; onProgress?: (event: MediaTaskProgress) => void }) {
  const { db, assets } = deps
  const media = deps.media ?? createFfmpegMedia()
  const now = deps.now ?? Date.now
  const slots = deps.scheduler ?? scheduler
  const owner = {}
  const controllers = new Map<string, AbortController>()
  const turns = new Map<string, { turnId: string; instanceId: string }>()
  const progressByTask = new Map<string, number>()
  const inflightByTask = new Set<string>()
  const waiters = new Map<string, Set<() => void>>()
  let stopped = false
  const limiter = createMediaLimiter(slots, owner, () => stopped, () => VisError.of('unavailable', 'media.interrupted', {}, 'Local media processing was interrupted'))

  const exportPath = (taskId: string) => deps.exportDir ? join(deps.exportDir, `${taskId}.mov`) : undefined
  function exportTask(taskId: string) {
    const task = readMediaTask(db, taskId)
    if (task.operation !== 'video.exportMov') throw VisError.of('invalid_params', 'media.kind_mismatch', {}, 'This action requires a MOV export task')
    return task
  }
  function removeExport(taskId: string) {
    const path = exportPath(taskId)
    if (path) rmSync(path, { force: true })
    db.transaction(tx => {
      tx.update(s.mediaTasks).set({ download: null }).where(eq(s.mediaTasks.id, taskId)).run()
      emit(tx, taskId)
    }, { behavior: 'immediate' })
  }
  function cleanExports(all = false) {
    for (const task of db.select({ id: s.mediaTasks.id, download: s.mediaTasks.download }).from(s.mediaTasks).where(isNotNull(s.mediaTasks.download)).all()) {
      if (task.download && (all || task.download.expiresAt <= now())) removeExport(task.id)
    }
    if (all && deps.exportDir) rmSync(deps.exportDir, { recursive: true, force: true })
  }
  // Delivery files are disposable. A restart also clears files left between rename and DB commit.
  cleanExports(true)
  const expiry = setInterval(() => { try { cleanExports() } catch {} }, 60_000)
  expiry.unref()

  function emit(tx: SpaceTx, taskId: string) {
    appendEvent(tx, { type: 'mediaTask.stateChanged', entityType: 'mediaTask', entityId: taskId, payload: readMediaTask(tx, taskId) }, now())
  }

  function notify(taskId: string) {
    for (const wake of waiters.get(taskId) ?? []) wake()
    waiters.delete(taskId)
  }

  function fail(taskId: string, error: { code: string; message: string }) {
    db.transaction(tx => {
      const task = readMediaTask(tx, taskId)
      if (task.status === 'succeeded' || task.status === 'failed') return
      tx.update(s.mediaTasks).set({ status: 'failed', error, updatedAt: now() }).where(eq(s.mediaTasks.id, taskId)).run()
      emit(tx, taskId)
    }, { behavior: 'immediate' })
    progressByTask.delete(taskId)
    notify(taskId)
  }

  function sourceSlot(tx: SpaceTx, nodeId: string, slotId: string) {
    const node = readNodes(tx, [nodeId])[0]
    const slot = node?.slots.find(slot => slot.slotId === slotId)
    if (!node || !slot) throw VisError.of('not_found', 'media.source_not_found', {}, 'The source node or slot no longer exists')
    return { node, slot }
  }

  function source(tx: SpaceTx, nodeId: string, slotId: string) {
    const { node, slot } = sourceSlot(tx, nodeId, slotId)
    if (slot.content.type !== 'asset') throw VisError.of('invalid_params', 'media.asset_required', {}, 'The source slot must contain a media asset')
    const asset = assets.getVersion(tx, slot.content.assetVersionId)!
    return { node, slot, asset }
  }

  function authorize(tx: SpaceTx, sessionId: string | null) {
    if (sessionId === null) return
    const session = tx.select().from(s.sessions).where(eq(s.sessions.id, sessionId)).get()
    const work = session?.workItemId ? tx.select().from(s.workItems).where(eq(s.workItems.id, session.workItemId)).get() : undefined
    if (!session || session.archivedAt !== null || (session.workItemId && (!work || work.archivedAt !== null || work.status !== 'in_progress'))) throw VisError.of('forbidden', 'media.session_inactive', {}, 'Media writes require an active session and an executable linked work item')
    const turn = tx.select().from(s.turns).where(and(eq(s.turns.sessionId, sessionId), inArray(s.turns.status, ['running', 'waiting_user']))).get()
    if (!turn?.instanceId || findInstanceTurn(tx, turn.instanceId)?.turnId !== turn.id || deps.isTurnStopping?.(turn.id)) throw VisError.of('forbidden', 'runtime.turn_inactive', {}, 'Media writes require an active turn')
    return { turnId: turn.id, instanceId: turn.instanceId }
  }

  function assertCurrent(tx: SpaceTx, task: Task) {
    if (task.sessionId) {
      const turn = turns.get(task.id)
      if (!turn || findInstanceTurn(tx, turn.instanceId)?.turnId !== turn.turnId || deps.isTurnStopping?.(turn.turnId)) throw cancelled()
      try { authorize(tx, task.sessionId) } catch { throw cancelled() }
    }
    // Exports are pinned to history and survive edits or deletion of the timeline node.
    if (task.operation === 'timeline.export' || task.operation === 'video.exportMov') return
    const node = tx.select().from(s.nodes).where(eq(s.nodes.id, task.nodeId)).get()
    const slot = tx.select().from(s.slots).where(eq(s.slots.id, task.slotId)).get()
    if (LOCAL_OPERATION_OUTPUT[task.operation] === 'replace' &&
      (slot?.currentRevision !== task.expectedRevision || node?.layoutRevision !== task.sourceLayoutRevision)) {
      throw VisError.of('revision_conflict', 'media.revision_conflict', {}, 'The source node changed during media processing')
    }
    return source(tx, task.nodeId, task.slotId)
  }

  async function runTask(taskId: string) {
    const controller = new AbortController()
    controllers.set(taskId, controller)
    const timeout = setTimeout(() => controller.abort(VisError.of('unavailable', 'media.timeout', {}, 'Local media processing exceeded its time limit')), deps.timeoutMs ?? MEDIA_TASK_TIMEOUT_MS)
    let output: ProcessedMedia | undefined
    const staged: StagedBlob[] = []
    try {
      const task = db.select().from(s.mediaTasks).where(eq(s.mediaTasks.id, taskId)).get()!
      if (stopped || task.status !== 'queued') return
      db.transaction(tx => {
        tx.update(s.mediaTasks).set({ status: 'running', updatedAt: now() }).where(eq(s.mediaTasks.id, taskId)).run()
        emit(tx, taskId)
      }, { behavior: 'immediate' })
      let lastProgress = 0
      let lastPublished = -Infinity
      const options = {
        signal: controller.signal,
        onProgress(progress: number) {
          if (stopped || controller.signal.aborted || !controllers.has(taskId)) return
          const value = Math.max(lastProgress, Math.min(1, progress))
          if (value < lastProgress + 0.01 && value !== 1) return
          lastProgress = value
          progressByTask.set(taskId, value)
          if (now() - lastPublished < 250) return
          lastPublished = now()
          deps.onProgress?.({ taskId, progress: value })
        },
      }
      if (task.operation === 'timeline.export') {
        output = await exportTimeline(db, assets, task, options, deps.timeline)
      } else {
        const asset = task.sourceAssetVersionId ? assets.getVersion(db, task.sourceAssetVersionId) : undefined
        if (!asset) throw VisError.of('not_found', 'media.source_not_found', {}, 'The source asset version no longer exists')
        output = await media.process(assets.blobPath(asset.blobHash), task.operation, task.params, options)
      }
      controller.signal.throwIfAborted()
      assertCurrent(db, task)
      if (task.operation === 'video.exportMov') {
        const path = exportPath(taskId)
        if (!path) throw VisError.of('unavailable', 'media.export_unavailable', {}, 'Local MOV export storage is unavailable')
        const part = `${path}.part`
        try {
          mkdirSync(deps.exportDir!, { recursive: true })
          await copyFile(output.outputs[0]!.path, part)
          controller.signal.throwIfAborted()
          await rename(part, path)
          const { size } = await stat(path)
          db.transaction(tx => {
            controller.signal.throwIfAborted()
            tx.update(s.mediaTasks).set({ status: 'succeeded', progress: 1, download: { filename: `video-${taskId}.mov`, byteSize: size, expiresAt: now() + MEDIA_EXPORT_RETENTION_MS }, updatedAt: now() }).where(eq(s.mediaTasks.id, taskId)).run()
            emit(tx, taskId)
          }, { behavior: 'immediate' })
          notify(taskId)
        } finally { await rm(part, { force: true }) }
        return
      }
      for (const item of output.outputs) {
        staged.push(await assets.stageFile(item.path))
        controller.signal.throwIfAborted()
      }
      db.transaction(tx => {
        controller.signal.throwIfAborted()
        const current = assertCurrent(tx, task)
        const operationId = newId('operation', now())
        const replacing = LOCAL_OPERATION_OUTPUT[task.operation] === 'replace'
        const assetVersionIds = output!.outputs.map((item, i) => assets.registerVersion(tx, {
          staged: staged[i]!, kind: item.kind, mime: item.mime, origin: 'derived',
          ...(replacing && current ? { assetId: current.asset.assetId } : {}),
          ...(item.width !== undefined ? { width: item.width } : {}), ...(item.height !== undefined ? { height: item.height } : {}),
          ...(item.durationMs !== undefined ? { durationMs: item.durationMs } : {}),
          ...(item.hasAlpha !== undefined ? { hasAlpha: item.hasAlpha } : {}),
          ...(item.fps !== undefined ? { fps: item.fps } : {}),
        }).assetVersionId)
        const timeline = task.operation === 'timeline.export' ? tx.select().from(s.nodes).where(eq(s.nodes.id, task.nodeId)).get() : undefined
        const ops: CanvasOp[] = replacing
          ? [{ op: 'slot.setAsset', slotId: task.slotId, expectedRevision: task.expectedRevision, assetVersionId: assetVersionIds[0]! }]
          : output!.outputs.map((item, i) => ({
            op: 'node.create', tempId: `output_${i}`, kind: item.kind,
            inputNodeIds: task.operation === 'timeline.export' && timeline?.deletedAt !== null ? [] : [task.nodeId],
            ...(timeline?.title ? { title: `${timeline.title} \u00b7 r${task.expectedRevision}` } : {}),
            content: { assetVersionId: assetVersionIds[i]! },
          }))
        const actor: Actor = task.sessionId ? { kind: 'agent', sessionId: task.sessionId } : { kind: 'user' }
        const applied = applyOps(tx, actor, { requestId: operationId, description: task.operation, ops }, now(),
          task.operation === 'timeline.export' ? { exportOf: { timelineNodeId: task.nodeId, timelineRevision: task.expectedRevision } } : undefined)
        tx.update(s.mediaTasks).set({
          status: 'succeeded', progress: 1, assetVersionIds,
          nodeIds: replacing ? [] : Object.values(applied.idMap), operationId: task.sessionId ? null : operationId, updatedAt: now(),
        }).where(eq(s.mediaTasks.id, taskId)).run()
        emit(tx, taskId)
      }, { behavior: 'immediate' })
      notify(taskId)
    } catch (error) {
      const failure = controller.signal.aborted ? controller.signal.reason : error
      fail(taskId, failure instanceof VisError
        ? { code: failure.code === 'revision_conflict' ? failure.code : String(failure.details?.reason ?? failure.code), message: failure.message }
        : { code: 'media.process_failed', message: 'Local media processing failed' })
    } finally {
      clearTimeout(timeout)
      controllers.delete(taskId)
      turns.delete(taskId)
      progressByTask.delete(taskId)
      for (const blob of staged) assets.discardStaged(db, blob)
      await output?.dispose()
      const saved = db.select().from(s.mediaTasks).where(eq(s.mediaTasks.id, taskId)).get()
      if (saved?.operation === 'video.exportMov' && saved.status !== 'succeeded') {
        const path = exportPath(taskId)
        if (path) await rm(path, { force: true })
      }
    }
  }

  // Recovery happens when each project opens, before any of its new tasks can enter the global queue.
  for (const task of readActiveMediaTasks(db)) fail(task.taskId, { code: 'media.interrupted', message: 'Local media processing was interrupted by a restart' })

  async function get({ taskId, waitMs }: MethodParams<'media.get'>): Promise<MediaTaskView> {
    const deadline = Date.now() + Math.min(waitMs ?? 0, MEDIA_MAX_WAIT_MS)
    while (true) {
      const task = readMediaTask(db, taskId)
      if (progressByTask.has(taskId)) task.progress = progressByTask.get(taskId)!
      const remaining = deadline - Date.now()
      if (task.status === 'succeeded' || task.status === 'failed' || remaining <= 0) return task
      await new Promise<void>(resolve => {
        const wake = () => { clearTimeout(timer); waiters.get(taskId)?.delete(wake); resolve() }
        const timer = setTimeout(wake, remaining)
        const set = waiters.get(taskId) ?? new Set()
        set.add(wake)
        waiters.set(taskId, set)
      })
    }
  }

  return {
    get,
    cancel(taskId: string) {
      exportTask(taskId)
      this.cancelTask(taskId)
      return readMediaTask(db, taskId)
    },
    dismiss(taskId: string) {
      exportTask(taskId)
      this.cancelTask(taskId)
      removeExport(taskId)
      return readMediaTask(db, taskId)
    },
    exportDownload(taskId: string) {
      const task = exportTask(taskId)
      const path = exportPath(taskId)
      if (task.download && task.download.expiresAt <= now()) removeExport(taskId)
      if (task.status !== 'succeeded' || !task.download || task.download.expiresAt <= now() || !path || !existsSync(path)) {
        throw VisError.of('not_found', 'media.export_expired', {}, 'The MOV export is unavailable or has expired; export it again')
      }
      return { path, ...task.download, mime: 'video/quicktime' as const }
    },
    cancelTask(taskId: string) {
      const task = readMediaTask(db, taskId)
      if (task.status === 'succeeded' || task.status === 'failed') return
      controllers.get(taskId)?.abort(cancelled())
      fail(taskId, { code: 'media.cancelled', message: 'Local media processing was cancelled' })
    },
    recoverInterrupted(taskId: string) {
      const task = readMediaTask(db, taskId)
      if (task.status !== 'failed' || task.error?.code !== 'media.interrupted') return
      db.transaction(tx => {
        tx.update(s.mediaTasks).set({ status: 'queued', error: null, updatedAt: now() }).where(eq(s.mediaTasks.id, taskId)).run()
        emit(tx, taskId)
      }, { behavior: 'immediate' })
    },
    cancelSession(sessionId: string) {
      for (const task of db.select({ id: s.mediaTasks.id }).from(s.mediaTasks).where(and(eq(s.mediaTasks.sessionId, sessionId), inArray(s.mediaTasks.status, ['queued', 'running']))).all()) {
        controllers.get(task.id)?.abort(cancelled())
        fail(task.id, { code: 'media.cancelled', message: 'Local media processing was cancelled because its session stopped' })
        turns.delete(task.id)
      }
    },
    async process(actor: Actor, p: MethodParams<'media.process'>): Promise<MediaTaskView> {
      if (stopped) throw VisError.of('unavailable', 'media.interrupted', {}, 'Local media processing is stopping')
      if (p.operation === 'video.exportMov' && actor.kind !== 'user') throw VisError.of('forbidden', 'media.export_user_only', {}, 'Only the user can export MOV delivery files')
      const sessionId = actor.kind === 'agent' ? actor.sessionId : null
      const turn = authorize(db, sessionId)
      const { waitMs: _wait, ...params } = p
      const { taskId } = runIdempotent(db, { requestId: p.requestId, method: 'media.process', params: { ...params, sessionId } }, tx => {
        const { node, slot } = sourceSlot(tx, p.nodeId, p.slotId)
        let sourceAssetVersionId: string | null = null
        if (p.operation === 'timeline.export') {
          if (slot.content.type !== 'timeline') throw VisError.of('invalid_params', 'media.kind_mismatch', {}, 'Timeline export requires a timeline document slot')
          if (slot.revision !== p.expectedRevision) throw VisError.of('revision_conflict', 'media.revision_conflict', {}, 'The source slot changed; read it before retrying')
            if (![...slot.content.doc.tracks, ...(slot.content.doc.textTracks ?? [])].some(track => track.clips.length)) throw VisError.of('invalid_params', 'timeline.empty', {}, 'The timeline has no clips to export')
        } else {
          const { asset } = source(tx, p.nodeId, p.slotId)
          if (asset.kind !== operationKind(p.operation)) throw VisError.of('invalid_params', 'media.kind_mismatch', {}, 'The source media kind does not match the operation')
          sourceAssetVersionId = asset.id
        }
        if (slot.revision !== p.expectedRevision) throw VisError.of('revision_conflict', 'media.revision_conflict', {}, 'The source slot changed; read it before retrying')
        const taskId = `media_${ulid(now())}`
        tx.insert(s.mediaTasks).values({
          id: taskId, requestId: p.requestId, status: 'queued', operation: p.operation, nodeId: p.nodeId, slotId: p.slotId,
          expectedRevision: p.expectedRevision, sourceLayoutRevision: node.layoutRevision, sourceAssetVersionId,
          sessionId, params: p.params, createdAt: now(), updatedAt: now(),
        }).run()
        emit(tx, taskId)
        if (turn) turns.set(taskId, turn)
        return { taskId }
      }, now)
      if (readMediaTask(db, taskId).status === 'queued' && !inflightByTask.has(taskId)) {
        inflightByTask.add(taskId)
        void limiter.enqueue(() => runTask(taskId)).finally(() => { inflightByTask.delete(taskId) })
      }
      return get({ taskId, ...(p.waitMs ? { waitMs: p.waitMs } : {}) })
    },
    async analyze(p: MethodParams<'media.analyze'>) {
      if (stopped) throw VisError.of('unavailable', 'media.interrupted', {}, 'Local media processing is stopping')
      const { asset } = source(db, p.nodeId, p.slotId)
      if (asset.kind !== 'audio') throw VisError.of('invalid_params', 'media.kind_mismatch', {}, 'Silence analysis requires an audio source')
      return media.analyzeSilence(assets.blobPath(asset.blobHash), {
        ...(p.params?.minSilenceMs !== undefined ? { minSilenceMs: p.params.minSilenceMs } : {}),
        ...(p.params?.thresholdDb !== undefined ? { thresholdDb: p.params.thresholdDb } : {}),
      }, { signal: AbortSignal.timeout(deps.timeoutMs ?? MEDIA_TASK_TIMEOUT_MS) })
    },
    async stop() {
      stopped = true
      clearInterval(expiry)
      const drained = limiter.drain()
      for (const controller of controllers.values()) controller.abort(VisError.of('unavailable', 'media.interrupted', {}, 'Local media processing was interrupted'))
      for (const task of readActiveMediaTasks(db)) fail(task.taskId, { code: 'media.interrupted', message: 'Local media processing was interrupted' })
      await drained
      cleanExports(true)
    },
  }
}

export type MediaTaskService = ReturnType<typeof createMediaTaskService>
