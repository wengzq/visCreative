import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CanvasOp, type CanvasOp as Op, type MethodParams, type NodeKind } from '@vis/protocol'
import { openSpaceDb, readEventsAfter, spaceSchema as s, type SpaceDb } from '@vis/storage'
import { createCanvasService, type CanvasService } from './service'

const user = { kind: 'user' } as const
const agent = { kind: 'agent', sessionId: 'session' } as const
const now = 1_800_000_000_000
const generation = { provider: 'ark', model: 'image-model', params: { ratio: '16:9', nested: { quality: 2 } } }
let db: SpaceDb
let canvas: CanvasService
let request = 0

beforeEach(() => {
  db = openSpaceDb(':memory:')
  canvas = createCanvasService({ db, now: () => now })
  db.insert(s.sessions).values({ id: agent.sessionId, agentKind: 'codex', title: '', createdAt: now }).run()
})
afterEach(() => db.$client.close())

const rid = () => `generation_${++request}`
const apply = (...ops: Op[]) => canvas.apply(user, { requestId: rid(), ops })
const node = (nodeId: string) => canvas.get({ nodeIds: [nodeId] }).nodes[0]!
const create = (tempId: string, kind: NodeKind = 'image'): Extract<Op, { op: 'node.create' }> =>
  ({ op: 'node.create', tempId, kind, x: 0, y: 0, w: 320, h: 200 })
const undo = () => canvas.undo({ requestId: rid() })
const redo = () => canvas.redo({ requestId: rid() })

