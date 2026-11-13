import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CanvasOp } from '@vis/protocol'
import { eq, openSpaceDb, readEventsAfter, spaceSchema as s, type SpaceDb } from '@vis/storage'
import { createCanvasService, type CanvasService } from './service'

const user = { kind: 'user' } as const
const agent = { kind: 'agent', sessionId: 'session' } as const
const now = 1_800_000_000_000
let db: SpaceDb
let canvas: CanvasService
let request = 0
let dir: string | undefined

beforeEach(() => {
  db = openSpaceDb(':memory:')
  canvas = createCanvasService({ db, now: () => now })
  db.insert(s.sessions).values({ id: agent.sessionId, agentKind: 'codex', title: '', createdAt: now }).run()
})
afterEach(() => {
  db.$client.close()
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

const rid = () => `history_${++request}`
const apply = (...ops: CanvasOp[]) => canvas.apply(user, { requestId: rid(), ops })
const seed = (...ops: CanvasOp[]) => canvas.apply(agent, { requestId: rid(), ops })
const undo = () => canvas.undo({ requestId: rid() })
const redo = () => canvas.redo({ requestId: rid() })
const create = (tempId: string, text?: string): Extract<CanvasOp, { op: 'node.create' }> =>
  ({ op: 'node.create', tempId, kind: 'text', x: 0, y: 0, w: 320, h: 200, ...(text !== undefined ? { content: { text } } : {}) })
const node = (nodeId: string) => canvas.get({ nodeIds: [nodeId] }).nodes[0]!
const main = (nodeId: string) => node(nodeId).slots[0]!

function seedAsset(id: string) {
  db.insert(s.blobs).values({ hash: `hash_${id}`, byteSize: 1, createdAt: now }).run()
  db.insert(s.assets).values({ id: `asset_${id}`, kind: 'image', origin: 'generation', createdAt: now }).run()
  db.insert(s.assetVersions).values({ id, assetId: `asset_${id}`, version: 1, blobHash: `hash_${id}`, mime: 'image/png', createdAt: now }).run()
  return id
}

function databaseSnapshot() {
  const tables = db.$client.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]
  return tables.map(({ name }) => [name, db.$client.prepare(`SELECT * FROM "${name}"`).all()])
}

describe('Canvas undo and redo', () => {
  it.each(['image', 'video', 'audio'] as const)('creates and edits a %s prompt with optimistic checks and undoable author writes', kind => {
    const nodeId = seed({ op: 'node.create', tempId: 'legacy', kind }).idMap.legacy!
    expect(() => apply({ op: 'node.setPrompt', nodeId, body: 'Stale', expectedRevision: 1 })).toThrow(expect.objectContaining({ code: 'revision_conflict' }))
    apply({ op: 'node.setPrompt', nodeId, body: 'Original {{ref:source}}', expectedRevision: 0 })
    const prompt = () => node(nodeId).slots.find(slot => slot.slotKey === 'prompt')!
    expect(prompt()).toMatchObject({ revision: 1, content: { type: 'text', body: 'Original {{ref:source}}' }, writer: { actor: 'user' } })
    expect(readEventsAfter(db, 0).slice(-2)).toMatchObject([
      { type: 'slot.revised', payload: { nodeId, slot: prompt() } },
      { type: 'node.updated', payload: { nodeId, slots: [{ slotKey: 'main' }, { slotKey: 'prompt', revision: 1 }] } },
    ])
    expect(() => apply({ op: 'node.setPrompt', nodeId, body: 'Duplicate', expectedRevision: 0 })).toThrow(expect.objectContaining({ code: 'revision_conflict' }))
    undo()
    expect(prompt().content).toEqual({ type: 'empty' })
    redo()
    expect(prompt()).toMatchObject({ revision: 3, content: { type: 'text', body: 'Original {{ref:source}}' } })
    apply({ op: 'node.setPrompt', nodeId, body: 'Edited', expectedRevision: 3 })
    undo()
    expect(prompt().content).toEqual({ type: 'text', body: 'Original {{ref:source}}' })
    redo()
    expect(prompt().content).toEqual({ type: 'text', body: 'Edited' })
  })

  it.each(['text', 'script', 'timeline', 'previz', 'scene'] as const)('rejects prompt creation on a %s node without events', kind => {
    const nodeId = seed({ op: 'node.create', tempId: 'invalid', kind }).idMap.invalid!
    const before = readEventsAfter(db, 0)
    expect(() => apply({ op: 'node.setPrompt', nodeId, body: 'Invalid', expectedRevision: 0 })).toThrow(expect.objectContaining({ code: 'invalid_params' }))
    expect(readEventsAfter(db, 0)).toEqual(before)
  })
  it('Empty history writes no operations or events; empty results are also idempotent by requestId', () => {
    const params = { requestId: rid() }
    expect(canvas.undo(params)).toEqual({ nothing: true })
    expect(redo()).toEqual({ nothing: true })
    const { idMap } = apply(create('n'))
    expect(canvas.undo(params)).toEqual({ nothing: true })
    expect(node(idMap.n!)).toBeDefined()
    expect(db.select().from(s.operations).all()).toHaveLength(1)
    expect(readEventsAfter(db, 0)).toHaveLength(1)
    expect(() => canvas.redo(params)).toThrow(expect.objectContaining({ code: 'idempotency_conflict' }))
  })

  it('Creation and deletion preserve nodes, both slots, assets, and reference inputs; redo reuses original IDs', () => {
    const ref = seed(create('ref')).idMap.ref!
    const assetVersionId = seedAsset('original')
    const { idMap } = apply({ op: 'node.create', tempId: 'image', kind: 'image', x: 5, y: 10, w: 320, h: 180,
      prompt: '提示词', content: { assetVersionId }, inputNodeIds: [ref] })
    const original = node(idMap.image!)
    undo()
    expect(canvas.get({ nodeIds: [original.nodeId] }).nodes).toEqual([])
    expect(db.select().from(s.slots).where(eq(s.slots.nodeId, original.nodeId)).all().every(slot => slot.deletedAt !== null)).toBe(true)
    redo()
    expect(node(original.nodeId)).toEqual(original)
    apply({ op: 'node.delete', nodeId: original.nodeId })
    expect(canvas.get({ nodeIds: [original.nodeId] }).nodes).toEqual([])
    undo()
    expect(node(original.nodeId)).toEqual(original)
    redo()
    expect(canvas.get({ nodeIds: [original.nodeId] }).nodes).toEqual([])
    expect(db.select().from(s.assetVersions).all().map(asset => asset.id)).toEqual([assetVersionId])
  })

  it('Layout restores all fields and keeps incrementing layout revisions without changing content revisions', () => {
    const nodeId = seed(create('n', '正文')).idMap.n!
    const original = node(nodeId)
    apply({ op: 'node.layout', nodeId, x: 10, y: 20, w: 500, h: 100, z: 9 })
    undo()
    expect(node(nodeId)).toEqual({ ...original, layoutRevision: 3 })
    redo()
    expect(node(nodeId)).toEqual({ ...original, x: 10, y: 20, w: 500, h: 100, z: 9, layoutRevision: 4 })
  })

  it('Reference inputs restore their order; clearing also supports undo and redo', () => {
    const { idMap } = seed(create('a'), create('b'), { op: 'node.create', tempId: 'target', kind: 'image', x: 0, y: 0, w: 320, h: 200, prompt: '' })
    const nodeId = idMap.target!
    apply({ op: 'node.setInputs', nodeId, inputNodeIds: [idMap.b!, idMap.a!] })
    apply({ op: 'node.setInputs', nodeId, inputNodeIds: [] })
    undo()
    expect(node(nodeId).inputs).toEqual([idMap.b, idMap.a])
    undo()
    expect(node(nodeId)).not.toHaveProperty('inputs')
    redo()
    expect(node(nodeId).inputs).toEqual([idMap.b, idMap.a])
    redo()
    expect(node(nodeId)).not.toHaveProperty('inputs')
  })

  it('Undoing input node deletion also pushes full views of dependent nodes with restored references', () => {
    const ref = seed(create('ref')).idMap.ref!
    const target = seed({ op: 'node.create', tempId: 'target', kind: 'image', x: 0, y: 0, w: 320, h: 200, prompt: '', inputNodeIds: [ref] }).idMap.target!
    const deleted = apply({ op: 'node.delete', nodeId: ref })
    expect(node(target)).not.toHaveProperty('inputs')
    const result = undo()
    expect(node(target).inputs).toEqual([ref])
    const events = readEventsAfter(db, deleted.eventSeq)
    expect(events.map(event => event.type)).toEqual(['node.created', 'node.updated'])
    expect(events[0]!.payload).toEqual(node(ref))
    expect(events[1]!.payload).toEqual(node(target))
    expect(events.every(event => 'operationId' in result && event.operationId === result.operationId)).toBe(true)
  })

  it('Consecutive text edits, including creation, can all be undone and redone over repeated cycles', () => {
    const nodeId = apply(create('n', '初稿')).idMap.n!
    const slotId = main(nodeId).slotId
    for (const [index, body] of ['第二稿', '第三稿', '定稿'].entries()) {
      apply({ op: 'slot.setText', slotId, body, expectedRevision: index + 1 })
    }
    let revision = 4
    for (let cycle = 0; cycle < 2; cycle++) {
      for (const body of ['第三稿', '第二稿', '初稿']) {
        undo()
        expect(main(nodeId)).toMatchObject({ revision: ++revision, content: { type: 'text', body } })
      }
      undo()
      expect(canvas.get({}).nodes).toEqual([])
      expect(undo()).toEqual({ nothing: true })
      redo()
      expect(main(nodeId)).toMatchObject({ slotId, revision, content: { body: '初稿' } })
      for (const body of ['第二稿', '第三稿', '定稿']) {
        redo()
        expect(main(nodeId)).toMatchObject({ revision: ++revision, content: { type: 'text', body } })
      }
      expect(redo()).toEqual({ nothing: true })
    }
  })

  it('Asset writes and clears restore through new revisions without deleting old assets or revisions', () => {
    const nodeId = seed({ op: 'node.create', tempId: 'n', kind: 'image', x: 0, y: 0, w: 320, h: 200 }).idMap.n!
    const slotId = main(nodeId).slotId
    const assetVersionId = seedAsset('image')
    apply({ op: 'slot.setAsset', slotId, assetVersionId, expectedRevision: 0 })
    undo()
    expect(main(nodeId)).toMatchObject({ revision: 2, content: { type: 'empty' } })
    redo()
    expect(main(nodeId)).toMatchObject({ revision: 3, content: { type: 'asset', assetVersionId } })
    apply({ op: 'slot.clear', slotId, expectedRevision: 3 })
    undo()
    expect(main(nodeId)).toMatchObject({ revision: 5, content: { type: 'asset', assetVersionId } })
    redo()
    expect(main(nodeId)).toMatchObject({ revision: 6, content: { type: 'empty' } })
    expect(db.select().from(s.slotRevisions).where(eq(s.slotRevisions.slotId, slotId)).all()).toHaveLength(6)
    expect(db.select().from(s.assetVersions).all()).toHaveLength(1)
  })

  it('A mixed batch is one undo step, reversing multiple writes to the same slot in reverse order', () => {
    const { idMap: old } = seed(create('ref'), create('removed', '保留'))
    const before = canvas.get({})
    const a = seedAsset('a')
    const b = seedAsset('b')
    const { idMap } = apply(
      { op: 'node.create', tempId: 'new', kind: 'image', x: 0, y: 0, w: 320, h: 200, prompt: '初稿', content: { assetVersionId: a } },
      { op: 'node.layout', nodeId: 'new', x: 100, z: 5 },
      { op: 'node.setInputs', nodeId: 'new', inputNodeIds: [old.ref!] },
      { op: 'slot.setText', slotId: 'new:prompt', body: '定稿', expectedRevision: 1 },
      { op: 'slot.setAsset', slotId: 'new:main', assetVersionId: b, expectedRevision: 1 },
      { op: 'slot.clear', slotId: 'new:main', expectedRevision: 2 },
      { op: 'node.delete', nodeId: old.removed! },
    )
    undo()
    expect(canvas.get({})).toEqual(before)
    expect(undo()).toEqual({ nothing: true })
    redo()
    expect(node(idMap.new!)).toMatchObject({ x: 100, z: 5, inputs: [old.ref], slots: [
      { revision: 7, content: { type: 'empty' } }, { revision: 4, content: { type: 'text', body: '定稿' } },
    ] })
    expect(canvas.get({ nodeIds: [old.removed!] }).nodes).toEqual([])
    expect(redo()).toEqual({ nothing: true })
  })

  it('Multiple edits to an existing slot in one batch still allow all later history to be undone and redone', () => {
    const nodeId = seed(create('n', '初稿')).idMap.n!
    const slotId = main(nodeId).slotId
    apply({ op: 'slot.setText', slotId, body: '第二稿', expectedRevision: 1 })
    apply(
      { op: 'slot.setText', slotId, body: '第三稿', expectedRevision: 2 },
      { op: 'slot.setText', slotId, body: '第四稿', expectedRevision: 3 },
    )
    apply({ op: 'slot.setText', slotId, body: '定稿', expectedRevision: 4 })
    for (const body of ['第四稿', '第二稿', '初稿']) {
      undo()
      expect(main(nodeId).content).toEqual({ type: 'text', body })
    }
    for (const body of ['第二稿', '第四稿', '定稿']) {
      redo()
      expect(main(nodeId).content).toEqual({ type: 'text', body })
    }
  })

  it('Successful new user operations clear redo; failed batches preserve redo', () => {
    const nodeId = seed(create('n', '初稿')).idMap.n!
    const slotId = main(nodeId).slotId
    apply({ op: 'slot.setText', slotId, body: '定稿', expectedRevision: 1 })
    undo()
    const before = databaseSnapshot()
    expect(() => apply({ op: 'node.layout', nodeId, x: 99 }, { op: 'slot.clear', slotId, expectedRevision: 1 }))
      .toThrow(expect.objectContaining({ code: 'revision_conflict' }))
    expect(databaseSnapshot()).toEqual(before)
    redo()
    expect(main(nodeId).content).toEqual({ type: 'text', body: '定稿' })
    undo()
    apply({ op: 'node.layout', nodeId, x: 42 })
    expect(redo()).toEqual({ nothing: true })
    undo()
    expect(node(nodeId).x).toBe(0)
    expect(undo()).toEqual({ nothing: true })
  })

  it('Agent operations do not enter user history or clear existing redo', () => {
    const userNode = apply(create('user', '用户')).idMap.user!
    undo()
    const agentNode = seed(create('agent', 'Agent')).idMap.agent!
    redo()
    expect(canvas.get({}).nodes.map(node => node.nodeId).sort()).toEqual([userNode, agentNode].sort())
    undo()
    expect(canvas.get({}).nodes.map(node => node.nodeId)).toEqual([agentNode])
    expect(undo()).toEqual({ nothing: true })
  })

  it.each(['undo', 'redo'] as const)('%s rejects the entire step after Agent content changes and leaves the database unchanged', direction => {
    const { idMap } = seed(create('a', 'A'), create('b', 'B'))
    const a = main(idMap.a!)
    const b = main(idMap.b!)
    apply(
      { op: 'node.layout', nodeId: idMap.a!, x: 50 },
      { op: 'slot.setText', slotId: a.slotId, body: '用户 A', expectedRevision: 1 },
      { op: 'slot.setText', slotId: b.slotId, body: '用户 B', expectedRevision: 1 },
    )
    if (direction === 'redo') undo()
    seed({ op: 'slot.setText', slotId: b.slotId, body: 'Agent 修改', expectedRevision: main(idMap.b!).revision })
    const before = databaseSnapshot()
    const params = { requestId: rid() }
    expect(() => canvas[direction](params)).toThrow(expect.objectContaining({ code: 'revision_conflict' }))
    expect(databaseSnapshot()).toEqual(before)
    expect(() => canvas[direction](params)).toThrow(expect.objectContaining({ code: 'revision_conflict' }))
    expect(databaseSnapshot()).toEqual(before)
  })

  it.each(['undo', 'redo'] as const)('%s rejects targets deleted by an Agent without resurrecting nodes', direction => {
    const nodeId = seed(create('n', '正文')).idMap.n!
    apply({ op: 'node.layout', nodeId, x: 20 })
    if (direction === 'redo') undo()
    seed({ op: 'node.delete', nodeId })
    const before = databaseSnapshot()
    expect(() => canvas[direction]({ requestId: rid() })).toThrow(expect.objectContaining({ code: 'revision_conflict' }))
    expect(databaseSnapshot()).toEqual(before)
    expect(canvas.get({}).nodes).toEqual([])
  })

  it.each(['undo', 'redo'] as const)('%s does not overwrite assets delivered later by generation jobs', direction => {
    const assetVersionId = seedAsset('user')
    const generated = seedAsset('generated')
    const nodeId = seed({ op: 'node.create', tempId: 'n', kind: 'image', x: 0, y: 0, w: 320, h: 200 }).idMap.n!
    const slotId = main(nodeId).slotId
    apply({ op: 'slot.setAsset', slotId, assetVersionId, expectedRevision: 0 })
    if (direction === 'redo') undo()
    db.insert(s.generationJobs).values({ id: 'job', kind: 'image', provider: 'mock', model: 'm', params: {}, status: 'finalizing', createdAt: now, updatedAt: now }).run()
    db.insert(s.deliveryBindings).values({ id: 'binding', jobId: 'job', outputIndex: 0, targetKind: 'slot', nodeId, slotId,
      expectedContentRevision: main(nodeId).revision, status: 'pending' }).run()
    db.update(s.slots).set({ acceptedBindingId: 'binding' }).where(eq(s.slots.id, slotId)).run()
    expect(db.transaction(tx => canvas.deliverOutput(tx, { bindingId: 'binding', assetVersionId: generated }))).toMatchObject({ status: 'delivered' })
    const before = databaseSnapshot()
    expect(() => canvas[direction]({ requestId: rid() })).toThrow(expect.objectContaining({ code: 'revision_conflict' }))
    expect(databaseSnapshot()).toEqual(before)
    expect(main(nodeId).content).toMatchObject({ type: 'asset', assetVersionId: generated })
  })

  it('Repeated undo and redo return the first result without rewriting revisions, operations, events, or moving history', () => {
    const nodeId = seed(create('n', '初稿')).idMap.n!
    const slotId = main(nodeId).slotId
    const original = canvas.apply(user, { requestId: rid(), description: '编辑正文', ops: [{ op: 'slot.setText', slotId, body: '定稿', expectedRevision: 1 }] })
    const undoParams = { requestId: rid() }
    const undone = canvas.undo(undoParams)
    expect(undone).toEqual({ operationId: undoParams.requestId, description: '撤销：编辑正文' })
    let snapshot = databaseSnapshot()
    expect(canvas.undo(undoParams)).toEqual(undone)
    expect(databaseSnapshot()).toEqual(snapshot)
    const redoParams = { requestId: rid() }
    const redone = canvas.redo(redoParams)
    expect(redone).toEqual({ operationId: redoParams.requestId, description: '重做：编辑正文' })
    snapshot = databaseSnapshot()
    expect(canvas.redo(redoParams)).toEqual(redone)
    expect(canvas.undo(undoParams)).toEqual(undone)
    expect(databaseSnapshot()).toEqual(snapshot)
    expect(() => canvas.redo(undoParams)).toThrow(expect.objectContaining({ code: 'idempotency_conflict' }))
    expect(() => canvas.undo({ requestId: original.operationId })).toThrow(expect.objectContaining({ code: 'idempotency_conflict' }))
    expect(main(nodeId)).toMatchObject({ revision: 4, content: { body: '定稿' } })
    expect(readEventsAfter(db, 0).map(event => event.operationId)).toEqual([expect.any(String), original.operationId, undoParams.requestId, redoParams.requestId])
  })

  it('Undo and redo stacks and requestId remain valid after closing and reopening the database', () => {
    dir = mkdtempSync(join(tmpdir(), 'vis-undo-'))
    const file = join(dir, 'space.db')
    db.$client.close()
    db = openSpaceDb(file)
    canvas = createCanvasService({ db, now: () => now })
    const nodeId = apply(create('n', '初稿')).idMap.n!
    const slotId = main(nodeId).slotId
    apply({ op: 'slot.setText', slotId, body: '定稿', expectedRevision: 1 })
    const reopen = () => {
      db.$client.close()
      db = openSpaceDb(file)
      canvas = createCanvasService({ db, now: () => now })
    }
    reopen()
    const params = { requestId: rid() }
    const result = canvas.undo(params)
    expect(main(nodeId).content).toEqual({ type: 'text', body: '初稿' })
    reopen()
    const before = databaseSnapshot()
    expect(canvas.undo(params)).toEqual(result)
    expect(databaseSnapshot()).toEqual(before)
    redo()
    expect(main(nodeId)).toMatchObject({ revision: 4, content: { body: '定稿' } })
    undo()
    undo()
    expect(canvas.get({}).nodes).toEqual([])
    reopen()
    redo()
    redo()
    expect(main(nodeId).content).toEqual({ type: 'text', body: '定稿' })
  })
})
