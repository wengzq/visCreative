import { isDeepStrictEqual } from 'node:util'
import { applyOps, validateScene } from '@vis/canvas-core'
import { ulid, VisError } from '@vis/domain'
import { SceneDoc, type MethodParams, type SceneChange, type SceneChangeInput, type SceneProposal } from '@vis/protocol'
import { and, asc, eq, isNull, runIdempotent, spaceSchema as s, type SpaceDb, type SpaceTx } from '@vis/storage'
import { stampUserScene } from './scene-permissions'
import { sceneSlot, sceneChangeContent as content, sceneChangeMatches as matches, saveSceneProposal as save, emitSceneProposal as changed, refreshReviews, type SceneProposalRow as Row } from './reviews'
export { refreshSceneProposals } from './reviews'

const targetKey = (change: SceneChangeInput) => change.target === 'duration' ? 'duration' : `${change.target}/${change.id}`
function view(row: Row, nodeId: string): SceneProposal {
  return { proposalId: row.id, nodeId, slotId: row.slotId, baseRevision: row.baseRevision, sessionId: row.sessionId, summary: row.summary, changes: row.changes, status: row.status, createdAt: row.createdAt }
}

function applyChanges(current: SceneDoc, changes: readonly SceneChangeInput[]): SceneDoc {
  const doc = structuredClone(current)
  for (const change of changes) {
    if (change.target === 'duration') {
      if (change.durationS === null) delete doc.durationS
      else doc.durationS = change.durationS
    } else if (change.target === 'object') {
      doc.objects = doc.objects.flatMap(item => item.id !== change.id ? [item] : change.action === 'delete' ? [] : [{ ...change.item, createdBy: item.createdBy, userTouched: item.userTouched }])
    } else {
      doc.views = doc.views.flatMap(item => item.id !== change.id ? [item] : change.action === 'delete' ? [] : [{ ...change.item, still: item.still, createdBy: item.createdBy, userTouched: item.userTouched }])
    }
  }
  const parsed = SceneDoc.safeParse(doc)
  if (!parsed.success) throw VisError.of('invalid_params', 'scene.change_invalid', {}, 'The combined changes do not form a valid scene')
  return parsed.data
}

