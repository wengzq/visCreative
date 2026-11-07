import { afterEach, beforeEach, expect, it } from 'vitest'
import { createCanvasService } from '@vis/canvas-core'
import { currentSeq, eq, openSpaceDb, readEventsAfter, spaceSchema as s, type SpaceDb } from '@vis/storage'
import { createTextProposalService, refreshTextProposals } from './text-proposals'

let db: SpaceDb
let canvas: ReturnType<typeof createCanvasService>
let service: ReturnType<typeof createTextProposalService>
let slotId: string
const original = '# 第一章\n\n清晨有雾。林舟回家。河水很静。'
const rid = () => crypto.randomUUID()
const slot = () => canvas.get({}).nodes[0]!.slots[0]!
const write = (body: string) => canvas.apply({ kind: 'user' }, { requestId: rid(), ops: [{ op: 'slot.setText', slotId, expectedRevision: slot().revision, body }] })
const propose = (edits = [{ find: '清晨有雾', replace: '薄雾笼罩清晨' }, { find: '林舟回家', replace: '林舟走向河岸' }]) => service.propose({ requestId: rid(), slotId, baseRevision: slot().revision, summary: 'Clarify the scene', edits }, 'session')
const refs = (proposal: ReturnType<typeof propose>) => proposal.edits.map(edit => ({ proposalId: proposal.proposalId, editId: edit.editId }))

beforeEach(() => {
  db = openSpaceDb(':memory:')
  db.insert(s.sessions).values({ id: 'session', agentKind: 'codex', title: 'Writer', createdAt: 1 }).run()
  canvas = createCanvasService({ db, onChanged: tx => refreshTextProposals(tx, 1) })
  service = createTextProposalService(db)
  canvas.apply({ kind: 'user' }, { requestId: rid(), ops: [{ op: 'node.create', tempId: 'book', kind: 'text', format: 'markdown', content: { text: original } }] })
  slotId = slot().slotId
})
afterEach(() => db.$client.close())

it('stores proposals without changing text, deduplicates retries and emits ordered events', () => {
  const params = { requestId: rid(), slotId, baseRevision: 1, summary: 'A clearer opening', edits: [{ find: '清晨有雾', replace: '晨雾弥漫' }] }
  const seq = currentSeq(db)
  const result = service.propose(params, 'session')
  expect(service.propose(params, 'session')).toEqual(result)
  expect(slot().content).toEqual({ type: 'text', body: original })
  expect(service.list({ status: 'open' }).proposals).toEqual([result])
  const events = readEventsAfter(db, seq)
  expect(events).toHaveLength(1)
  expect(events[0]).toMatchObject({ type: 'text.proposalChanged', payload: { proposalId: result.proposalId, slotId } })
})

it('rejects missing, overlapping and repeated anchors, but allows context to identify one repeated quote', () => {
  write('雾。浓雾。')
  expect(() => propose([{ find: '雾', replace: '风' }])).toThrowError(expect.objectContaining({ details: { reason: 'writing.anchor_not_unique', params: { index: 0 } } }))
  expect(() => propose([{ find: '雨', replace: '风' }])).toThrowError(expect.objectContaining({ code: 'invalid_params' }))
  const contextual = service.propose({ requestId: rid(), slotId, baseRevision: slot().revision, summary: 'Context', edits: [{ find: '雾', before: '浓', after: '。', replace: '云' }] }, 'session')
  expect(contextual.edits[0]!.status).toBe('pending')
  expect(() => propose([{ find: '浓雾', replace: '风' }, { find: '雾。', replace: '云' }])).toThrowError(expect.objectContaining({ code: 'invalid_params' }))
  expect(service.list({ status: 'all' }).proposals).toHaveLength(1)
})

it('accepts and rejects individual edits atomically as user writes, with history and undo', () => {
  const proposal = propose()
  const selected = refs(proposal)
  const params = { requestId: rid(), slotId, action: 'accept' as const, expectedRevision: 1, body: original.replace('清晨有雾', '薄雾笼罩清晨'), edits: [selected[0]!] }
  const accepted = service.resolve(params)
  expect(service.resolve(params)).toEqual(accepted)
  expect(slot()).toMatchObject({ revision: 2, writer: { actor: 'user' }, content: { type: 'text', body: params.body } })
  expect(accepted.proposals[0]!.edits.map(edit => edit.status)).toEqual(['accepted', 'pending'])
  const rejected = service.resolve({ requestId: rid(), slotId, action: 'reject', edits: [selected[1]!] })
  expect(rejected.proposals[0]).toMatchObject({ status: 'resolved' })
  expect(rejected.proposals[0]!.edits.map(edit => edit.status)).toEqual(['accepted', 'rejected'])
  expect(canvas.history({ slotId, limit: 10 }).versions.map(version => version.revision)).toEqual([2, 1])
  canvas.undo({ requestId: rid() })
  expect(slot().content).toEqual({ type: 'text', body: original })
})

it('accepts a batch in one revision and rejects a batch without a content revision', () => {
  const proposal = propose()
  service.resolve({ requestId: rid(), slotId, action: 'accept', expectedRevision: 1, body: original.replace('清晨有雾', '薄雾笼罩清晨').replace('林舟回家', '林舟走向河岸'), edits: refs(proposal) })
  expect(slot().revision).toBe(2)
  expect(service.list({ status: 'resolved' }).proposals[0]!.edits.map(edit => edit.status)).toEqual(['accepted', 'accepted'])
  const second = propose([{ find: '河水很静', replace: '河面泛起涟漪' }])
  service.resolve({ requestId: rid(), slotId, action: 'reject', edits: refs(second) })
  expect(slot().revision).toBe(2)
})

it('retains unique anchors after unrelated movement and permanently stales changed anchors, including after undo', () => {
  const proposal = propose()
  write('序言\n' + original)
  expect(service.list({ status: 'open' }).proposals[0]!.edits.map(edit => edit.status)).toEqual(['pending', 'pending'])
  write('序言\n' + original.replace('清晨有雾', '清晨无雾'))
  expect(service.list({ status: 'open' }).proposals[0]!.edits.map(edit => edit.status)).toEqual(['stale', 'pending'])
  const before = currentSeq(db)
  expect(() => service.resolve({ requestId: rid(), slotId, action: 'accept', expectedRevision: slot().revision, body: 'Should never apply', edits: [refs(proposal)[0]!] })).toThrowError(expect.objectContaining({ details: { reason: 'writing.edit_stale', params: {} } }))
  expect(currentSeq(db)).toBe(before)
  canvas.undo({ requestId: rid() })
  expect(slot().content).toEqual({ type: 'text', body: '序言\n' + original })
  expect(service.list({ status: 'open' }).proposals[0]!.edits[0]!.status).toBe('stale')
})

it('rolls back every edit state, event and revision on conflicts or a mismatched draft', () => {
  const proposal = propose()
  const params = { requestId: rid(), slotId, action: 'accept' as const, expectedRevision: 0, body: 'Wrong', edits: refs(proposal) }
  const before = currentSeq(db)
  expect(() => service.resolve(params)).toThrowError(expect.objectContaining({ code: 'revision_conflict' }))
  expect(() => service.resolve({ ...params, expectedRevision: 1 })).toThrowError(expect.objectContaining({ details: { reason: 'writing.draft_mismatch', params: {} } }))
  expect(service.list({ status: 'open' }).proposals).toEqual([proposal])
  expect(currentSeq(db)).toBe(before)
  expect(slot().revision).toBe(1)
  expect(db.select().from(s.idempotencyKeys).where(eq(s.idempotencyKeys.requestId, params.requestId)).get()).toBeUndefined()
})
