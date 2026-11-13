import { studiodEndpoint } from '../../../runtime/studiod-endpoint'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import type { Server } from 'node:net'
import { join, resolve } from 'node:path'
import { createFfmpegMedia, type MediaTools } from '@vis/assets'
import { readJobView, localDate, type ProviderAdapter, type ProviderDefaults, type ProviderType } from '@vis/generation'
import { acquireFileLock, LockHeldError, openAppDb, openSpaceDb, appSchema, spaceSchema, eq, and, asc, inArray, isNull } from '@vis/storage'
import { VisError } from '@vis/domain'
import { assertAgent } from './agents'
import { createGlobalGenerationQuota } from './generation-quota'
import { newSecret } from './auth'
import { createGateway, type Gateway, type ShutdownReason } from './gateway'
import { createProviderManager, type ProviderManager } from './providers'
import { createSystemSecretStore, type SecretStore } from './secret-store'
import { createHostingManager, type HostingManager } from './hosting'
import type { UploadRequest } from './tos-upload'
import { listen } from './server'
import { type AgentRuntimes, createSpaceRegistry, type SpaceRegistry } from './space-host'
import { hasActiveMediaTasks } from './media-tasks'

/** studiod exits after this duration with no UI connections or active work (RFC 0004 "Lifecycle"). */
export const IDLE_EXIT_MS = 10 * 60_000

export type StudiodOptions = {
  /** Application data directory: contains app.db, spaces/ and run/. */
  dataDir: string
  studiodVersion: string
  runtimes: AgentRuntimes
  watchdog?: import('@vis/workbench-core').TurnWatchdogOptions
  providers: ProviderAdapter[]
  providerTypes?: readonly ProviderType[]
  defaults: ProviderDefaults
  secretStore?: SecretStore
  hostingSecretStore?: SecretStore
  hostingFetch?: typeof fetch
  hostingUploadRequest?: UploadRequest
  idleExitMs?: number
  /** Defaults to ffmpeg / ffprobe from PATH */
  media?: MediaTools
  mediaTaskTimeoutMs?: number
  now?: () => number
}

export type Studiod = {
  socketPath: string
  tokenPath: string
  gateway: Gateway
  spaces: SpaceRegistry
  /** The process should exit after the returned Promise completes. */
  stopped: Promise<ShutdownReason>
  stop(reason: ShutdownReason): Promise<void>
}

/** studiod is already running for this data directory. The caller should connect to that instance instead of starting another. */
export class StudiodRunningError extends Error {
  constructor(readonly dataDir: string) {
    super(`studiod is already using data directory ${dataDir}`)
    this.name = 'StudiodRunningError'
  }
}

export function runDir(dataDir: string) {
  return join(dataDir, 'run')
}

