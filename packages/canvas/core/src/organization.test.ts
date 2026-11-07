import { beforeEach, expect, it } from 'vitest'
import { eq, openSpaceDb, readEventsAfter, spaceSchema as s, type SpaceDb } from '@vis/storage'
import { createCanvasService, type CanvasService } from './service'

let db: SpaceDb
let canvas: CanvasService
const user = { kind: 'user' } as const
const agent = { kind: 'agent', sessionId: 'agent' } as const
beforeEach(() => {
  db = openSpaceDb(':memory:')
  db.insert(s.sessions).values({ id: 'agent', agentKind: 'codex', title: '', createdAt: 1 }).run()
  canvas = createCanvasService({ db, now: () => 1 })
})

it('Existing data retains default metadata; creation and partial updates support undo and redo and publish full views', () => {
  db.insert(s.nodes).values({ id: 'old', kind: 'text', x: 0, y: 0, w: 10, h: 10, z: 1, createdAt: 1 }).run()
  expect(canvas.get({ nodeIds: ['old'] }).nodes[0]).toMatchObject({ category: null, purpose: 'artifact', format: 'plain' })
  const created = canvas.apply(user, { requestId: 'create', ops: [{ op: 'node.create', tempId: 'n', kind: 'text', category: '分镜', purpose: 'working', format: 'markdown' }] })
  const nodeId = created.idMap.n!
  canvas.apply(user, { requestId: 'meta', ops: [{ op: 'node.setMeta', nodeId, category: null, format: 'code' }] })
  expect(canvas.get({ nodeIds: [nodeId] }).nodes[0]).toMatchObject({ category: null, purpose: 'working', format: 'code' })
  expect(readEventsAfter(db, 0).at(-1)).toMatchObject({ type: 'node.updated', payload: { category: null, purpose: 'working', format: 'code' } })
  canvas.undo({ requestId: 'undo' })
  expect(canvas.get({ nodeIds: [nodeId] }).nodes[0]).toMatchObject({ category: '分镜', purpose: 'working', format: 'markdown' })
  canvas.redo({ requestId: 'redo' })
  expect(canvas.get({ nodeIds: [nodeId] }).nodes[0]).toMatchObject({ category: null, purpose: 'working', format: 'code' })
})

it('Missing coordinates use default dimensions; nodes avoid each other within a batch and return their placement', () => {
  const r = canvas.apply(agent, { requestId: 'create', ops: [
    { op: 'node.create', tempId: 'a', kind: 'text', w: 100 },
    { op: 'node.create', tempId: 'b', kind: 'text' },
  ] })
  expect(r.placements).toEqual({ a: { x: 0, y: 0, w: 100, h: 200 }, b: { x: 180, y: 240, w: 320, h: 200 } })
  expect(canvas.apply(agent, { requestId: 'create', ops: [
    { op: 'node.create', tempId: 'a', kind: 'text', w: 100 }, { op: 'node.create', tempId: 'b', kind: 'text' },
  ] })).toEqual(r)
})

it('Provenance takes precedence over category frames; place to the right of all inputs and avoid occupied space', () => {
  canvas.apply(user, { requestId: 'seed', ops: [
    { op: 'frame.create', tempId: 'f', title: '镜头', x: -1000, y: 0, w: 500, h: 500 },
    { op: 'node.create', tempId: 'a', kind: 'text', x: 0, y: 0, w: 100, h: 100 },
    { op: 'node.create', tempId: 'b', kind: 'text', x: 200, y: 0, w: 100, h: 100 },
    { op: 'node.create', tempId: 'c', kind: 'text', x: 340, y: 0, w: 100, h: 100 },
  ] })
  const nodes = canvas.get({}).nodes.filter(n => n.kind !== 'frame')
  const r = canvas.apply(agent, { requestId: 'result', ops: [{ op: 'node.create', tempId: 'n', kind: 'text', category: '镜头', inputNodeIds: nodes.slice(0, 2).map(n => n.nodeId) }] })
  expect(r.placements?.n).toMatchObject({ x: 340, y: 140 })
  expect(canvas.get({ nodeIds: [r.idMap.n!] }).nodes[0]?.inputs).toEqual(nodes.slice(0, 2).map(n => n.nodeId))
})

it('Place sequentially within category frames; frame expansion preserves members and undo', () => {
  const f = canvas.apply(user, { requestId: 'frame', ops: [{ op: 'frame.create', tempId: 'f', title: '人物', x: 0, y: 0, w: 400, h: 300 }] }).idMap.f!
  const r = canvas.apply(user, { requestId: 'members', ops: [
    { op: 'node.create', tempId: 'a', kind: 'text', category: '人物' },
    { op: 'node.create', tempId: 'b', kind: 'text', category: '人物' },
  ] })
  expect(r.placements).toMatchObject({ a: { x: 40, y: 40 }, b: { x: 40, y: 280 } })
  expect(canvas.get({ nodeIds: [r.idMap.a!, r.idMap.b!] }).nodes.map(n => n.frameId)).toEqual([f, f])
  expect(canvas.get({ nodeIds: [f] }).nodes[0]?.h).toBe(520)
  canvas.undo({ requestId: 'undo' })
  expect(canvas.get({}).nodes).toHaveLength(1)
  expect(canvas.get({}).nodes[0]?.h).toBe(300)
  canvas.redo({ requestId: 'redo' })
  expect(canvas.get({ nodeIds: [r.idMap.b!] }).nodes[0]?.frameId).toBe(f)
})

