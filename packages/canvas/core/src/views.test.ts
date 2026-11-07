import { afterEach, beforeEach, expect, it } from 'vitest'
import { openSpaceDb, readEventsAfter, spaceSchema as s, type SpaceDb } from '@vis/storage'
import { createCanvasService, type CanvasService } from './service'

const user = { kind: 'user' } as const
const agent = { kind: 'agent', sessionId: 'session' } as const
let db: SpaceDb
let canvas: CanvasService
beforeEach(() => {
  db = openSpaceDb(':memory:')
  canvas = createCanvasService({ db })
  db.insert(s.sessions).values({ id: agent.sessionId, agentKind: 'codex', title: 'Editor assistant', createdAt: 1 }).run()
})
afterEach(() => db.$client.close())

it('joins the current slot writer into reads and node and slot events', () => {
  canvas.apply(user, { requestId: 'create', ops: [{ op: 'node.create', tempId: 'note', kind: 'text', content: { text: 'First draft' } }] })
  const node = canvas.get({}).nodes[0]!
  const slot = node.slots[0]!
  expect(slot.writer).toEqual({ actor: 'user' })
  expect(readEventsAfter(db, 0).at(-1)?.payload).toMatchObject({ slots: [{ writer: { actor: 'user' } }] })
  canvas.apply(agent, { requestId: 'agent-edit', ops: [{ op: 'slot.setText', slotId: slot.slotId, expectedRevision: 1, body: 'Agent edit' }, { op: 'node.setMeta', nodeId: node.nodeId, title: 'Revised' }] })
  expect(canvas.get({}).nodes[0]?.slots[0]?.writer).toEqual({ actor: 'agent', sessionId: agent.sessionId })
  const events = readEventsAfter(db, 0)
  expect(events.find(event => event.type === 'slot.revised')?.payload).toMatchObject({ slot: { writer: { actor: 'agent', sessionId: agent.sessionId } } })
  expect(events.at(-1)?.payload).toMatchObject({ slots: [{ writer: { actor: 'agent', sessionId: agent.sessionId } }] })
  canvas.apply(user, { requestId: 'user-edit', ops: [{ op: 'slot.setText', slotId: slot.slotId, expectedRevision: 2, body: 'User edit' }] })
  expect(canvas.get({}).nodes[0]?.slots[0]?.writer).toEqual({ actor: 'user' })
})

it('keeps the writer pinned to a turn snapshot revision after later edits', () => {
  const { idMap } = canvas.apply(agent, { requestId: 'create', ops: [{ op: 'node.create', tempId: 'note', kind: 'text', content: { text: 'Agent draft' } }] })
  const slot = canvas.get({}).nodes[0]!.slots[0]!
  db.insert(s.messages).values({ id: 'message', sessionId: agent.sessionId, text: '', deliveryState: 'submitted', createdAt: 1 }).run()
  db.insert(s.turns).values({ id: 'turn', sessionId: agent.sessionId, messageId: 'message', status: 'running' }).run()
  db.insert(s.inputSnapshots).values({ id: 'snapshot', turnId: 'turn', createdAt: 1 }).run()
  db.insert(s.snapshotItems).values({ snapshotId: 'snapshot', ordinal: 0, nodeId: idMap.note!, slotId: slot.slotId, slotRevision: 1 }).run()
  canvas.apply(user, { requestId: 'user-edit', ops: [{ op: 'slot.setText', slotId: slot.slotId, expectedRevision: 1, body: 'User draft' }] })
  expect(canvas.get({ snapshot: 'turn' }, { inputSnapshotId: 'snapshot' }).nodes[0]?.slots[0]).toMatchObject({ revision: 1, writer: { actor: 'agent', sessionId: agent.sessionId } })
  expect(canvas.get({}).nodes[0]?.slots[0]?.writer).toEqual({ actor: 'user' })
})

it('retains an actor without a session on legacy agent operations and omits writers on unwritten slots', () => {
  canvas.apply(user, { requestId: 'create', ops: [{ op: 'node.create', tempId: 'unwritten', kind: 'video' }] })
  expect(canvas.get({}).nodes[0]?.slots[0]?.writer).toBeUndefined()
  db.insert(s.operations).values({ id: 'legacy', actorKind: 'agent', createdAt: 1 }).run()
  db.insert(s.nodes).values({ id: 'legacy-node', kind: 'text', x: 0, y: 0, w: 1, h: 1, z: 2, createdAt: 1 }).run()
  db.insert(s.slots).values({ id: 'legacy-slot', nodeId: 'legacy-node', slotKey: 'main', contentType: 'text', currentRevision: 1 }).run()
  db.insert(s.slotRevisions).values({ slotId: 'legacy-slot', revision: 1, textBody: 'Legacy draft', operationId: 'legacy', createdAt: 1 }).run()
  expect(canvas.get({ nodeIds: ['legacy-node'] }).nodes[0]?.slots[0]?.writer).toEqual({ actor: 'agent' })
})
