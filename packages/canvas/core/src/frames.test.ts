import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CanvasOp as CanvasOpSchema, type CanvasOp } from '@vis/protocol'
import { eq, openSpaceDb, readEventsAfter, spaceSchema as s, type SpaceDb } from '@vis/storage'
import { createCanvasService, type CanvasService } from './service'
import { frameMemberIds } from './frames'

const now = 1_800_000_000_000
const user = { kind: 'user' } as const
let db: SpaceDb
let canvas: CanvasService
let request = 0

beforeEach(() => {
  db = openSpaceDb(':memory:')
  canvas = createCanvasService({ db, now: () => now })
})
afterEach(() => db.$client.close())

const rid = () => `frame_${++request}`
const apply = (...ops: CanvasOp[]) => canvas.apply(user, { requestId: rid(), ops })
const undo = () => canvas.undo({ requestId: rid() })
const redo = () => canvas.redo({ requestId: rid() })
const node = (nodeId: string) => canvas.get({ nodeIds: [nodeId] }).nodes[0]!
const frame = (tempId: string, x = 0, y = 0, w = 1000, h = 800): Extract<CanvasOp, { op: 'frame.create' }> =>
  ({ op: 'frame.create', tempId, title: tempId, x, y, w, h })
const text = (tempId: string, x = 100, y = 100, w = 100, h = 100): Extract<CanvasOp, { op: 'node.create' }> =>
  ({ op: 'node.create', tempId, kind: 'text', x, y, w, h, content: { text: '保留正文' } })

