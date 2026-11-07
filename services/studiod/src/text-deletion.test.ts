import { expect, it } from 'vitest'
import { createCanvasService } from '@vis/canvas-core'
import { openSpaceDb, spaceSchema as s } from '@vis/storage'
import { createTextDeletionService, refreshTextDeletionApprovals } from './text-deletion'

it('expires deletion approvals without deleting text and never treats session grants or auto mode as authorization', () => {
  const db = openSpaceDb(':memory:')
  let at = 1000
  const deletion = createTextDeletionService(db, () => at)
  try {
    db.insert(s.sessions).values({ id: 'session', title: 'Writer', agentKind: 'codex', approvalMode: 'auto', createdAt: 1 }).run()
    db.insert(s.messages).values({ id: 'message', sessionId: 'session', text: 'Request', deliveryState: 'delivered', createdAt: 1 }).run()
    db.insert(s.turns).values({ id: 'turn', sessionId: 'session', messageId: 'message', status: 'running' }).run()
    const canvas = createCanvasService({ db, onChanged: tx => refreshTextDeletionApprovals(tx, at) })
    const nodeId = canvas.apply({ kind: 'user' }, { requestId: 'seed', ops: [{ op: 'node.create', tempId: 'book', kind: 'text', content: { text: 'Author prose' } }] }).idMap.book!
    const requested = deletion.request({ requestId: 'request', nodeId, expectedRevision: 1 }, 'session', 'turn')
    expect(requested.status).toBe('pending')
    expect(canvas.get({}).nodes).toHaveLength(1)
    expect(() => deletion.respond({ requestId: 'session-grant', approvalId: requested.approvalId, decision: 'allow_session' })).toThrowError(expect.objectContaining({ details: { reason: 'writing.delete_once_only', params: {} } }))
    at += 10 * 60_000
    deletion.expire()
    expect(deletion.respond({ requestId: 'expired', approvalId: requested.approvalId, decision: 'allow_once' })).toEqual({ status: 'expired' })
    expect(canvas.get({}).nodes[0]!.slots[0]!.content).toEqual({ type: 'text', body: 'Author prose' })
  } finally { deletion.close(); db.$client.close() }
})
