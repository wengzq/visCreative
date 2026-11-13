import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { applyOps, createCanvasService } from '@vis/canvas-core'
import { EMPTY_SCENE, SceneDoc, type SceneChangeInput, type SceneObject, type SceneView } from '@vis/protocol'
import { currentSeq, eq, openSpaceDb, readEventsAfter, spaceSchema as s, type SpaceDb } from '@vis/storage'
import { createSceneProposalService, refreshSceneProposals } from './scene-proposals'
import { refreshReviews } from './reviews'
import { createTextProposalService } from './text-proposals'
import { assertAgentSceneWrites, objectContent, stampUserScene, viewContent } from './scene-permissions'

let db: SpaceDb
let canvas: ReturnType<typeof createCanvasService>
let service: ReturnType<typeof createSceneProposalService>
let slotId: string
let nodeId: string
const rid = () => crypto.randomUUID()
const object = (id = 'bench'): SceneObject => ({ id, name: id, hidden: false, createdBy: 'agent', userTouched: false,
  transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, source: { type: 'prop', propId: 'bench' } })
const view = (): SceneView => ({ id: 'wide', name: 'Wide', camera: { position: [0, 2, 5], target: [0, 1, 0], roll: 0, focalLengthMm: 35 }, aspectRatio: '16:9', still: null, createdBy: 'agent', userTouched: false })
const slot = () => canvas.get({ nodeIds: [nodeId] }).nodes[0]!.slots[0]!
const doc = (): SceneDoc => { const content = slot().content; if (content.type !== 'scene') throw new Error('Expected scene'); return content.doc }
const write = (next: SceneDoc) => canvas.apply({ kind: 'user' }, { requestId: rid(), ops: [{ op: 'scene.set', slotId, expectedRevision: slot().revision, doc: stampUserScene(doc(), next) }] })
const update = (id = 'bench', name = 'Moved'): SceneChangeInput => ({ target: 'object', id, action: 'update', item: { ...objectContent(doc().objects.find(item => item.id === id)!), name } })
const propose = (changes: SceneChangeInput[] = [update()]) => service.propose({ requestId: rid(), slotId, baseRevision: slot().revision, summary: 'Adjust the scene', changes }, 'session')
const refs = (proposal: ReturnType<typeof propose>) => proposal.changes.map(change => ({ proposalId: proposal.proposalId, changeId: change.changeId }))
const stored = (id: string) => service.list({ status: 'all' }).proposals.find(proposal => proposal.proposalId === id)!
const error = (reason: string) => expect.objectContaining({ details: expect.objectContaining({ reason }) })

beforeEach(() => {
  db = openSpaceDb(':memory:')
  db.insert(s.sessions).values({ id: 'session', agentKind: 'codex', title: 'Builder', createdAt: 1 }).run()
  canvas = createCanvasService({ db, onChanged: tx => { refreshReviews(tx, 1) } })
  service = createSceneProposalService(db)
  const created = canvas.apply({ kind: 'user' }, { requestId: rid(), ops: [{ op: 'node.create', tempId: 'stage', kind: 'scene' }] })
  nodeId = created.idMap.stage!
  slotId = slot().slotId
  canvas.apply({ kind: 'agent', sessionId: 'session' }, { requestId: rid(), ops: [{ op: 'scene.set', slotId, expectedRevision: 1, doc: { ...EMPTY_SCENE, objects: [object(), object('chair')], views: [view()] } }] })
})
afterEach(() => db.$client.close())

it('records server bases without changing the scene and replays propose even after later edits', () => {
  const params = { requestId: rid(), slotId, baseRevision: slot().revision, summary: 'Move bench', changes: [update()] }
  const before = doc(), seq = currentSeq(db)
  const proposal = service.propose(params, 'session')
  expect(proposal.changes[0]).toMatchObject({ base: objectContent(before.objects[0]!), status: 'pending' })
  expect(doc()).toEqual(before)
  expect(readEventsAfter(db, seq)).toMatchObject([{ type: 'scene.proposalChanged', payload: { proposalId: proposal.proposalId, slotId } }])
  write({ ...doc(), objects: doc().objects.map(item => ({ ...item, name: 'Author edit' })) })
  expect(service.propose(params, 'session')).toEqual(proposal)
  expect(stored(proposal.proposalId).changes[0]!.status).toBe('stale')
  expect(() => service.propose({ ...params, summary: 'Different' }, 'session')).toThrowError(expect.objectContaining({ code: 'idempotency_conflict' }))
})

