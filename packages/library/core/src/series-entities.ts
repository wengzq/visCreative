import type { AssetStore } from '@vis/assets'
import { ulid, VisError } from '@vis/domain'
import type { EntityMember, EntityView, MethodParams, SpaceSeries } from '@vis/protocol'
import { and, appendEvent, desc, eq, fingerprint, isNull, runIdempotent, seriesSchema, spaceSchema as s, type SpaceDb, type SpaceTx } from '@vis/storage'
import { assertEntityRevision, entityRow, findEntityByName, readEntity, writeEntity, type EntitiesChanged } from './entities'
import { copySeriesBlob, seriesBlobPath, seriesRevisionView, type SeriesLibrary, type SeriesMedia, type SeriesRevision } from './series-library'

export function detachSeriesEntities(db: SpaceDb, now: number) {
  db.transaction(tx => {
    for (const row of tx.select().from(s.entities).where(isNull(s.entities.deletedAt)).all()) {
      if (!row.seriesEntityId) continue
      tx.update(s.entities).set({ seriesEntityId: null, seriesRevision: null, seriesBaseRevision: null, seriesMemberAssetIds: [], revision: row.revision + 1, updatedAt: now })
        .where(eq(s.entities.id, row.id)).run()
      appendEvent(tx, { type: 'entity.updated', entityType: 'entity', entityId: row.id, payload: { entityId: row.id, revision: row.revision + 1 } }, now)
    }
    // Deleted settings must not regain a link after restoring or importing their historical data.
    tx.update(s.entities).set({ seriesEntityId: null, seriesRevision: null, seriesBaseRevision: null, seriesMemberAssetIds: [] }).run()
  }, { behavior: 'immediate' })
}

