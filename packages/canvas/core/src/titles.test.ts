import { afterEach, expect, it } from 'vitest'
import { openSpaceDb } from '@vis/storage'
import { createCanvasService } from './service'

const db = openSpaceDb(':memory:')
afterEach(() => db.$client.close())

it('preserves titles through create, clear, undo, redo and copying metadata', () => {
  const canvas = createCanvasService({ db })
  const created = canvas.apply({ kind: 'user' }, { requestId: 'create-title', ops: [{ op: 'node.create', tempId: 'n', kind: 'image', title: 'Original title' }] })
  const nodeId = created.idMap.n!
  expect(canvas.get({ nodeIds: [nodeId] }).nodes[0]!.title).toBe('Original title')
  canvas.apply({ kind: 'user' }, { requestId: 'rename', ops: [{ op: 'node.setMeta', nodeId, title: 'Renamed' }] })
  canvas.undo({ requestId: 'undo-name' })
  expect(canvas.get({ nodeIds: [nodeId] }).nodes[0]!.title).toBe('Original title')
  canvas.redo({ requestId: 'redo-name' })
  expect(canvas.get({ nodeIds: [nodeId] }).nodes[0]!.title).toBe('Renamed')
  canvas.apply({ kind: 'user' }, { requestId: 'clear-name', ops: [{ op: 'node.setMeta', nodeId, title: null }] })
  expect(canvas.get({ nodeIds: [nodeId] }).nodes[0]!.title).toBeNull()
  canvas.undo({ requestId: 'undo-clear' })
  const original = canvas.get({ nodeIds: [nodeId] }).nodes[0]!
  canvas.apply({ kind: 'user' }, { requestId: 'copy-name', ops: [{ op: 'node.create', tempId: 'copy', kind: 'image', title: original.title! }] })
  expect(canvas.get({}).nodes.map(node => node.title)).toEqual(['Renamed', 'Renamed'])
})
