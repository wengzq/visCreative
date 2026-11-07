import { assetVersionView } from '@vis/assets'
import { VisError } from '@vis/domain'
import { assetLibrary, isMediaKind, LIBRARY_LIMITS, type Caller, type LibraryAsset, type MethodParams, type MethodResult } from '@vis/protocol'
import { and, appendEvent, desc, eq, inArray, isNull, spaceSchema as s, sql, type SpaceTx } from '@vis/storage'
import { entityAssetFilter, entityIdsForAssets } from './entities'
import { libraryFacts, libraryVisibility, searchLibraryAssets } from './queries'

export type LibraryReadContext = { caller: Caller; blobPath: (hash: string) => string }
export const LABEL_FIELDS = ['displayName', 'category', 'tags'] as const

export function readAsset(tx: SpaceTx, assetId: string) {
  const asset = tx.select().from(s.assets).where(eq(s.assets.id, assetId)).get()
  if (!asset || !isMediaKind(asset.kind)) throw VisError.of('not_found', 'asset.not_found', { assetId }, `Asset ${assetId} does not exist`)
  return asset
}

export function listAssetVersions(tx: SpaceTx, assetId: string, ctx: LibraryReadContext): MethodResult<'asset.versions'> {
  const asset = readAsset(tx, assetId)
  const versions = tx.select().from(s.assetVersions).where(eq(s.assetVersions.assetId, assetId)).orderBy(desc(s.assetVersions.version)).all()
  return { versions: versions.map(version => assetVersionView({ ...version, kind: asset.kind }, asset, ctx.blobPath)) }
}

export function readLabelSnapshot(tx: SpaceTx, assetId: string, asset = readAsset(tx, assetId)): s.LibraryLabelSnapshot {
  return {
    displayName: asset.displayName, category: asset.category, labeledBy: asset.labeledBy, userFields: asset.userFields,
    tags: tx.select().from(s.assetTags).where(eq(s.assetTags.assetId, assetId)).all().map(row => row.tag),
  }
}

export function writeTags(tx: SpaceTx, assetId: string, tags: string[]) {
  tx.delete(s.assetTags).where(eq(s.assetTags.assetId, assetId)).run()
  const seen = new Set<string>()
  for (const value of tags) {
    const tag = value.trim()
    const normalized = tag.toLowerCase()
    if (seen.has(normalized)) continue
    seen.add(normalized)
    tx.insert(s.assetTags).values({ assetId, tag, normalized }).run()
  }
}

export function emitAssetUpdated(tx: SpaceTx, assetId: string, revision: number, now: number) {
  appendEvent(tx, { type: 'asset.updated', entityType: 'asset', entityId: assetId, payload: { assetId, revision } }, now)
}

