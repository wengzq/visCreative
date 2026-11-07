import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { entity, type EntityProposalInput } from '@vis/protocol'
import { eq, openSpaceDb, spaceSchema as s, type SpaceDb } from '@vis/storage'
import { createEntityService, entityIdsForAssets, type EntityService } from './entities'

let db: SpaceDb
let service: EntityService
let serial = 0
const requestId = () => `request-${++serial}`
beforeEach(() => {
  db = openSpaceDb(':memory:')
  service = createEntityService({ db, now: () => 1000 })
  db.insert(s.sessions).values({ id: 'session', agentKind: 'codex', title: 'Organizer', createdAt: 1 }).run()
})
afterEach(() => db.$client.close())
function media(id: string, kind: 'image' | 'video' | 'audio' = 'image') {
  db.insert(s.blobs).values({ hash: id, byteSize: 1, createdAt: 1 }).run()
  db.insert(s.assets).values({ id, kind, origin: 'import', createdAt: 1 }).run()
  db.insert(s.assetVersions).values({ id: `${id}-v1`, assetId: id, version: 1, blobHash: id, mime: `${kind}/png`, createdAt: 1 }).run()
  return `${id}-v1`
}
function create(name = 'Hero') { return service.create({ requestId: requestId(), kind: 'character', name }) }
function proposal(input: Partial<EntityProposalInput> = {}) {
  return service.propose('session', { requestId: requestId(), proposals: [{ kind: 'character', name: 'Hero', members: [{ assetId: 'one', role: 'image' }], reason: 'Same subject', ...input }] }).proposalIds[0]!
}

it.each(['font', 'model'] as const)('refuses a %s asset as a setting member even with the other role', kind => {
  db.insert(s.assets).values({ id: kind, kind, origin: 'import', createdAt: 1 }).run()
  expect(() => service.create({
    requestId: requestId(), kind: 'prop', name: 'Bench', members: [{ assetId: kind, role: 'other' }],
  })).toThrow(expect.objectContaining({ code: 'invalid_params', details: expect.objectContaining({ reason: 'entity.member_unavailable' }) }))
  expect(db.query.entities.findMany().sync()).toEqual([])
})

it('normalizes names per kind, returns the existing id, permits reuse after deletion and checks revisions', () => {
  const hero = create(' Hero ')
  expect(hero.name).toBe('Hero')
  expect(() => create('hErO')).toThrow(expect.objectContaining({ code: 'invalid_params', details: { reason: 'entity.name_taken', params: { entityId: hero.id, kind: 'character', name: 'hErO' } } }))
  expect(service.create({ requestId: requestId(), kind: 'scene', name: 'hero' }).kind).toBe('scene')
  expect(() => service.update({ entityId: hero.id, expectedRevision: 0, description: 'Changed' })).toThrow(expect.objectContaining({ code: 'revision_conflict' }))
  service.delete({ entityId: hero.id, expectedRevision: hero.revision })
  expect(create('hero').id).not.toBe(hero.id)
  expect(service.list({ includeDeleted: true }).items).toHaveLength(3)
  expect(service.list({ includeDeleted: false, query: 'HERO', kind: 'character' }).items).toHaveLength(1)
})

it('deduplicates create requests and rejects changed request payloads', () => {
  const input = { requestId: requestId(), kind: 'character' as const, name: 'Hero' }
  expect(service.create(input)).toEqual(service.create(input))
  expect(() => service.create({ ...input, name: 'Other' })).toThrow(expect.objectContaining({ code: 'idempotency_conflict' }))
})

