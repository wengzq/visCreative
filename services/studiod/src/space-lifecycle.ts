import { lstat, readdir, realpath, rename, mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, parse } from 'node:path'
import { VisError } from '@vis/domain'
import type { MethodParams, MethodResult, SpaceSeries } from '@vis/protocol'
import { appSchema as a, spaceSchema as s, eq, inArray, isNull, and, fingerprint, openSpaceDb, type AppDb } from '@vis/storage'
import type { SpaceHost } from './space-host'
import { ACTIVE_TURNS, TERMINAL_JOBS, stopExecution } from './stop-execution'
import { databaseVersion } from './database-version'

type PurgeRecord = { lifecycle: 'space.purge'; finished: boolean; result: MethodResult<'space.purge'> }

type DeleteRecord = {
  lifecycle: 'space.delete'
  spaceId: string
  finished: boolean
  stops: { sessionId: string; turnId: string }[]
  cancelledJobs: { jobId: string; providerCancelled: boolean }[]
}
const contains = (parent: string, child: string) => {
  const path = relative(parent, child)
  return path === '' || (!path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && path !== '..' && !isAbsolute(path))
}
// Resolve existing parents even for missing paths to prevent bypassing protection through parent directory links.
async function canonical(path: string): Promise<string> {
  try { return await realpath(path) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const parent = dirname(path)
    return parent === path ? path : join(await canonical(parent), relative(parent, path))
  }
}
async function bytes(path: string): Promise<number | null> {
  let stat
  try { stat = await lstat(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) return stat.size
  let total = 0
  for (const entry of await readdir(path)) total += await bytes(join(path, entry)) ?? 0
  return total
}

export function createSpaceLifecycle(deps: {
  db: AppDb; dataDir: string; projectsDir: string; now(): number
  open(spaceId: string, suspended?: boolean): SpaceHost | undefined
  close(spaceId: string): Promise<void>
  drain(): void
  restoreSeries?(spaceId: string): SpaceSeries | null
}) {
  const { db, now } = deps
  const unavailable = new Set<string>()
  let pendingCache: { version: string; ids: Set<string> } | undefined
  function pendingDeleteIds() {
    const version = databaseVersion(db)
    if (version !== undefined && pendingCache?.version === version) return pendingCache.ids
    const ids = new Set(db.select().from(a.idempotencyKeys).all().flatMap(key => {
      const record = key.result as Partial<DeleteRecord>
      return record.lifecycle === 'space.delete' && !record.finished && record.spaceId ? [record.spaceId] : []
    }))
    if (version !== undefined) pendingCache = { version, ids }
    return ids
  }
  let mutating = false
  let tail: Promise<unknown> = Promise.resolve()
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(async () => {
      mutating = true
      try { return await fn() } finally { mutating = false }
    })
    tail = run.catch(() => {})
    return run
  }
  function row(spaceId: string) {
    const found = db.select().from(a.spaces).where(eq(a.spaces.id, spaceId)).get()
    if (!found) throw VisError.of('not_found', 'space.not_found', {}, 'Project does not exist')
    return found
  }
  function deleted(spaceId: string) {
    const found = row(spaceId)
    if (found.deletedAt === null) throw VisError.of('invalid_transition', 'space.deleted_required', {}, 'Only recently deleted projects can be operated on')
    return found
  }
  function replay(method: string, params: { requestId: string }) {
    const known = db.select().from(a.idempotencyKeys).where(eq(a.idempotencyKeys.requestId, params.requestId)).get()
    if (known && known.fingerprint !== fingerprint(method, params)) throw VisError.of('idempotency_conflict', 'request.idempotency_conflict', {}, 'requestId has already been used for a different request')
    return known?.result
  }
  function save(method: string, params: { requestId: string }, result: unknown) {
    db.insert(a.idempotencyKeys).values({ requestId: params.requestId, fingerprint: fingerprint(method, params), result })
      .onConflictDoUpdate({ target: a.idempotencyKeys.requestId, set: { result } }).run()
  }
  async function safety(spaceId: string): Promise<VisError | null> {
    const project = row(spaceId)
    const root = resolve(project.rootPath)
    const resolved = await canonical(root)
    const candidates = [root, resolved]
    const protectedRoots = await Promise.all([homedir(), deps.projectsDir, join(homedir(), 'visCreative')].map(path => canonical(resolve(path))))
    if (candidates.some(path => path === parse(path).root || protectedRoots.includes(path))) return VisError.of('forbidden', 'space.purge_protected_root', {}, 'Cannot delete the filesystem root, user home directory or projects root directory')
    const data = await canonical(resolve(deps.dataDir))
    if (candidates.some(path => contains(path, data))) return VisError.of('forbidden', 'space.purge_contains_data', {}, 'Project directory contains the application data directory')
    for (const other of db.select().from(a.spaces).all()) {
      if (other.id === spaceId) continue
      for (const path of [resolve(other.rootPath), resolve(deps.dataDir, other.dir)]) {
        const target = await canonical(path)
        if (candidates.some(parent => contains(parent, path) || contains(parent, target))) return VisError.of('forbidden', 'space.purge_contains_project', {}, 'Project directory contains another project directory or application data')
      }
    }
    return null
  }
  async function completeDelete(requestId: string, plan: DeleteRecord) {
    if (plan.finished) return
    unavailable.add(plan.spaceId)
    if (row(plan.spaceId).deletedAt === null) {
      const host = deps.open(plan.spaceId, true)
      if (!host) throw VisError.of('not_found', 'space.not_found', {}, 'Project does not exist')
      host.sessions.dispose()
      host.db.update(s.sessions).set({ queuePaused: true }).run()
      await stopExecution(host.db, host.sessions, host.generation, requestId, plan)
      host.db.update(s.agentInstances).set({ status: 'exited', exitedAt: now(), exitReason: 'Project has been deleted' }).where(inArray(s.agentInstances.status, ['starting', 'ready'])).run()
      // The stopped state is the recovery boundary; do not archive work items or rewrite canvas and message history.
      db.transaction(tx => {
        tx.update(a.spaces).set({ deletedAt: now() }).where(eq(a.spaces.id, plan.spaceId)).run()
        tx.delete(a.workSlots).where(eq(a.workSlots.spaceId, plan.spaceId)).run()
        tx.update(a.idempotencyKeys).set({ result: plan }).where(eq(a.idempotencyKeys.requestId, requestId)).run()
      })
    }
    await deps.close(plan.spaceId)
    plan.finished = true
    db.update(a.idempotencyKeys).set({ result: plan }).where(eq(a.idempotencyKeys.requestId, requestId)).run()
    unavailable.delete(plan.spaceId)
    deps.drain()
  }
  async function finishPendingDelete(spaceId: string) {
    for (const key of db.select().from(a.idempotencyKeys).all()) {
      const plan = key.result as Partial<DeleteRecord>
      if (plan.lifecycle === 'space.delete' && plan.spaceId === spaceId && !plan.finished) await completeDelete(key.requestId, plan as DeleteRecord)
    }
  }
  return {
    assertCanCreate() {
      if (mutating) throw VisError.of('busy', 'space.mutation_in_progress', {}, 'Project change in progress; try again later')
    },
    unavailable: (spaceId: string) => unavailable.has(spaceId),
    async recoverDeletes() {
      for (const key of db.select().from(a.idempotencyKeys).all()) {
        const plan = key.result as Partial<DeleteRecord>
        if (plan.lifecycle !== 'space.delete' || plan.finished) continue
        // Persisted deletedAt means stopping is complete; do not reopen it on restart.
        const project = db.select().from(a.spaces).where(eq(a.spaces.id, plan.spaceId!)).get()
        if (!project || project.deletedAt !== null) {
          if (project) {
            await rm(resolve(deps.dataDir, project.dir, 'cache', 'previews'), { recursive: true, force: true })
            await rm(resolve(deps.dataDir, project.dir, 'cache', 'exports'), { recursive: true, force: true })
          }
          db.update(a.idempotencyKeys).set({ result: { ...plan, finished: true } }).where(eq(a.idempotencyKeys.requestId, key.requestId)).run()
        } else await completeDelete(key.requestId, plan as DeleteRecord)
      }
    },
    pendingDelete(spaceId: string) {
      return pendingDeleteIds().has(spaceId)
    },
    deletePlan(params: MethodParams<'space.deletePlan'>): MethodResult<'space.deletePlan'> {
      const project = row(params.spaceId)
      if (project.deletedAt !== null || unavailable.has(project.id)) throw VisError.of('not_found', 'space.deleted', {}, 'Project has been deleted')
      const host = deps.open(project.id)!
      return {
        rootPath: project.rootPath,
        runningTurns: host.db.select().from(s.turns).where(inArray(s.turns.status, [...ACTIVE_TURNS])).all().length,
        unfinishedJobs: host.db.select().from(s.generationJobs).all().filter(job => !(TERMINAL_JOBS as readonly string[]).includes(job.status)).length,
        workInProgress: host.db.select().from(s.workItems).where(and(isNull(s.workItems.archivedAt), eq(s.workItems.status, 'in_progress'))).all().length,
        unresolvedMessages: host.db.select().from(s.workMessages).where(and(isNull(s.workMessages.resolvedBy), inArray(s.workMessages.kind, ['question', 'blocked', 'escalation']))).all().length,
      }
    },
    delete(params: MethodParams<'space.delete'>): Promise<MethodResult<'space.delete'>> {
      return serial(async () => {
        let plan = replay('space.delete', params) as DeleteRecord | undefined
        if (!plan) {
          const project = row(params.spaceId)
          if (project.deletedAt !== null) throw VisError.of('not_found', 'space.deleted', {}, 'Project has been deleted')
          const host = deps.open(project.id)!
          plan = { lifecycle: 'space.delete', spaceId: project.id, finished: false,
            stops: host.db.select().from(s.turns).where(inArray(s.turns.status, [...ACTIVE_TURNS])).all().map(turn => ({ sessionId: turn.sessionId, turnId: turn.id })),
            cancelledJobs: host.db.select().from(s.generationJobs).all().filter(job => !(TERMINAL_JOBS as readonly string[]).includes(job.status)).map(job => ({ jobId: job.id, providerCancelled: false })),
          }
          save('space.delete', params, plan)
        }
        await completeDelete(params.requestId, plan)
        return { spaceId: plan.spaceId, cancelledJobs: plan.cancelledJobs }
      })
    },
    async listDeleted(_params: MethodParams<'space.listDeleted'>): Promise<MethodResult<'space.listDeleted'>> {
      const spaces = []
      for (const project of db.select().from(a.spaces).all().filter(project => project.deletedAt !== null)) {
        const reason = await safety(project.id).catch(() => ({ message: 'Project directory has moved or is inaccessible' }))
        spaces.push({ spaceId: project.id, name: project.name, rootPath: project.rootPath, deletedAt: project.deletedAt!, rootPathExists: existsSync(project.rootPath), canDeleteProjectDir: reason === null, canDeleteProjectDirReason: reason?.message ?? null, purgeError: project.purgeError })
      }
      return { spaces }
    },
    async diskUsage(params: MethodParams<'space.diskUsage'>): Promise<MethodResult<'space.diskUsage'>> {
      const project = deleted(params.spaceId)
      const [dataBytes, projectDirBytes] = await Promise.all([bytes(resolve(deps.dataDir, project.dir)), bytes(project.rootPath)])
      return { dataBytes: dataBytes ?? 0, projectDirBytes }
    },
    restore(params: MethodParams<'space.restore'>): Promise<MethodResult<'space.restore'>> {
      return serial(async () => {
        const known = replay('space.restore', params)
        if (known) return known as MethodResult<'space.restore'>
        await finishPendingDelete(params.spaceId)
        const project = deleted(params.spaceId)
        if (project.purgeError) throw VisError.of('invalid_transition', 'space.partial_purge', {}, 'Project has been partially permanently deleted and cannot be restored; retry permanent deletion')
        const file = resolve(deps.dataDir, project.dir, 'space.db')
        if (existsSync(file)) {
          const spaceDb = openSpaceDb(file)
          try {
            spaceDb.transaction(tx => {
              for (const item of tx.select().from(s.workItems).all()) {
                if (item.status === 'in_progress' || item.waitingSlotSince !== null) tx.update(s.workItems).set({ status: item.status === 'in_progress' ? 'todo' : item.status, waitingSlotSince: null, revision: item.revision + 1, statusChangedAt: now() }).where(eq(s.workItems.id, item.id)).run()
              }
              tx.update(s.sessions).set({ queuePaused: true }).run()
            })
          } finally { spaceDb.$client.close() }
        }
        return db.transaction(tx => {
          const membership = deps.restoreSeries?.(project.id)
          const result = { spaceId: project.id, name: project.name, rootPath: project.rootPath, createdAt: project.createdAt,
            ...(membership ? { series: membership } : {}) }
          tx.update(a.spaces).set({ deletedAt: null }).where(eq(a.spaces.id, project.id)).run()
          save('space.restore', params, result)
          return result
        })
      })
    },
    purge(params: MethodParams<'space.purge'>): Promise<MethodResult<'space.purge'>> {
      return serial(async () => {
        let record = replay('space.purge', params) as PurgeRecord | undefined
        if (record?.finished) return record.result
        await finishPendingDelete(params.spaceId)
        let project = deleted(params.spaceId)
        const data = resolve(deps.dataDir, project.dir)
        const reason = params.deleteProjectDir ? await safety(project.id) : null
        if (reason) throw reason
        const preservedRoot = await canonical(resolve(project.rootPath))
        const resolvedData = await canonical(data)
        for (const other of db.select().from(a.spaces).all()) {
          if (other.id !== project.id && (contains(resolvedData, await canonical(resolve(other.rootPath))) || contains(resolvedData, await canonical(resolve(deps.dataDir, other.dir))))) {
            throw VisError.of('forbidden', 'space.purge_data_contains_project', {}, 'Application data directory contains another project directory and cannot be permanently deleted')
          }
        }
        let movedProjectDir = record?.result.movedProjectDir
        record ??= { lifecycle: 'space.purge', finished: false, result: { spaceId: project.id, projectDirDeleted: params.deleteProjectDir ?? false } }
        save('space.purge', params, record)
        db.update(a.spaces).set({ purgeError: 'Permanent deletion is not complete; try again' }).where(eq(a.spaces.id, project.id)).run()
        try {
          if (!params.deleteProjectDir && contains(resolvedData, preservedRoot) && existsSync(project.rootPath)) {
            movedProjectDir = resolve(deps.dataDir, 'orphaned-projects', project.id)
            await mkdir(dirname(movedProjectDir), { recursive: true })
            record.result.movedProjectDir = movedProjectDir
            save('space.purge', params, record)
            await rename(preservedRoot, movedProjectDir)
            db.update(a.spaces).set({ rootPath: movedProjectDir }).where(eq(a.spaces.id, project.id)).run()
            project = { ...project, rootPath: movedProjectDir }
          }
          // After a crash following a successful move, still return the preserved location without ever recreating deleted data.
          if (movedProjectDir && existsSync(movedProjectDir) && !existsSync(project.rootPath)) {
            db.update(a.spaces).set({ rootPath: movedProjectDir }).where(eq(a.spaces.id, project.id)).run()
            project = { ...project, rootPath: movedProjectDir }
          }
          await rm(data, { recursive: true, force: true })
          if (params.deleteProjectDir) await rm(project.rootPath, { recursive: true, force: true })
          const result = { spaceId: project.id, projectDirDeleted: params.deleteProjectDir ?? false, ...(movedProjectDir ? { movedProjectDir } : {}) }
          db.transaction(tx => {
            tx.delete(a.workSlots).where(eq(a.workSlots.spaceId, project.id)).run()
            tx.delete(a.spaces).where(eq(a.spaces.id, project.id)).run()
            save('space.purge', params, { lifecycle: 'space.purge', finished: true, result })
          })
          return result
        } catch (error) {
          db.update(a.spaces).set({ purgeError: error instanceof Error ? error.message : String(error) }).where(eq(a.spaces.id, project.id)).run()
          throw error
        }
      })
    },
  }
}