describe('Node generation settings', () => {
  it('The protocol preserves optional generation settings and reset operations with omitted settings, and validates field types', () => {
    expect(CanvasOp.parse({ ...create('n'), generation })).toHaveProperty('generation', generation)
    expect(CanvasOp.parse({ op: 'node.setGeneration', nodeId: 'node', generation: { params: {} } })).toHaveProperty('generation', { params: {} })
    expect(CanvasOp.parse({ op: 'node.setGeneration', nodeId: 'node' })).not.toHaveProperty('generation')
    expect(CanvasOp.parse({ op: 'node.setGeneration', nodeId: 'node', onlyIfUnset: true })).toHaveProperty('onlyIfUnset', true)
    expect(CanvasOp.safeParse({ op: 'node.setGeneration', nodeId: 'node', onlyIfUnset: 'true' }).success).toBe(false)
    for (const value of [null, { provider: 1 }, { model: false }, { params: [] }]) {
      expect(CanvasOp.safeParse({ ...create('n'), generation: value }).success).toBe(false)
    }
  })

  it.each(['image', 'video', 'audio', 'text'] as const)('Creating a %s node saves settings; node.created includes the full view', kind => {
    const result = apply({ ...create('n', kind), generation })
    const created = node(result.idMap.n!)
    expect(created).toMatchObject({ generation, layoutRevision: 1 })
    expect(readEventsAfter(db, 0)[0]!.payload).toEqual(created)
    undo()
    expect(canvas.get({}).nodes).toEqual([])
    redo()
    expect(node(created.nodeId)).toEqual(created)
  })

  it('Resolve tempId within the batch; replace settings wholesale instead of merging; retries do not duplicate writes', () => {
    const result = apply({ ...create('n'), generation }, { op: 'node.setGeneration', nodeId: 'n', generation: { model: 'other' } })
    const nodeId = result.idMap.n!
    expect(node(nodeId)).toMatchObject({ generation: { model: 'other' }, layoutRevision: 2 })
    expect(node(nodeId).generation).toEqual({ model: 'other' })
    expect(node(nodeId).slots[0]!.revision).toBe(0)
    const events = readEventsAfter(db, 0)
    expect(events.map(event => event.type)).toEqual(['node.created', 'node.updated'])
    expect(events[1]!.payload).toEqual(node(nodeId))
    const params: MethodParams<'canvas.apply'> = { requestId: rid(), ops: [{ op: 'node.setGeneration', nodeId, generation: { params: {} } }] }
    const replaced = canvas.apply(user, params)
    expect(canvas.apply(user, params)).toEqual(replaced)
    expect(node(nodeId)).toMatchObject({ generation: { params: {} }, layoutRevision: 3 })
    expect(readEventsAfter(db, replaced.eventSeq)).toEqual([])
  })

  it('Omitting generation resets settings; repeated undo and redo restore all settings; Agent settings remain last-write-wins', () => {
    const nodeId = canvas.apply(agent, { requestId: rid(), ops: [create('n')] }).idMap.n!
    apply({ op: 'node.setGeneration', nodeId, generation })
    apply({ op: 'node.setGeneration', nodeId })
    expect(node(nodeId)).not.toHaveProperty('generation')
    undo()
    expect(node(nodeId).generation).toEqual(generation)
    undo()
    expect(node(nodeId)).not.toHaveProperty('generation')
    redo()
    expect(node(nodeId).generation).toEqual(generation)
    canvas.apply(agent, { requestId: rid(), ops: [{ op: 'node.setGeneration', nodeId, generation: { provider: 'other' } }] })
    redo()
    expect(node(nodeId)).not.toHaveProperty('generation')
    undo()
    expect(node(nodeId).generation).toEqual({ provider: 'other' })
    expect(node(nodeId).slots[0]!.revision).toBe(0)
    expect(readEventsAfter(db, 0).slice(1).every(event => event.type === 'node.updated')).toBe(true)
    expect(readEventsAfter(db, 0).at(-1)!.payload).toEqual(node(nodeId))
  })

  it('Evaluate migration conditions within the transaction, preserving settings, history, and events written by users after the scan', () => {
    const nodeId = canvas.apply(agent, { requestId: rid(), ops: [create('n')] }).idMap.n!
    expect(node(nodeId)).not.toHaveProperty('generation')
    apply({ op: 'node.setGeneration', nodeId, generation })
    const before = node(nodeId)
    const history = db.select().from(s.undoEntries).all()
    const events = readEventsAfter(db, 0)
    apply({ op: 'node.setGeneration', nodeId, generation: { provider: 'legacy' }, onlyIfUnset: true })
    expect(node(nodeId)).toEqual(before)
    expect(db.select().from(s.undoEntries).all()).toEqual(history)
    expect(readEventsAfter(db, 0)).toEqual(events)
    undo()
    expect(node(nodeId)).not.toHaveProperty('generation')
    redo()
    expect(node(nodeId).generation).toEqual(generation)
  })

  it('Conditional writes to unset settings still support undo and redo; skipping configured nodes does not clear the redo stack', () => {
    const nodeId = canvas.apply(agent, { requestId: rid(), ops: [create('n')] }).idMap.n!
    apply({ op: 'node.setGeneration', nodeId, generation: {}, onlyIfUnset: true })
    expect(node(nodeId)).toMatchObject({ generation: {}, layoutRevision: 2 })
    expect(readEventsAfter(db, 0).at(-1)!.payload).toEqual(node(nodeId))
    undo()
    expect(node(nodeId)).not.toHaveProperty('generation')
    redo()
    expect(node(nodeId).generation).toEqual({})
    apply({ op: 'node.setGeneration', nodeId, generation })
    undo()
    const history = db.select().from(s.undoEntries).all()
    apply({ op: 'node.setGeneration', nodeId, generation: { provider: 'legacy' }, onlyIfUnset: true })
    expect(db.select().from(s.undoEntries).all()).toEqual(history)
    redo()
    expect(node(nodeId).generation).toEqual(generation)
  })

  it('Reject writes to missing or deleted nodes and roll back the entire batch without leaving settings or events', () => {
    const nodeId = apply({ ...create('n'), generation }).idMap.n!
    apply({ op: 'node.delete', nodeId })
    const events = readEventsAfter(db, 0)
    for (const id of ['missing', nodeId]) {
      expect(() => apply(create('temporary'), { op: 'node.setGeneration', nodeId: id, generation: {} })).toThrow(expect.objectContaining({ code: 'not_found' }))
    }
    expect(canvas.get({}).nodes).toEqual([])
    expect(readEventsAfter(db, 0)).toEqual(events)
    undo()
    expect(node(nodeId).generation).toEqual(generation)
  })

  it('Turn snapshots expose current settings while slot content uses fixed revisions and remains readable after node deletion', () => {
    const nodeId = apply({ ...create('n'), prompt: '初稿', generation }).idMap.n!
    const prompt = node(nodeId).slots.find(slot => slot.slotKey === 'prompt')!
    db.insert(s.messages).values({ id: 'message', sessionId: agent.sessionId, text: '', deliveryState: 'submitted', createdAt: now }).run()
    db.insert(s.turns).values({ id: 'turn', sessionId: agent.sessionId, messageId: 'message', status: 'running' }).run()
    db.insert(s.inputSnapshots).values({ id: 'snapshot', turnId: 'turn', createdAt: now }).run()
    db.insert(s.snapshotItems).values({ snapshotId: 'snapshot', ordinal: 0, nodeId, slotId: prompt.slotId, slotRevision: 1 }).run()
    apply({ op: 'node.setGeneration', nodeId, generation: { model: 'current' } }, { op: 'slot.setText', slotId: prompt.slotId, body: '修改后', expectedRevision: 1 })
    apply({ op: 'node.delete', nodeId })
    const snapshot = canvas.get({ snapshot: 'turn' }, { inputSnapshotId: 'snapshot' }).nodes[0]!
    expect(snapshot).toMatchObject({ generation: { model: 'current' }, layoutRevision: 2, slots: [{ revision: 1, content: { body: '初稿' } }] })
  })
})