it('requires project image references without adding members and includes refs in belongs-to chips', () => {
  const image = media('image')
  const audio = media('audio', 'audio')
  for (const assetVersionId of ['missing', audio]) {
    expect(() => service.create({ requestId: requestId(), kind: 'style', name: 'Ink', refs: [{ assetVersionId }] })).toThrow(expect.objectContaining({ code: 'invalid_params' }))
  }
  const setting = service.create({ requestId: requestId(), kind: 'style', name: 'Ink', refs: [{ assetVersionId: image }] })
  expect(setting.members).toEqual([])
  expect(entityIdsForAssets(db, ['image', 'audio']).get('image')).toEqual([setting.id])
  expect(entity.get.result.safeParse(setting).success).toBe(true)
  expect(service.update({ entityId: setting.id, expectedRevision: 1, refs: [] }).members).toEqual([])
  expect(entityIdsForAssets(db, ['image']).has('image')).toBe(false)
})

it('allows a group image to belong to two characters and another kind while checking member roles', () => {
  media('one')
  const hero = service.create({ requestId: requestId(), kind: 'character', name: 'Hero', members: [{ assetId: 'one', role: 'image' }] })
  const other = service.create({ requestId: requestId(), kind: 'character', name: 'Other', members: hero.members })
  expect(other.members).toEqual(hero.members)
  expect(entityIdsForAssets(db, ['one']).get('one')).toEqual([hero.id, other.id])
  expect(service.create({ requestId: requestId(), kind: 'scene', name: 'Park', members: hero.members }).members).toEqual(hero.members)
  expect(() => service.update({ entityId: hero.id, expectedRevision: 1, members: [{ assetId: 'one', role: 'voice' }] })).toThrow()
})

it('supersedes only overlapping pending proposals and is idempotent', () => {
  media('one')
  media('two')
  const old = proposal()
  const separate = proposal({ name: 'Another', members: [{ assetId: 'two', role: 'image' }] })
  db.insert(s.libraryRuns).values({ id: 'organize', kind: 'merge', sessionId: 'session', startedAt: 1 }).run()
  const input = { requestId: requestId(), runId: 'organize', proposals: [{ kind: 'character' as const, name: 'Hero', reason: 'Same face', members: [{ assetId: 'one', role: 'image' as const }] }] }
  const result = service.propose('session', input)
  expect(service.propose('session', input)).toEqual(result)
  expect(service.proposalList({ status: 'superseded' }).items.map(item => item.proposalId)).toEqual([old])
  expect(service.proposalList({ status: 'pending' }).items.map(item => item.proposalId)).toEqual(expect.arrayContaining([separate, result.proposalIds[0]]))
  expect(service.proposalList({ status: 'pending' }).items.find(item => item.runId === 'organize')?.sessionId).toBe('session')
})

it('requires explicit edits after a target revision moves and accepts atomically with proposal provenance', () => {
  const ref = media('one')
  const hero = create()
  const id = proposal({ entityId: hero.id, refs: [ref] })
  service.update({ entityId: hero.id, expectedRevision: 1, description: 'User edit' })
  expect(service.proposalList({ status: 'pending' }).items[0]!.needsRecheck).toBe(true)
  for (const edits of [undefined, {}]) expect(() => service.proposalResolve({ requestId: requestId(), proposalId: id, accept: true, ...(edits ? { edits } : {}) })).toThrow(expect.objectContaining({ details: { reason: 'entity.proposal_recheck_required', params: {} } }))
  expect(db.select().from(s.entityAssets).all()).toHaveLength(0)
  const result = service.proposalResolve({ requestId: requestId(), proposalId: id, accept: true, edits: { name: 'Hero reviewed' } })
  expect(result.entity).toMatchObject({ id: hero.id, name: 'Hero reviewed', description: 'User edit', refs: [{ assetVersionId: ref }] })
  expect(result.proposal.needsRecheck).toBe(false)
  expect(db.select().from(s.entityAssets).get()?.addedByProposalId).toBe(id)
})

