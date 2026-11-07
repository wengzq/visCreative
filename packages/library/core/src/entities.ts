import { ulid, VisError } from '@vis/domain'
import { entity, isMediaKind, type EntityKind, type EntityMember, type EntityRef, type EntityView, type ScriptDoc } from '@vis/protocol'
import { and, appendEvent, eq, inArray, isNull, runIdempotent, spaceSchema as s, sql, type SpaceDb, type SpaceTx } from '@vis/storage'
import { createProposalMethods } from './proposals'

export type EntitiesChanged = (tx: SpaceTx, entityIds: string[]) => void
export type EntityWrite = { kind: EntityKind; name: string; description?: string | undefined; refs?: EntityRef[] | undefined; members?: EntityMember[] | undefined; pendingSourceNodeId?: string | null | undefined }
export const normalizedEntityName = (name: string) => name.trim().toLowerCase()

export function entityRow(tx: SpaceTx, id: string, includeDeleted = false) {
  const row = tx.select().from(s.entities).where(and(eq(s.entities.id, id), includeDeleted ? undefined : isNull(s.entities.deletedAt))).get()
  if (!row) throw VisError.of('not_found', 'entity.not_found', { entityId: id }, 'The setting does not exist or has been deleted')
  return row
}

export function findEntityByName(tx: SpaceTx, kind: EntityKind, name: string) {
  return tx.select().from(s.entities).where(and(eq(s.entities.kind, kind), isNull(s.entities.deletedAt),
    sql`lower(trim(${s.entities.name})) = lower(trim(${name}))`)).get()
}

export function currentScripts(tx: SpaceTx, includeDeleted = false) {
  return tx.select({ nodeId: s.nodes.id, title: s.nodes.title, createdAt: s.nodes.createdAt, slot: s.slots, doc: s.slotRevisions.scriptDoc })
    .from(s.nodes).innerJoin(s.slots, and(eq(s.slots.nodeId, s.nodes.id), eq(s.slots.slotKey, 'main')))
    .innerJoin(s.slotRevisions, and(eq(s.slotRevisions.slotId, s.slots.id), eq(s.slotRevisions.revision, s.slots.currentRevision)))
    .where(and(eq(s.nodes.kind, 'script'), includeDeleted ? undefined : isNull(s.nodes.deletedAt), includeDeleted ? undefined : isNull(s.slots.deletedAt))).orderBy(s.nodes.createdAt, s.nodes.id).all()
}

export function shotUsesEntity(shot: ScriptDoc['shots'][number], id: string) {
  return shot.sceneId === id || shot.characterIds.includes(id) || shot.propIds.includes(id)
    || Object.values(shot).some(value => typeof value === 'string' && value.includes(`{{asset:${id}}}`))
}

export function projectScriptEntities(tx: SpaceTx, source: ScriptDoc): ScriptDoc {
  return projectScriptsEntities(tx, [source])[0]!
}

/** All current documents in one canvas read share a single settings/source-node query. */
export function projectScriptsEntities(tx: SpaceTx, sources: ScriptDoc[]): ScriptDoc[] {
  const ids = [...new Set(sources.flatMap(source => source.castIds ? [...source.castIds, ...(source.styleId ? [source.styleId] : [])] : []))]
  const rows = ids.length ? tx.select({ entity: s.entities, sourceNodeId: s.nodes.id }).from(s.entities)
    .leftJoin(s.nodes, and(eq(s.nodes.id, sql`coalesce(${s.entities.pendingSourceNodeId}, json_extract(${s.entities.refs}, '$[0].sourceNodeId'))`), eq(s.nodes.kind, 'image'), isNull(s.nodes.deletedAt)))
    .where(and(inArray(s.entities.id, ids), isNull(s.entities.deletedAt))).all() : []
  const byId = new Map(rows.map(row => [row.entity.id, row]))
  return sources.map(source => {
    const doc = structuredClone(source)
    if (!source.castIds) return doc
    doc.assets = source.castIds.flatMap(id => {
      const entry = byId.get(id)
      if (!entry) return []
      const row = entry.entity
      if (row.kind === 'style') return []
      return [{ id, rev: row.revision, kind: row.kind, name: row.name, description: row.description, imageNodeId: entry.sourceNodeId }]
    })
    doc.style = source.styleId ? byId.get(source.styleId)?.entity.description ?? null : null
    return doc
  })
}

