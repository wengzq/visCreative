import { checkSlotDelivery, type DeliveryOutcome, newId, VisError } from '@vis/domain'
import type { MediaKind, NodeGeneration } from '@vis/protocol'
import { and, appendEvent, eq, isNull, spaceSchema as s, type SpaceTx } from '@vis/storage'
import { fitNodeToAsset } from './fit'
import { defaultNodeSize, placeNewNode } from './placement'
import { liveNodeRects, readJobInputNodes, readNodes } from './views'
import { createNodeWithSlot, mediaVersionKind, insertOperation, writeSlotRevision } from './write'

/**
 * Deliver a registered output using its persisted binding (implements CanvasDeliveryPort). Must run inside a write transaction:
 * writing media assets adjusts node height to the asset ratio without adding user undo entries.
 * Checks and writes share a transaction; repeated calls are idempotent. If conditions fail, retain the output as an asset and only update binding status.
 */
export function deliverOutput(tx: SpaceTx, input: { bindingId: string; assetVersionId: string }, now: number): DeliveryOutcome {
  const binding = tx.select().from(s.deliveryBindings).where(eq(s.deliveryBindings.id, input.bindingId)).get()
  if (!binding) throw VisError.of('not_found', 'canvas.binding_not_found', { bindingId: input.bindingId }, `Binding ${input.bindingId} does not exist`)
  if (binding.status !== 'pending') return { status: 'already_settled' }

  const media = mediaVersionKind(tx, input.assetVersionId)

  const settle = (status: 'delivered' | 'conflict' | 'target_missing', extra: { operationId?: string; createdNodeId?: string } = {}) => {
    tx.update(s.deliveryBindings)
      .set({ status, deliveredOperationId: extra.operationId ?? null, createdNodeId: extra.createdNodeId ?? binding.createdNodeId })
      .where(eq(s.deliveryBindings.id, binding.id))
      .run()
    // Target node (the new node when creating one), used by the UI for highlighting
    const nodeId = extra.createdNodeId ?? binding.nodeId
    appendEvent(
      tx,
      { type: 'binding.stateChanged', entityType: 'binding', entityId: binding.id, payload: { bindingId: binding.id, jobId: binding.jobId, status, ...(nodeId ? { nodeId } : {}) }, ...(extra.operationId ? { operationId: extra.operationId } : {}) },
      now,
    )
  }

  // A new_node binding created before RFC 0047 has no placeholder slot: create its node now. Placeholders deliver like slot targets.
  if (binding.targetKind === 'new_node' && !binding.slotId) {
    const operationId = newId('operation')
    insertOperation(tx, { id: operationId, actor: { kind: 'system' }, description: `生成结果交付（${binding.jobId}）` }, now)
    // Register provenance before reading event views; commit or roll back with content delivery in the same transaction.
    tx.update(s.deliveryBindings).set({ deliveredOperationId: operationId }).where(eq(s.deliveryBindings.id, binding.id)).run()
    const existing = liveNodeRects(tx)
    const placement = binding.placement as { nearNodeId?: string; nodeId?: string } | null
    const nearNodeId = placement?.nearNodeId
    const near = nearNodeId ? readNodes(tx, [nearNodeId])[0] : undefined
    const size = defaultNodeSize(media.kind, media)
    const pos = placeNewNode(size, existing, near)
    const created = createNodeWithSlot(tx, { ...(placement?.nodeId ? { nodeId: placement.nodeId } : {}), kind: media.kind, ...pos, ...size,
      ...draftFields(tx, binding.jobId), content: { assetVersionId: input.assetVersionId } }, operationId, now)
    settle('delivered', { operationId, createdNodeId: created.nodeId })
    return { status: 'delivered', nodeId: created.nodeId, slotId: created.slotId, slotRevision: created.revision }
  }

  // A slot target or a placeholder: submit filled nodeId, slotId and expectedContentRevision
  const node = tx.select({ deletedAt: s.nodes.deletedAt }).from(s.nodes).where(eq(s.nodes.id, binding.nodeId!)).get()
  const slot = tx
    .select()
    .from(s.slots)
    .where(and(eq(s.slots.id, binding.slotId!), eq(s.slots.nodeId, binding.nodeId!)))
    .get()
  const verdict = checkSlotDelivery(
    { bindingId: binding.id, status: binding.status, expectedContentRevision: binding.expectedContentRevision! },
    { node: node ?? null, slot: slot ?? null },
    media.kind,
  )
  if (!verdict.ok) {
    if (verdict.nextBindingStatus) settle(verdict.nextBindingStatus)
    return verdict.nextBindingStatus ? { status: verdict.nextBindingStatus } : { status: 'already_settled' }
  }

  const operationId = newId('operation')
  insertOperation(tx, { id: operationId, actor: { kind: 'system' }, description: `生成结果回填（${binding.jobId}）` }, now)
  // The slot.revised view also needs to read provenance at write time.
  tx.update(s.deliveryBindings).set({ deliveredOperationId: operationId }).where(eq(s.deliveryBindings.id, binding.id)).run()
  const revision = writeSlotRevision(tx, slot!.id, slot!.currentRevision, { assetVersionId: input.assetVersionId }, operationId, now)
  if (slot!.slotKey === 'main') fitNodeToAsset(tx, binding.nodeId!, input.assetVersionId, operationId, now)
  settle('delivered', { operationId })
  return { status: 'delivered', nodeId: binding.nodeId!, slotId: slot!.id, slotRevision: revision }
}


