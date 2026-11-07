import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { ApprovalPayload, FrameView, WorkMessageFrom } from '@vis/protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendEvent, currentSeq, readEventsAfter } from './events'
import { fingerprint, runIdempotent } from './idempotency'
import { isLegacyWorkspaceRequest, workspaceMigrationBoundary } from './migrate-workspaces'
import { openSpaceDb } from './open'
import * as s from './schema/space'
import { claimWorkMessages, replayWorkMessages } from './work-messages'

const now = 1_800_000_000_000

describe('0010 workspace unbinding migration', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'vis-workspace-migration-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('preserves legacy events and request caches verbatim, rejects old-result replay and never reexecutes', () => {
    const migrations = join(dir, 'old-cache-migrations')
    mkdirSync(join(migrations, 'meta'), { recursive: true })
    const journal = JSON.parse(readFileSync(new URL('../migrations/space/meta/_journal.json', import.meta.url), 'utf8'))
    const entries = journal.entries.slice(0, 10) as { tag: string }[]
    for (const entry of entries) copyFileSync(new URL(`../migrations/space/${entry.tag}.sql`, import.meta.url), join(migrations, `${entry.tag}.sql`))
    writeFileSync(join(migrations, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }))
    const file = join(dir, 'old-cache.db')
    const old = drizzle(new Database(file))
    migrate(old, { migrationsFolder: migrations })
    const params = { requestId: 'legacy-create', title: '原工作区' }
    const payload = ' { "workItemId": "work_old", "frameNodeId": "node_frame", "frameNodeCount": 1, "reviewBy": "coordinator" } '
    const result = ` { "item": ${payload}, "queued": false } `
    old.$client.prepare('INSERT INTO events (type, entity_type, entity_id, payload, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('work.itemChanged', 'work', 'work_old', payload, now)
    const insertCache = old.$client.prepare('INSERT INTO idempotency_keys (request_id, method, fingerprint, result, created_at) VALUES (?, ?, ?, ?, ?)')
    insertCache.run(params.requestId, 'work.create', fingerprint('work.create', params), result, now)
    const methods = ['generation.submit', 'canvas.apply', 'session.create', 'work.recall', 'work.delete', 'session.stop', 'generation.cancel']
    for (const method of methods) {
      const requestId = `legacy-${method}`
      const params = { requestId, ...(method === 'work.delete' ? { deleteCanvas: true } : {}) }
      insertCache.run(requestId, method, fingerprint(method, params), result, now)
    }
    const oldEvents = old.$client.prepare('SELECT * FROM events').all()
    const oldCaches = old.$client.prepare('SELECT * FROM idempotency_keys').all()
    old.$client.close()

    const upgraded = openSpaceDb(file)
    const boundary = { eventSeq: 1, idempotencyRowid: methods.length + 1 }
    let calls = 0
    try {
      expect(upgraded.$client.prepare('SELECT * FROM events').all()).toEqual(oldEvents)
      expect(upgraded.$client.prepare('SELECT * FROM idempotency_keys').all()).toEqual(oldCaches)
      expect(workspaceMigrationBoundary(upgraded)).toEqual(boundary)
      expect(isLegacyWorkspaceRequest(upgraded, params.requestId)).toBe(true)
      expect(isLegacyWorkspaceRequest(upgraded, 'unknown')).toBe(false)
      expect(() => runIdempotent(upgraded, { requestId: params.requestId, method: 'work.create', params }, () => { calls++; return {} }))
        .toThrow(expect.objectContaining({ code: 'request_not_replayable' }))
      for (const method of methods) {
        const requestId = `legacy-${method}`
        const params = { requestId, ...(method === 'work.delete' ? { deleteCanvas: true } : {}) }
        const replay = () => runIdempotent(upgraded, { requestId, method, params }, () => { calls++; return {} })
        if (['generation.submit', 'canvas.apply', 'session.create'].includes(method)) {
          expect(replay).toThrow(expect.objectContaining({ code: 'request_not_replayable' }))
        } else expect(replay()).toEqual(JSON.parse(result))
      }
      expect(calls).toBe(0)
      for (const method of ['work.create', 'work.delete']) {
        const requestId = method === 'work.create' ? params.requestId : `legacy-${method}`
        expect(() => runIdempotent(upgraded, { requestId, method, params: { requestId } }, () => { calls++; return {} }))
          .toThrow(expect.objectContaining({ code: 'idempotency_conflict' }))
      }
      expect(() => runIdempotent(upgraded, { requestId: params.requestId, method: 'session.create', params }, () => { calls++; return {} }))
        .toThrow(expect.objectContaining({ code: 'idempotency_conflict' }))
      expect(calls).toBe(0)
      expect(upgraded.$client.prepare('SELECT * FROM idempotency_keys').all()).toEqual(oldCaches)

      // Equal timestamps or clock rollback must not misclassify post-upgrade requests as legacy cache entries.
      for (const at of [now, now - 1000]) {
        const requestId = `new-${at}`
        const replay = () => runIdempotent(upgraded, { requestId, method: 'work.create', params: {} }, () => ({ n: ++calls }), () => at)
        const expected = { n: calls + 1 }
        expect(replay()).toEqual(expected)
        expect(replay()).toEqual(expected)
        expect(isLegacyWorkspaceRequest(upgraded, requestId)).toBe(false)
      }
      expect(calls).toBe(2)
      appendEvent(upgraded, { type: 'node.created', entityType: 'node', entityId: 'node_new', payload: { id: 'node_new' } }, now)
    } finally { upgraded.$client.close() }

    const reopened = openSpaceDb(file)
    try {
      expect(workspaceMigrationBoundary(reopened)).toEqual(boundary)
      expect(currentSeq(reopened)).toBe(2)
      expect(isLegacyWorkspaceRequest(reopened, params.requestId)).toBe(true)
      expect(isLegacyWorkspaceRequest(reopened, `new-${now - 1000}`)).toBe(false)
      expect(runIdempotent(reopened, { requestId: `new-${now - 1000}`, method: 'work.create', params: {} }, () => { calls++; return {} })).toEqual({ n: 2 })
      expect(calls).toBe(2)
      expect(reopened.$client.prepare('SELECT * FROM events WHERE seq = 1').all()).toEqual(oldEvents)
      expect(reopened.$client.prepare('SELECT * FROM idempotency_keys WHERE rowid <= ?').all(boundary.idempotencyRowid)).toEqual(oldCaches)
    } finally { reopened.$client.close() }
  })

  it('upgrades existing parent-child workspaces, preserving canvas, message delivery and other authorizations while rejecting legacy outside-frame approvals without restoring bindings', () => {
    const migrations = join(dir, 'old-migrations')
    mkdirSync(join(migrations, 'meta'), { recursive: true })
    const journal = JSON.parse(readFileSync(new URL('../migrations/space/meta/_journal.json', import.meta.url), 'utf8'))
    const entries = journal.entries.slice(0, 10) as { tag: string }[]
    for (const entry of entries) copyFileSync(new URL(`../migrations/space/${entry.tag}.sql`, import.meta.url), join(migrations, `${entry.tag}.sql`))
    writeFileSync(join(migrations, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }))
    const file = join(dir, 'space.db')
    const old = drizzle(new Database(file))
    migrate(old, { migrationsFolder: migrations })
    old.$client.pragma('foreign_keys = ON')
    old.$client.prepare('INSERT INTO nodes (id, kind, x, y, w, h, z, frame, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('node_frame', 'frame', 50, 60, 800, 600, -1, JSON.stringify({ title: '原框', color: 'blue', workItemId: 'work_child' }), now)
    old.$client.prepare('INSERT INTO nodes (id, kind, x, y, w, h, z, frame_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('node_image', 'image', 100, 120, 320, 200, 0, 'node_frame', now)
    const work = old.$client.prepare('INSERT INTO work_items (id, parent_id, title, review_by, work_dir, frame_node_id, created_by, status_changed_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    work.run('work_parent', null, '父工作区', 'user', '/work/parent', null, '{"kind":"user"}', now, now)
    work.run('work_child', 'work_parent', '子工作区', 'coordinator', '/work/child', 'node_frame', '{"kind":"user"}', now, now)
    const session = old.$client.prepare('INSERT INTO sessions (id, agent_kind, title, work_item_id, role, work_dir, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    session.run('ses_parent', 'codex', '原主会话', 'work_parent', 'coordinator', '/work/parent', now)
    session.run('ses_child', 'deepseek', '原子会话', 'work_child', 'worker', '/work/child', now + 1)
    session.run('ses_other', 'codex', '其他会话', 'work_child', 'chat', '/work/child', now + 2)
    const message = old.$client.prepare('INSERT INTO work_messages (id, work_item_id, kind, "from", "to", body, target_session_id, delivery_id, delivered_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    message.run('wmsg_report', 'work_child', 'done', JSON.stringify({ kind: 'session', sessionId: 'ses_child', role: 'worker' }), 'coordinator', '完成报告', 'ses_parent', 'dlv_started', now + 2, now + 1)
    message.run('wmsg_reply', 'work_child', 'reply', JSON.stringify({ kind: 'session', sessionId: 'ses_parent', role: 'coordinator' }), 'worker', '继续处理', 'ses_child', null, null, now + 2)
    message.run('wmsg_user', 'work_child', 'question', '{"kind":"user"}', 'user', '请确认', null, null, null, now + 3)
    old.$client.prepare('UPDATE work_items SET review_report_id = ? WHERE id = ?').run('wmsg_report', 'work_child')
    const input = old.$client.prepare('INSERT INTO messages (id, session_id, text, delivery_state, created_at) VALUES (?, ?, ?, ?, ?)')
    const turn = old.$client.prepare('INSERT INTO turns (id, session_id, message_id, status, started_at) VALUES (?, ?, ?, ?, ?)')
    input.run('msg_frame', 'ses_child', '修改画布', 'delivered', now)
    input.run('msg_command', 'ses_other', '执行命令', 'delivered', now)
    turn.run('trn_frame', 'ses_child', 'msg_frame', 'waiting_user', now)
    turn.run('trn_command', 'ses_other', 'msg_command', 'waiting_user', now)
    const approval = old.$client.prepare('INSERT INTO transcript_entries (session_id, item_id, created_seq, revision, turn_id, kind, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    const framePayload = { approvalId: 'approval_frame', kind: 'canvas_outside_frame', summary: '写入框外节点', detail: '原审批详情', nodeIds: ['node_image'], status: 'pending' }
    approval.run('ses_child', 'approval_frame', 1, 1, 'trn_frame', 'approval', JSON.stringify(framePayload), now, now)
    approval.run('ses_child', 'approval_grant', 2, 2, null, 'approval', JSON.stringify({ ...framePayload, approvalId: 'approval_grant', status: 'approved', decision: 'allow_session' }), now, now)
    const commandGrant = { approvalId: 'approval_command', kind: 'command', summary: '命令授权', detail: 'pwd', cwd: '/work/child', status: 'approved', decision: 'allow_session' }
    approval.run('ses_child', 'approval_command', 3, 2, null, 'approval', JSON.stringify(commandGrant), now, now)
    const { decision: _, ...command } = commandGrant
    const commandPending = { ...command, approvalId: 'approval_pending', status: 'pending' }
    approval.run('ses_other', 'approval_pending', 1, 1, 'trn_command', 'approval', JSON.stringify(commandPending), now, now)
    old.$client.prepare('INSERT INTO operations (id, actor_kind, created_at) VALUES (?, ?, ?)').run('op_old', 'user', now)
    const presence = { kind: 'presence', nodeId: 'node_frame', deleted: true }
    old.$client.prepare('INSERT INTO undo_entries (id, operation_id, state, inverse, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('op_old', 'op_old', 'done', JSON.stringify({ steps: [presence, { kind: 'frameBinding', nodeId: 'node_frame', workItemId: 'work_child', frameNodeId: null }], nodes: { node_frame: false }, slots: {}, workFrames: { work_child: 'node_frame' } }), now)
    old.$client.close()

    const upgraded = openSpaceDb(file)
    expect(upgraded.$client.pragma('foreign_keys', { simple: true })).toBe(1)
    expect(upgraded.$client.pragma('foreign_key_check')).toEqual([])
    expect(upgraded.$client.pragma('table_info(work_items)')).not.toContainEqual(expect.objectContaining({ name: 'frame_node_id' }))
    expect(upgraded.$client.pragma('table_info(sessions)')).not.toContainEqual(expect.objectContaining({ name: 'role' }))
    expect(upgraded.select().from(s.workItems).all()).toMatchObject([
      { id: 'work_parent', parentId: null, title: '父工作区', reviewBy: 'user', workDir: '/work/parent' },
      { id: 'work_child', parentId: 'work_parent', title: '子工作区', reviewBy: 'parent', workDir: '/work/child', reviewReportId: 'wmsg_report' },
    ])
    const nodes = upgraded.select().from(s.nodes).all()
    expect(nodes).toMatchObject([
      { id: 'node_frame', x: 50, y: 60, w: 800, h: 600, frame: { title: '原框', color: 'blue' } },
      { id: 'node_image', x: 100, y: 120, frameId: 'node_frame' },
    ])
    expect(FrameView.parse(nodes[0]!.frame)).toEqual({ title: '原框', color: 'blue' })
    expect(nodes[0]!.frame).not.toHaveProperty('workItemId')
    const messages = upgraded.select().from(s.workMessages).all()
    expect(messages).toMatchObject([
      { id: 'wmsg_report', to: 'parent', targetSessionId: 'ses_parent', deliveryId: 'dlv_started', deliveredAt: now + 2, ackedAt: null, from: { kind: 'session', sessionId: 'ses_child' } },
      { id: 'wmsg_reply', to: 'child', targetSessionId: 'ses_child', deliveryId: null },
      { id: 'wmsg_user', to: 'user', targetSessionId: null },
    ])
    for (const row of messages) expect(WorkMessageFrom.parse(row.from)).toEqual(row.from)
    expect(replayWorkMessages(upgraded, 'ses_parent')).toMatchObject([{ deliveryId: 'dlv_started', messages: [{ id: 'wmsg_report', redelivered: true }] }])
    expect(claimWorkMessages(upgraded, 'ses_child', 'dlv_new').map(row => row.id)).toEqual(['wmsg_reply'])
    const approvals = upgraded.select().from(s.transcriptEntries).all()
    for (const row of approvals) expect(ApprovalPayload.parse(row.payload)).toEqual(row.payload)
    expect(approvals.slice(0, 2)).toMatchObject([
      { revision: 2, payload: { kind: 'other', status: 'expired', decision: 'deny', detail: '原审批详情' } },
      { revision: 3, payload: { kind: 'other', status: 'expired', decision: 'deny' } },
    ])
    expect(approvals[0]!.payload).not.toHaveProperty('nodeIds')
    expect(approvals[2]).toMatchObject({ revision: 2, payload: commandGrant, updatedAt: now })
    expect(approvals[3]).toMatchObject({ revision: 1, payload: commandPending, updatedAt: now })
    expect(upgraded.select().from(s.turns).all()).toMatchObject([{ id: 'trn_frame', status: 'failed', endedAt: expect.any(Number) }, { id: 'trn_command', status: 'waiting_user', endedAt: null }])
    expect(upgraded.select().from(s.sessions).all()).toMatchObject([{ id: 'ses_parent', queuePaused: false }, { id: 'ses_child', queuePaused: true }, { id: 'ses_other', queuePaused: false }])
    expect(upgraded.select().from(s.undoEntries).get()!.inverse).toEqual({ steps: [presence], nodes: { node_frame: false }, slots: {} })
    upgraded.insert(s.sessions).values({ id: 'ses_extra', agentKind: 'codex', title: '额外会话', workItemId: 'work_child', createdAt: now + 3 }).run()
    const events = readEventsAfter(upgraded, 0)
    expect(events).toContainEqual(expect.objectContaining({ type: 'turn.stateChanged', payload: { turnId: 'trn_frame', status: 'failed' } }))
    const boundary = { eventSeq: currentSeq(upgraded), idempotencyRowid: 0 }
    expect(workspaceMigrationBoundary(upgraded)).toEqual(boundary)
    upgraded.$client.close()

    const reopened = openSpaceDb(file)
    expect(reopened.select().from(s.transcriptEntries).all()).toEqual(approvals)
    expect(readEventsAfter(reopened, 0)).toEqual(events)
    expect(workspaceMigrationBoundary(reopened)).toEqual(boundary)
    expect(reopened.select().from(s.sessions).all()).toHaveLength(4)
    reopened.$client.close()
  })
})
