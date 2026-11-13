import { isDeepStrictEqual } from 'node:util'
import { VisError } from '@vis/domain'
import { ApprovalPayload, SceneDoc, textEditAnchor, type SceneChange, type SceneChangeInput } from '@vis/protocol'
import { and, appendEvent, eq, isNull, spaceSchema as s, type SpaceTx } from '@vis/storage'
import { readSessionSummary, upsertItem } from '@vis/workbench-core'
import { objectContent, viewContent } from './scene-permissions'

export function manuscript(tx: SpaceTx, slotId: string) {
  const row = tx.select({ slot: s.slots, node: s.nodes, body: s.slotRevisions.textBody }).from(s.slots)
    .innerJoin(s.nodes, eq(s.nodes.id, s.slots.nodeId))
    .leftJoin(s.slotRevisions, and(eq(s.slotRevisions.slotId, s.slots.id), eq(s.slotRevisions.revision, s.slots.currentRevision)))
    .where(and(eq(s.slots.id, slotId), isNull(s.slots.deletedAt), isNull(s.nodes.deletedAt))).get()
  if (!row || row.node.kind !== 'text' || row.node.format === 'code' || row.slot.slotKey !== 'main') {
    throw VisError.of('invalid_params', 'writing.manuscript_required', {}, 'A live non-code main text slot is required')
  }
  return { ...row, body: row.body ?? '' }
}

/** Called inside every canvas mutation, including undo, so a stale edit never becomes applicable again. */
export function refreshTextProposals(tx: SpaceTx, at: number) {
  for (const row of tx.select().from(s.textProposals).where(eq(s.textProposals.status, 'open')).all()) {
    let body: string | null = null
    try { body = manuscript(tx, row.slotId).body } catch { /* Deleted or converted manuscripts invalidate pending anchors. */ }
    let dirty = false
    const edits = row.edits.map(edit => {
      if (edit.status !== 'pending' || (body !== null && textEditAnchor(body, edit))) return edit
      dirty = true
      return { ...edit, status: 'stale' as const }
    })
    if (dirty) {
      tx.update(s.textProposals).set({ edits }).where(eq(s.textProposals.id, row.id)).run()
      appendEvent(tx, { type: 'text.proposalChanged', entityType: 'textProposal', entityId: row.id, payload: { proposalId: row.id, slotId: row.slotId } }, at)
    }
  }
}

export const textDeletionApprovals = (tx: SpaceTx) => tx.select().from(s.transcriptEntries).where(eq(s.transcriptEntries.kind, 'approval')).all()
export function currentTextDeletion(tx: SpaceTx, target: NonNullable<ApprovalPayload['textDelete']>) {
  return tx.select().from(s.slots).innerJoin(s.nodes, eq(s.nodes.id, s.slots.nodeId))
    .where(and(eq(s.slots.id, target.slotId), eq(s.nodes.id, target.nodeId), eq(s.slots.currentRevision, target.revision), isNull(s.slots.deletedAt), isNull(s.nodes.deletedAt))).get()
}
export function updateTextDeletion(tx: SpaceTx, row: typeof s.transcriptEntries.$inferSelect, payload: ApprovalPayload, at: number) {
  upsertItem(tx, { sessionId: row.sessionId, turnId: row.turnId, itemId: row.itemId, revision: row.revision + 1, kind: 'approval', payload }, at)
  appendEvent(tx, { type: 'session.updated', entityType: 'session', entityId: row.sessionId, payload: readSessionSummary(tx, row.sessionId) }, at)
}

/** Text revision changes void approval immediately; restoring the old body never restores the permission. */
export function refreshTextDeletionApprovals(tx: SpaceTx, at: number) {
  for (const row of textDeletionApprovals(tx)) {
    const parsed = ApprovalPayload.safeParse(row.payload)
    if (!parsed.success || parsed.data.kind !== 'text_delete' || parsed.data.status !== 'pending') continue
    const payload = parsed.data
    if (!payload.textDelete || payload.textDelete.expiresAt <= at || !currentTextDeletion(tx, payload.textDelete)) updateTextDeletion(tx, row, { ...payload, status: 'expired' }, at)
  }
}