it('rejects missing targets, duplicate objects/views/duration, noops, identity replacement, invalid combined documents and revision conflicts', () => {
  expect(() => propose([{ target: 'object', id: 'missing', action: 'delete' }])).toThrowError(error('scene.change_target_missing'))
  for (const change of [update(), { target: 'view', id: 'wide', action: 'delete' }, { target: 'duration', durationS: 3 }] as SceneChangeInput[]) {
    expect(() => propose([change, change])).toThrowError(error('scene.change_duplicate'))
  }
  expect(() => propose([update('bench', 'bench')])).toThrowError(error('scene.change_noop'))
  expect(() => propose([{ target: 'duration', durationS: null }])).toThrowError(error('scene.change_noop'))
  expect(() => propose([{ target: 'view', id: 'wide', action: 'update', item: viewContent(view()) }])).toThrowError(error('scene.change_noop'))
  expect(() => propose([{ target: 'object', id: 'bench', action: 'update', item: objectContent(object('replacement')) }])).toThrowError(error('scene.change_id_mismatch'))
  const tracked = { ...objectContent(object()), tracks: { hidden: [{ t: 5, value: false }] } }
  expect(() => propose([{ target: 'object', id: 'bench', action: 'update', item: tracked }, { target: 'duration', durationS: 2 }])).toThrowError(error('scene.change_invalid'))
  expect(() => service.propose({ requestId: rid(), slotId, baseRevision: 0, summary: 'Conflict', changes: [update()] }, 'session')).toThrowError(expect.objectContaining({ code: 'revision_conflict' }))
  expect(service.list({ status: 'all' }).proposals).toEqual([])
})

it('supersedes pending changes from any session per item and resolves proposals with no pending changes', () => {
  db.insert(s.sessions).values({ id: 'other', agentKind: 'codex', title: 'Other', createdAt: 1 }).run()
  const first = propose([update(), update('chair')])
  const second = service.propose({ requestId: rid(), slotId, baseRevision: slot().revision, summary: 'Further', changes: [update('bench', 'Further')] }, 'other')
  expect(stored(first.proposalId).changes.map(change => change.status)).toEqual(['superseded', 'pending'])
  propose([update('chair', 'New chair')])
  expect(stored(first.proposalId).status).toBe('resolved')
  expect(() => service.resolve({ requestId: rid(), slotId, action: 'accept', expectedRevision: slot().revision, changes: [refs(first)[0]!] })).toThrowError(error('scene.change_not_pending'))
  expect(stored(second.proposalId).changes[0]!.status).toBe('pending')
  service.resolve({ requestId: rid(), slotId, action: 'reject', changes: refs(first) })
  expect(stored(first.proposalId).changes.map(change => change.status)).toEqual(['rejected', 'rejected'])
})

it('caps open proposals after superseding and rolls failed cap checks back', () => {
  write({ ...doc(), objects: Array.from({ length: 22 }, (_, i) => object(`item${i}`)) })
  for (let i = 0; i < 20; i++) propose([update(`item${i}`)])
  const seq = currentSeq(db)
  expect(() => propose([update('item20')])).toThrowError(error('scene.proposals_full'))
  expect(() => propose([update('item0'), update('item21')])).not.toThrow()
  expect(service.list({ status: 'open' }).proposals).toHaveLength(20)
  expect(currentSeq(db)).toBe(seq + 2)
})

it('ignores unrelated edits but permanently stales changed or deleted items including undo and redo', () => {
  const proposal = propose([update(), { target: 'view', id: 'wide', action: 'update', item: { ...viewContent(view()), name: 'Closer' } }])
  write({ ...doc(), objects: doc().objects.map(item => item.id === 'chair' ? { ...item, name: 'Other' } : item) })
  expect(stored(proposal.proposalId).changes.map(change => change.status)).toEqual(['pending', 'pending'])
  write({ ...doc(), objects: doc().objects.filter(item => item.id !== 'bench') })
  expect(stored(proposal.proposalId).changes.map(change => change.status)).toEqual(['stale', 'pending'])
  canvas.undo({ requestId: rid() })
  expect(doc().objects.some(item => item.id === 'bench')).toBe(true)
  expect(stored(proposal.proposalId).changes[0]!.status).toBe('stale')
  write({ ...doc(), views: [{ ...doc().views[0]!, name: 'Author view' }] })
  expect(stored(proposal.proposalId).status).toBe('resolved')
  expect(() => service.resolve({ requestId: rid(), slotId, action: 'accept', expectedRevision: slot().revision, changes: refs(proposal) })).toThrowError(error('scene.change_stale'))
  canvas.undo({ requestId: rid() })
  canvas.redo({ requestId: rid() })
  expect(stored(proposal.proposalId).changes.map(change => change.status)).toEqual(['stale', 'stale'])
})