// Read only current revisions: historical slot contents and deleted slots must never keep an asset "used".
export function readLibraryAssets(tx: SpaceTx, ctx: LibraryReadContext, assetIds: string[]): LibraryAsset[] {
  if (!assetIds.length) return []
  const rows = tx.select({
    asset: s.assets, version: s.assetVersions,
    versionCount: sql<number>`(select count(*) from asset_versions av where av.asset_id = ${s.assets.id})`,
    prompt: sql<unknown>`json_extract(${s.generationJobs.params}, '$.prompt')`,
  }).from(s.assets)
    .innerJoin(s.assetVersions, and(eq(s.assetVersions.assetId, s.assets.id),
      eq(s.assetVersions.version, sql`(select max(av.version) from asset_versions av where av.asset_id = ${s.assets.id})`)))
    .leftJoin(s.generationJobs, eq(s.generationJobs.id, s.assetVersions.sourceJobId))
    .where(inArray(s.assets.id, assetIds))
    .orderBy(desc(s.assets.createdAt), desc(s.assets.id)).all()
  const usages = tx.select({ assetId: s.assetVersions.assetId, node: s.nodes }).from(s.slots)
    .innerJoin(s.nodes, eq(s.nodes.id, s.slots.nodeId))
    .innerJoin(s.slotRevisions, and(eq(s.slotRevisions.slotId, s.slots.id), eq(s.slotRevisions.revision, s.slots.currentRevision)))
    .innerJoin(s.assetVersions, eq(s.assetVersions.id, s.slotRevisions.assetVersionId))
    .where(and(inArray(s.assetVersions.assetId, assetIds), isNull(s.nodes.deletedAt), isNull(s.slots.deletedAt)))
    .orderBy(desc(s.nodes.createdAt), desc(s.nodes.id)).all()
  const using = new Map<string, Map<string, typeof s.nodes.$inferSelect>>()
  for (const { assetId, node } of usages) {
    if (!using.has(assetId)) using.set(assetId, new Map())
    using.get(assetId)!.set(node.id, node)
  }
  // Provenance survives deleting or replacing the export's canvas node.
  const exported = new Set(tx.select({ assetId: s.assetVersions.assetId }).from(s.nodes)
    .innerJoin(s.slots, eq(s.slots.nodeId, s.nodes.id))
    .innerJoin(s.slotRevisions, and(eq(s.slotRevisions.slotId, s.slots.id), eq(s.slotRevisions.revision, 1)))
    .innerJoin(s.assetVersions, eq(s.assetVersions.id, s.slotRevisions.assetVersionId))
    .where(and(inArray(s.assetVersions.assetId, assetIds), sql`${s.nodes.exportOf} is not null`)).all().map(row => row.assetId))
  const tags = new Map<string, string[]>()
  for (const row of tx.select().from(s.assetTags).where(inArray(s.assetTags.assetId, assetIds)).all()) {
    if (!tags.has(row.assetId)) tags.set(row.assetId, [])
    tags.get(row.assetId)!.push(row.tag)
  }
  const entities = entityIdsForAssets(tx, assetIds)
  return rows.flatMap(({ asset, version, versionCount, prompt }) => {
    const kind = asset.kind
    if (!isMediaKind(kind)) return []
    const nodes = [...(using.get(asset.id)?.values() ?? [])]
    return [{
      assetId: asset.id, kind, origin: asset.origin,
      ...(asset.displayName !== null ? { displayName: asset.displayName } : {}),
      category: asset.category,
      effectiveCategory: asset.category ?? nodes.find(node => node.category !== null)?.category ?? (asset.kind === 'video' && exported.has(asset.id) ? '成片' : null),
      tags: tags.get(asset.id) ?? [], archived: asset.archivedAt !== null, revision: asset.revision,
      createdAt: asset.createdAt, labeledBy: asset.labeledBy, userFields: asset.userFields,
      latest: assetVersionView({ ...version, kind: asset.kind }, asset, ctx.blobPath),
      versionCount, usage: { count: nodes.length, nodeIds: nodes.slice(0, LIBRARY_LIMITS.usageNodeIds).map(node => node.id) },
      entityIds: entities.get(asset.id) ?? [],
      ...(ctx.caller === 'agent' ? { context: { nodeTitles: [...new Set(nodes.flatMap(node => node.title ? [node.title] : []))],
        ...(typeof prompt === 'string' && prompt.trim() ? { prompt } : {}) } } : {}),
    }]
  })
}

function cursorPosition(cursor: string): [number, string] {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (Array.isArray(value) && value.length === 2 && Number.isSafeInteger(value[0]) && typeof value[1] === 'string' && value[1]) return value as [number, string]
  } catch { /* Invalid cursors use the same application error as other invalid parameters. */ }
  throw VisError.of('invalid_params', 'library.invalid_cursor', {}, 'Library cursor is invalid')
}