export function createSeriesEntityService(deps: {
  db: SpaceDb; assets: AssetStore; spaceId: string; libraries: SeriesLibrary
  series(): SpaceSeries | null
  now?: () => number; onEntitiesChanged?: EntitiesChanged
  afterSeriesWrite?: () => void
}) {
  const { db, assets, libraries } = deps
  const now = deps.now ?? Date.now
  function requireSeries() {
    const series = deps.series()
    if (!series) throw VisError.of('invalid_params', 'series.project_required', {}, 'This project does not belong to a series')
    return series
  }
  function view(tx: SpaceTx, id: string): EntityView {
    const entity = readEntity(tx, id)
    if (entity.series) entity.series.latestRevision = libraries.revision(requireSeries().seriesId, entity.series.seriesEntityId).revision
    return entity
  }
  function mediaFromProject(tx: SpaceTx, versionId: string, seriesId: string): SeriesMedia {
    const row = tx.select({ version: s.assetVersions, blob: s.blobs }).from(s.assetVersions)
      .innerJoin(s.blobs, eq(s.blobs.hash, s.assetVersions.blobHash)).where(eq(s.assetVersions.id, versionId)).get()
    if (!row) throw VisError.of('not_found', 'asset.version_not_found', {}, 'Setting media version does not exist')
    const { version, blob } = row
    const media: SeriesMedia = { refId: `seriesRef_${ulid(now())}`, hash: blob.hash, byteSize: blob.byteSize, mime: version.mime,
      ...(version.width === null ? {} : { width: version.width }), ...(version.height === null ? {} : { height: version.height }),
      ...(version.durationMs === null ? {} : { durationMs: version.durationMs }) }
    copySeriesBlob(assets.blobPath(blob.hash), seriesBlobPath(libraries.open(seriesId).blobsDir, blob.hash), media)
    return media
  }
  function copyIntoProject(tx: SpaceTx, seriesId: string, setting: SeriesRevision, existingId?: string) {
    const library = libraries.open(seriesId)
    const copied: EntityMember[] = []
    const refs = setting.refs.map(media => {
      copySeriesBlob(seriesBlobPath(library.blobsDir, media.hash), assets.blobPath(media.hash), media)
      const registered = assets.registerVersion(tx, { staged: { hash: media.hash, byteSize: media.byteSize }, kind: 'image', mime: media.mime,
        origin: 'import', displayName: setting.name, ...(media.width === undefined ? {} : { width: media.width }), ...(media.height === undefined ? {} : { height: media.height }) })
      copied.push({ assetId: registered.assetId, role: 'image' })
      return { assetVersionId: registered.assetVersionId }
    })
    if (setting.voice) {
      const media = setting.voice
      copySeriesBlob(seriesBlobPath(library.blobsDir, media.hash), assets.blobPath(media.hash), media)
      const registered = assets.registerVersion(tx, { staged: { hash: media.hash, byteSize: media.byteSize }, kind: 'audio', mime: media.mime,
        origin: 'import', displayName: setting.name, ...(media.durationMs === undefined ? {} : { durationMs: media.durationMs }) })
      copied.push({ assetId: registered.assetId, role: 'voice' })
    }
    const row = existingId ? entityRow(tx, existingId) : undefined
    const retained = row ? tx.select({ assetId: s.entityAssets.assetId, role: s.entityAssets.role }).from(s.entityAssets)
      .where(eq(s.entityAssets.entityId, row.id)).all().filter(member => !row.seriesMemberAssetIds.includes(member.assetId)) : []
    const kind = libraries.entity(seriesId, setting.seriesEntityId).kind
    const written = writeEntity(tx, { kind, name: setting.name, description: setting.description, refs, members: [...retained, ...copied] },
      { ...(existingId ? { id: existingId } : {}), now: now(), onEntitiesChanged: deps.onEntitiesChanged })
    tx.update(s.entities).set({ seriesEntityId: setting.seriesEntityId, seriesRevision: setting.revision,
      seriesBaseRevision: written.revision, seriesMemberAssetIds: copied.map(member => member.assetId) }).where(eq(s.entities.id, written.id)).run()
    return view(tx, written.id)
  }
  function linked(tx: SpaceTx, entityId: string) {
    const row = entityRow(tx, entityId)
    if (!row.seriesEntityId || row.seriesRevision === null) throw VisError.of('invalid_params', 'entity.series_required', {}, 'Setting is not linked to a series')
    return row as typeof row & { seriesEntityId: string; seriesRevision: number }
  }
  function replace(params: MethodParams<'entity.updateFromSeries'>, reset: boolean) {
    return runIdempotent(db, { requestId: params.requestId, method: reset ? 'entity.resetToSeries' : 'entity.updateFromSeries', params }, tx => {
      const { seriesId } = requireSeries()
      const row = linked(tx, params.entityId)
      assertEntityRevision(row, params.expectedRevision)
      return copyIntoProject(tx, seriesId, libraries.revision(seriesId, row.seriesEntityId, reset ? row.seriesRevision : undefined), row.id)
    }, now)
  }
  return {
    latestRevisions: () => {
      const series = deps.series()
      return series ? libraries.latestRevisions(series.seriesId) : new Map<string, number>()
    },
    list(params: MethodParams<'series.entityList'>) {
      const series = deps.series()
      if (!series) return { series: null, items: [] }
      const links = db.select().from(s.entities).where(isNull(s.entities.deletedAt)).all()
      return { series: { seriesId: series.seriesId, name: series.name }, items: libraries.latest(series.seriesId)
        .filter(row => (!params.kind || row.entity.kind === params.kind) && (!params.query?.trim() || `${row.latest.name}\n${row.latest.description}`.toLowerCase().includes(params.query.trim().toLowerCase())))
        .map(row => {
          const link = links.find(entity => entity.seriesEntityId === row.entity.id)
          return { seriesEntityId: row.entity.id, kind: row.entity.kind, latest: seriesRevisionView(row.latest),
            ...(link ? { linkedEntityId: link.id, linkedRevision: link.seriesRevision! } : {}) }
        }) }
    },
    link(params: MethodParams<'entity.link'>) {
      return runIdempotent(db, { requestId: params.requestId, method: 'entity.link', params }, tx => {
        const { seriesId } = requireSeries()
        const already = tx.select().from(s.entities).where(and(eq(s.entities.seriesEntityId, params.seriesEntityId), isNull(s.entities.deletedAt))).get()
        if (already) return view(tx, already.id)
        const source = libraries.entity(seriesId, params.seriesEntityId)
        const latest = libraries.revision(seriesId, source.id)
        const duplicate = findEntityByName(tx, source.kind, latest.name)
        if (params.replaceEntityId) {
          if (duplicate?.id !== params.replaceEntityId || params.expectedRevision === undefined) throw VisError.of('invalid_params', 'entity.replace_target_required', {}, 'Replacement must name the matching setting and its revision')
          assertEntityRevision(duplicate, params.expectedRevision)
        } else if (duplicate) {
          throw VisError.of('invalid_params', 'entity.name_taken', { entityId: duplicate.id, seriesEntityId: source.id, kind: source.kind, name: latest.name }, 'A project setting with this kind and name already exists')
        }
        return copyIntoProject(tx, seriesId, latest, params.replaceEntityId)
      }, now)
    },
    diff(params: MethodParams<'entity.seriesDiff'>) {
      return db.transaction(tx => {
        const { seriesId } = requireSeries()
        const row = linked(tx, params.entityId)
        return { entity: view(tx, row.id), pinned: seriesRevisionView(libraries.revision(seriesId, row.seriesEntityId, row.seriesRevision)),
          latest: seriesRevisionView(libraries.revision(seriesId, row.seriesEntityId)) }
      })
    },
    updateFromSeries: (p: MethodParams<'entity.updateFromSeries'>) => replace(p, false),
    resetToSeries: (p: MethodParams<'entity.resetToSeries'>) => replace(p, true),
    publish(params: MethodParams<'entity.publish'>) {
      return runIdempotent(db, { requestId: params.requestId, method: 'entity.publish', params }, tx => {
        const { seriesId } = requireSeries()
        const row = entityRow(tx, params.entityId)
        assertEntityRevision(row, params.expectedRevision)
        const fp = fingerprint('entity.publish', { ...params, spaceId: deps.spaceId })
        const known = libraries.open(seriesId).db.select().from(seriesSchema.seriesPublishRequests)
          .where(eq(seriesSchema.seriesPublishRequests.requestId, params.requestId)).get()
        if (known && known.fingerprint !== fp) throw VisError.of('idempotency_conflict', 'request.id_conflict', {}, 'Publication request has different content')
        if (!known && row.seriesEntityId) {
          const latest = libraries.revision(seriesId, row.seriesEntityId)
          if (params.resolve === 'takeSeries') {
            const entity = copyIntoProject(tx, seriesId, latest, row.id)
            return { entity, seriesEntityId: row.seriesEntityId, seriesRevision: latest.revision }
          }
          if (latest.revision > (row.seriesRevision ?? 0)) {
            if (!params.resolve) throw VisError.of('revision_conflict', 'entity.series_moved', { seriesRevision: latest.revision }, 'The series has a newer revision; choose which version to keep')
          }
        }
        let published = known ? { seriesEntityId: known.seriesEntityId, revision: known.revision } : undefined
        if (!published) {
          const refs = row.refs.map(ref => mediaFromProject(tx, ref.assetVersionId, seriesId))
          const voice = tx.select({ versionId: s.assetVersions.id }).from(s.entityAssets)
            .innerJoin(s.assetVersions, eq(s.assetVersions.assetId, s.entityAssets.assetId))
            .where(and(eq(s.entityAssets.entityId, row.id), eq(s.entityAssets.role, 'voice')))
            .orderBy(s.entityAssets.assetId, desc(s.assetVersions.version)).get()
          published = libraries.publish(seriesId, { requestId: params.requestId, fingerprint: fp,
            ...(row.seriesEntityId ? { seriesEntityId: row.seriesEntityId } : {}), kind: row.kind, name: row.name, description: row.description,
            refs, voice: voice ? mediaFromProject(tx, voice.versionId, seriesId) : null, spaceId: deps.spaceId })
          deps.afterSeriesWrite?.()
        }
        const revision = row.revision + 1
        // The members that became the published refs and voice are now series copies, so a later update or reset replaces them
        // instead of keeping them beside fresh copies.
        const refAssets = new Set(row.refs.map(ref => tx.select({ assetId: s.assetVersions.assetId }).from(s.assetVersions)
          .where(eq(s.assetVersions.id, ref.assetVersionId)).get()?.assetId))
        const members = tx.select({ assetId: s.entityAssets.assetId, role: s.entityAssets.role }).from(s.entityAssets).where(eq(s.entityAssets.entityId, row.id)).all()
          .sort((left, right) => left.assetId < right.assetId ? -1 : left.assetId > right.assetId ? 1 : 0)
        const voiceAsset = members.find(member => member.role === 'voice')?.assetId
        const owned = members.filter(member => (member.role === 'image' && refAssets.has(member.assetId)) || member.assetId === voiceAsset).map(member => member.assetId)
        tx.update(s.entities).set({ seriesEntityId: published.seriesEntityId, seriesRevision: published.revision, seriesBaseRevision: revision,
          seriesMemberAssetIds: owned, revision, updatedAt: now() }).where(eq(s.entities.id, row.id)).run()
        appendEvent(tx, { type: 'entity.updated', entityType: 'entity', entityId: row.id, payload: { entityId: row.id, revision } }, now())
        return { entity: view(tx, row.id), seriesEntityId: published.seriesEntityId, seriesRevision: published.revision }
      }, now)
    },
    detach: () => detachSeriesEntities(db, now()),
  }
}
export type SeriesEntityService = ReturnType<typeof createSeriesEntityService>
