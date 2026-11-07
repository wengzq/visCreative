import { VisError } from '@vis/domain'
import { projectScriptsEntities } from '@vis/library-core'
import type { MethodParams, MethodResult, NodeView, SlotContent, SlotView } from '@vis/protocol'
import { and, desc, eq, inArray, isNull, lt, ne, spaceSchema as s, type SpaceTx } from '@vis/storage'

/** Read current content of undeleted nodes and their slots */
export function readNodes(tx: SpaceTx, nodeIds?: string[]): NodeView[] {
  const nodeRows = tx
    .select()
    .from(s.nodes)
    .where(and(isNull(s.nodes.deletedAt), nodeIds ? inArray(s.nodes.id, nodeIds) : undefined))
    .orderBy(s.nodes.z)
    .all()
  if (nodeRows.length === 0) return []
  const inputsByNode = readNodeInputs(tx, nodeRows.map(n => n.id))

  const slotRows = tx
    .select({
      slot: s.slots,
      jobId: s.deliveryBindings.jobId,
      textBody: s.slotRevisions.textBody,
      scriptDoc: s.slotRevisions.scriptDoc,
      timelineDoc: s.slotRevisions.timelineDoc,
      previzDoc: s.slotRevisions.previzDoc,
      sceneDoc: s.slotRevisions.sceneDoc,
      assetVersionId: s.slotRevisions.assetVersionId,
      mime: s.assetVersions.mime,
      hasAlpha: s.assetVersions.hasAlpha,
      actor: s.operations.actorKind,
      sessionId: s.operations.actorSessionId,
    })
    .from(s.slots)
    .leftJoin(s.slotRevisions, and(eq(s.slotRevisions.slotId, s.slots.id), eq(s.slotRevisions.revision, s.slots.currentRevision)))
    .leftJoin(s.deliveryBindings, eq(s.deliveryBindings.deliveredOperationId, s.slotRevisions.operationId))
    .leftJoin(s.assetVersions, eq(s.assetVersions.id, s.slotRevisions.assetVersionId))
    .leftJoin(s.operations, eq(s.operations.id, s.slotRevisions.operationId))
    .where(and(isNull(s.slots.deletedAt), inArray(s.slots.nodeId, nodeRows.map(n => n.id))))
    .all()

  const inputsByJob = readJobInputNodes(tx, [...new Set(slotRows.flatMap(r => r.jobId ? [r.jobId] : []))])
  const scripts = slotRows.flatMap(row => row.scriptDoc ? [row.scriptDoc] : [])
  const projections = new Map(scripts.map((doc, index) => [doc, index]))
  const projected = projectScriptsEntities(tx, scripts)

  const slotsByNode = new Map<string, SlotView[]>()
  for (const r of slotRows) {
    const list = slotsByNode.get(r.slot.nodeId) ?? []
    list.push({ slotId: r.slot.id, slotKey: r.slot.slotKey, contentType: r.slot.contentType, revision: r.slot.currentRevision, content: contentOf(r.scriptDoc ? { ...r, scriptDoc: projected[projections.get(r.scriptDoc)!]! } : r),
      ...(r.actor ? { writer: { actor: r.actor, ...(r.sessionId ? { sessionId: r.sessionId } : {}) } } : {}),
      ...(r.jobId ? { source: { jobId: r.jobId, inputNodeIds: [...(inputsByJob.get(r.jobId) ?? [])].filter(id => id !== r.slot.nodeId) } } : {}),
    })
    slotsByNode.set(r.slot.nodeId, list)
  }

  return nodeRows.map(n => ({ ...nodeView(n, inputsByNode.get(n.id)), slots: (slotsByNode.get(n.id) ?? []).sort((a, b) => Number(b.slotKey === 'main') - Number(a.slotKey === 'main')) }))
}