it('rechecks archived members, permits removal with edits, and rejects without changing settings', () => {
  const ref = media('one')
  media('two')
  const id = proposal({ members: [{ assetId: 'one', role: 'image' }, { assetId: 'two', role: 'image' }], refs: [ref] })
  db.update(s.assets).set({ archivedAt: 1 }).where(eq(s.assets.id, 'two')).run()
  expect(service.proposalList({ status: 'pending' }).items[0]!.needsRecheck).toBe(true)
  expect(() => service.proposalResolve({ requestId: requestId(), proposalId: id, accept: true, edits: { name: 'Reviewed' } })).toThrow()
  const accepted = service.proposalResolve({ requestId: requestId(), proposalId: id, accept: true, edits: { members: [{ assetId: 'one', role: 'image' }] } })
  expect(accepted.entity?.members).toHaveLength(1)
  const rejectedId = proposal()
  expect(service.proposalResolve({ requestId: requestId(), proposalId: rejectedId, accept: false }).proposal.status).toBe('rejected')
  expect(service.list({ includeDeleted: false }).items).toHaveLength(1)
})

it('unmerges only members added by the latest accepted proposal, preserving old members', () => {
  media('one')
  const secondRef = media('two')
  const hero = service.create({ requestId: requestId(), kind: 'character', name: 'Hero', members: [{ assetId: 'one', role: 'image' }] })
  const id = proposal({ entityId: hero.id, members: [{ assetId: 'two', role: 'image' }], refs: [secondRef] })
  const accepted = service.proposalResolve({ requestId: requestId(), proposalId: id, accept: true }).entity!
  const params = { requestId: requestId(), entityId: hero.id, expectedRevision: accepted.revision }
  const undone = service.unmerge(params)
  expect(service.unmerge(params)).toEqual(undone)
  expect(undone.members).toEqual([{ assetId: 'one', role: 'image' }])
  expect(undone.refs).toEqual([])
})

it('rejects proposal refs outside its members and rolls back all proposals when one is invalid', () => {
  media('one')
  const other = media('other')
  expect(() => proposal({ refs: [other] })).toThrow()
  expect(() => service.propose('session', { requestId: requestId(), proposals: [
    { kind: 'character', name: 'Hero', members: [{ assetId: 'one', role: 'image' }], reason: 'Face' },
    { kind: 'character', name: 'Other', members: [{ assetId: 'missing', role: 'image' }], reason: 'Face' },
  ] })).toThrow()
  expect(service.proposalList({ status: 'pending' }).items).toEqual([])
})

it('unmerges by acceptance order when proposals are accepted in the opposite creation order at the same timestamp', () => {
  media('one')
  media('two')
  const hero = create()
  const first = proposal({ entityId: hero.id })
  const second = proposal({ entityId: hero.id, members: [{ assetId: 'two', role: 'image' }] })
  service.proposalResolve({ requestId: requestId(), proposalId: second, accept: true })
  const latest = service.proposalResolve({ requestId: requestId(), proposalId: first, accept: true, edits: { name: 'Hero' } }).entity!
  expect(service.unmerge({ requestId: requestId(), entityId: hero.id, expectedRevision: latest.revision }).members).toEqual([{ assetId: 'two', role: 'image' }])
})

it('looks up normalized names through the live unique index', () => {
  const hero = create(' Hero ')
  const prepare = vi.spyOn(db.$client, 'prepare')
  try {
    expect(() => create(' HERO ')).toThrow(expect.objectContaining({ details: expect.objectContaining({ reason: 'entity.name_taken' }) }))
    const query = prepare.mock.calls.map(([query]) => query).find(query => query.includes('lower(trim('))!
    expect(query).toContain(' = lower(trim(')
    const plan = db.$client.prepare(`EXPLAIN QUERY PLAN ${query}`).all('character', 'HERO') as { detail: string }[]
    expect(plan.some(row => row.detail.includes('USING INDEX entities_live_kind_name') && row.detail.includes('<expr>='))).toBe(true)
    expect(service.get({ entityId: hero.id }).revision).toBe(1)
  } finally { prepare.mockRestore() }
})