/** Settings a result node carries over from its job */
function draftFields(tx: SpaceTx, jobId: string): { prompt?: string; inputNodeIds: string[]; generation?: NodeGeneration } {
  const job = tx.select().from(s.generationJobs).where(eq(s.generationJobs.id, jobId)).get()!
  const { prompt, resolvedPrompt: _resolvedPrompt, actualPrompt: _actualPrompt, revisedPrompt: _revisedPrompt, frameRefs: _frameRefs, providerConfiguration: _configuration, ...params } = job.params as Record<string, unknown>
  const inputIds = [...(readJobInputNodes(tx, [job.id]).get(job.id) ?? [])]
  const liveIds = new Set(readNodes(tx, inputIds).map(node => node.nodeId))
  // Only plain generation is a reusable draft (RFC 0039 §1). An operation result keeps just its subject link:
  // seeding the operation's model and params would make the node's Generate send them to plain generate.
  const generate = job.operation === 'generate'
  return {
    ...(generate && typeof prompt === 'string' && prompt.length ? { prompt } : {}),
    inputNodeIds: (generate ? inputIds : inputIds.slice(0, 1)).filter(id => liveIds.has(id)),
    ...(generate ? { generation: { provider: job.provider, model: job.model, params } } : {}),
  }
}

/** Width:height from the job's own aspect parameter, if it names one; parameter names differ by service */
function aspectOf(params: Record<string, unknown>): { width: number; height: number } | undefined {
  for (const key of ['ratio', 'aspectRatio', 'aspect_ratio', 'size']) {
    const match = typeof params[key] === 'string' ? /^\s*(\d+(?:\.\d+)?)\s*[:x*×]\s*(\d+(?:\.\d+)?)\s*$/i.exec(params[key] as string) : null
    if (match && Number(match[1]) > 0 && Number(match[2]) > 0) return { width: Number(match[1]), height: Number(match[2]) }
  }
  const { width, height } = params
  return typeof width === 'number' && typeof height === 'number' && width > 0 && height > 0 ? { width, height } : undefined
}

/**
 * Create the empty result node of a pending new_node binding at submit (RFC 0047). Runs in the submit transaction: the node
 * takes its place now, delivery later fills its main slot through the slot checks, and neither step adds a user undo entry.
 */
export function reservePlaceholder(tx: SpaceTx, input: { bindingId: string }, now: number): void {
  const binding = tx.select().from(s.deliveryBindings).where(eq(s.deliveryBindings.id, input.bindingId)).get()
  if (!binding || binding.targetKind !== 'new_node' || binding.slotId || binding.status !== 'pending') return
  const job = tx.select().from(s.generationJobs).where(eq(s.generationJobs.id, binding.jobId)).get()!
  const kind = job.kind as MediaKind
  const operationId = newId('operation')
  insertOperation(tx, { id: operationId, actor: { kind: 'system' }, description: `生成结果占位（${binding.jobId}）` }, now)
  const nearNodeId = (binding.placement as { nearNodeId?: string } | null)?.nearNodeId
  const near = nearNodeId ? readNodes(tx, [nearNodeId])[0] : undefined
  const size = defaultNodeSize(kind, aspectOf(job.params as Record<string, unknown>))
  const pos = placeNewNode(size, liveNodeRects(tx), near)
  const created = createNodeWithSlot(tx, { kind, ...pos, ...size, ...draftFields(tx, job.id) }, operationId, now)
  tx.update(s.deliveryBindings)
    .set({ nodeId: created.nodeId, slotId: created.slotId, expectedContentRevision: created.revision, createdNodeId: created.nodeId })
    .where(eq(s.deliveryBindings.id, binding.id))
    .run()
  tx.update(s.slots).set({ acceptedBindingId: binding.id }).where(eq(s.slots.id, created.slotId)).run()
}

/**
 * Remove a cancelled job's placeholders (RFC 0047 decision 1) while their main slot is still empty and still awaits this job.
 * One the author wrote into, or that a later job now targets, stays.
 */
export function releasePlaceholders(tx: SpaceTx, input: { jobId: string }, now: number): void {
  const bindings = tx.select().from(s.deliveryBindings)
    .where(and(eq(s.deliveryBindings.jobId, input.jobId), eq(s.deliveryBindings.targetKind, 'new_node'))).all()
  let operationId: string | undefined
  for (const binding of bindings) {
    if (!binding.createdNodeId || !binding.slotId) continue
    const node = tx.select({ deletedAt: s.nodes.deletedAt }).from(s.nodes).where(eq(s.nodes.id, binding.createdNodeId)).get()
    const slot = tx.select().from(s.slots).where(eq(s.slots.id, binding.slotId)).get()
    if (!node || node.deletedAt !== null || !slot || slot.deletedAt !== null) continue
    if (slot.currentRevision !== 0 || slot.acceptedBindingId !== binding.id) continue
    if (!operationId) {
      operationId = newId('operation')
      insertOperation(tx, { id: operationId, actor: { kind: 'system' }, description: `取消生成，移除占位（${input.jobId}）` }, now)
    }
    // Tombstone as node.delete does; the binding keeps pointing at it for history
    tx.update(s.nodes).set({ deletedAt: now }).where(eq(s.nodes.id, binding.createdNodeId)).run()
    tx.update(s.slots).set({ deletedAt: now }).where(and(eq(s.slots.nodeId, binding.createdNodeId), isNull(s.slots.deletedAt))).run()
    appendEvent(tx, { type: 'node.deleted', entityType: 'node', entityId: binding.createdNodeId, payload: { nodeId: binding.createdNodeId }, operationId }, now)
  }
}
