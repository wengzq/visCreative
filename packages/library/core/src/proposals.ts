import { ulid, VisError } from '@vis/domain'
import { entity, type EntityProposalInput, type EntityProposalView, type MethodParams } from '@vis/protocol'
import { and, appendEvent, desc, eq, inArray, runIdempotent, spaceSchema as s, type SpaceDb, type SpaceTx } from '@vis/storage'
import { assertEntityRevision, entityRow, readEntity, validateEntityMedia, writeEntity, type EntitiesChanged } from './entities'
import { requireActiveLibraryRun } from './state'

type ProposalRow = typeof s.entityProposals.$inferSelect
function readProposal(tx: SpaceTx, row: ProposalRow): EntityProposalView {
  const target = row.payload.entityId ? tx.select().from(s.entities).where(eq(s.entities.id, row.payload.entityId)).get() : undefined
  const members = tx.select().from(s.assets).where(inArray(s.assets.id, row.payload.members.map(member => member.assetId))).all()
  return {
    ...row.payload, proposalId: row.id, sessionId: row.sessionId, status: row.status,
    ...(row.runId ? { runId: row.runId } : {}), ...(row.targetRevision !== null ? { targetRevision: row.targetRevision } : {}),
    needsRecheck: row.status === 'pending' && (Boolean(row.payload.entityId && (!target || target.deletedAt !== null || target.revision !== row.targetRevision))
      || members.length !== row.payload.members.length || members.some(member => member.archivedAt !== null)),
    createdAt: row.createdAt, ...(row.resolvedAt !== null ? { resolvedAt: row.resolvedAt } : {}),
  }
}
export function proposalEvent(tx: SpaceTx, id: string, status: ProposalRow['status'], now: number) {
  appendEvent(tx, { type: 'entity.proposalChanged', entityType: 'entityProposal', entityId: id, payload: { proposalId: id, status } }, now)
}
function refsOf(input: EntityProposalInput) { return (input.refs ?? []).map(assetVersionId => ({ assetVersionId })) }
function validateProposal(tx: SpaceTx, input: EntityProposalInput) {
  const members = structuredClone(input.members)
  validateEntityMedia(tx, refsOf(input), members)
  const memberIds = new Set(members.map(member => member.assetId))
  const versions = input.refs?.length ? tx.select({ assetId: s.assetVersions.assetId }).from(s.assetVersions).where(inArray(s.assetVersions.id, input.refs)).all() : []
  if (versions.some(version => !memberIds.has(version.assetId))) throw VisError.of('invalid_params', 'entity.proposal_ref_member', {}, 'Proposal references must belong to the proposed members')
  if (input.entityId && entityRow(tx, input.entityId).kind !== input.kind) throw VisError.of('invalid_params', 'entity.proposal_kind', {}, 'The proposed kind must match its target setting')
}

