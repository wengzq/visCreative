import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readEventsAfter } from './events'
import { openSpaceDb, type SpaceDb } from './open'
import * as s from './schema/space'
import { ackWorkMessages, claimWorkMessages, markWorkMessagesDelivered, readWorkMessageBatch, replayWorkMessages } from './work-messages'

describe('Work message batches', () => {
  let db: SpaceDb
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vis-work-messages-'))
    db = openSpaceDb(join(dir, 'space.db'))
    db.insert(s.workItems).values({ id: 'work_1', title: '工作项', workDir: '/tmp/work', createdBy: { kind: 'user' }, statusChangedAt: 1, createdAt: 1 }).run()
    db.insert(s.sessions).values([
      { id: 'ses_1', workItemId: 'work_1', agentKind: 'codex', title: 'worker', createdAt: 1 },
      { id: 'ses_2', workItemId: 'work_1', agentKind: 'codex', title: 'coordinator', createdAt: 1 },
    ]).run()
  })
  afterEach(() => {
    db.$client.close()
    rmSync(dir, { recursive: true, force: true })
  })

  function message(id: string, targetSessionId: string | null = 'ses_1', to: 'child' | 'parent' | 'user' = 'child', createdAt = 1) {
    db.insert(s.workMessages).values({ id, workItemId: 'work_1', kind: 'brief', from: { kind: 'user' }, to, body: id, targetSessionId, createdAt }).run()
  }

  it('merges pending messages for the same recipient; later messages enter a new batch', () => {
    message('wmsg_2', 'ses_1', 'child', 2)
    message('wmsg_1')
    message('wmsg_other', 'ses_2', 'parent')
    message('wmsg_user', null, 'user')
    expect(claimWorkMessages(db, 'ses_1', 'dlv_1').map(m => m.id)).toEqual(['wmsg_1', 'wmsg_2'])
    expect(claimWorkMessages(db, 'ses_1', 'dlv_2')).toEqual([])
    message('wmsg_3', 'ses_1', 'child', 3)
    expect(claimWorkMessages(db, 'ses_1', 'dlv_3').map(m => m.id)).toEqual(['wmsg_3'])
    expect(readWorkMessageBatch(db, 'ses_2', 'dlv_1')).toEqual([])
    expect(db.select().from(s.workMessages).where(eq(s.workMessages.id, 'wmsg_user')).get()?.deliveryId).toBeNull()
  })

  it('writes delivery time only at turn start, acknowledges by batch after success and preserves the first timestamp on duplicate notifications', () => {
    message('wmsg_1')
    message('wmsg_2')
    claimWorkMessages(db, 'ses_1', 'dlv_1')
    expect(ackWorkMessages(db, 'ses_1', 'dlv_1', 2)).toBe(0)
    expect(markWorkMessagesDelivered(db, 'ses_2', 'dlv_1', 3)).toBe(0)
    expect(markWorkMessagesDelivered(db, 'ses_1', 'dlv_1', 4)).toBe(2)
    expect(markWorkMessagesDelivered(db, 'ses_1', 'dlv_1', 5)).toBe(0)
    expect(ackWorkMessages(db, 'ses_1', 'wmsg_1', 6)).toBe(0)
    expect(ackWorkMessages(db, 'ses_2', 'dlv_1', 6)).toBe(0)
    expect(ackWorkMessages(db, 'ses_1', 'dlv_1', 7)).toBe(2)
    expect(ackWorkMessages(db, 'ses_1', 'dlv_1', 8)).toBe(0)
    expect(readWorkMessageBatch(db, 'ses_1', 'dlv_1')).toMatchObject([
      { deliveredAt: 4, ackedAt: 7 }, { deliveredAt: 4, ackedAt: 7 },
    ])
    expect(readEventsAfter(db, 0)).toMatchObject([{
      type: 'work.messageAcked', entityId: 'dlv_1',
      payload: { deliveryId: 'dlv_1', sessionId: 'ses_1', messageIds: ['wmsg_1', 'wmsg_2'], ackedAt: 7 },
    }])
    expect(replayWorkMessages(db, 'ses_1')).toEqual([])
  })

  it('existing batches cannot accept appended messages, reroute to other sessions or be reused after acknowledgment', () => {
    message('wmsg_1')
    claimWorkMessages(db, 'ses_1', 'dlv_1')
    message('wmsg_later')
    message('wmsg_other', 'ses_2', 'parent')
    expect(() => claimWorkMessages(db, 'ses_1', 'dlv_1')).toThrow(/batch already exists/)
    expect(() => claimWorkMessages(db, 'ses_1', 'dlv_1')).toThrow(expect.objectContaining({
      code: 'invalid_params', message: 'Delivery batch already exists: dlv_1',
      details: { reason: 'work.delivery_batch_exists', params: { deliveryId: 'dlv_1' } },
    }))
    expect(() => claimWorkMessages(db, 'ses_2', 'dlv_1')).toThrow(/batch already exists/)
    expect(readWorkMessageBatch(db, 'ses_1', 'dlv_1').map(m => m.id)).toEqual(['wmsg_1'])
    expect(db.select().from(s.workMessages).where(eq(s.workMessages.id, 'wmsg_other')).get()?.deliveryId).toBeNull()
    markWorkMessagesDelivered(db, 'ses_1', 'dlv_1', 2)
    ackWorkMessages(db, 'ses_1', 'dlv_1', 3)
    expect(() => claimWorkMessages(db, 'ses_1', 'dlv_1')).toThrow(/batch already exists/)
    expect(claimWorkMessages(db, 'ses_1', 'dlv_2').map(m => m.id)).toEqual(['wmsg_later'])
  })

  it('batch acknowledgment and its event roll back with the caller transaction', () => {
    message('wmsg_1')
    claimWorkMessages(db, 'ses_1', 'dlv_1')
    markWorkMessagesDelivered(db, 'ses_1', 'dlv_1', 2)
    expect(() => db.transaction(tx => {
      expect(ackWorkMessages(tx, 'ses_1', 'dlv_1', 3)).toBe(1)
      expect(readEventsAfter(tx, 0)).toHaveLength(1)
      throw new Error('Turn completion failed')
    }, { behavior: 'immediate' })).toThrow('Turn completion failed')
    expect(readWorkMessageBatch(db, 'ses_1', 'dlv_1')[0]?.ackedAt).toBeNull()
    expect(readEventsAfter(db, 0)).toEqual([])
    expect(ackWorkMessages(db, 'ses_1', 'dlv_1', 4)).toBe(1)
    expect(ackWorkMessages(db, 'ses_1', 'dlv_1', 5)).toBe(0)
    expect(readEventsAfter(db, 0)).toHaveLength(1)
  })

  it('failure or restart recovers the whole batch, marking only messages that actually started as redelivered', () => {
    message('wmsg_started')
    claimWorkMessages(db, 'ses_1', 'dlv_started')
    markWorkMessagesDelivered(db, 'ses_1', 'dlv_started', 2)
    message('wmsg_queued', 'ses_1', 'child', 3)
    claimWorkMessages(db, 'ses_1', 'dlv_queued')
    message('wmsg_unclaimed', 'ses_1', 'child', 4)
    db.$client.close()
    db = openSpaceDb(join(dir, 'space.db'))
    expect(replayWorkMessages(db, 'ses_2')).toEqual([])
    expect(replayWorkMessages(db, 'ses_1')).toMatchObject([
      { deliveryId: 'dlv_started', messages: [{ id: 'wmsg_started', redelivered: true, deliveredAt: 2, ackedAt: null }] },
      { deliveryId: 'dlv_queued', messages: [{ id: 'wmsg_queued', redelivered: false, deliveredAt: null, ackedAt: null }] },
    ])
    expect(replayWorkMessages(db, 'ses_1')).toHaveLength(2)
  })

  it('batch claiming and the session queue can roll back together', () => {
    message('wmsg_1')
    expect(() => db.transaction(tx => {
      claimWorkMessages(tx, 'ses_1', 'dlv_1')
      tx.insert(s.messages).values({ id: 'msg_1', sessionId: 'ses_1', text: 'brief', deliveryState: 'submitted', createdAt: 1 }).run()
      throw new Error('Queue write failed')
    }, { behavior: 'immediate' })).toThrow('Queue write failed')
    expect(db.select().from(s.messages).all()).toEqual([])
    expect(db.select().from(s.workMessages).get()?.deliveryId).toBeNull()
    expect(claimWorkMessages(db, 'ses_1', 'dlv_2')).toHaveLength(1)
  })
})