export function readEntity(tx: SpaceTx, id: string): EntityView {
  const row = entityRow(tx, id, true)
  const scripts = currentScripts(tx).filter(script => script.doc && (script.doc.styleId === id || (script.doc.castIds ?? script.doc.assets.map(asset => asset.id)).includes(id)))
  return {
    id: row.id, kind: row.kind, name: row.name, description: row.description, refs: row.refs, revision: row.revision,
    createdAt: row.createdAt, updatedAt: row.updatedAt, ...(row.deletedAt !== null ? { deletedAt: row.deletedAt } : {}),
    members: tx.select({ assetId: s.entityAssets.assetId, role: s.entityAssets.role }).from(s.entityAssets).where(eq(s.entityAssets.entityId, id)).all(),
    usage: { scriptNodeIds: scripts.map(script => script.nodeId), shotCount: scripts.reduce((count, script) => count + script.doc!.shots.filter(shot => script.doc!.styleId === id || shotUsesEntity(shot, id)).length, 0) },
    ...(row.seriesEntityId && row.seriesRevision !== null ? { series: { seriesEntityId: row.seriesEntityId, revision: row.seriesRevision, latestRevision: row.seriesRevision, modifiedLocally: row.revision > (row.seriesBaseRevision ?? row.revision) } } : {}),
  }
}

export function entityIdsForAssets(tx: SpaceTx, assetIds: string[]): Map<string, string[]> {
  const result = new Map<string, string[]>()
  if (!assetIds.length) return result
  const rows = tx.select({ assetId: s.assets.id, entityId: s.entities.id }).from(s.entities)
    .innerJoin(s.assets, sql`exists (select 1 from ${s.entityAssets} where ${s.entityAssets.entityId} = ${s.entities.id} and ${s.entityAssets.assetId} = ${s.assets.id})
      or exists (select 1 from json_each(${s.entities.refs}) as ref join ${s.assetVersions} on ${s.assetVersions.id} = json_extract(ref.value, '$.assetVersionId') where ${s.assetVersions.assetId} = ${s.assets.id})`)
    .where(and(inArray(s.assets.id, assetIds), isNull(s.entities.deletedAt))).orderBy(sql`${s.entities}.rowid`).all()
  for (const row of rows) result.set(row.assetId, [...(result.get(row.assetId) ?? []), row.entityId])
  return result
}

// The library's setting filter matches the same assets as its setting chips: members and ref assets of a live setting.
export function entityAssetFilter(entityId: string) {
  return sql`exists (select 1 from entities e where e.id = ${entityId} and e.deleted_at is null and (
    exists (select 1 from entity_assets ea where ea.entity_id = e.id and ea.asset_id = assets.id)
    or exists (select 1 from json_each(e.refs) as ref join asset_versions av on av.id = json_extract(ref.value, '$.assetVersionId') where av.asset_id = assets.id)))`
}

export function assertEntityRevision(row: ReturnType<typeof entityRow>, expectedRevision: number) {
  if (row.revision !== expectedRevision) throw VisError.of('revision_conflict', 'entity.revision_conflict', { entityId: row.id, currentRevision: row.revision }, 'The setting changed; read it again and retry')
}

export function usableEntityImage(tx: SpaceTx, assetVersionId: string) {
  const row = tx.select({ assetId: s.assets.id, kind: s.assets.kind, archivedAt: s.assets.archivedAt, mime: s.assetVersions.mime }).from(s.assetVersions)
    .innerJoin(s.assets, eq(s.assets.id, s.assetVersions.assetId)).where(eq(s.assetVersions.id, assetVersionId)).get()
  return row?.kind === 'image' && row.mime.startsWith('image/') && row.archivedAt === null ? row : undefined
}