describe('Canvas frames', () => {
  it('Create a frame without slots; full views match events, and property changes support undo and redo', () => {
    const result = apply(frame('frame'))
    const nodeId = result.idMap.frame!
    const original = node(nodeId)
    expect(original).toMatchObject({ kind: 'frame', frame: { title: 'frame', color: 'gray' }, frameId: null, slots: [] })
    expect(result.slotRevisions).toEqual({})
    expect(readEventsAfter(db, 0)[0]!.payload).toEqual(original)
    apply({ op: 'frame.update', nodeId, title: '新标题', color: 'violet' })
    expect(node(nodeId)).toMatchObject({ frame: { title: '新标题', color: 'violet' } })
    undo()
    expect(node(nodeId)).toMatchObject({ frame: original.frame })
    redo()
    expect(node(nodeId)).toMatchObject({ frame: { title: '新标题', color: 'violet' } })
    undo()
    undo()
    expect(canvas.get({}).nodes).toEqual([])
    redo()
    expect(node(nodeId)).toMatchObject({ frame: original.frame, slots: [] })
  })

  it('Creating a frame around existing nodes updates membership; undo preserves content and restores original membership', () => {
    const nodeId = apply(text('text')).idMap.text!
    const created = apply(frame('outer'))
    const outerId = created.idMap.outer!
    expect(node(nodeId).frameId).toBe(outerId)
    expect(readEventsAfter(db, 1).find(event => event.type === 'node.updated')!.payload).toEqual(node(nodeId))
    undo()
    expect(node(nodeId)).toMatchObject({ frameId: null, slots: [{ content: { body: '保留正文' } }] })
    redo()
    expect(node(nodeId).frameId).toBe(outerId)
  })

  it.each(['create', 'delete'] as const)('Undoing frame %s does not overwrite current membership after an Agent moves members to another frame', action => {
    const { idMap } = apply(frame('other', 2000), text('member'))
    const frameId = apply(frame('frame')).idMap.frame!
    if (action === 'delete') apply({ op: 'node.delete', nodeId: frameId })
    db.insert(s.sessions).values({ id: 'agent', agentKind: 'codex', title: '', createdAt: now }).run()
    canvas.apply({ kind: 'agent', sessionId: 'agent' }, { requestId: rid(), ops: [{ op: 'node.layout', nodeId: idMap.member!, x: 2100 }] })
    const before = canvas.get({})
    expect(node(idMap.member!).frameId).toBe(idMap.other)
    expect(() => undo()).toThrow(expect.objectContaining({ code: 'revision_conflict' }))
    expect(canvas.get({})).toEqual(before)
  })

  it('Reject old membership history even when an Agent changes member geometry within the same frame', () => {
    const nodeId = apply(text('member')).idMap.member!
    apply(frame('frame'))
    db.insert(s.sessions).values({ id: 'agent', agentKind: 'codex', title: '', createdAt: now }).run()
    canvas.apply({ kind: 'agent', sessionId: 'agent' }, { requestId: rid(), ops: [{ op: 'node.layout', nodeId, x: 200 }] })
    const before = canvas.get({})
    expect(() => undo()).toThrow(expect.objectContaining({ code: 'revision_conflict' }))
    expect(canvas.get({})).toEqual(before)
  })

  it('After undoing their own member layout, users can still undo and redo frame operations', () => {
    const nodeId = apply(text('member')).idMap.member!
    const frameId = apply(frame('frame')).idMap.frame!
    apply({ op: 'node.layout', nodeId, x: 200 })
    undo()
    expect(node(nodeId)).toMatchObject({ x: 100, frameId })
    undo()
    expect(node(nodeId)).toMatchObject({ x: 100, frameId: null })
    redo()
    expect(node(nodeId)).toMatchObject({ x: 100, frameId })
    redo()
    expect(node(nodeId)).toMatchObject({ x: 200, frameId })
  })

  it('Assign nodes to the innermost frame by center point; frames never adopt outer frames as members', () => {
    const { idMap } = apply(frame('outer'), frame('inner', 200, 200, 400, 300), text('inside', 150, 150, 200, 200), text('edge', 50, 50, 100, 100))
    expect(node(idMap.outer!).frameId).toBeNull()
    expect(node(idMap.inner!).frameId).toBe(idMap.outer)
    expect(node(idMap.inside!).frameId).toBe(idMap.inner)
    expect(node(idMap.edge!).frameId).toBe(idMap.outer)
    apply({ op: 'node.layout', nodeId: idMap.edge!, x: 150, y: 150 })
    expect(node(idMap.edge!).frameId).toBe(idMap.inner)
    apply({ op: 'node.layout', nodeId: idMap.edge!, x: -100, y: -100 })
    expect(node(idMap.edge!).frameId).toBeNull()
    undo()
    expect(node(idMap.edge!).frameId).toBe(idMap.inner)
    redo()
    expect(node(idMap.edge!).frameId).toBeNull()
  })

  it('Resizing frames recalculates existing node membership without moving content; undo and redo also recalculate', () => {
    const { idMap } = apply(frame('frame', 0, 0, 200, 200), text('text', 300, 100))
    const original = node(idMap.text!)
    apply({ op: 'node.layout', nodeId: idMap.frame!, w: 500 })
    expect(node(idMap.text!)).toEqual({ ...original, frameId: idMap.frame })
    undo()
    expect(node(idMap.text!)).toEqual(original)
    redo()
    expect(node(idMap.text!).frameId).toBe(idMap.frame)
    apply({ op: 'node.layout', nodeId: idMap.frame!, x: 1000 })
    expect(node(idMap.text!).frameId).toBeNull()
  })

  it('Deleting a frame only clears direct membership; undo and redo preserve child frames, nodes, and independent work items', () => {
    const { idMap } = apply(frame('outer'), frame('inner', 200, 200, 400, 300), text('outerText'), text('innerText', 300, 300))
    const outerId = idMap.outer!
    db.insert(s.workItems).values({ id: 'work', title: '工作项', workDir: '/tmp/work',
      createdBy: user, statusChangedAt: now, createdAt: now }).run()
    const work = db.select().from(s.workItems).where(eq(s.workItems.id, 'work')).get()!
    apply({ op: 'node.delete', nodeId: outerId })
    expect(canvas.get({}).nodes).toHaveLength(3)
    expect(node(idMap.outerText!).frameId).toBeNull()
    expect(node(idMap.inner!).frameId).toBeNull()
    expect(node(idMap.innerText!).frameId).toBe(idMap.inner)
    for (let cycle = 0; cycle < 2; cycle++) {
      undo()
      expect(node(idMap.outerText!).frameId).toBe(outerId)
      expect(node(idMap.inner!).frameId).toBe(outerId)
      expect(node(outerId).frame).toEqual({ title: 'outer', color: 'gray' })
      redo()
      expect(node(idMap.outerText!).frameId).toBeNull()
    }
    expect(db.select().from(s.workItems).where(eq(s.workItems.id, 'work')).get()).toEqual(work)
    expect(node(idMap.innerText!).slots[0]!.content).toEqual({ type: 'text', body: '保留正文' })
  })

  it('Frame titles and colors can be changed directly; ordinary nodes cannot be updated as frames', () => {
    const { idMap } = apply(frame('frame'), text('text'))
    const nodeId = idMap.frame!
    apply({ op: 'frame.update', nodeId, title: '整理素材', color: 'red' })
    expect(node(nodeId).frame).toEqual({ title: '整理素材', color: 'red' })
    expect(() => apply({ op: 'frame.update', nodeId: idMap.text!, color: 'red' })).toThrow(expect.objectContaining({ code: 'invalid_params' }))
    expect(() => apply({ op: 'node.setGeneration', nodeId, generation: {} })).toThrow(expect.objectContaining({ code: 'invalid_params' }))
  })

  it('Undoing color restores only color and does not overwrite a title later changed by an Agent', () => {
    const nodeId = apply(frame('frame')).idMap.frame!
    apply({ op: 'frame.update', nodeId, color: 'blue' })
    db.insert(s.sessions).values({ id: 'agent', agentKind: 'codex', title: '', createdAt: now }).run()
    canvas.apply({ kind: 'agent', sessionId: 'agent' }, { requestId: rid(), ops: [{ op: 'frame.update', nodeId, title: 'Agent 新标题' }] })
    undo()
    expect(node(nodeId).frame).toEqual({ title: 'Agent 新标题', color: 'gray' })
    redo()
    expect(node(nodeId).frame).toEqual({ title: 'Agent 新标题', color: 'blue' })
  })

  it('A mixed frame and content layout batch needs one undo step and keeps membership consistent', () => {
    const { idMap } = apply(frame('outer'), frame('inner', 200, 200, 400, 300), text('text', 300, 300))
    const original = canvas.get({}).nodes
    apply(...original.map(item => ({ op: 'node.layout' as const, nodeId: item.nodeId, x: item.x + 2000, y: item.y + 2000 })))
    expect(node(idMap.text!).frameId).toBe(idMap.inner)
    undo()
    expect(canvas.get({}).nodes.map(({ layoutRevision, ...item }) => item)).toEqual(original.map(({ layoutRevision, ...item }) => item))
    redo()
    expect(node(idMap.text!)).toMatchObject({ x: 2300, y: 2300, frameId: idMap.inner })
  })

  it('A single frame.move recursively moves over 200 nested members; events, undo, and redo preserve all memberships', () => {
    const { idMap } = apply(frame('outer', 0, 0, 3000, 2000), frame('inner', 400, 400, 1000, 1000), frame('deep', 600, 600, 500, 500), text('outside', 3500, 500))
    for (let batch = 0; batch < 3; batch++) apply(...Array.from({ length: 80 }, (_, index) => text(`member_${batch}_${index}`, 700, 700, 40, 40)))
    const original = canvas.get({}).nodes
    const memberIds = db.transaction(tx => frameMemberIds(tx, idMap.outer!))
    expect(memberIds).toHaveLength(243)
    expect(memberIds).toContain(idMap.outer)
    expect(memberIds).toContain(idMap.deep)
    expect(memberIds).not.toContain(idMap.outside)
    const members = new Set(memberIds)
    const move = CanvasOpSchema.parse({ op: 'frame.move', nodeId: idMap.outer!, dx: 3000, dy: -500 })
    const result = apply(move)
    const expected = original.map(item => members.has(item.nodeId) ? { ...item, x: item.x + 3000, y: item.y - 500, layoutRevision: item.layoutRevision + 1 } : item)
    expect(canvas.get({}).nodes).toEqual(expected)
    const events = readEventsAfter(db, result.eventSeq - memberIds.length, memberIds.length + 1)
    expect(events).toHaveLength(memberIds.length)
    expect(events.every(event => event.type === 'node.updated' && event.operationId === result.operationId)).toBe(true)
    const history = db.select().from(s.undoEntries).where(eq(s.undoEntries.id, result.operationId)).get()!.inverse as { steps: { kind: string }[] }
    expect(history.steps.map(step => step.kind)).toEqual(['frameMove'])
    const withoutRevision = (items: typeof original) => items.map(({ layoutRevision, ...item }) => item)
    undo()
    expect(withoutRevision(canvas.get({}).nodes)).toEqual(withoutRevision(original))
    redo()
    expect(withoutRevision(canvas.get({}).nodes)).toEqual(withoutRevision(expected))
    expect(node(idMap.outside!)).toEqual(original.find(item => item.nodeId === idMap.outside))
  })

  it('frame.move uses current server members, supports temporary frame IDs within the batch, and rejects ordinary nodes', () => {
    const { idMap } = apply(frame('frame'), text('inside'), text('outside', 2000))
    apply({ op: 'node.layout', nodeId: idMap.inside!, x: 3000 }, { op: 'node.layout', nodeId: idMap.outside!, x: 100 })
    apply({ op: 'frame.move', nodeId: idMap.frame!, dx: 5000, dy: 100 })
    expect(node(idMap.inside!)).toMatchObject({ x: 3000, frameId: null })
    expect(node(idMap.outside!)).toMatchObject({ x: 5100, frameId: idMap.frame })
    expect(() => apply({ op: 'frame.move', nodeId: idMap.inside!, dx: 1, dy: 1 })).toThrow(expect.objectContaining({ code: 'invalid_params' }))
    const created = apply(frame('new', -1000), { op: 'frame.move', nodeId: 'new', dx: 100, dy: -100 })
    expect(node(created.idMap.new!)).toMatchObject({ x: -900, y: -100 })
  })

  it('Reject the entire move undo after an Agent deletes a member; do not move remaining members', () => {
    const { idMap } = apply(frame('frame'), text('member'))
    apply({ op: 'frame.move', nodeId: idMap.frame!, dx: 1000, dy: 1000 })
    db.insert(s.sessions).values({ id: 'agent', agentKind: 'codex', title: '', createdAt: now }).run()
    canvas.apply({ kind: 'agent', sessionId: 'agent' }, { requestId: rid(), ops: [{ op: 'node.delete', nodeId: idMap.member! }] })
    const before = canvas.get({})
    expect(() => undo()).toThrow(expect.objectContaining({ code: 'revision_conflict' }))
    expect(canvas.get({})).toEqual(before)
  })

  it.each(['undo', 'redo'] as const)('After an Agent moves members to another frame, %s of a whole-frame move does not overwrite coordinates or membership', direction => {
    const { idMap } = apply(frame('frame'), text('member'), frame('other', 3000))
    apply({ op: 'frame.move', nodeId: idMap.frame!, dx: 1000, dy: 0 })
    if (direction === 'redo') undo()
    db.insert(s.sessions).values({ id: 'agent', agentKind: 'codex', title: '', createdAt: now }).run()
    canvas.apply({ kind: 'agent', sessionId: 'agent' }, { requestId: rid(), ops: [{ op: 'node.layout', nodeId: idMap.member!, x: 3100 }] })
    const before = canvas.get({})
    expect(node(idMap.member!)).toMatchObject({ x: 3100, frameId: idMap.other })
    expect(() => canvas[direction]({ requestId: rid() })).toThrow(expect.objectContaining({ code: 'revision_conflict' }))
    expect(canvas.get({})).toEqual(before)
  })

  it('Temporary frame IDs within a batch support updates and layout and share uniqueness constraints with ordinary nodes', () => {
    const { idMap } = apply(frame('f'), { op: 'frame.update', nodeId: 'f', title: '改名' }, { op: 'node.layout', nodeId: 'f', x: 50 })
    expect(node(idMap.f!)).toMatchObject({ x: 50, frame: { title: '改名' } })
    const before = canvas.get({})
    expect(() => apply(frame('duplicate'), text('duplicate'))).toThrow(expect.objectContaining({ code: 'invalid_params' }))
    expect(canvas.get({})).toEqual(before)
  })

  it('Generation delivery treats frames as background, keeps results adjacent, and writes correct membership', () => {
    const { idMap } = apply(frame('frame'), { op: 'node.create', tempId: 'image', kind: 'image', x: 100, y: 100, w: 320, h: 320 })
    db.insert(s.blobs).values({ hash: 'hash', byteSize: 1, createdAt: now }).run()
    db.insert(s.assets).values({ id: 'asset', kind: 'image', origin: 'generation', createdAt: now }).run()
    db.insert(s.assetVersions).values({ id: 'version', assetId: 'asset', version: 1, blobHash: 'hash', mime: 'image/png', createdAt: now }).run()
    db.insert(s.generationJobs).values({ id: 'job', kind: 'image', provider: 'mock', model: 'mock', params: {}, status: 'finalizing', createdAt: now, updatedAt: now }).run()
    db.insert(s.deliveryBindings).values({ id: 'binding', jobId: 'job', outputIndex: 0, targetKind: 'new_node', placement: { nearNodeId: idMap.image! }, status: 'pending' }).run()
    const result = db.transaction(tx => canvas.deliverOutput(tx, { bindingId: 'binding', assetVersionId: 'version' }))
    expect(result).toMatchObject({ status: 'delivered' })
    if (result.status !== 'delivered') throw new Error('Delivery failed')
    expect(node(result.nodeId)).toMatchObject({ kind: 'image', x: 460, y: 100, frameId: idMap.frame })
  })
})
