import { checkSlotDelivery, type DeliveryOutcome, newId, VisError } from '@vis/domain'
import { and, appendEvent, eq, spaceSchema as s, type SpaceTx } from '@vis/storage'
import { fitNodeToAsset } from './fit'
import { defaultNodeSize, placeNewNode } from './placement'
import { liveNodeRects, readNodes } from './views'
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
      .set({ status, deliveredOperationId: extra.operationId ?? null, createdNodeId: extra.createdNodeId ?? null })
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

  if (binding.targetKind === 'new_node') {
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
    const job = tx.select().from(s.generationJobs).where(eq(s.generationJobs.id, binding.jobId)).get()!
    const subject = job.operation !== 'generate' ? tx.select({ nodeId: s.slots.nodeId }).from(s.jobInputs)
      .innerJoin(s.slots, eq(s.slots.id, s.jobInputs.slotId)).where(eq(s.jobInputs.jobId, job.id)).orderBy(s.jobInputs.ordinal).get() : undefined
    const liveSubject = subject && readNodes(tx, [subject.nodeId])[0]
    const created = createNodeWithSlot(tx, { ...(placement?.nodeId ? { nodeId: placement.nodeId } : {}), kind: media.kind, ...pos, ...size,
      ...(liveSubject ? { inputNodeIds: [liveSubject.nodeId] } : {}), content: { assetVersionId: input.assetVersionId } }, operationId, now)
    settle('delivered', { operationId, createdNodeId: created.nodeId })
    return { status: 'delivered', nodeId: created.nodeId, slotId: created.slotId, slotRevision: created.revision }
  }

  // target_kind = slot: table constraints ensure nodeId, slotId, and expectedContentRevision are non-null
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

