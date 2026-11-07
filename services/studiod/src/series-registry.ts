import { ulid, VisError } from '@vis/domain'
import { createSeriesLibrary } from '@vis/library-core'
import type { MethodParams, MethodResult, SeriesTarget, SeriesView, SpaceSeries } from '@vis/protocol'
import { SERIES_LIMITS } from '@vis/protocol'
import { and, appSchema as a, asc, eq, fingerprint, isNull, sql, type AppDb } from '@vis/storage'
import type { SpaceHost } from './space-host'

type AppTx = Parameters<Parameters<AppDb['transaction']>[0]>[0]
// expectedRevisions pins each checklist publish before it runs, so a retry after a crash replays the same publish request.
type SetSeriesPlan = { operation: 'space.setSeries'; finished: boolean; expectedRevisions?: Record<string, number>; result: MethodResult<'space.setSeries'> }

export function createSeriesRegistry(deps: {
  db: AppDb; dataDir: string; now(): number
  open(spaceId: string): SpaceHost | undefined
  opened(spaceId: string): SpaceHost | undefined
}) {
  const { db, now } = deps
  const libraries = createSeriesLibrary({ dataDir: deps.dataDir, now })
  function row(seriesId: string, tx: AppTx | AppDb = db) {
    const found = tx.select().from(a.series).where(and(eq(a.series.id, seriesId), isNull(a.series.deletedAt))).get()
    if (!found) throw VisError.of('not_found', 'series.not_found', { seriesId }, 'Series does not exist or has been deleted')
    return found
  }
  function availableName(tx: AppTx, name: string, except?: string) {
    const found = tx.select().from(a.series).where(and(isNull(a.series.deletedAt), sql`lower(trim(${a.series.name})) = lower(trim(${name}))`)).get()
    if (found && found.id !== except) throw VisError.of('invalid_params', 'series.name_taken', { seriesId: found.id }, 'A series with this name already exists')
  }
  function target(tx: AppTx, value: SeriesTarget) {
    if ('seriesId' in value) return row(value.seriesId, tx).id
    availableName(tx, value.name)
    const id = `series_${ulid(now())}`
    tx.insert(a.series).values({ id, name: value.name.trim(), createdAt: now() }).run()
    return id
  }
  function episode(tx: AppTx | AppDb, seriesId: string, requested?: number, except?: string) {
    const used = new Set(tx.select().from(a.spaces).where(and(eq(a.spaces.seriesId, seriesId), isNull(a.spaces.deletedAt))).all()
      .filter(space => space.id !== except).map(space => space.episode ?? 0))
    if (requested !== undefined) {
      if (used.has(requested)) throw VisError.of('invalid_params', 'series.episode_taken', { episode: requested }, 'This episode number is already in use')
      return requested
    }
    let next = Math.max(0, ...used) + 1
    if (next <= SERIES_LIMITS.episode) return next
    next = 1
    while (used.has(next)) next++
    if (next > SERIES_LIMITS.episode) throw VisError.of('invalid_params', 'series.episode_limit', {}, 'This series has no available episode numbers')
    return next
  }
  function membership(spaceId: string): SpaceSeries | null {
    const space = db.select().from(a.spaces).where(eq(a.spaces.id, spaceId)).get()
    if (!space?.seriesId || space.episode === null) return null
    const series = row(space.seriesId)
    return { seriesId: series.id, name: series.name, episode: space.episode }
  }
  function view(seriesId: string): SeriesView {
    const series = row(seriesId)
    return { seriesId: series.id, name: series.name, createdAt: series.createdAt, settingCount: libraries.latest(seriesId).length,
      episodes: db.select().from(a.spaces).where(and(eq(a.spaces.seriesId, seriesId), isNull(a.spaces.deletedAt)))
        .orderBy(asc(a.spaces.episode)).all().map(space => ({ spaceId: space.id, name: space.name, episode: space.episode! })) }
  }
  function replay(method: string, params: { requestId: string }) {
    const known = db.select().from(a.idempotencyKeys).where(eq(a.idempotencyKeys.requestId, params.requestId)).get()
    if (known && known.fingerprint !== fingerprint(method, params)) throw VisError.of('idempotency_conflict', 'request.id_conflict', {}, 'requestId has already been used for a different request')
    return known?.result
  }
  function save(tx: AppTx | AppDb, method: string, params: { requestId: string }, result: unknown) {
    tx.insert(a.idempotencyKeys).values({ requestId: params.requestId, fingerprint: fingerprint(method, params), result })
      .onConflictDoUpdate({ target: a.idempotencyKeys.requestId, set: { result } }).run()
  }
  function finishDetach(spaceId: string) {
    const project = db.select().from(a.spaces).where(eq(a.spaces.id, spaceId)).get()
    const host = deps.opened(spaceId)
    if (project?.seriesDetachPending && host) {
      host.seriesEntities.detach()
      db.update(a.spaces).set({ seriesDetachPending: false }).where(eq(a.spaces.id, spaceId)).run()
    }
  }
  return {
    libraries, target, episode, membership,
    require: (seriesId: string) => row(seriesId),
    list: () => ({ items: db.select().from(a.series).where(isNull(a.series.deletedAt)).orderBy(a.series.createdAt, a.series.id).all().map(series => view(series.id)) }),
    create(params: MethodParams<'series.create'>) {
      const known = replay('series.create', params)
      if (known) return known as SeriesView
      return db.transaction(tx => {
        const seriesId = target(tx, { name: params.name })
        const result = view(seriesId)
        save(tx, 'series.create', params, result)
        return result
      }, { behavior: 'immediate' })
    },
    rename(params: MethodParams<'series.rename'>) {
      return db.transaction(tx => {
        row(params.seriesId, tx)
        availableName(tx, params.name, params.seriesId)
        tx.update(a.series).set({ name: params.name.trim() }).where(eq(a.series.id, params.seriesId)).run()
        return view(params.seriesId)
      }, { behavior: 'immediate' })
    },
    delete(params: MethodParams<'series.delete'>) {
      const known = replay('series.delete', params) as MethodResult<'series.delete'> | undefined
      const result = known ?? db.transaction(tx => {
        row(params.seriesId, tx)
        const spaces = tx.select().from(a.spaces).where(eq(a.spaces.seriesId, params.seriesId)).all()
        tx.update(a.spaces).set({ seriesId: null, episode: null, seriesDetachPending: true }).where(eq(a.spaces.seriesId, params.seriesId)).run()
        tx.update(a.series).set({ deletedAt: now() }).where(eq(a.series.id, params.seriesId)).run()
        const result = { seriesId: params.seriesId, detachedSpaceIds: spaces.map(space => space.id) }
        save(tx, 'series.delete', params, result)
        return result
      }, { behavior: 'immediate' })
      for (const spaceId of result.detachedSpaceIds) finishDetach(spaceId)
      libraries.close(params.seriesId)
      return result
    },
    setSeries(params: MethodParams<'space.setSeries'>) {
      let plan = replay('space.setSeries', params) as SetSeriesPlan | undefined
      if (plan?.finished) return plan.result
      if (!plan) plan = db.transaction(tx => {
        const space = tx.select().from(a.spaces).where(and(eq(a.spaces.id, params.spaceId), isNull(a.spaces.deletedAt))).get()
        if (!space) throw VisError.of('not_found', 'space.not_found', {}, 'Project does not exist')
        const seriesId = params.series ? target(tx, params.series) : null
        const number = seriesId ? episode(tx, seriesId, params.episode ?? (seriesId === space.seriesId ? space.episode ?? undefined : undefined), space.id) : null
        tx.update(a.spaces).set({ seriesId, episode: number, seriesDetachPending: space.seriesDetachPending || space.seriesId !== seriesId }).where(eq(a.spaces.id, space.id)).run()
        const value: SetSeriesPlan = { operation: 'space.setSeries', finished: false,
          result: { spaceId: space.id, series: membership(space.id), published: [], failed: [] } }
        save(tx, 'space.setSeries', params, value)
        return value
      }, { behavior: 'immediate' })
      finishDetach(params.spaceId)
      if (plan.result.series && params.publishEntityIds?.length) {
        const host = deps.open(params.spaceId)!
        for (const [index, entityId] of params.publishEntityIds.entries()) {
          if (plan.result.published.includes(entityId) || plan.result.failed.some(failure => failure.entityId === entityId)) continue
          try {
            const expectedRevisions = plan.expectedRevisions ??= {}
            if (expectedRevisions[entityId] === undefined) {
              expectedRevisions[entityId] = host.entities.get({ entityId }).revision
              save(db, 'space.setSeries', params, plan)
            }
            host.seriesEntities.publish({ requestId: `${params.requestId}:publish:${index}`, entityId, expectedRevision: expectedRevisions[entityId] })
            plan.result.published.push(entityId)
          } catch (error) {
            plan.result.failed.push({ entityId, code: error instanceof VisError ? error.code : 'internal' })
          }
          save(db, 'space.setSeries', params, plan)
        }
      }
      plan.finished = true
      save(db, 'space.setSeries', params, plan)
      return plan.result
    },
    prepareRestore(spaceId: string) {
      const space = db.select().from(a.spaces).where(eq(a.spaces.id, spaceId)).get()!
      if (!space.seriesId) return null
      const series = row(space.seriesId)
      const number = episode(db, series.id, undefined, spaceId)
      const occupied = db.select().from(a.spaces).where(and(eq(a.spaces.seriesId, series.id), eq(a.spaces.episode, space.episode!), isNull(a.spaces.deletedAt))).get()
      const restoredEpisode = occupied ? number : space.episode!
      db.update(a.spaces).set({ episode: restoredEpisode }).where(eq(a.spaces.id, spaceId)).run()
      return { seriesId: series.id, name: series.name, episode: restoredEpisode }
    },
  }
}
export type SeriesRegistry = ReturnType<typeof createSeriesRegistry>