export function readSlotHistory(tx: SpaceTx, params: MethodParams<'slot.history'>): MethodResult<'slot.history'> {
  const slot = tx.select({ nodeId: s.slots.nodeId, currentRevision: s.slots.currentRevision }).from(s.slots)
    .innerJoin(s.nodes, eq(s.nodes.id, s.slots.nodeId))
    .where(and(eq(s.slots.id, params.slotId), params.includeDeleted ? undefined : isNull(s.slots.deletedAt), params.includeDeleted ? undefined : isNull(s.nodes.deletedAt))).get()
  if (!slot) throw VisError.of('not_found', 'canvas.slot_not_found', { slotId: params.slotId }, `Slot ${params.slotId} does not exist or has been deleted`)
  const rows = tx.select({
    revision: s.slotRevisions.revision,
    textBody: s.slotRevisions.textBody,
    scriptDoc: s.slotRevisions.scriptDoc,
    timelineDoc: s.slotRevisions.timelineDoc,
      previzDoc: s.slotRevisions.previzDoc,
      sceneDoc: s.slotRevisions.sceneDoc,
    assetVersionId: s.slotRevisions.assetVersionId,
    mime: s.assetVersions.mime,
      hasAlpha: s.assetVersions.hasAlpha,
    createdAt: s.slotRevisions.createdAt,
    actor: s.operations.actorKind,
    job: s.generationJobs,
  }).from(s.slotRevisions)
    .innerJoin(s.operations, eq(s.operations.id, s.slotRevisions.operationId))
    .leftJoin(s.assetVersions, eq(s.assetVersions.id, s.slotRevisions.assetVersionId))
    .leftJoin(s.deliveryBindings, eq(s.deliveryBindings.deliveredOperationId, s.slotRevisions.operationId))
    .leftJoin(s.generationJobs, eq(s.generationJobs.id, s.deliveryBindings.jobId))
    .where(and(eq(s.slotRevisions.slotId, params.slotId), params.beforeRevision !== undefined ? lt(s.slotRevisions.revision, params.beforeRevision) : undefined))
    .orderBy(desc(s.slotRevisions.revision)).limit(params.limit + 1).all()
  const page = rows.slice(0, params.limit)
  const inputsByJob = readJobInputNodes(tx, [...new Set(page.flatMap(r => r.job ? [r.job.id] : []))])
  return {
    versions: page.map(r => {
      const { resolvedPrompt: _resolvedPrompt, ...visibleParams } = (r.job?.params ?? {}) as Record<string, unknown>
      const jobParams = r.job ? visibleParams : undefined
      return {
        revision: r.revision, content: contentOf(r), createdAt: r.createdAt, actor: r.actor, isCurrent: r.revision === slot.currentRevision,
        ...(r.job ? { source: {
          jobId: r.job.id, provider: r.job.provider, model: r.job.model, params: jobParams!,
          ...(typeof jobParams?.prompt === 'string' ? { prompt: jobParams.prompt } : {}),
          inputNodeIds: [...(inputsByJob.get(r.job.id) ?? [])].filter(id => id !== slot.nodeId),
        } } : {}),
      }
    }),
    hasMore: rows.length > params.limit,
  }
}

/**
 * Read the turn input snapshot (0003 canvas.get snapshot: 'turn'): include only snapshotted slots, using snapshot revisions for content;
 * after the snapshot is fixed, return nodes even if deleted, using current layout values.
 */
export function readSnapshotNodes(tx: SpaceTx, snapshotId: string, nodeIds?: string[]): NodeView[] {
  const items = tx
    .select({
      nodeId: s.snapshotItems.nodeId,
      slot: s.slots,
      revision: s.snapshotItems.slotRevision,
      textBody: s.slotRevisions.textBody,
      scriptDoc: s.slotRevisions.scriptDoc,
      timelineDoc: s.slotRevisions.timelineDoc,
      previzDoc: s.slotRevisions.previzDoc,
      sceneDoc: s.slotRevisions.sceneDoc,
      assetVersionId: s.slotRevisions.assetVersionId,
      mime: s.assetVersions.mime,
      hasAlpha: s.assetVersions.hasAlpha,
      actor: s.operations.actorKind,
      sessionId: s.operations.actorSessionId,
    })
    .from(s.snapshotItems)
    .innerJoin(s.slots, eq(s.slots.id, s.snapshotItems.slotId))
    .innerJoin(s.slotRevisions, and(eq(s.slotRevisions.slotId, s.snapshotItems.slotId), eq(s.slotRevisions.revision, s.snapshotItems.slotRevision)))
    .leftJoin(s.operations, eq(s.operations.id, s.slotRevisions.operationId))
    .leftJoin(s.assetVersions, eq(s.assetVersions.id, s.slotRevisions.assetVersionId))
    .where(and(eq(s.snapshotItems.snapshotId, snapshotId), nodeIds ? inArray(s.snapshotItems.nodeId, nodeIds) : undefined))
    .orderBy(s.snapshotItems.ordinal)
    .all()
  if (items.length === 0) return []

  const nodeRows = tx.select().from(s.nodes).where(inArray(s.nodes.id, [...new Set(items.map(i => i.nodeId))])).orderBy(s.nodes.z).all()
  const inputsByNode = readNodeInputs(tx, nodeRows.map(n => n.id))
  const slotsByNode = new Map<string, SlotView[]>()
  for (const r of items) {
    const list = slotsByNode.get(r.nodeId) ?? []
    list.push({ slotId: r.slot.id, slotKey: r.slot.slotKey, contentType: r.slot.contentType, revision: r.revision, content: contentOf(r),
      ...(r.actor ? { writer: { actor: r.actor, ...(r.sessionId ? { sessionId: r.sessionId } : {}) } } : {}),
    })
    slotsByNode.set(r.nodeId, list)
  }
  return nodeRows.map(n => ({ ...nodeView(n, inputsByNode.get(n.id)), slots: (slotsByNode.get(n.id) ?? []).sort((a, b) => Number(b.slotKey === 'main') - Number(a.slotKey === 'main')) }))
}

