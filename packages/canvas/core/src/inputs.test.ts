import { beforeEach, describe, expect, it } from 'vitest'
import type { CanvasOp, MethodParams, NodeKind } from '@vis/protocol'
import { eq, openSpaceDb, readEventsAfter, spaceSchema as s, type SpaceDb } from '@vis/storage'
import { createCanvasService, type CanvasService } from './service'

const user = { kind: 'user' } as const
let db: SpaceDb
let canvas: CanvasService
let request = 0
const now = 1_800_000_000_000

beforeEach(() => {
  db = openSpaceDb(':memory:')
  canvas = createCanvasService({ db, now: () => now })
})

const apply = (...ops: CanvasOp[]) => canvas.apply(user, { requestId: `inputs_${++request}`, ops })
const create = (tempId: string, kind: NodeKind = 'image', prompt?: string): Extract<CanvasOp, { op: 'node.create' }> =>
  ({ op: 'node.create', tempId, kind, x: 0, y: 0, w: 320, h: 200, ...(prompt !== undefined ? { prompt } : {}) })

describe('Node reference inputs', () => {
  it.each(['image', 'video', 'audio'] as const)('%s creation and full replacement resolve tempId on both sides, deduplicate in order, exclude self, and emit full views', kind => {
    const result = apply(
      create('a', 'text'),
      create('b', 'audio'),
      { ...create('target', kind, ''), inputNodeIds: ['b', 'a', 'b', 'target'] },
      { op: 'node.setInputs', nodeId: 'target', inputNodeIds: ['a', 'target', 'a'] },
    )
    const node = canvas.get({ nodeIds: [result.idMap.target!] }).nodes[0]!
    expect(node).toMatchObject({ inputs: [result.idMap.a], layoutRevision: 2 })
    expect(node.slots.map(slot => slot.revision)).toEqual([0, 1])
    expect(db.select().from(s.nodeInputs).all()).toEqual([{ nodeId: node.nodeId, ordinal: 0, inputNodeId: result.idMap.a }])
    const events = readEventsAfter(db, 0)
    expect(events.map(event => event.type)).toEqual(['node.created', 'node.created', 'node.created', 'node.updated'])
    expect(events[2]!.payload).toEqual({ ...node, layoutRevision: 1, inputs: [result.idMap.b, result.idMap.a] })
    expect(events[3]!.payload).toEqual(node)
    expect(result.eventSeq).toBe(events[3]!.seq)
  })

  it('Clearing by full replacement omits inputs; retries do not increment revisions again', () => {
    const { idMap } = apply(create('a', 'text'), create('target', 'image', ''))
    apply({ op: 'node.setInputs', nodeId: idMap.target!, inputNodeIds: [idMap.a!] })
    const params: MethodParams<'canvas.apply'> = { requestId: 'clear', ops: [{ op: 'node.setInputs', nodeId: idMap.target!, inputNodeIds: [] }] }
    const result = canvas.apply(user, params)
    expect(canvas.apply(user, params)).toEqual(result)
    const node = canvas.get({ nodeIds: [idMap.target!] }).nodes[0]!
    expect(node.layoutRevision).toBe(3)
    expect(node).not.toHaveProperty('inputs')
    expect(readEventsAfter(db, result.eventSeq - 1)[0]!.payload).toEqual(node)
    expect(db.select().from(s.nodeInputs).all()).toEqual([])
  })

  it.each(['text', 'image', 'video', 'audio'] as const)('%s nodes without a prompt slot can still declare output inputs', kind => {
    const { idMap } = apply(create('target', kind))
    const result = apply(create('a'), { op: 'node.setInputs', nodeId: idMap.target!, inputNodeIds: ['a'] })
    expect(canvas.get({}).nodes).toHaveLength(2)
    expect(canvas.get({ nodeIds: [idMap.target!] }).nodes[0]).toMatchObject({ layoutRevision: 2, inputs: [result.idMap.a] })
    expect(readEventsAfter(db, 0)).toHaveLength(3)
  })

  it('An empty input list at creation does not require prompt, but text nodes still cannot have prompt', () => {
    apply({ ...create('target'), inputNodeIds: [] })
    expect(canvas.get({}).nodes).toHaveLength(1)
    expect(() => apply({ ...create('target', 'text', ''), inputNodeIds: [] })).toThrow(expect.objectContaining({ code: 'invalid_params' }))
    expect(canvas.get({}).nodes).toHaveLength(1)
  })

  it('Missing or deleted inputs and targets return not_found, preserving original inputs and events', () => {
    const { idMap } = apply(create('a'), create('b'), create('target', 'image', ''))
    apply({ op: 'node.setInputs', nodeId: idMap.target!, inputNodeIds: [idMap.a!] })
    apply({ op: 'node.delete', nodeId: idMap.b! })
    const before = canvas.get({}).nodes
    const events = readEventsAfter(db, 0)
    for (const inputNodeId of ['missing', idMap.b!]) {
      expect(() => apply({ op: 'node.setInputs', nodeId: idMap.target!, inputNodeIds: [inputNodeId] })).toThrow(expect.objectContaining({ code: 'not_found' }))
      expect(() => apply({ ...create('invalid', 'video', ''), inputNodeIds: [inputNodeId] })).toThrow(expect.objectContaining({ code: 'not_found' }))
    }
    for (const nodeId of ['missing', idMap.b!]) {
      expect(() => apply({ op: 'node.setInputs', nodeId, inputNodeIds: [] })).toThrow(expect.objectContaining({ code: 'not_found' }))
    }
    expect(canvas.get({}).nodes).toEqual(before)
    expect(readEventsAfter(db, 0)).toEqual(events)
  })

  it('Current and turn snapshot views filter deleted inputs; snapshots retain content revisions and deleted targets', () => {
    const { idMap } = apply(create('a'), create('b'), create('target', 'image', '初稿'))
    const nodeId = idMap.target!
    const prompt = canvas.get({ nodeIds: [nodeId] }).nodes[0]!.slots.find(slot => slot.slotKey === 'prompt')!
    db.insert(s.sessions).values({ id: 'session', agentKind: 'claude', title: '', createdAt: now }).run()
    db.insert(s.messages).values({ id: 'message', sessionId: 'session', text: '', deliveryState: 'submitted', createdAt: now }).run()
    db.insert(s.turns).values({ id: 'turn', sessionId: 'session', messageId: 'message', status: 'running' }).run()
    db.insert(s.inputSnapshots).values({ id: 'snapshot', turnId: 'turn', createdAt: now }).run()
    db.insert(s.snapshotItems).values({ snapshotId: 'snapshot', ordinal: 0, nodeId, slotId: prompt.slotId, slotRevision: 1 }).run()
    apply(
      { op: 'node.setInputs', nodeId, inputNodeIds: [idMap.b!, idMap.a!] },
      { op: 'slot.setText', slotId: prompt.slotId, body: '修改后', expectedRevision: 1 },
    )
    const snapshot = () => canvas.get({ snapshot: 'turn' }, { inputSnapshotId: 'snapshot' }).nodes[0]!
    expect(snapshot().inputs).toEqual([idMap.b, idMap.a])
    apply({ op: 'node.delete', nodeId: idMap.b! })
    expect(canvas.get({ nodeIds: [nodeId] }).nodes[0]!.inputs).toEqual([idMap.a])
    expect(snapshot()).toMatchObject({ layoutRevision: 2, inputs: [idMap.a], slots: [{ revision: 1, content: { body: '初稿' } }] })
    expect(db.select().from(s.nodeInputs).where(eq(s.nodeInputs.nodeId, nodeId)).all()).toHaveLength(2)
    apply({ op: 'node.delete', nodeId: idMap.a! }, { op: 'node.delete', nodeId })
    expect(canvas.get({ nodeIds: [nodeId] }).nodes).toEqual([])
    expect(snapshot()).not.toHaveProperty('inputs')
  })
})