it('compares duration independently and resolves deleted scene proposals as permanently stale', () => {
  const proposal = propose([{ target: 'duration', durationS: 3 }, update()])
  write({ ...doc(), durationS: 4 })
  expect(stored(proposal.proposalId).changes.map(change => change.status)).toEqual(['stale', 'pending'])
  canvas.apply({ kind: 'user' }, { requestId: rid(), ops: [{ op: 'node.delete', nodeId }] })
  expect(service.list({ status: 'all' }).proposals).toEqual([])
  expect(db.select().from(s.sceneProposals).where(eq(s.sceneProposals.id, proposal.proposalId)).get()).toMatchObject({ status: 'resolved', changes: [{ status: 'stale' }, { status: 'stale' }] })
  canvas.undo({ requestId: rid() })
  expect(stored(proposal.proposalId).changes.every(change => change.status === 'stale')).toBe(true)
})

it('accepts selected changes in one user revision, preserves protection, replays safely, and supports undo', () => {
  const proposal = propose([update(), { target: 'view', id: 'wide', action: 'update', item: { ...viewContent(view()), name: 'Closer' } }, { target: 'object', id: 'chair', action: 'delete' }, { target: 'duration', durationS: 3 }])
  const before = doc(), revision = slot().revision
  const params = { requestId: rid(), slotId, action: 'accept' as const, expectedRevision: revision, changes: refs(proposal).reverse() }
  const result = service.resolve(params)
  expect(result.revision).toBe(revision + 1)
  expect(result.proposals[0]).toMatchObject({ status: 'resolved' })
  expect(slot().writer).toMatchObject({ actor: 'user' })
  expect(doc()).toMatchObject({ durationS: 3, objects: [{ id: 'bench', name: 'Moved', createdBy: 'agent', userTouched: true }], views: [{ name: 'Closer', userTouched: true }] })
  expect(() => assertAgentSceneWrites(canvas.get({}).nodes, [{ op: 'scene.set', slotId, expectedRevision: slot().revision, doc: before }])).toThrowError(error('scene.object_protected'))
  expect(service.resolve(params)).toEqual(result)
  canvas.undo({ requestId: rid() })
  expect(doc()).toEqual(before)
  expect(service.resolve(params)).toEqual(result)
  expect(doc()).toEqual(before)
  expect(canvas.history({ slotId, limit: 10 }).versions).toHaveLength(4)
})

it('rejects as metadata only, permits dismissing stale changes, and refuses repeated resolutions', () => {
  const proposal = propose([update(), update('chair')]), revision = slot().revision
  write({ ...doc(), objects: doc().objects.filter(item => item.id !== 'chair') })
  const params = { requestId: rid(), slotId, action: 'reject' as const, changes: refs(proposal) }
  const result = service.resolve(params)
  expect(slot().revision).toBe(revision + 1)
  expect(result).not.toHaveProperty('revision')
  expect(result.proposals[0]!.changes.map(change => change.status)).toEqual(['rejected', 'rejected'])
  expect(service.resolve(params)).toEqual(result)
  expect(() => service.resolve({ ...params, requestId: rid() })).toThrowError(error('scene.change_not_pending'))
})

it('rolls back all state, events and document on revision conflicts and invalid subsets', () => {
  write({ ...doc(), durationS: 5, objects: [{ ...object(), tracks: { hidden: [{ t: 5, value: false }] } }, object('chair')] })
  const proposal = propose([{ target: 'object', id: 'bench', action: 'update', item: { ...objectContent(object()), name: 'Static' } }, { target: 'duration', durationS: null }])
  const before = doc(), seq = currentSeq(db)
  const params = { requestId: rid(), slotId, action: 'accept' as const, expectedRevision: slot().revision, changes: [refs(proposal)[1]!] }
  expect(() => service.resolve({ ...params, expectedRevision: 0 })).toThrowError(expect.objectContaining({ code: 'revision_conflict' }))
  expect(() => service.resolve(params)).toThrowError(error('scene.change_invalid'))
  expect(doc()).toEqual(before)
  expect(stored(proposal.proposalId)).toEqual(proposal)
  expect(currentSeq(db)).toBe(seq)
  service.resolve({ ...params, requestId: rid(), changes: refs(proposal) })
  expect(doc()).not.toHaveProperty('durationS')
  expect(doc().objects[0]).not.toHaveProperty('tracks')
})