function readNodeInputs(tx: SpaceTx, nodeIds: string[]): Map<string, string[]> {
  const rows = tx.select({ nodeId: s.nodeInputs.nodeId, inputNodeId: s.nodeInputs.inputNodeId }).from(s.nodeInputs)
    .innerJoin(s.nodes, eq(s.nodes.id, s.nodeInputs.inputNodeId))
    .where(and(inArray(s.nodeInputs.nodeId, nodeIds), isNull(s.nodes.deletedAt)))
    .orderBy(s.nodeInputs.ordinal).all()
  const inputs = new Map<string, string[]>()
  for (const row of rows) {
    const ids = inputs.get(row.nodeId) ?? []
    ids.push(row.inputNodeId)
    inputs.set(row.nodeId, ids)
  }
  return inputs
}

function readJobInputNodes(tx: SpaceTx, jobIds: string[]): Map<string, Set<string>> {
  // Include slots of deleted nodes; deduplicate by ordinal to preserve provenance order.
  const inputs = jobIds.length ? tx.select({ jobId: s.jobInputs.jobId, nodeId: s.slots.nodeId })
    .from(s.jobInputs)
    .innerJoin(s.slots, eq(s.slots.id, s.jobInputs.slotId))
    .where(inArray(s.jobInputs.jobId, jobIds))
    .orderBy(s.jobInputs.ordinal)
    .all() : []
  const inputsByJob = new Map<string, Set<string>>()
  for (const input of inputs) {
    const ids = inputsByJob.get(input.jobId) ?? new Set<string>()
    ids.add(input.nodeId)
    inputsByJob.set(input.jobId, ids)
  }
  return inputsByJob
}

function contentOf(r: { previzDoc: import('@vis/protocol').PrevizDoc | null; sceneDoc: import('@vis/protocol').SceneDoc | null; scriptDoc: import('@vis/protocol').ScriptDoc | null; timelineDoc: import('@vis/protocol').TimelineDoc | null; textBody: string | null; assetVersionId: string | null; mime: string | null; hasAlpha?: boolean | null }): SlotContent {
  if (r.previzDoc !== null) return { type: 'previz', doc: r.previzDoc }
  if (r.sceneDoc !== null) return { type: 'scene', doc: r.sceneDoc }
  if (r.scriptDoc !== null) return { type: 'script', doc: r.scriptDoc }
  if (r.timelineDoc !== null) return { type: 'timeline', doc: r.timelineDoc }
  return r.assetVersionId && r.mime
    ? { type: 'asset', assetVersionId: r.assetVersionId, mime: r.mime, ...(r.hasAlpha != null ? { hasAlpha: r.hasAlpha } : {}) }
    : r.textBody !== null
      ? { type: 'text', body: r.textBody }
      : { type: 'empty' }
}

function nodeView(n: typeof s.nodes.$inferSelect, inputs?: string[]): Omit<NodeView, 'slots'> {
  return { nodeId: n.id, kind: n.kind, x: n.x, y: n.y, w: n.w, h: n.h, z: n.z, layoutRevision: n.layoutRevision,
    title: n.title, category: n.category, purpose: n.purpose, format: n.format, shot: n.shot, exportOf: n.exportOf, frameId: n.frameId, ...(n.kind === 'frame' && n.frame ? { frame: n.frame } : {}),
    ...(inputs?.length ? { inputs } : {}), ...(n.generation !== null ? { generation: n.generation } : {}),
  }
}

export function liveNodeRects(tx: SpaceTx) {
  return tx.select({ id: s.nodes.id, x: s.nodes.x, y: s.nodes.y, w: s.nodes.w, h: s.nodes.h }).from(s.nodes)
    .where(and(isNull(s.nodes.deletedAt), ne(s.nodes.kind, 'frame'), ne(s.nodes.purpose, 'working'))).all()
}