export function validateEntityMedia(tx: SpaceTx, refs: EntityRef[], members: EntityMember[]) {
  const ids = new Set(members.map(member => member.assetId))
  if (ids.size !== members.length) throw VisError.of('invalid_params', 'entity.duplicate_member', {}, 'A setting cannot contain a member more than once')
  for (const member of members) {
    const asset = tx.select().from(s.assets).where(eq(s.assets.id, member.assetId)).get()
    if (!asset || asset.archivedAt !== null || !isMediaKind(asset.kind)) throw VisError.of('invalid_params', 'entity.member_unavailable', { assetId: member.assetId }, 'A member is missing or archived')
    const expected = { image: 'image', video: 'video', voice: 'audio', other: asset.kind }[member.role]
    if (asset.kind !== expected) throw VisError.of('invalid_params', 'entity.member_kind', { assetId: member.assetId }, 'The member role does not match its media kind')
  }
  for (const ref of refs) {
    if (!usableEntityImage(tx, ref.assetVersionId)) throw VisError.of('invalid_params', 'entity.image_ref_required', {}, 'Setting references must be image versions of this project')
  }
}

export function writeEntity(tx: SpaceTx, input: EntityWrite, opts: {
  now: number; id?: string; createId?: string; initialRevision?: number; expectedRevision?: number; proposalId?: string; onEntitiesChanged?: EntitiesChanged | undefined
}): EntityView {
  const previous = opts.id ? entityRow(tx, opts.id) : undefined
  if (previous && opts.expectedRevision !== undefined) assertEntityRevision(previous, opts.expectedRevision)
  const duplicate = findEntityByName(tx, input.kind, input.name)
  if (duplicate && duplicate.id !== previous?.id) throw VisError.of('invalid_params', 'entity.name_taken', { entityId: duplicate.id, kind: input.kind, name: input.name.trim() }, 'A setting with this kind and name already exists')
  const refs = structuredClone(input.refs ?? previous?.refs ?? [])
  const pendingSourceNodeId = input.pendingSourceNodeId === undefined ? (input.refs !== undefined ? null : previous?.pendingSourceNodeId ?? null) : input.pendingSourceNodeId
  if (pendingSourceNodeId) {
    const node = tx.select().from(s.nodes).where(and(eq(s.nodes.id, pendingSourceNodeId), isNull(s.nodes.deletedAt))).get()
    if (node?.kind !== 'image') throw VisError.of('invalid_params', 'entity.image_node_required', {}, 'A pending reference must name a live image node')
  }
  const oldMembers = previous ? tx.select().from(s.entityAssets).where(eq(s.entityAssets.entityId, previous.id)).all() : []
  const members = structuredClone(input.members ?? oldMembers.map(({ assetId, role }) => ({ assetId, role })))
  validateEntityMedia(tx, refs, members)
  const id = previous?.id ?? opts.createId ?? `entity_${ulid(opts.now)}`
  const revision = previous ? previous.revision + 1 : opts.initialRevision ?? 1
  const values = { kind: input.kind, name: input.name.trim(), description: input.description ?? previous?.description ?? '', refs, pendingSourceNodeId, revision, updatedAt: opts.now }
  if (previous) tx.update(s.entities).set(values).where(eq(s.entities.id, id)).run()
  else tx.insert(s.entities).values({ ...values, id, createdAt: opts.now }).run()
  tx.delete(s.entityAssets).where(eq(s.entityAssets.entityId, id)).run()
  for (const member of members) tx.insert(s.entityAssets).values({ entityId: id, ...member,
    addedByProposalId: oldMembers.find(old => old.assetId === member.assetId)?.addedByProposalId ?? (oldMembers.some(old => old.assetId === member.assetId) ? null : opts.proposalId ?? null),
  }).run()
  appendEvent(tx, { type: previous ? 'entity.updated' : 'entity.created', entityType: 'entity', entityId: id, payload: { entityId: id, revision } }, opts.now)
  opts.onEntitiesChanged?.(tx, [id])
  return readEntity(tx, id)
}

export function adoptPendingEntityImage(tx: SpaceTx, nodeId: string, assetVersionId: string, now: number, onEntitiesChanged: EntitiesChanged) {
  const rows = tx.select().from(s.entities).where(and(eq(s.entities.pendingSourceNodeId, nodeId), isNull(s.entities.deletedAt))).all()
  if (!rows.length) return
  // Delivery must land even when older members or references have since been archived.
  if (!usableEntityImage(tx, assetVersionId)) {
    console.warn('[settings] Pending image adoption skipped: image version is missing, archived or unusable', { nodeId, assetVersionId })
    return
  }
  for (const row of rows) {
    const revision = row.revision + 1
    tx.update(s.entities).set({ refs: [{ assetVersionId, sourceNodeId: nodeId }, ...row.refs.slice(1)], pendingSourceNodeId: null, revision, updatedAt: now }).where(eq(s.entities.id, row.id)).run()
    appendEvent(tx, { type: 'entity.updated', entityType: 'entity', entityId: row.id, payload: { entityId: row.id, revision } }, now)
    onEntitiesChanged(tx, [row.id])
  }
}

