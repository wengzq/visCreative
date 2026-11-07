import { afterEach, beforeEach, expect, it } from 'vitest'
import { EMPTY_PREVIZ, emptyPrevizPanel, type CanvasOp } from '@vis/protocol'
import { openSpaceDb, spaceSchema as s, type SpaceDb } from '@vis/storage'
import { createCanvasService, type CanvasService } from './service'

let db: SpaceDb
let canvas: CanvasService
const apply = (ops: CanvasOp[]) => canvas.apply({ kind: 'user' }, { requestId: crypto.randomUUID(), ops })
beforeEach(() => { db = openSpaceDb(':memory:'); canvas = createCanvasService({ db }) })
afterEach(() => db.$client.close())
const main = (id: string) => canvas.get({ nodeIds: [id] }).nodes[0]!.slots[0]!

it('creates, persists, versions and restores previz documents with optimistic concurrency', () => {
  const id = apply([{ op: 'node.create', kind: 'previz', tempId: 'p' }]).idMap.p!
  expect(main(id)).toMatchObject({ revision: 1, content: { type: 'previz', doc: EMPTY_PREVIZ } })
  const doc = { ...EMPTY_PREVIZ, rev: 1, panels: [emptyPrevizPanel('one')] }
  const op = { op: 'previz.set' as const, slotId: main(id).slotId, expectedRevision: 1, doc }
  apply([op])
  expect(main(id).content).toEqual({ type: 'previz', doc })
  expect(() => apply([op])).toThrow(expect.objectContaining({ code: 'revision_conflict' }))
  canvas.undo({ requestId: crypto.randomUUID() })
  expect(main(id).content).toEqual({ type: 'previz', doc: EMPTY_PREVIZ })
  canvas.redo({ requestId: crypto.randomUUID() })
  expect(main(id).content).toEqual({ type: 'previz', doc })
  expect(canvas.history({ slotId: op.slotId, limit: 50 }).versions).toHaveLength(4)
})

it('requires existing image versions for every picture and rejects generic slot edits', () => {
  const id = apply([{ op: 'node.create', kind: 'previz', tempId: 'p' }]).idMap.p!
  const slot = main(id)
  db.insert(s.blobs).values({ hash: 'audio', byteSize: 1, createdAt: 1 }).run()
  db.insert(s.assets).values({ id: 'audio', kind: 'audio', origin: 'import', createdAt: 1 }).run()
  db.insert(s.assetVersions).values({ id: 'audio', assetId: 'audio', version: 1, blobHash: 'audio', mime: 'audio/wav', createdAt: 1 }).run()
  for (const asset of ['missing', 'audio']) for (const key of ['underlay', 'sketch', 'image', 'blockout']) {
    expect(() => apply([{ op: 'previz.set', slotId: slot.slotId, expectedRevision: 1, doc: { ...EMPTY_PREVIZ, panels: [{ ...emptyPrevizPanel('one'), [key]: asset }] } }])).toThrow()
  }
  expect(() => apply([{ op: 'slot.clear', slotId: slot.slotId, expectedRevision: 1 }])).toThrow(expect.objectContaining({ code: 'invalid_params' }))
})