export function createSceneProposalService(db: SpaceDb, now = Date.now) {
  return {
    propose(params: MethodParams<'scene.propose'>, sessionId: string, authorize?: (tx: SpaceTx) => void) {
      return runIdempotent(db, { requestId: params.requestId, method: 'scene.propose', params: { ...params, sessionId } }, tx => {
        authorize?.(tx)
        const source = sceneSlot(tx, params.slotId)
        if (source.slot.currentRevision !== params.baseRevision) throw VisError.of('revision_conflict', 'canvas.revision_conflict', {}, 'The scene revision changed; reread it before proposing')
        const keys = new Set<string>()
        const changes = params.changes.map(change => {
          const key = targetKey(change)
          if (keys.has(key)) throw VisError.of('invalid_params', 'scene.change_duplicate', {}, 'Each item may be changed at most once in a proposal')
          keys.add(key)
          const base = content(source.doc, change)
          if (base === undefined) throw VisError.of('invalid_params', 'scene.change_target_missing', {}, 'The proposed target is missing')
          if (change.target !== 'duration' && change.action === 'update' && change.item.id !== change.id) throw VisError.of('invalid_params', 'scene.change_id_mismatch', {}, 'An update must preserve the target ID')
          if (isDeepStrictEqual(base, change.target === 'duration' ? change.durationS : change.action === 'update' ? change.item : undefined)) throw VisError.of('invalid_params', 'scene.change_noop', {}, 'The proposed content equals the current content')
          return { ...change, base, changeId: `sceneChange_${ulid(now())}`, status: 'pending' } as SceneChange
        })
        validateScene(tx, applyChanges(source.doc, changes))
        for (const row of tx.select().from(s.sceneProposals).where(and(eq(s.sceneProposals.slotId, params.slotId), eq(s.sceneProposals.status, 'open'))).all()) {
          const superseded = row.changes.map(change => change.status === 'pending' && keys.has(targetKey(change)) ? { ...change, status: 'superseded' as const } : change)
          if (superseded.some((change, i) => change !== row.changes[i])) { save(tx, row, superseded); changed(tx, row, now()) }
        }
        const open = tx.select({ id: s.sceneProposals.id }).from(s.sceneProposals).where(and(eq(s.sceneProposals.slotId, params.slotId), eq(s.sceneProposals.status, 'open'))).all()
        if (open.length >= 20) throw VisError.of('invalid_params', 'scene.proposals_full', {}, 'This scene already has 20 open proposals')
        const row: Row = { id: `sceneProposal_${ulid(now())}`, slotId: params.slotId, baseRevision: params.baseRevision, sessionId, summary: params.summary, changes, status: 'open', createdAt: now() }
        tx.insert(s.sceneProposals).values(row).run()
        changed(tx, row, now())
        return view(row, source.node.id)
      }, now)
    },
    list(params: MethodParams<'scene.proposal.list'>) {
      return db.transaction(tx => ({ proposals: tx.select().from(s.sceneProposals)
        .innerJoin(s.slots, eq(s.slots.id, s.sceneProposals.slotId)).innerJoin(s.nodes, eq(s.nodes.id, s.slots.nodeId))
        .where(and(params.slotId ? eq(s.sceneProposals.slotId, params.slotId) : undefined,
          params.status === 'all' ? undefined : eq(s.sceneProposals.status, params.status), isNull(s.nodes.deletedAt), isNull(s.slots.deletedAt)))
        .orderBy(asc(s.sceneProposals.createdAt), asc(s.sceneProposals.id)).all().map(row => view(row.scene_proposals, row.nodes.id)) }))
    },
    resolve(params: MethodParams<'scene.proposal.resolve'>) {
      return runIdempotent(db, { requestId: params.requestId, method: 'scene.proposal.resolve', params }, tx => {
        const source = sceneSlot(tx, params.slotId)
        if (params.action === 'accept' && source.slot.currentRevision !== params.expectedRevision) throw VisError.of('revision_conflict', 'canvas.revision_conflict', {}, 'The scene revision changed; review the current scene')
        const proposals = new Map<string, Row>()
        for (const ref of params.changes) {
          const row = proposals.get(ref.proposalId) ?? tx.select().from(s.sceneProposals).where(eq(s.sceneProposals.id, ref.proposalId)).get()
          const change = row?.changes.find(change => change.changeId === ref.changeId)
          if (!row || row.slotId !== params.slotId || !change || ['accepted', 'rejected'].includes(change.status)) throw VisError.of('invalid_params', 'scene.change_not_pending', {}, 'The proposed change is no longer awaiting review')
          if (params.action === 'accept') {
            if (change.status === 'stale') throw VisError.of('invalid_params', 'scene.change_stale', {}, 'The proposed change is stale and cannot be applied')
            if (change.status !== 'pending') throw VisError.of('invalid_params', 'scene.change_not_pending', {}, 'The proposed change is no longer pending')
            if (!matches(source.doc, change)) throw VisError.of('invalid_params', 'scene.change_stale', {}, 'The proposed change is stale and cannot be applied')
          }
          proposals.set(row.id, row)
        }
        const ids = new Set(params.changes.map(ref => `${ref.proposalId}/${ref.changeId}`))
        // Apply stored proposal order, independently of the UI's selection order.
        const ordered = [...proposals.values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
        const selected = ordered.flatMap(row => row.changes.filter(change => ids.has(`${row.id}/${change.changeId}`)))
        const updated = ordered.map(row => save(tx, row, row.changes.map(change => ids.has(`${row.id}/${change.changeId}`) ? { ...change, status: params.action === 'accept' ? 'accepted' : 'rejected' } : change)))
        if (params.action === 'accept') {
          const next = stampUserScene(source.doc, applyChanges(source.doc, selected))
          applyOps(tx, { kind: 'user' }, { requestId: params.requestId, ops: [{ op: 'scene.set', slotId: params.slotId, expectedRevision: params.expectedRevision, doc: next }] }, now())
        }
        const refreshed = refreshReviews(tx, now())
        for (const row of updated) if (!refreshed.has(row.id)) changed(tx, row, now())
        return { proposals: updated.map(row => view(refreshed.get(row.id) ?? row, source.node.id)),
          ...(params.action === 'accept' ? { revision: params.expectedRevision + 1 } : {}) }
      }, now)
    },
  }
}
