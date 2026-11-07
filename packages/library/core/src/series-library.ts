import { createHash, randomUUID } from 'node:crypto'
import { closeSync, copyFileSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ulid, VisError } from '@vis/domain'
import type { EntityKind, SeriesRevisionView } from '@vis/protocol'
import { and, desc, eq, isNull, openSeriesDb, seriesSchema as s, sql, type SeriesDb } from '@vis/storage'

export type SeriesMedia = s.SeriesMedia
export type SeriesRevision = typeof s.seriesEntityRevisions.$inferSelect

function digestFile(path: string) {
  const file = openSync(path, 'r')
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  try {
    let size = 0
    for (let count = readSync(file, buffer); count > 0; count = readSync(file, buffer)) {
      hash.update(buffer.subarray(0, count))
      size += count
    }
    return { hash: hash.digest('hex'), byteSize: size }
  } finally { closeSync(file) }
}

export function seriesBlobPath(blobsDir: string, hash: string) {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid series blob hash')
  return join(blobsDir, hash.slice(0, 2), hash)
}

/** Atomic installation leaves at worst an unreferenced blob when a database write fails. */
export function copySeriesBlob(source: string, target: string, media: Pick<SeriesMedia, 'hash' | 'byteSize'>, link = linkSync) {
  mkdirSync(dirname(target), { recursive: true })
  const temporary = `${target}.${randomUUID()}.tmp`
  try {
    if (!existsSync(target)) {
      try { link(source, temporary) }
      catch (error) {
        if (!['EXDEV', 'EPERM', 'EACCES', 'ENOTSUP', 'EMLINK'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
        copyFileSync(source, temporary)
      }
      const digest = digestFile(temporary)
      if (digest.hash !== media.hash || digest.byteSize !== media.byteSize) throw new Error('Series blob hash or size mismatch')
      const fd = openSync(temporary, 'r+')
      try { fsyncSync(fd) } finally { closeSync(fd) }
      renameSync(temporary, target)
    } else if (statSync(target).size !== media.byteSize) {
      // Targets are content-addressed and only installed after their hash is verified, so a size check is enough here;
      // rehashing every ref on each link, update and publish would block the event loop inside a write transaction.
      throw new Error('Series blob hash or size mismatch')
    }
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary)
  }
}

export function seriesRevisionView(row: SeriesRevision): SeriesRevisionView {
  return {
    revision: row.revision, name: row.name, description: row.description,
    refs: row.refs.map(({ refId, mime, width, height }) => ({ refId, mime, ...(width === undefined ? {} : { width }), ...(height === undefined ? {} : { height }) })),
    hasVoice: row.voice !== null, publishedAt: row.publishedAt,
    ...(row.publishedFromSpaceId ? { publishedFromSpaceId: row.publishedFromSpaceId } : {}),
  }
}

export function createSeriesLibrary(deps: { dataDir: string; now?: () => number }) {
  const opened = new Map<string, { db: SeriesDb; blobsDir: string }>()
  function open(seriesId: string) {
    // IDs come from app.db, never from a filesystem path supplied by a caller.
    if (!/^[A-Za-z0-9_-]+$/.test(seriesId)) throw VisError.of('not_found', 'series.not_found', {}, 'Series does not exist')
    let library = opened.get(seriesId)
    if (!library) {
      const dir = join(deps.dataDir, 'series', seriesId)
      mkdirSync(join(dir, 'blobs'), { recursive: true })
      library = { db: openSeriesDb(join(dir, 'library.db')), blobsDir: join(dir, 'blobs') }
      opened.set(seriesId, library)
    }
    return library
  }
  function entity(seriesId: string, entityId: string) {
    const { db } = open(seriesId)
    const row = db.select().from(s.seriesEntities).where(and(eq(s.seriesEntities.id, entityId), isNull(s.seriesEntities.deletedAt))).get()
    if (!row) throw VisError.of('not_found', 'series.entity_not_found', { seriesEntityId: entityId }, 'Series setting does not exist')
    return row
  }
  function revision(seriesId: string, entityId: string, pin?: number) {
    entity(seriesId, entityId)
    const row = open(seriesId).db.select().from(s.seriesEntityRevisions)
      .where(and(eq(s.seriesEntityRevisions.seriesEntityId, entityId), pin === undefined ? undefined : eq(s.seriesEntityRevisions.revision, pin)))
      .orderBy(desc(s.seriesEntityRevisions.revision)).get()
    if (!row) throw VisError.of('not_found', 'series.revision_not_found', {}, 'Series setting revision does not exist')
    return row
  }
  function latest(seriesId: string) {
    const { db } = open(seriesId)
    return db.select({ entity: s.seriesEntities, latest: s.seriesEntityRevisions }).from(s.seriesEntities)
      .innerJoin(s.seriesEntityRevisions, and(eq(s.seriesEntities.id, s.seriesEntityRevisions.seriesEntityId),
        sql`${s.seriesEntityRevisions.revision} = (select max(r.revision) from series_entity_revisions r where r.series_entity_id = ${s.seriesEntities.id})`))
      .where(isNull(s.seriesEntities.deletedAt)).orderBy(s.seriesEntities.createdAt, s.seriesEntities.id).all()
  }
  return {
    open, entity, revision, latest,
    latestRevisions: (seriesId: string) => new Map(latest(seriesId).map(row => [row.entity.id, row.latest.revision])),
    mediaGet(seriesId: string, refId: string) {
      const rows = open(seriesId).db.select().from(s.seriesEntityRevisions)
        .where(sql`exists (select 1 from json_each(${s.seriesEntityRevisions.refs}) where json_extract(value, '$.refId') = ${refId})
          or json_extract(${s.seriesEntityRevisions.voice}, '$.refId') = ${refId}`).all()
      const media = rows.flatMap(row => [...row.refs, ...(row.voice ? [row.voice] : [])]).find(ref => ref.refId === refId)
      if (!media) throw VisError.of('not_found', 'series.ref_not_found', {}, 'Series reference does not exist')
      return { path: seriesBlobPath(open(seriesId).blobsDir, media.hash), mime: media.mime }
    },
    publish(seriesId: string, input: {
      requestId: string; fingerprint: string; seriesEntityId?: string
      kind: EntityKind; name: string; description: string; refs: SeriesMedia[]; voice: SeriesMedia | null; spaceId: string
    }) {
      const now = (deps.now ?? Date.now)()
      return open(seriesId).db.transaction(tx => {
        const known = tx.select().from(s.seriesPublishRequests).where(eq(s.seriesPublishRequests.requestId, input.requestId)).get()
        if (known) {
          if (known.fingerprint !== input.fingerprint) throw VisError.of('idempotency_conflict', 'request.id_conflict', {}, 'Publication request has different content')
          return { seriesEntityId: known.seriesEntityId, revision: known.revision }
        }
        const duplicate = tx.select().from(s.seriesEntities).where(and(eq(s.seriesEntities.kind, input.kind), isNull(s.seriesEntities.deletedAt),
          sql`lower(trim(${s.seriesEntities.name})) = lower(trim(${input.name}))`)).get()
        if (duplicate && duplicate.id !== input.seriesEntityId) throw VisError.of('invalid_params', 'series.entity_name_taken', { seriesEntityId: duplicate.id }, 'A series setting with this kind and name already exists')
        const id = input.seriesEntityId ?? `seriesEntity_${ulid(now)}`
        const previous = input.seriesEntityId ? revision(seriesId, id) : undefined
        const number = (previous?.revision ?? 0) + 1
        if (previous) tx.update(s.seriesEntities).set({ name: input.name }).where(eq(s.seriesEntities.id, id)).run()
        else tx.insert(s.seriesEntities).values({ id, kind: input.kind, name: input.name, createdAt: now }).run()
        tx.insert(s.seriesEntityRevisions).values({ seriesEntityId: id, revision: number, name: input.name, description: input.description,
          refs: input.refs, voice: input.voice, publishedAt: now, publishedFromSpaceId: input.spaceId }).run()
        tx.insert(s.seriesPublishRequests).values({ requestId: input.requestId, fingerprint: input.fingerprint, seriesEntityId: id, revision: number }).run()
        return { seriesEntityId: id, revision: number }
      }, { behavior: 'immediate' })
    },
    close(seriesId: string) {
      opened.get(seriesId)?.db.$client.close()
      opened.delete(seriesId)
    },
    closeAll() {
      for (const { db } of opened.values()) db.$client.close()
      opened.clear()
    },
  }
}
export type SeriesLibrary = ReturnType<typeof createSeriesLibrary>
