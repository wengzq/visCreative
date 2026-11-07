import { applyOps } from '@vis/canvas-core'
import { ulid, VisError } from '@vis/domain'
import { applyTextEdits, textEditAnchor, type MethodParams, type TextProposal, type TextProposalEdit } from '@vis/protocol'
import { and, appendEvent, asc, eq, isNull, runIdempotent, spaceSchema as s, type SpaceDb, type SpaceTx } from '@vis/storage'

function manuscript(tx: SpaceTx, slotId: string) {
  const row = tx.select({ slot: s.slots, node: s.nodes, body: s.slotRevisions.textBody }).from(s.slots)
    .innerJoin(s.nodes, eq(s.nodes.id, s.slots.nodeId))
    .leftJoin(s.slotRevisions, and(eq(s.slotRevisions.slotId, s.slots.id), eq(s.slotRevisions.revision, s.slots.currentRevision)))
    .where(and(eq(s.slots.id, slotId), isNull(s.slots.deletedAt), isNull(s.nodes.deletedAt))).get()
  if (!row || row.node.kind !== 'text' || row.node.format === 'code' || row.slot.slotKey !== 'main') {
    throw VisError.of('invalid_params', 'writing.manuscript_required', {}, 'A live non-code main text slot is required')
  }
  return { ...row, body: row.body ?? '' }
}

function changed(tx: SpaceTx, row: typeof s.textProposals.$inferSelect, at: number) {
  appendEvent(tx, { type: 'text.proposalChanged', entityType: 'textProposal', entityId: row.id, payload: { proposalId: row.id, slotId: row.slotId } }, at)
}
function view(tx: SpaceTx, row: typeof s.textProposals.$inferSelect): TextProposal {
  const nodeId = tx.select({ nodeId: s.slots.nodeId }).from(s.slots).where(eq(s.slots.id, row.slotId)).get()!.nodeId
  return { proposalId: row.id, nodeId, slotId: row.slotId, baseRevision: row.baseRevision, sessionId: row.sessionId, summary: row.summary, edits: row.edits, status: row.status, createdAt: row.createdAt }
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
      changed(tx, row, at)
    }
  }
}

export function createTextProposalService(db: SpaceDb, now = Date.now) {
  return {
    propose(params: MethodParams<'text.propose'>, sessionId: string) {
      return runIdempotent(db, { requestId: params.requestId, method: 'text.propose', params: { ...params, sessionId } }, tx => {
        const source = manuscript(tx, params.slotId)
        if (source.slot.currentRevision !== params.baseRevision) throw VisError.of('revision_conflict', 'canvas.revision_conflict', {}, 'The manuscript revision changed; reread it before proposing')
        for (const [index, edit] of params.edits.entries()) if (!textEditAnchor(source.body, edit)) {
          throw VisError.of('invalid_params', 'writing.anchor_not_unique', { index }, 'The quoted find and context must match exactly once')
        }
        if (applyTextEdits(source.body, params.edits) === null) throw VisError.of('invalid_params', 'writing.edits_overlap', {}, 'Proposed edits must not overlap')
        const row = { id: `textProposal_${ulid(now())}`, slotId: params.slotId, baseRevision: params.baseRevision, sessionId, summary: params.summary,
          edits: params.edits.map(edit => ({ ...edit, editId: `textEdit_${ulid(now())}`, status: 'pending' as const })), status: 'open' as const, createdAt: now() }
        tx.insert(s.textProposals).values(row).run()
        changed(tx, row, now())
        return view(tx, row)
      }, now)
    },
    list(params: MethodParams<'text.proposal.list'>) {
      return db.transaction(tx => ({ proposals: tx.select().from(s.textProposals)
        .innerJoin(s.slots, eq(s.slots.id, s.textProposals.slotId)).innerJoin(s.nodes, eq(s.nodes.id, s.slots.nodeId))
        .where(and(params.slotId ? eq(s.textProposals.slotId, params.slotId) : undefined,
          params.status === 'all' ? undefined : eq(s.textProposals.status, params.status), isNull(s.nodes.deletedAt), isNull(s.slots.deletedAt)))
        .orderBy(asc(s.textProposals.createdAt), asc(s.textProposals.id)).all().map(row => view(tx, row.text_proposals)) }))
    },
    resolve(params: MethodParams<'text.proposal.resolve'>) {
      return runIdempotent(db, { requestId: params.requestId, method: 'text.proposal.resolve', params }, tx => {
        const source = manuscript(tx, params.slotId)
        if (params.action === 'accept' && source.slot.currentRevision !== params.expectedRevision) throw VisError.of('revision_conflict', 'canvas.revision_conflict', {}, 'The manuscript revision changed; review the current text')
        const proposals = new Map<string, typeof s.textProposals.$inferSelect>()
        const selected: TextProposalEdit[] = []
        for (const ref of params.edits) {
          const row = proposals.get(ref.proposalId) ?? tx.select().from(s.textProposals).where(eq(s.textProposals.id, ref.proposalId)).get()
          const edit = row?.edits.find(edit => edit.editId === ref.editId)
          if (!row || row.slotId !== params.slotId || !edit || row.status !== 'open' || !['pending', 'stale'].includes(edit.status)) throw VisError.of('invalid_params', 'writing.edit_not_pending', {}, 'The proposal edit is no longer awaiting review')
          if (params.action === 'accept' && (edit.status === 'stale' || !textEditAnchor(source.body, edit))) throw VisError.of('invalid_params', 'writing.edit_stale', {}, 'The edit is stale and cannot be applied')
          proposals.set(row.id, row)
          selected.push(edit)
        }
        if (params.action === 'accept') {
          const body = applyTextEdits(source.body, selected)
          if (body === null) throw VisError.of('invalid_params', 'writing.edits_overlap', {}, 'The selected edits overlap or have stale anchors')
          if (body !== params.body) throw VisError.of('invalid_params', 'writing.draft_mismatch', {}, 'The saved draft must contain exactly the accepted edits; save other changes first')
        }
        for (const row of proposals.values()) {
          const ids = new Set(params.edits.filter(ref => ref.proposalId === row.id).map(ref => ref.editId))
          row.edits = row.edits.map(edit => ids.has(edit.editId) ? { ...edit, status: params.action === 'accept' ? 'accepted' : 'rejected' } : edit)
          row.status = row.edits.some(edit => edit.status === 'pending' || edit.status === 'stale') ? 'open' : 'resolved'
          tx.update(s.textProposals).set({ edits: row.edits, status: row.status }).where(eq(s.textProposals.id, row.id)).run()
          changed(tx, row, now())
        }
        if (params.action === 'accept') applyOps(tx, { kind: 'user' }, { requestId: params.requestId, ops: [{ op: 'slot.setText', slotId: params.slotId, expectedRevision: params.expectedRevision, body: params.body }] }, now())
        refreshTextProposals(tx, now())
        return { proposals: [...proposals.keys()].map(id => view(tx, tx.select().from(s.textProposals).where(eq(s.textProposals.id, id)).get()!)),
          ...(params.action === 'accept' ? { revision: params.expectedRevision + 1 } : {}) }
      }, now)
    },
  }
}
