import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createCanvasService } from '@vis/canvas-core'
import * as protocol from '@vis/protocol'
import { openSpaceDb, type SpaceDb } from '@vis/storage'
import { assertAgentMediaPurpose } from './canvas-permissions'

let db: SpaceDb
beforeEach(() => { db = openSpaceDb(':memory:') })
afterEach(() => { vi.restoreAllMocks(); db.$client.close() })

it('follows the protocol classifier when another canvas kind becomes media', () => {
  vi.spyOn(protocol, 'isMediaKind').mockImplementation((kind): kind is protocol.MediaKind => kind === 'future-media')
  const op = { op: 'node.create', tempId: 'future', kind: 'future-media', purpose: 'working' } as unknown as protocol.CanvasOp
  expect(() => db.transaction(tx => assertAgentMediaPurpose(tx, [op]))).toThrow(expect.objectContaining({
    code: 'forbidden', details: { reason: 'canvas.working_media_forbidden', params: { tempId: 'future' } },
  }))
})

it('reads existing node state once for a batch with many metadata operations', () => {
  const canvas = createCanvasService({ db })
  const created = canvas.apply({ kind: 'user' }, { requestId: 'seed', ops: [
    { op: 'node.create', tempId: 'text', kind: 'text' },
    { op: 'node.create', tempId: 'script', kind: 'script' },
    { op: 'node.create', tempId: 'timeline', kind: 'timeline' },
  ] })
  const ops: protocol.CanvasOp[] = Array.from({ length: 30 }, () => Object.values(created.idMap)
    .map(nodeId => ({ op: 'node.setMeta' as const, nodeId, purpose: 'working' as const }))).flat()
  db.transaction(tx => {
    const select = vi.spyOn(tx, 'select')
    assertAgentMediaPurpose(tx, ops)
    expect(select).toHaveBeenCalledTimes(1)
  })
})
