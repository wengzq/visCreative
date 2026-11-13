import { refreshReviews } from './reviews'
import { createSkillLibrary, type SkillLibrary } from './skill-library'
import { createTextDeletionService } from './text-deletion'
import { readSeriesTexts } from './series-text'
import { createTextProposalService } from './text-proposals'
import { createSceneProposalService } from './scene-proposals'
import { createSkillService, type SkillService } from './skills'
import { attachmentPath } from './attachment'
import { createSpaceLifecycle } from './space-lifecycle'
import { accessSync, constants, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { type AssetStore, createAssetStore, type MediaTools } from '@vis/assets'
import { createMediaTaskService, type MediaTaskService } from './media-tasks'
import { createMediaPreviewService, type MediaPreviewService } from './media-previews'
import { type CanvasService, createCanvasService, markScriptEntitiesChanged, migrateScriptEntities } from '@vis/canvas-core'
import { createEntityService, createSeriesEntityService, detachSeriesEntities, createSeriesLibrary, type EntityService, type SeriesEntityService, type SeriesLibrary } from '@vis/library-core'
import { createSeriesRegistry, type SeriesRegistry } from './series-registry'
import { newId, VisError } from '@vis/domain'
import { createGenerationService, type GenerationService, type GenerationQuota, type ProviderAdapter, type ProviderDefaults } from '@vis/generation'
import { type AppDb, appSchema, asc, desc, eq, isNull, fingerprint, openSpaceDb, type SpaceDb, spaceSchema } from '@vis/storage'
import type { AgentKind, AgentModelOption, GenerationLimits, MediaTaskProgress, MethodParams, SpaceSeries, SpaceSummary, TransientEvent } from '@vis/protocol'
import { type AgentEvent, type AgentRuntimePort, createSessionService, type RequestApproval, type SessionService } from '@vis/workbench-core'
import { listProjectSkills, validateDirectory } from './filesystem'
import { createWorkService, type WorkService } from './work-service'
import { createWorkDeletionService } from './work-deletion'
import { createWorkSlots, type WorkSlots } from './work-slots'
import { createScriptBatchService, type ScriptBatchService } from './script-batches'
import { createLibraryService, type LibraryService } from '@vis/library-core'
import { agentLabel, assertAgent, listAgents } from './agents'

/**
 * Agent runtimes are supplied externally (by each Agent adapter): persistent events reach this space's SessionService via report,
 * while streamed text goes directly to the UI via stream.
 */
export type AgentRuntimeFactory = ((ctx: { spaceId: string; dir: string; db: SpaceDb; workDir: (sessionId: string) => string; report: (event: AgentEvent) => void; stream: (event: TransientEvent) => void; requestApproval: RequestApproval; forbiddenPaths?: readonly string[] }) =>
  AgentRuntimePort & { dispose?(): Promise<void> }) & {
    descriptor?: import('@vis/workbench-core').AgentDescriptor
    modelsSupported?: boolean
    availability?: () => { available: boolean; reason?: string }
  }

/** One factory per Agent kind; unconfigured kinds fail to start at delivery time. */
export type AgentRuntimes = Partial<Record<AgentKind, AgentRuntimeFactory>>

type AgentOptionsCache = Map<AgentKind, { expiresAt: number; result: Promise<AgentModelOption[]> }>

/** Route calls to the runtime matching the session agentKind. */
function routeByAgentKind(db: SpaceDb, runtimes: Partial<Record<AgentKind, ReturnType<AgentRuntimeFactory>>>, optionsCache: AgentOptionsCache, now: () => number): AgentRuntimePort & { dispose(): Promise<void> } {
  const pick = (sessionId: string) => {
    const kind = db.select({ kind: spaceSchema.sessions.agentKind }).from(spaceSchema.sessions).where(eq(spaceSchema.sessions.id, sessionId)).get()?.kind
    const runtime = kind && Object.hasOwn(runtimes, kind) ? runtimes[kind] : undefined
    if (!runtime) throw VisError.of('unavailable', 'session.agent_unconfigured', { kind: kind ?? 'unknown' }, `${kind ?? 'unknown'} Agent is not configured`)
    return runtime
  }
  return {
    async agentOptions(kind, options) {
      const cached = optionsCache.get(kind)
      if (cached && cached.expiresAt > now()) return cached.result
      const runtime = Object.hasOwn(runtimes, kind) ? runtimes[kind] : undefined
      if (!runtime) throw VisError.of('unavailable', 'session.agent_unconfigured', { kind }, `${kind} Agent is not configured`)
      if (!runtime.agentOptions) throw VisError.of('unavailable', 'session.agent_models_unsupported', { kind }, `${kind} Agent does not support reading model lists`)
      const result = Promise.resolve().then(() => runtime.agentOptions!(kind, options))
      const entry = { expiresAt: Infinity, result }
      optionsCache.set(kind, entry)
      try {
        const models = await result
        entry.expiresAt = now() + 10 * 60_000
        return models
      } catch (error) {
        optionsCache.delete(kind)
        throw error
      }
    },
    ensureReady: async sessionId => pick(sessionId).ensureReady(sessionId),
    dispatchTurn: async input => pick(input.sessionId).dispatchTurn(input),
    interruptTurn: async input => pick(input.sessionId).interruptTurn(input),
    terminateTurn: async input => pick(input.sessionId).terminateTurn(input),
    async dispose() { await Promise.all(Object.values(runtimes).map(r => r?.dispose?.())) },
  }
}

export type SpaceHostOptions = {
  media?: MediaTools
  mediaTaskTimeoutMs?: number
  runtimes: AgentRuntimes
  providers: ProviderAdapter[]
  defaults: ProviderDefaults
  limits?: GenerationLimits
  workSlots?: WorkSlots
  quotaForSpace?: (spaceId: string) => GenerationQuota
  resolveProvider?: (id: string, configuration: unknown) => ProviderAdapter | undefined
  now?: () => number
  watchdog?: import('@vis/workbench-core').TurnWatchdogOptions
  agentOptionsCache?: AgentOptionsCache
  suspended?: boolean
  preserveRootPath?: boolean
  pollIntervalMs?: number
  seriesLibraries?: SeriesLibrary
  seriesMembership?: () => SpaceSeries | null
  detachSeriesPending?: boolean
  /** Streamed text outlet; Gateway pushes to UI clients subscribed to this space. */
  onTransient?: (spaceId: string, event: TransientEvent | MediaTaskProgress) => void
}

/** An open space: one space.db and the services assembled on top of it. */
export type SpaceHost = {
  spaceId: string
  rootPath: string
  workDir(sessionId: string): string
  db: SpaceDb
  assets: AssetStore
  mediaTasks: MediaTaskService
  mediaPreviews: MediaPreviewService
  textDeletion: ReturnType<typeof createTextDeletionService>
  sceneProposals: ReturnType<typeof createSceneProposalService>
  textProposals: ReturnType<typeof createTextProposalService>
  canvas: CanvasService
  entities: EntityService
  seriesEntities: SeriesEntityService
  generation: GenerationService
  scriptBatches: ScriptBatchService
  sessions: SessionService
  work: WorkService
  workDeletion: ReturnType<typeof createWorkDeletionService>
  skills: SkillService
  library: LibraryService
  close(): Promise<void>
}

export function openSpaceHost(spaceId: string, dir: string, opts: SpaceHostOptions, rootPath = join(dir, 'project')): SpaceHost {
  const now = opts.now ?? Date.now
  mkdirSync(dir, { recursive: true })
  const db = openSpaceDb(join(dir, 'space.db'))
  if (opts.detachSeriesPending) detachSeriesEntities(db, now())
  migrateScriptEntities(db, now())
  if (!opts.preserveRootPath) for (const folder of ['assets', 'skills', 'workspaces']) mkdirSync(join(rootPath, folder), { recursive: true })
  // Recovering existing sessions must preserve the original adapter cwd, without moving them into a new project directory.
  for (const session of db.select().from(spaceSchema.sessions).all()) {
    if (!session.workDir) {
      const workDir = join(dir, 'sessions', session.id)
      mkdirSync(workDir, { recursive: true })
      db.update(spaceSchema.sessions).set({ workDir }).where(eq(spaceSchema.sessions.id, session.id)).run()
      if (session.workItemId) db.update(spaceSchema.workItems).set({ workDir }).where(eq(spaceSchema.workItems.id, session.workItemId)).run()
    }
  }
  const workDir = (sessionId: string) => {
    const session = db.select().from(spaceSchema.sessions).where(eq(spaceSchema.sessions.id, sessionId)).get()
    if (!session) throw VisError.of('not_found', 'session.not_found', { sessionId }, `Session ${sessionId} does not exist`)
    const directory = session.workItemId ? db.select().from(spaceSchema.workItems).where(eq(spaceSchema.workItems.id, session.workItemId)).get()?.workDir ?? session.workDir : session.workDir
    if (!validateDirectory(directory).valid) throw VisError.of('not_found', 'work.directory_path_not_found', { path: session.workDir }, `Working directory has moved or is inaccessible: ${session.workDir}`)
    return directory
  }
  const skills = createSkillService(rootPath, dir, now)
  const assets = createAssetStore({ blobsDir: join(dir, 'blobs'), now })
  const library = createLibraryService({ db, blobPath: hash => assets.blobPath(hash), now })
  const canvas = createCanvasService({ db, now, onChanged: tx => { refreshReviews(tx, now()) } })
  const sceneProposals = createSceneProposalService(db, now)
  const textProposals = createTextProposalService(db, now)
  const textDeletion = createTextDeletionService(db, now)
  const ownSeriesLibrary = opts.seriesLibraries ? undefined : createSeriesLibrary({ dataDir: dir, now })
  const seriesEntities = createSeriesEntityService({ db, assets, spaceId, libraries: opts.seriesLibraries ?? ownSeriesLibrary!,
    series: opts.seriesMembership ?? (() => null), now, onEntitiesChanged: (tx, ids) => markScriptEntitiesChanged(tx, ids, now()) })
  const entities = createEntityService({ db, now, latestSeriesRevisions: seriesEntities.latestRevisions,
    onEntitiesChanged: (tx, ids) => markScriptEntitiesChanged(tx, ids, now()) })
  let sessions: SessionService | undefined
  const mediaTasks = createMediaTaskService({ db, assets, exportDir: join(dir, 'cache', 'exports'), now, isTurnStopping: turnId => sessions?.isTurnStopping(turnId) ?? false, onProgress: event => opts.onTransient?.(spaceId, event), ...(opts.media ? { media: opts.media } : {}), ...(opts.media?.paths ? { timeline: opts.media.paths } : {}), ...(opts.mediaTaskTimeoutMs !== undefined ? { timeoutMs: opts.mediaTaskTimeoutMs } : {}) })
  const mediaPreviews = createMediaPreviewService({ db, assets, dir: join(dir, 'cache', 'previews'), ...(opts.media?.paths ? { paths: opts.media.paths } : {}) })
  const generation = createGenerationService({
    db, assets, delivery: canvas, providers: opts.providers, defaults: opts.defaults, now,
    ...(opts.quotaForSpace ? { quota: opts.quotaForSpace(spaceId) } : {}),
    ...(opts.limits ? { limits: opts.limits } : {}),
    ...(opts.resolveProvider ? { resolveProvider: opts.resolveProvider } : {}),
    ...(opts.pollIntervalMs ? { pollIntervalMs: opts.pollIntervalMs } : {}),
  })
  const scriptBatches = createScriptBatchService({ db, canvas, generation, mediaTasks, providers: opts.providers, defaults: opts.defaults, now })
  const cancelSessionWork = async (sessionId: string) => {
    mediaTasks.cancelSession(sessionId)
    await scriptBatches.cancelSession(sessionId)
  }
  // SessionService and the runtime reference each other: give the runtime a forwarding function first.
  const report = (event: AgentEvent) => sessions?.handleAgentEvent(event)
  const stream = (event: TransientEvent) => {
    sessions?.recordActivity(event.sessionId, event.turnId)
    opts.onTransient?.(spaceId, event)
  }
  const requestApproval: RequestApproval = request => sessions?.requestApproval(request) ?? Promise.resolve('deny')
  const forbiddenPaths = [...new Set(Object.values(opts.runtimes).flatMap(runtime => runtime?.descriptor?.forbiddenPaths ?? []))]
  const runtime = routeByAgentKind(db, Object.fromEntries(
    Object.entries(opts.runtimes).flatMap(([kind, factory]) => {
      if (!factory) return []
      const instance = factory({ spaceId, dir, db, workDir, report, stream, requestApproval, forbiddenPaths })
      factory.modelsSupported = !!instance.agentOptions
      return [[kind, instance]]
    }),
  ), opts.agentOptionsCache ?? new Map(), now)
  sessions = createSessionService({ db, runtime, rootPath, assetPath: id => attachmentPath(db, assets, rootPath, id), listSkills: () => listProjectSkills(rootPath), now,
    ...(opts.watchdog ? { watchdog: opts.watchdog } : {}),
    agentLabel: kind => agentLabel(opts.runtimes, kind),
    assertAgent: kind => assertAgent(opts.runtimes, kind),
    onStop: cancelSessionWork,
    onWorkFailure: (t, failure, key) => work.notifySessionFailure(t, failure, key),
    acquireWorkSlot: id => opts.workSlots?.reserve(spaceId, id) ?? true,
    releaseWorkSlot: id => opts.workSlots?.release(spaceId, id),
  })
  const work = createWorkService({ db, spaceId, rootPath, sessions, generation, runtime, now,
    assertAgent: kind => assertAgent(opts.runtimes, kind),
    cancelSessionMedia: cancelSessionWork,
    slots: opts.workSlots ?? { reserve: () => true, release: () => {} },
  })
  const workDeletion = createWorkDeletionService(db, work, now)

  // Finish turns left by the previous process, then recover unfinished generation jobs.
  if (!opts.suspended) sessions.recover()
  const pendingRecovery = db.select().from(spaceSchema.idempotencyKeys).all().some(key =>
    (key.method === 'work.recall' || key.method === 'work.delete') && !(key.result as { finished: boolean }).finished)
  if (!pendingRecovery && !opts.suspended) { generation.start(); scriptBatches.startScheduler() }

  return {
    spaceId, rootPath, workDir, db, assets, canvas, sceneProposals, textProposals, textDeletion, entities, seriesEntities, generation, mediaTasks, mediaPreviews, scriptBatches, sessions, work, workDeletion, skills, library,
    async close() {
      textDeletion.close()
      workDeletion.close()
      const previewsClosed = mediaPreviews.close()
      await scriptBatches.stop()
      sessions.dispose()
      await runtime.dispose()
      await sessions.idle()
      await generation.stop()
      await mediaTasks.stop()
      await previewsClosed
      db.$client.close()
      ownSeriesLibrary?.closeAll()
    },
  }
}


/** Spaces are registered in app.db; opened on first access and kept resident until studiod exits. */
export interface SpaceRegistry extends Pick<ReturnType<typeof createSpaceLifecycle>, 'deletePlan' | 'delete' | 'listDeleted' | 'diskUsage' | 'restore' | 'purge' | 'recoverDeletes'> {
  assertAgent?(kind: string): void
  agents?(): import('@vis/protocol').AgentView[]
  projectsDir: string
  skillLibrary: SkillLibrary
  workSlots: WorkSlots
  series: SeriesRegistry
  list(): SpaceSummary[]
  create(params: string | MethodParams<'space.create'>): SpaceSummary
  /** Return the open instance for a registered space, or undefined if unregistered. */
  get(spaceId: string): SpaceHost | undefined
  readTexts(spaceId: string): ReturnType<typeof readSeriesTexts>
  markOpened(spaceId: string): void
  opened(): SpaceHost[]
  closeAll(): Promise<void>
}

export function createSpaceRegistry(deps: { appDb: AppDb; dataDir: string; host: SpaceHostOptions; now?: () => number }): SpaceRegistry {
  const { appDb } = deps
  const now = deps.now ?? Date.now
  const hosts = new Map<string, SpaceHost>()
  const agentOptionsCache: AgentOptionsCache = new Map()
  const skillLibrary = createSkillLibrary(appDb, deps.dataDir, now)
  const a = appSchema
  const projectsDir = resolve(process.env.VIS_PROJECTS_DIR ?? join(homedir(), 'visCreative'))
  const series = createSeriesRegistry({ db: appDb, dataDir: deps.dataDir, now,
    open: spaceId => registry.get(spaceId), opened: spaceId => hosts.get(spaceId) })

  for (const row of appDb.select().from(a.spaces).all()) {
    if (!row.rootPath && row.deletedAt === null) {
      const rootPath = resolve(deps.dataDir, row.dir, 'project')
      for (const folder of ['assets', 'skills', 'workspaces']) mkdirSync(join(rootPath, folder), { recursive: true })
      appDb.update(a.spaces).set({ rootPath }).where(eq(a.spaces.id, row.id)).run()
    }
  }

  const workSlots = createWorkSlots(appDb, {
    queue: () => registry.list().flatMap(space => registry.get(space.spaceId)!.work.queued().map(item => ({ spaceId: space.spaceId, ...item }))),
    activate: (spaceId, workItemId) => { registry.get(spaceId)!.work.activateQueued(workItemId) },
  }, now)
  function open(spaceId: string, suspended = false) {
    const open = hosts.get(spaceId)
    if (open) return open
    const row = appDb.select().from(a.spaces).where(eq(a.spaces.id, spaceId)).get()
    if (!row) return undefined
    if (row.deletedAt !== null) throw VisError.of('not_found', 'space.deleted', {}, 'Project has been deleted')
    const host = openSpaceHost(spaceId, resolve(deps.dataDir, row.dir), { ...deps.host, agentOptionsCache, workSlots, suspended, preserveRootPath: true,
      seriesLibraries: series.libraries, seriesMembership: () => series.membership(spaceId), detachSeriesPending: row.seriesDetachPending }, row.rootPath)
    hosts.set(spaceId, host)
    if (row.seriesDetachPending) appDb.update(a.spaces).set({ seriesDetachPending: false }).where(eq(a.spaces.id, spaceId)).run()
    if (row.lastOpenedAt === null) appDb.update(a.spaces).set({ lastOpenedAt: now() }).where(eq(a.spaces.id, spaceId)).run()
    return host
  }
  const lifecycle = createSpaceLifecycle({ db: appDb, dataDir: deps.dataDir, projectsDir, now, open,
    restoreSeries: spaceId => series.prepareRestore(spaceId),
    async close(spaceId) {
      const host = hosts.get(spaceId)
      if (host) { await host.close(); await host.mediaPreviews.clear(); hosts.delete(spaceId) }
    },
    drain: () => workSlots.drain(),
  })
  const registry: SpaceRegistry = {
    agents: () => listAgents(deps.host.runtimes),
    assertAgent: kind => assertAgent(deps.host.runtimes, kind),
    ...lifecycle, projectsDir, workSlots, series, skillLibrary,
    list() {
      return appDb.select().from(a.spaces).where(isNull(a.spaces.deletedAt)).orderBy(desc(a.spaces.lastOpenedAt), asc(a.spaces.createdAt)).all()
        .filter(r => !lifecycle.unavailable(r.id) && !lifecycle.pendingDelete(r.id))
        .map(r => {
          const membership = series.membership(r.id)
          return { spaceId: r.id, name: r.name, rootPath: r.rootPath, createdAt: r.createdAt, ...(membership ? { series: membership } : {}) }
        })
    },
    create(params) {
      lifecycle.assertCanCreate()
      const p: Partial<MethodParams<'space.create'>> & { name: string } = typeof params === 'string' ? { name: params } : params
      const name = p.name.trim()
      if (!name) throw VisError.of('invalid_params', 'space.name_required', {}, 'Project name cannot be empty')
      if (p.rootPath && !isAbsolute(p.rootPath)) throw VisError.of('invalid_params', 'space.absolute_path_required', {}, 'Project directory must be an absolute path')
      const rootPath = p.rootPath ? resolve(p.rootPath) : resolve(projectsDir, name.replace(/[\\/\0]/g, '-').replace(/^\.+$/, '-'))
      return appDb.transaction(tx => {
        const fp = fingerprint('space.create', p)
        const requestId = 'requestId' in p ? p.requestId : undefined
        const existing = requestId ? tx.select().from(a.idempotencyKeys).where(eq(a.idempotencyKeys.requestId, requestId)).get() : undefined
        if (existing) {
          if (existing.fingerprint !== fp) throw VisError.of('idempotency_conflict', 'request.id_conflict', { requestId: requestId! }, `requestId ${requestId} has already been used for a different request`)
          return existing.result as SpaceSummary
        }
        for (const folder of ['assets', 'skills', 'workspaces']) mkdirSync(join(rootPath, folder), { recursive: true })
        accessSync(rootPath, constants.R_OK | constants.W_OK | constants.X_OK)
        const at = now()
        const id = newId('space', at)
        const seriesId = p.series ? series.target(tx, p.series) : null
        const episode = seriesId ? series.episode(tx, seriesId, p.episode) : null
        tx.insert(a.spaces).values({ id, name, rootPath, dir: join('spaces', id), createdAt: at, seriesId, episode }).run()
        const membership = series.membership(id)
        const skippedSkills = skillLibrary.addToProject(id, rootPath)
        const result: SpaceSummary = { spaceId: id, name, rootPath, createdAt: at, ...(membership ? { series: membership } : {}), ...(skippedSkills.length ? { skippedSkills } : {}) }
        if (requestId) tx.insert(a.idempotencyKeys).values({ requestId, fingerprint: fp, result }).run()
        return result
      }, { behavior: 'immediate' })
    },
    get(spaceId) {
      const row = appDb.select().from(a.spaces).where(eq(a.spaces.id, spaceId)).get()
      if ((row && row.deletedAt !== null) || lifecycle.unavailable(spaceId) || lifecycle.pendingDelete(spaceId)) throw VisError.of('not_found', 'space.deleted', {}, 'Project has been deleted')
      return open(spaceId)
    },
    readTexts(spaceId) {
      const row = appDb.select().from(a.spaces).where(eq(a.spaces.id, spaceId)).get()
      if (!row || row.deletedAt !== null || lifecycle.unavailable(spaceId) || lifecycle.pendingDelete(spaceId)) throw VisError.of('not_found', 'space.deleted', {}, 'Project is unavailable')
      return readSeriesTexts(join(resolve(deps.dataDir, row.dir), 'space.db'), hosts.get(spaceId)?.db)
    },
    markOpened(spaceId) {
      appDb.update(a.spaces).set({ lastOpenedAt: now() }).where(eq(a.spaces.id, spaceId)).run()
    },
    opened: () => [...hosts.values()].filter(host => !lifecycle.unavailable(host.spaceId) && !lifecycle.pendingDelete(host.spaceId)),
    async closeAll() {
      const all = [...hosts.values()]
      hosts.clear()
      await Promise.all(all.map(h => h.close()))
      series.libraries.closeAll()
    },
  }
  return registry
}
