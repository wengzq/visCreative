import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { eq, openSpaceDb, readEventsAfter, spaceSchema as s, type SpaceDb } from '@vis/storage'
import { createCanvasService, type CanvasService } from './service'

const user = { kind: 'user' } as const
let db: SpaceDb
let canvas: CanvasService
let clock: number

beforeEach(() => {
  clock = 1_800_000_000_000
  db = openSpaceDb(':memory:')
  canvas = createCanvasService({ db, now: () => clock })
})
afterEach(() => db.$client.close())

function createNode(kind: 'image' | 'text' = 'text') {
  canvas.apply(user, { requestId: 'create', ops: [{ op: 'node.create', tempId: 'n', kind, x: 0, y: 0, w: 320, h: 200 }] })
  return canvas.get({}).nodes[0]!
}

describe('slot.history', () => {
  it('Retain text, empty strings, and clears in descending revision order; derive the actor from operations; reads emit no events', () => {
    const node = createNode()
    const slotId = node.slots[0]!.slotId
    expect(canvas.history({ slotId, limit: 50 })).toEqual({ versions: [], hasMore: false })
    clock++
    canvas.apply(user, { requestId: 'write', ops: [{ op: 'slot.setText', slotId, body: '', expectedRevision: 0 }] })
    const writtenAt = clock
    db.insert(s.sessions).values({ id: 'session', agentKind: 'codex', title: 's', createdAt: clock }).run()
    clock++
    canvas.apply({ kind: 'agent', sessionId: 'session' }, { requestId: 'agent-write', ops: [{ op: 'slot.setText', slotId, body: '改稿', expectedRevision: 1 }] })
    const editedAt = clock
    clock++
    canvas.apply(user, { requestId: 'clear', ops: [{ op: 'slot.clear', slotId, expectedRevision: 2 }] })
    const before = readEventsAfter(db, 0)

    expect(canvas.history({ slotId, limit: 50 })).toEqual({ versions: [
      { revision: 3, content: { type: 'empty' }, createdAt: clock, actor: 'user', isCurrent: true },
      { revision: 2, content: { type: 'text', body: '改稿' }, createdAt: editedAt, actor: 'agent', isCurrent: false },
      { revision: 1, content: { type: 'text', body: '' }, createdAt: writtenAt, actor: 'user', isCurrent: false },
    ], hasMore: false })
    expect(readEventsAfter(db, 0)).toEqual(before)
  })

  it('Pagination cursors are exclusive; the more marker exists only when earlier revisions remain', () => {
    const slotId = createNode().slots[0]!.slotId
    for (let revision = 0; revision < 5; revision++) {
      canvas.apply(user, { requestId: `write-${revision}`, ops: [{ op: 'slot.setText', slotId, body: `${revision}`, expectedRevision: revision }] })
    }
    const first = canvas.history({ slotId, limit: 2 })
    expect(first.versions.map(v => v.revision)).toEqual([5, 4])
    expect(first.hasMore).toBe(true)
    const second = canvas.history({ slotId, limit: 2, beforeRevision: first.versions.at(-1)!.revision })
    expect(second.versions.map(v => v.revision)).toEqual([3, 2])
    expect(second.hasMore).toBe(true)
    expect(second.versions.every(v => !v.isCurrent)).toBe(true)
    expect(canvas.history({ slotId, limit: 2, beforeRevision: 3 }).hasMore).toBe(false)
    const last = canvas.history({ slotId, limit: 2, beforeRevision: 2 })
    expect(last.versions.map(v => v.revision)).toEqual([1])
    expect(last.hasMore).toBe(false)
    expect(canvas.history({ slotId, limit: 2, beforeRevision: 1 })).toEqual({ versions: [], hasMore: false })
  })

  it('Return not_found when a slot or its node is missing or deleted', () => {
    expect(() => canvas.history({ slotId: 'missing', limit: 50 })).toThrow(expect.objectContaining({ code: 'not_found' }))
    const node = createNode()
    const slotId = node.slots[0]!.slotId
    canvas.apply(user, { requestId: 'delete', ops: [{ op: 'node.delete', nodeId: node.nodeId }] })
    expect(() => canvas.history({ slotId, limit: 50 })).toThrow(expect.objectContaining({ code: 'not_found' }))
    db.update(s.slots).set({ deletedAt: null }).where(eq(s.slots.id, slotId)).run()
    expect(() => canvas.history({ slotId, limit: 50 })).toThrow(expect.objectContaining({ code: 'not_found' }))
  })

  it('includeDeleted explicitly reads tombstoned nodes and slots, preserves revisions and pagination, and still rejects nonexistent slots', () => {
    const node = createNode(), slotId = node.slots[0]!.slotId
    canvas.apply(user, { requestId: 'text', ops: [{ op: 'slot.setText', slotId, body: '删除前内容', expectedRevision: 0 }, { op: 'slot.setText', slotId, body: '最后一版', expectedRevision: 1 }] })
    canvas.apply(user, { requestId: 'delete', ops: [{ op: 'node.delete', nodeId: node.nodeId }] })
    for (const includeDeleted of [undefined, false]) expect(() => canvas.history({ slotId, limit: 50, includeDeleted })).toThrow(expect.objectContaining({ code: 'not_found' }))
    expect(canvas.history({ slotId, limit: 1, includeDeleted: true })).toMatchObject({ versions: [{ revision: 2, content: { type: 'text', body: '最后一版' }, isCurrent: true }], hasMore: true })
    expect(canvas.history({ slotId, limit: 1, beforeRevision: 2, includeDeleted: true })).toMatchObject({ versions: [{ revision: 1, content: { type: 'text', body: '删除前内容' }, isCurrent: false }], hasMore: false })
    expect(() => canvas.history({ slotId: 'missing', limit: 50, includeDeleted: true })).toThrow(expect.objectContaining({ code: 'not_found' }))
  })
})