export function createProposalMethods(deps: { db: SpaceDb; now: () => number; onEntitiesChanged?: EntitiesChanged }) {
  const { db, now, onEntitiesChanged } = deps
  return {
    propose(sessionId: string, params: MethodParams<'entity.propose'>) {
      const p = entity.propose.params.parse(params)
      return runIdempotent(db, { requestId: p.requestId, method: 'entity.propose', params: { ...p, sessionId } }, tx => {
        if (p.runId !== undefined) requireActiveLibraryRun(tx, p.runId, 'merge', sessionId)
        const proposalIds: string[] = []
        for (const input of p.proposals) {
          validateProposal(tx, input)
          const ids = new Set(input.members.map(member => member.assetId))
          for (const old of tx.select().from(s.entityProposals).where(eq(s.entityProposals.status, 'pending')).all()) {
            if (!old.payload.members.some(member => ids.has(member.assetId))) continue
            tx.update(s.entityProposals).set({ status: 'superseded', resolvedAt: now() }).where(eq(s.entityProposals.id, old.id)).run()
            proposalEvent(tx, old.id, 'superseded', now())
          }
          const id = `proposal_${ulid(now())}`
          tx.insert(s.entityProposals).values({
            id, requestId: p.requestId, sessionId, runId: p.runId, payload: input,
            targetRevision: input.entityId ? entityRow(tx, input.entityId).revision : null, status: 'pending', createdAt: now(),
          }).run()
          proposalEvent(tx, id, 'pending', now())
          proposalIds.push(id)
        }
        return { proposalIds }
      }, now)
    },
    proposalList(params: MethodParams<'entity.proposalList'>) {
      return db.transaction(tx => ({ items: tx.select().from(s.entityProposals).where(eq(s.entityProposals.status, params.status)).orderBy(desc(s.entityProposals.createdAt), desc(s.entityProposals.id)).all().map(row => readProposal(tx, row)) }))
    },
    proposalResolve(params: MethodParams<'entity.proposalResolve'>) {
      const p = entity.proposalResolve.params.parse(params)
      return runIdempotent(db, { requestId: p.requestId, method: 'entity.proposalResolve', params: p }, tx => {
        const row = tx.select().from(s.entityProposals).where(eq(s.entityProposals.id, p.proposalId)).get()
        if (!row) throw VisError.of('not_found', 'entity.proposal_not_found', {}, 'The merge proposal does not exist')
        if (row.status !== 'pending') throw VisError.of('invalid_transition', 'entity.proposal_resolved', {}, 'The merge proposal is no longer pending')
        const view = readProposal(tx, row)
        if (p.accept && view.needsRecheck && (!p.edits || !Object.values(p.edits).some(value => value !== undefined))) throw VisError.of('invalid_params', 'entity.proposal_recheck_required', {}, 'Review and edit this proposal before accepting it')
        const input: EntityProposalInput = { ...row.payload, ...p.edits, name: p.edits?.name ?? row.payload.name, members: p.edits?.members ?? row.payload.members }
        let setting
        if (p.accept) {
          validateProposal(tx, input)
          const previous = input.entityId ? readEntity(tx, input.entityId) : undefined
          const existing = previous?.members ?? []
          const members = [...existing, ...input.members.filter(member => !existing.some(old => old.assetId === member.assetId))]
          setting = writeEntity(tx, { ...input, members, refs: input.refs !== undefined ? refsOf(input) : previous?.refs ?? [] },
            { ...(input.entityId ? { id: input.entityId, expectedRevision: entityRow(tx, input.entityId).revision } : {}), now: now(), proposalId: row.id, onEntitiesChanged })
        }
        const status = p.accept ? 'accepted' : 'rejected'
        tx.update(s.entityProposals).set({ status, resolvedAt: now(), ...(p.accept ? { payload: input, resolvedEntityId: setting!.id } : {}) }).where(eq(s.entityProposals.id, row.id)).run()
        proposalEvent(tx, row.id, status, now())
        const resolved = tx.select().from(s.entityProposals).where(eq(s.entityProposals.id, row.id)).get()!
        return { proposal: readProposal(tx, resolved), ...(setting ? { entity: setting } : {}) }
      }, now)
    },
    unmerge(params: MethodParams<'entity.unmerge'>) {
      return runIdempotent(db, { requestId: params.requestId, method: 'entity.unmerge', params }, tx => {
        const row = entityRow(tx, params.entityId)
        assertEntityRevision(row, params.expectedRevision)
        const accepted = tx.select().from(s.entityProposals).where(and(eq(s.entityProposals.resolvedEntityId, row.id), eq(s.entityProposals.status, 'accepted'))).all()
        const latestEvent = accepted.length ? tx.select({ id: s.events.entityId }).from(s.events)
          .where(and(eq(s.events.type, 'entity.proposalChanged'), inArray(s.events.entityId, accepted.map(proposal => proposal.id)))).orderBy(desc(s.events.seq)).get() : undefined
        const latest = accepted.find(proposal => proposal.id === latestEvent?.id)
        if (!latest) return readEntity(tx, row.id)
        const removed = tx.select().from(s.entityAssets).where(and(eq(s.entityAssets.entityId, row.id), eq(s.entityAssets.addedByProposalId, latest.id))).all()
        if (!removed.length) return readEntity(tx, row.id)
        const ids = new Set(removed.map(member => member.assetId))
        const versions = tx.select().from(s.assetVersions).where(inArray(s.assetVersions.assetId, [...ids])).all()
        const refs = row.refs.filter(ref => !versions.some(version => version.id === ref.assetVersionId))
        const members = readEntity(tx, row.id).members.filter(member => !ids.has(member.assetId))
        return writeEntity(tx, { ...row, refs, members }, { id: row.id, expectedRevision: row.revision, now: now(), onEntitiesChanged })
      }, now)
    },
  }
}