function findSceneSlot(tx: SpaceTx, slotId: string) {
  const row = tx.select({ slot: s.slots, node: s.nodes, doc: s.slotRevisions.sceneDoc }).from(s.slots)
    .innerJoin(s.nodes, eq(s.nodes.id, s.slots.nodeId))
    .leftJoin(s.slotRevisions, and(eq(s.slotRevisions.slotId, s.slots.id), eq(s.slotRevisions.revision, s.slots.currentRevision)))
    .where(and(eq(s.slots.id, slotId), isNull(s.slots.deletedAt), isNull(s.nodes.deletedAt))).get()
  if (!row) return undefined
  if (row.node.kind !== 'scene' || row.slot.slotKey !== 'main' || !row.doc) {
    throw VisError.of('invalid_params', 'scene.slot_required', {}, 'A live main scene slot is required')
  }
  return { ...row, doc: SceneDoc.parse(row.doc) }
}
export function sceneSlot(tx: SpaceTx, slotId: string) {
  const row = findSceneSlot(tx, slotId)
  if (!row) throw VisError.of('invalid_params', 'scene.slot_required', {}, 'A live main scene slot is required')
  return row
}
export function sceneChangeContent(doc: SceneDoc, change: SceneChangeInput) {
  if (change.target === 'duration') return doc.durationS ?? null
  if (change.target === 'object') {
    const item = doc.objects.find(item => item.id === change.id)
    return item && objectContent(item)
  }
  const item = doc.views.find(item => item.id === change.id)
  return item && viewContent(item)
}
export const sceneChangeMatches = (doc: SceneDoc, change: SceneChange) => isDeepStrictEqual(sceneChangeContent(doc, change), change.base)
export type SceneProposalRow = typeof s.sceneProposals.$inferSelect
export function emitSceneProposal(tx: SpaceTx, row: SceneProposalRow, at: number) {
  appendEvent(tx, { type: 'scene.proposalChanged', entityType: 'sceneProposal', entityId: row.id, payload: { proposalId: row.id, slotId: row.slotId } }, at)
}
export function saveSceneProposal(tx: SpaceTx, row: SceneProposalRow, changes: SceneChange[]): SceneProposalRow {
  const status = changes.some(change => change.status === 'pending') ? 'open' as const : 'resolved' as const
  tx.update(s.sceneProposals).set({ changes, status }).where(eq(s.sceneProposals.id, row.id)).run()
  return { ...row, changes, status }
}

/** Load each scene once; only a missing or deleted source invalidates pending changes without a comparison. */
export function refreshSceneProposals(tx: SpaceTx, at: number) {
  const bySlot = new Map<string, SceneProposalRow[]>()
  for (const row of tx.select().from(s.sceneProposals).where(eq(s.sceneProposals.status, 'open')).all()) {
    const rows = bySlot.get(row.slotId) ?? []
    rows.push(row)
    bySlot.set(row.slotId, rows)
  }
  const refreshed = new Map<string, SceneProposalRow>()
  for (const [slotId, rows] of bySlot) {
    const doc = findSceneSlot(tx, slotId)?.doc
    for (const row of rows) {
      let dirty = false
      const changes = row.changes.map(change => {
        if (change.status !== 'pending' || (doc && sceneChangeMatches(doc, change))) return change
        dirty = true
        return { ...change, status: 'stale' as const }
      })
      if (dirty) {
        refreshed.set(row.id, saveSceneProposal(tx, row, changes))
        emitSceneProposal(tx, row, at)
      }
    }
  }
  return refreshed
}

/** Every canvas mutation refreshes all review mechanisms in its existing transaction. */
export function refreshReviews(tx: SpaceTx, at: number) {
  refreshTextProposals(tx, at)
  refreshTextDeletionApprovals(tx, at)
  return refreshSceneProposals(tx, at)
}
