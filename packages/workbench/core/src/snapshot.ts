import { newId, VisError } from '@vis/domain'
import { and, eq, isNull, spaceSchema as s, type SpaceTx } from '@vis/storage'
import type { TurnRef } from './runtime-port'

/**
 * Resolve references and persist the input snapshot at turn start, before first delivery to the Agent (0001 "Asset References and Execution Snapshots").
 * Empty slots are targets only and do not enter the snapshot; deleted referenced nodes or slots cause errors rather than silent asset replacement.
 */
export function resolveSnapshot(tx: SpaceTx, turnId: string, messageId: string, now: number, assetPath?: (assetVersionId: string) => string): { snapshotId: string; refs: TurnRef[]; assetText: string } {
  const refs = tx.select().from(s.messageRefs).where(eq(s.messageRefs.messageId, messageId)).orderBy(s.messageRefs.ordinal).all()
  const snapshotId = newId('snapshot', now)
  tx.insert(s.inputSnapshots).values({ id: snapshotId, turnId, createdAt: now }).run()

  const resolved: TurnRef[] = []
  const attachments: string[] = []
  let ordinal = 0
  for (const ref of refs) {
    if (ref.assetVersionId) {
      const version = tx.select().from(s.assetVersions).where(eq(s.assetVersions.id, ref.assetVersionId)).get()
      const asset = version && tx.select().from(s.assets).where(eq(s.assets.id, version.assetId)).get()
      if (!version || !asset) throw VisError.of('not_found', 'session.ref_asset_not_found', { assetVersionId: ref.assetVersionId }, `Referenced asset ${ref.assetVersionId} does not exist`)
      if (!assetPath) throw VisError.of('unavailable', 'session.ref_asset_path_unavailable', {}, 'Cannot resolve the asset attachment path')
      attachments.push(JSON.stringify({ assetId: asset.id, assetVersionId: version.id, kind: asset.kind, filename: asset.displayName ?? version.id, path: assetPath(version.id) }))
      continue
    }
    if (!ref.nodeId) throw VisError.of('not_found', 'session.ref_target_not_found', {}, 'Reference target does not exist')
    const node = tx.select().from(s.nodes).where(and(eq(s.nodes.id, ref.nodeId), isNull(s.nodes.deletedAt))).get()
    if (!node) throw VisError.of('not_found', 'session.ref_node_not_found', { nodeId: ref.nodeId }, `Referenced node ${ref.nodeId} has been deleted or does not exist`)
    const slots = tx
      .select()
      .from(s.slots)
      // A fixed revision applies to only one slot: without a specified slot it applies only to main, since slot revision numbers are independent
      .where(and(eq(s.slots.nodeId, node.id), isNull(s.slots.deletedAt),
        ref.slotId ? eq(s.slots.id, ref.slotId) : ref.versionPolicy === 'pinned' ? eq(s.slots.slotKey, 'main') : undefined))
      .all()
    if (ref.slotId && slots.length === 0) throw VisError.of('not_found', 'session.ref_slot_not_found', { slotId: ref.slotId }, `Referenced slot ${ref.slotId} has been deleted or does not exist`)

    for (const slot of slots) {
      const revision = ref.versionPolicy === 'pinned' ? ref.pinnedRevision! : slot.currentRevision
      if (revision > slot.currentRevision) throw VisError.of('not_found', 'session.ref_revision_not_found', { slotId: slot.id, revision }, `Slot ${slot.id} has no revision ${revision}`)
      if (revision === 0) {
        resolved.push({ nodeId: node.id, slotId: slot.id, revision: null })
        continue
      }
      tx.insert(s.snapshotItems).values({ snapshotId, ordinal: ordinal++, nodeId: node.id, slotId: slot.id, slotRevision: revision }).run()
      resolved.push({ nodeId: node.id, slotId: slot.id, revision })
    }
  }
  tx.update(s.turns).set({ inputSnapshotId: snapshotId }).where(eq(s.turns.id, turnId)).run()
  return { snapshotId, refs: resolved, assetText: attachments.length ? `\n\n<素材附件>\n${attachments.join('\n')}\n</素材附件>` : '' }
}