it('Only move overlapping Agent coordinates; preserve user coordinates and unoccupied Agent coordinates', () => {
  canvas.apply(user, { requestId: 'base', ops: [{ op: 'node.create', tempId: 'n', kind: 'text', x: 0, y: 0 }] })
  const moved = canvas.apply(agent, { requestId: 'agent', ops: [{ op: 'node.create', tempId: 'n', kind: 'text', x: 0, y: 0 }] })
  expect(moved.placements?.n).toMatchObject({ x: 0, y: 240 })
  for (const [requestId, actor, x] of [['user', user, 0], ['free', agent, 1000]] as const) {
    const r = canvas.apply(actor, { requestId, ops: [{ op: 'node.create', tempId: 'n', kind: 'text', x, y: 0 }] })
    expect(r.placements).toEqual({})
    expect(canvas.get({ nodeIds: [r.idMap.n!] }).nodes[0]).toMatchObject({ x, y: 0 })
  }
})

it('Work documents are not obstacles and are not moved by visible nodes', () => {
  canvas.apply(user, { requestId: 'work', ops: [{ op: 'node.create', tempId: 'n', kind: 'text', x: 0, y: 0, purpose: 'working' }] })
  const r = canvas.apply(agent, { requestId: 'artifact', ops: [{ op: 'node.create', tempId: 'n', kind: 'text' }] })
  expect(r.placements?.n).toMatchObject({ x: 0, y: 0 })
  const w = canvas.apply(agent, { requestId: 'work2', ops: [{ op: 'node.create', tempId: 'n', kind: 'text', x: 0, y: 0, purpose: 'working' }] })
  expect(w.placements).toEqual({})
})

it('Text and media without prompts can set inputs, deduplicate, exclude self, validate existence, and undo', () => {
  const r = canvas.apply(user, { requestId: 'create', ops: [
    { op: 'node.create', tempId: 'a', kind: 'text' },
    { op: 'node.create', tempId: 'b', kind: 'image', inputNodeIds: ['a', 'a', 'b'] },
    { op: 'node.setInputs', nodeId: 'a', inputNodeIds: ['b'] },
  ] })
  expect(canvas.get({ nodeIds: [r.idMap.b!] }).nodes[0]?.inputs).toEqual([r.idMap.a])
  canvas.apply(user, { requestId: 'clear', ops: [{ op: 'node.setInputs', nodeId: r.idMap.a!, inputNodeIds: [] }] })
  canvas.undo({ requestId: 'undo' })
  expect(canvas.get({ nodeIds: [r.idMap.a!] }).nodes[0]?.inputs).toEqual([r.idMap.b])
  expect(() => canvas.apply(user, { requestId: 'bad', ops: [{ op: 'node.setInputs', nodeId: r.idMap.a!, inputNodeIds: ['missing'] }] })).toThrow()
  expect(db.select().from(s.nodeInputs).where(eq(s.nodeInputs.nodeId, r.idMap.a!)).all()).toHaveLength(1)
})


it('Category frame expansion keeps membership, undo, and redo consistent', () => {
  const r = canvas.apply(user, { requestId: 'seed-frame', ops: [
    { op: 'frame.create', tempId: 'f', title: '人物', x: 0, y: 0, w: 400, h: 100 },
    { op: 'node.create', tempId: 'outside', kind: 'text', x: 40, y: 130, w: 100, h: 100 },
  ] })
  expect(canvas.get({ nodeIds: [r.idMap.outside!] }).nodes[0]?.frameId).toBeNull()
  canvas.apply(user, { requestId: 'grow', ops: [{ op: 'node.create', tempId: 'n', kind: 'text', category: '人物' }] })
  const forward = canvas.get({}).nodes.map(({ layoutRevision, ...node }) => node)
  expect(canvas.get({ nodeIds: [r.idMap.outside!] }).nodes[0]?.frameId).toBe(r.idMap.f)
  canvas.undo({ requestId: 'undo-grow' })
  expect(canvas.get({ nodeIds: [r.idMap.outside!] }).nodes[0]?.frameId).toBeNull()
  canvas.redo({ requestId: 'redo-grow' })
  expect(canvas.get({}).nodes.map(({ layoutRevision, ...node }) => node)).toEqual(forward)
})


it('Nested category frames expand ancestors first; expansion, undo, and redo never invert the hierarchy', () => {
  const r = canvas.apply(user, { requestId: 'nested', ops: [
    { op: 'frame.create', tempId: 'outer', title: '全体', x: 0, y: 0, w: 600, h: 400 },
    { op: 'frame.create', tempId: 'inner', title: '人物', x: 40, y: 40, w: 400, h: 300 },
  ] })
  canvas.apply(user, { requestId: 'nested-grow', ops: [{ op: 'node.create', tempId: 'n', kind: 'text', category: '人物', w: 800, h: 500 }] })
  const forward = canvas.get({}).nodes.map(({ layoutRevision, ...node }) => node)
  expect(canvas.get({ nodeIds: [r.idMap.inner!] }).nodes[0]?.frameId).toBe(r.idMap.outer)
  expect(canvas.get({ nodeIds: [r.idMap.outer!] }).nodes[0]).toMatchObject({ frameId: null, w: 960, h: 660 })
  canvas.undo({ requestId: 'nested-undo' })
  expect(canvas.get({ nodeIds: [r.idMap.inner!] }).nodes[0]).toMatchObject({ frameId: r.idMap.outer, w: 400, h: 300 })
  expect(canvas.get({ nodeIds: [r.idMap.outer!] }).nodes[0]).toMatchObject({ frameId: null, w: 600, h: 400 })
  canvas.redo({ requestId: 'nested-redo' })
  expect(canvas.get({}).nodes.map(({ layoutRevision, ...node }) => node)).toEqual(forward)
})