it('validates combined selections across proposals against the current document', () => {
  write({ ...doc(), durationS: 5 })
  const duration = propose([{ target: 'duration', durationS: 2 }])
  const motion = propose([{ target: 'object', id: 'bench', action: 'update', item: { ...objectContent(object()), tracks: { hidden: [{ t: 4, value: true }] } } }])
  const params = { requestId: rid(), slotId, action: 'accept' as const, expectedRevision: slot().revision, changes: [...refs(motion), ...refs(duration)] }
  expect(() => service.resolve(params)).toThrowError(error('scene.change_invalid'))
  expect(stored(duration.proposalId)).toEqual(duration)
  expect(stored(motion.proposalId)).toEqual(motion)
  expect(service.resolve({ ...params, changes: refs(motion) }).proposals[0]!.status).toBe('resolved')
})


it('refuses missing or non-model assets at propose time without storing or superseding anything', () => {
  const pending = propose()
  db.insert(s.blobs).values({ hash: 'blob', byteSize: 0, createdAt: 1 }).run()
  db.insert(s.assets).values({ id: 'image', kind: 'image', origin: 'import', createdAt: 1 }).run()
  db.insert(s.assetVersions).values({ id: 'image-version', assetId: 'image', version: 1, blobHash: 'blob', mime: 'image/png', createdAt: 1 }).run()
  const before = doc(), seq = currentSeq(db)
  for (const [assetVersionId, reason] of [['missing', 'canvas.asset_version_not_found'], ['image-version', 'scene.model_required']]) {
    expect(() => propose([{ target: 'object', id: 'bench', action: 'update', item: { ...objectContent(object()), source: { type: 'model', assetVersionId: assetVersionId! } } }])).toThrowError(error(reason!))
  }
  expect(doc()).toEqual(before)
  expect(service.list({ status: 'all' }).proposals).toEqual([pending])
  expect(currentSeq(db)).toBe(seq)
})

it('propagates unexpected scene reads and rolls back the canvas mutation instead of staling proposals', () => {
  const proposal = propose(), seq = currentSeq(db)
  const prepare = db.$client.prepare.bind(db.$client)
  const failure = vi.spyOn(db.$client, 'prepare').mockImplementation(sql => {
    if (sql.startsWith('select ') && sql.includes('slot_revisions')) throw new Error('Injected scene read failure')
    return prepare(sql)
  })
  try {
    expect(() => db.transaction(tx => {
      tx.update(s.nodes).set({ title: 'Must roll back' }).where(eq(s.nodes.id, nodeId)).run()
      refreshSceneProposals(tx, 1)
    })).toThrow()
  } finally { failure.mockRestore() }
  expect(stored(proposal.proposalId)).toEqual(proposal)
  expect(canvas.get({ nodeIds: [nodeId] }).nodes[0]!.title).not.toBe('Must roll back')
  expect(currentSeq(db)).toBe(seq)
})

it('propagates corrupt live scene documents without committing stale states', () => {
  const proposal = propose(), original = doc()
  expect(() => db.transaction(tx => {
    tx.update(s.slotRevisions).set({ sceneDoc: { ...original, version: 2 } as unknown as SceneDoc }).where(eq(s.slotRevisions.slotId, slotId)).run()
    refreshSceneProposals(tx, 1)
  })).toThrow()
  expect(doc()).toEqual(original)
  expect(stored(proposal.proposalId)).toEqual(proposal)
})

it('reports superseded changes as not pending even after their source content changes', () => {
  const superseded = propose()
  propose([update('bench', 'Replacement')])
  write({ ...doc(), objects: doc().objects.map(item => ({ ...item, name: 'Author edit' })) })
  expect(() => service.resolve({ requestId: rid(), slotId, action: 'accept', expectedRevision: slot().revision, changes: refs(superseded) })).toThrowError(error('scene.change_not_pending'))
})