export function deleteEntity(tx: SpaceTx, id: string, expectedRevision: number, now: number, onEntitiesChanged?: EntitiesChanged) {
  const row = entityRow(tx, id)
  assertEntityRevision(row, expectedRevision)
  tx.update(s.entities).set({ deletedAt: now, updatedAt: now, revision: row.revision + 1 }).where(eq(s.entities.id, id)).run()
  tx.delete(s.entityAssets).where(eq(s.entityAssets.entityId, id)).run()
  appendEvent(tx, { type: 'entity.deleted', entityType: 'entity', entityId: id, payload: { entityId: id, revision: row.revision + 1 } }, now)
  onEntitiesChanged?.(tx, [id])
  return { entityId: id, revision: row.revision + 1 }
}

export function createEntityService(deps: { db: SpaceDb; now?: () => number; onEntitiesChanged?: EntitiesChanged; latestSeriesRevisions?: () => ReadonlyMap<string, number> }) {
  const { db, onEntitiesChanged } = deps
  const now = deps.now ?? Date.now
  const decorate = (view: EntityView, latest = deps.latestSeriesRevisions?.()) => {
    if (view.series) view.series.latestRevision = latest?.get(view.series.seriesEntityId) ?? view.series.revision
    return view
  }
  const proposals = createProposalMethods({ db, now, ...(onEntitiesChanged ? { onEntitiesChanged } : {}) })
  return {
    list(params: import('@vis/protocol').MethodParams<'entity.list'>) {
      const latest = deps.latestSeriesRevisions?.()
      return db.transaction(tx => ({ items: tx.select().from(s.entities).where(and(params.kind ? eq(s.entities.kind, params.kind) : undefined, params.includeDeleted ? undefined : isNull(s.entities.deletedAt)))
        .orderBy(s.entities.createdAt, s.entities.id).all().filter(row => !params.query || `${row.name}\n${row.description}`.toLowerCase().includes(params.query.toLowerCase())).map(row => decorate(readEntity(tx, row.id), latest)) }))
    },
    get({ entityId }: import('@vis/protocol').MethodParams<'entity.get'>) { return decorate(db.transaction(tx => readEntity(tx, entityId))) },
    create(params: import('@vis/protocol').MethodParams<'entity.create'>) {
      const p = entity.create.params.parse(params)
      return decorate(runIdempotent(db, { requestId: p.requestId, method: 'entity.create', params: p }, tx => writeEntity(tx, p, { now: now(), onEntitiesChanged }), now))
    },
    update(params: import('@vis/protocol').MethodParams<'entity.update'>) {
      const p = entity.update.params.parse(params)
      return decorate(db.transaction(tx => {
        const row = entityRow(tx, p.entityId)
        return writeEntity(tx, { ...row, ...p, name: p.name ?? row.name, description: p.description ?? row.description,
          ...(p.refs !== undefined ? { pendingSourceNodeId: null } : {}) }, { id: p.entityId, expectedRevision: p.expectedRevision, now: now(), onEntitiesChanged })
      }, { behavior: 'immediate' }))
    },
    delete(params: import('@vis/protocol').MethodParams<'entity.delete'>) {
      return db.transaction(tx => deleteEntity(tx, params.entityId, params.expectedRevision, now(), onEntitiesChanged), { behavior: 'immediate' })
    },
    ...proposals,
    proposalResolve(params: Parameters<typeof proposals.proposalResolve>[0]) {
      const result = proposals.proposalResolve(params)
      if (result.entity) decorate(result.entity)
      return result
    },
    unmerge(params: Parameters<typeof proposals.unmerge>[0]) { return decorate(proposals.unmerge(params)) },
  }
}
export type EntityService = ReturnType<typeof createEntityService>