export async function startStudiod(opts: StudiodOptions): Promise<Studiod> {
  const now = opts.now ?? Date.now
  const run = runDir(opts.dataDir)
  mkdirSync(run, { recursive: true, mode: 0o700 })
  const socketPath = studiodEndpoint(opts.dataDir)
  const tokenPath = join(run, 'studiod.token')

  // Acquire the lock before touching data: opening the database in a second instance first would let recovery mark active turns as interrupted and take over generation jobs.
  let lock: { release(): void }
  try {
    lock = acquireFileLock(join(run, 'studiod.lock'))
  } catch (error) {
    if (error instanceof LockHeldError) throw new StudiodRunningError(opts.dataDir)
    throw error
  }

  // Gateway depends on the space registry and is created later; discard streamed text until there is somewhere to push it.
  let publishTransient: Gateway['publishTransient'] = () => {}
  let appDb: ReturnType<typeof openAppDb> | undefined
  let spaces!: SpaceRegistry
  let providers: ProviderManager
  let hosting: HostingManager
  const media = opts.media ?? createFfmpegMedia()
  try {
    appDb = openAppDb(join(opts.dataDir, 'app.db'))
    hosting = createHostingManager({ dataDir: opts.dataDir, secrets: opts.hostingSecretStore ?? createSystemSecretStore('vis-creative.hosting'), fetch: opts.hostingFetch, uploadRequest: opts.hostingUploadRequest })
    await hosting.initialize()
    providers = createProviderManager({
      dataDir: opts.dataDir, builtins: opts.providers, defaults: opts.defaults, hosting,
      secrets: opts.secretStore ?? createSystemSecretStore(), media, ...(opts.providerTypes ? { providerTypes: opts.providerTypes } : {}),
      onChange(next, defaults, limits) {
        hostOptions.providers = next
        hostOptions.defaults = defaults
        hostOptions.limits = limits
        for (const host of spaces.opened()) { host.generation.configure(next, defaults, limits); host.scriptBatches.configure(next, defaults) }
      },
    })
    const quota = createGlobalGenerationQuota({ db: appDb, limits: providers.limits })
    // Complete the scan before recovering reservations; any project read failure aborts startup to avoid undercounting paid jobs.
    const paidJobs = []
    const activeWork: { spaceId: string; workItemId: string; acquiredAt: number }[] = []
    for (const space of appDb.select().from(appSchema.spaces).where(isNull(appSchema.spaces.deletedAt)).all()) {
      const file = resolve(opts.dataDir, space.dir, 'space.db')
      if (!existsSync(file)) {
        // Empty projects never opened before have no database; existing reservations mean they cannot be treated as empty.
        const occupied = appDb.select().from(appSchema.workSlots).where(eq(appSchema.workSlots.spaceId, space.id)).get()
        if (occupied) throw new Error(`Project ${space.name} work item database is missing; executor slots cannot be safely recovered`)
        const pending = appDb.select().from(appSchema.generationQuota).where(and(eq(appSchema.generationQuota.spaceId, space.id), inArray(appSchema.generationQuota.state, ['queued', 'active']))).get()
        if (pending) throw new Error(`Project ${space.name} job database is missing; generation quota cannot be safely recovered`)
        if (space.lastOpenedAt !== null) throw new Error(`Project ${space.name} work item database is missing; executor slots cannot be safely recovered`)
        continue
      }
      const spaceDb = openSpaceDb(file)
      try {
        for (const item of spaceDb.select().from(spaceSchema.workItems).where(and(eq(spaceSchema.workItems.status, 'in_progress'), isNull(spaceSchema.workItems.archivedAt))).all()) {
          const linked = spaceDb.select().from(spaceSchema.sessions).where(eq(spaceSchema.sessions.workItemId, item.id)).orderBy(asc(spaceSchema.sessions.createdAt), asc(spaceSchema.sessions.id)).all()
          const kind = (linked.find(session => session.archivedAt === null) ?? linked[0])?.agentKind ?? item.agentKind
          if (!kind) continue
          try { assertAgent(opts.runtimes, kind) }
          catch (error) {
            // Manual board moves preserve status, but removed adapters cannot occupy execution slots.
            if (error instanceof VisError && error.details?.reason === 'session.agent_unconfigured') continue
            throw error
          }
          activeWork.push({ spaceId: space.id, workItemId: item.id, acquiredAt: item.statusChangedAt })
        }
        for (const job of spaceDb.select().from(spaceSchema.generationJobs).all()) {
          const configuration = (job.params as { providerConfiguration?: { type?: string } }).providerConfiguration
          const type = configuration?.type ?? providers.adapters().find(adapter => adapter.id === job.provider)?.type ?? job.provider
          if (type === 'mock' || type === 'render') continue
          // Backfill daily counts for legacy jobs; unfinished jobs must also pass the global concurrency gate.
          if (job.quotaDate === null) {
            job.quotaDate = localDate(job.createdAt)
            spaceDb.update(spaceSchema.generationJobs).set({ quotaDate: job.quotaDate }).where(eq(spaceSchema.generationJobs.id, job.id)).run()
          }
          paidJobs.push({ jobId: job.id, spaceId: space.id, kind: job.kind, createdAt: job.createdAt, quotaDate: job.quotaDate, status: job.status })
        }
      } finally { spaceDb.$client.close() }
    }
    quota.reconcile(paidJobs)
    const hostOptions = {
      media, ...(opts.mediaTaskTimeoutMs !== undefined ? { mediaTaskTimeoutMs: opts.mediaTaskTimeoutMs } : {}),
      runtimes: opts.runtimes, providers: providers.adapters(), defaults: providers.defaults(), limits: providers.limits(), now,
      ...(opts.watchdog ? { watchdog: opts.watchdog } : {}),
      resolveProvider: providers.resolve,
      quotaForSpace: quota.forSpace,
      onTransient: (spaceId: string, event: Parameters<Gateway['publishTransient']>[1]) => publishTransient(spaceId, event),
    }
    spaces = createSpaceRegistry({ appDb, dataDir: opts.dataDir, now, host: hostOptions })
    spaces.workSlots.reconcile(activeWork)
    await spaces.recoverDeletes()
    for (const { spaceId } of spaces.list()) {
      const host = spaces.get(spaceId)!
      await host.work.recoverRecalls()
      await host.workDeletion.recover()
      host.generation.start()
      host.scriptBatches.startScheduler()
    }
    spaces.workSlots.drain()
  } catch (error) {
    if (spaces) await spaces.closeAll()
    appDb?.$client.close()
    lock.release()
    throw error
  }
  const db = appDb

  let resolveStopped!: (reason: ShutdownReason) => void
  const stopped = new Promise<ShutdownReason>(r => { resolveStopped = r })
  let stopping: Promise<void> | undefined

  const uiToken = newSecret()
  const gateway = createGateway({
    appDb: db, spaces, uiToken, studiodVersion: opts.studiodVersion, runtimeEpoch: randomUUID(),
    onShutdown: reason => { void stop(reason) },
    media, providers, hosting, now,
    usage: () => {
      const date = localDate(now())
      const ledger = db.select().from(appSchema.generationQuota).where(eq(appSchema.generationQuota.date, date)).all()
      const names = new Map(spaces.list().map(space => [space.spaceId, space.name]))
      const jobs = ledger.flatMap(row => {
        if (!names.has(row.spaceId)) return []
        const host = spaces.get(row.spaceId)
        const job = host && readJobView(host.db, row.jobId)
        return job ? [{ ...job, spaceId: row.spaceId, spaceName: names.get(row.spaceId) ?? row.spaceId }] : []
      })
      const count = (kind: 'image' | 'video' | 'audio', byAgent = false) => ledger.filter(row => row.kind === kind && (!byAgent || row.byAgent)).length
      return { date, image: count('image'), video: count('video'), audio: count('audio'), agent: { image: count('image', true), video: count('video', true), audio: count('audio', true) }, limits: providers.limits(), jobs, deletedProjectJobs: ledger.filter(row => !names.has(row.spaceId)).length }
    },
  })
  publishTransient = gateway.publishTransient
  let server: Server
  try {
    server = await listen(socketPath, gateway)
  } catch (error) {
    gateway.close()
    await spaces.closeAll()
    db.$client.close()
    lock.release()
    if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EADDRINUSE') throw new StudiodRunningError(opts.dataDir)
    throw error
  }
  // Write the token after the socket is ready: the main process can connect as soon as it reads the token.
  writeFileSync(tokenPath, uiToken, { mode: 0o600 })

  let idleSince: number | undefined
  const idleTimer = setInterval(() => {
    const { activeTurns, activeJobs } = gateway.activity()
    const idle = gateway.uiConnections() === 0 && activeTurns === 0 && activeJobs === 0 && spaces.opened().every(host => !hasActiveMediaTasks(host.db))
    if (!idle) { idleSince = undefined; return }
    idleSince ??= now()
    if (now() - idleSince >= (opts.idleExitMs ?? IDLE_EXIT_MS)) void stop('idle')
  }, Math.min(60_000, opts.idleExitMs ?? IDLE_EXIT_MS))
  idleTimer.unref()

  /**
   * "Exit and stop": stop accepting connections, terminate Agent processes and stop advancing generation jobs (without cancelling; resume on next startup).
   * SessionService.recover marks turns as interrupted on the next startup.
   */
  function stop(reason: ShutdownReason): Promise<void> {
    stopping ??= (async () => {
      clearInterval(idleTimer)
      gateway.close()
      await new Promise<void>(r => server.close(() => r()))
      await spaces.closeAll()
      db.$client.close()
      rmSync(tokenPath, { force: true })
      // Release last: only then can a new instance take over this data directory.
      lock.release()
      resolveStopped(reason)
    })()
    return stopping
  }

  return { socketPath, tokenPath, gateway, spaces, stopped, stop }
}