export function listLibraryAssets(tx: SpaceTx, params: MethodParams<'asset.list'>, ctx: LibraryReadContext): MethodResult<'asset.list'> {
  const p = assetLibrary.list.params.parse(params)
  const query = p.query?.trim().toLowerCase() || undefined
  const cursor = p.cursor === undefined ? undefined : cursorPosition(p.cursor)
  const cheap = sql.join([
    p.archived ? sql`archived_at is not null` : sql`archived_at is null`,
    p.kind === undefined ? sql`1` : sql`kind = ${p.kind}`,
    p.labeled === undefined ? sql`1` : p.labeled ? sql`labeled_by is not null` : sql`labeled_by is null`,
    p.entityId === undefined ? sql`1` : entityAssetFilter(p.entityId),
  ], sql` and `)
  const candidateFilters = sql`${cheap}
    ${p.category === undefined ? sql`` : p.category === null ? sql`and category is null` : sql`and (category is null or category = ${p.category})`}
    ${p.tag === undefined ? sql`` : sql`and exists (select 1 from asset_tags t where t.asset_id = assets.id and t.normalized = ${p.tag.trim().toLowerCase()})`}
    ${cursor ? sql`and (created_at < ${cursor[0]} or (created_at = ${cursor[0]} and id < ${cursor[1]}))` : sql``}`
  const candidates = query ? searchLibraryAssets(tx, candidateFilters, query) : candidateFilters
  const selected = tx.select({ id: sql<string>`id` }).from(sql`(${libraryFacts(candidates)}
    select id from facts where ${libraryVisibility(p.usage, query)}
    ${p.category === undefined ? sql`` : p.category === null ? sql`and effective_category is null` : sql`and effective_category = ${p.category}`}
    order by created_at desc, id desc limit ${p.limit + 1})`).all()
  const items = readLibraryAssets(tx, ctx, selected.slice(0, p.limit).map(row => row.id))
  const base = p.cursor === undefined && query
    ? p.category === undefined && p.tag === undefined ? candidates : searchLibraryAssets(tx, cheap, query)
    : cheap
  const facets = p.cursor === undefined ? {
    categories: tx.select({ name: sql<string | null>`name`, count: sql<number>`count` }).from(sql`(${libraryFacts(base)}
      select effective_category as name, count(*) as count from facts where ${libraryVisibility(p.usage, query)}
      group by effective_category)`).all(),
    tags: tx.select({ name: sql<string>`name`, count: sql<number>`count` }).from(sql`(${libraryFacts(base)}
      select t.tag as name, count(*) as count from facts
      join asset_tags t on t.asset_id = facts.id where ${libraryVisibility(p.usage, query)}
      group by t.normalized)`).all(),
  } : undefined
  const last = items.at(-1)
  return {
    items,
    ...(last && selected.length > p.limit ? { nextCursor: Buffer.from(JSON.stringify([last.createdAt, last.assetId])).toString('base64url') } : {}),
    ...(facets ? { facets } : {}),
  }
}

export function updateLibraryAsset(tx: SpaceTx, params: MethodParams<'asset.update'>, ctx: LibraryReadContext, now: number): LibraryAsset {
  const p = assetLibrary.update.params.parse(params)
  const asset = readAsset(tx, p.assetId)
  if (asset.revision !== p.expectedRevision) throw VisError.of('revision_conflict', 'asset.revision_conflict',
    { assetId: asset.id, expectedRevision: p.expectedRevision, actualRevision: asset.revision }, 'Asset revision has changed; reread before editing')
  const userFields = [...new Set([...asset.userFields, ...LABEL_FIELDS.filter(field => p.confirm || p[field] !== undefined)])]
  tx.update(s.assets).set({
    ...(p.displayName !== undefined ? { displayName: p.displayName } : {}),
    ...(p.category !== undefined ? { category: p.category } : {}),
    ...(p.archived !== undefined ? { archivedAt: p.archived ? asset.archivedAt ?? now : null } : {}),
    userFields, labeledBy: userFields.length ? 'user' : asset.labeledBy, revision: asset.revision + 1,
  }).where(eq(s.assets.id, p.assetId)).run()
  if (p.tags !== undefined) writeTags(tx, asset.id, p.tags)
  emitAssetUpdated(tx, asset.id, asset.revision + 1, now)
  return readLibraryAssets(tx, ctx, [asset.id])[0]!
}