it('loads and parses one source per slot for refresh and uses an index for open proposals', () => {
  propose([update()])
  propose([update('chair')])
  propose([{ target: 'duration', durationS: 3 }])
  const queries = vi.spyOn(db.$client, 'prepare')
  const parsed = vi.spyOn(SceneDoc, 'parse')
  try {
    db.transaction(tx => refreshSceneProposals(tx, 1))
    expect(queries.mock.calls.filter(([sql]) => sql.startsWith('select ') && sql.includes('slot_revisions'))).toHaveLength(1)
    expect(parsed).toHaveBeenCalledTimes(1)
  } finally { queries.mockRestore(); parsed.mockRestore() }
  const plan = db.$client.prepare("EXPLAIN QUERY PLAN SELECT * FROM scene_proposals WHERE status = 'open'").all() as { detail: string }[]
  expect(plan.some(row => row.detail.includes('scene_proposals_status_slot'))).toBe(true)
})

it('uses joined node IDs in lists and one known node ID for multi-proposal resolution', () => {
  const first = propose(), second = propose([update('chair')])
  const queries = vi.spyOn(db.$client, 'prepare')
  try {
    expect(service.list({ status: 'open' }).proposals.map(proposal => proposal.nodeId)).toEqual([nodeId, nodeId])
    expect(queries.mock.calls.filter(([sql]) => sql.startsWith('select '))).toHaveLength(1)
    queries.mockClear()
    const result = service.resolve({ requestId: rid(), slotId, action: 'accept', expectedRevision: slot().revision, changes: [...refs(first), ...refs(second)] })
    expect(result.proposals.map(proposal => proposal.nodeId)).toEqual([nodeId, nodeId])
    // Canvas application reads the owner once; rendering proposal views adds no slot lookups.
    expect(queries.mock.calls.filter(([sql]) => sql.startsWith('select "node_id" from "slots"'))).toHaveLength(1)
  } finally { queries.mockRestore() }
})

it('refreshes all review mechanisms on scene accept and emits one scene event per affected row', () => {
  const textId = canvas.apply({ kind: 'user' }, { requestId: rid(), ops: [{ op: 'node.create', tempId: 'book', kind: 'text', content: { text: 'Original sentence' } }] }).idMap.book!
  const textSlot = canvas.get({ nodeIds: [textId] }).nodes[0]!.slots[0]!
  const textService = createTextProposalService(db)
  const textProposal = textService.propose({ requestId: rid(), slotId: textSlot.slotId, baseRevision: 1, summary: 'Rewrite', edits: [{ find: 'Original', replace: 'Revised' }] }, 'session')
  db.insert(s.transcriptEntries).values({ sessionId: 'session', itemId: 'expired', revision: 1, createdSeq: 1, kind: 'approval', createdAt: 1, updatedAt: 1,
    payload: { approvalId: 'expired', kind: 'text_delete', summary: 'Delete', detail: '', status: 'pending', textDelete: { nodeId: textId, slotId: textSlot.slotId, revision: 1, title: 'Book', expiresAt: 0 } } }).run()
  const proposal = propose([update(), update('chair')])
  // Seed missed historical refreshes so acceptance must both update and stale the same proposal row.
  db.transaction(tx => applyOps(tx, { kind: 'user' }, { requestId: rid(), ops: [
    { op: 'slot.setText', slotId: textSlot.slotId, expectedRevision: 1, body: 'Different sentence' },
    { op: 'scene.set', slotId, expectedRevision: slot().revision, doc: { ...doc(), objects: doc().objects.map(item => item.id === 'chair' ? { ...item, name: 'Already changed' } : item) } },
  ] }, 1))
  const seq = currentSeq(db)
  const result = service.resolve({ requestId: rid(), slotId, action: 'accept', expectedRevision: slot().revision, changes: [refs(proposal)[0]!] })
  expect(result.proposals[0]!.changes.map(change => change.status)).toEqual(['accepted', 'stale'])
  expect(readEventsAfter(db, seq).filter(event => event.type === 'scene.proposalChanged' && event.entityId === proposal.proposalId)).toHaveLength(1)
  expect(textService.list({ status: 'all' }).proposals.find(row => row.proposalId === textProposal.proposalId)!.edits[0]!.status).toBe('stale')
  expect(db.select().from(s.transcriptEntries).where(eq(s.transcriptEntries.itemId, 'expired')).get()!.payload).toMatchObject({ status: 'expired' })
})
