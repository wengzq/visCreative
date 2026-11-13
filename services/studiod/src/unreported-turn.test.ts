import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq, openSpaceDb, spaceSchema as s, type SpaceDb } from '@vis/storage'
import type { WorkItemView } from '@vis/protocol'
import { createSessionService, DispatchError, type DispatchInput, type SessionService } from '@vis/workbench-core'
import { createWorkService, type WorkService } from './work-service'

let dir: string
let db: SpaceDb
let sessions: SessionService
let work: WorkService
let parent: WorkItemView
let calls: DispatchInput[]
let clock: number
let frozen: boolean
const rid = () => crypto.randomUUID()
const now = () => frozen ? clock : ++clock
const cancel = vi.fn()
const interrupt = vi.fn(async () => {})
const failures = vi.fn()
const dispatch = vi.fn(async (input: DispatchInput) => { calls.push(input) })

function openServices() {
  sessions = createSessionService({
    db, rootPath: dir, now,
    runtime: { ensureReady: async () => {}, dispatchTurn: dispatch, interruptTurn: interrupt, terminateTurn: async () => {} },
    onWorkFailure(t, failure, key) { failures(failure, key); work.notifySessionFailure(t, failure, key) },
  })
  work = createWorkService({
    db, spaceId: 'space', rootPath: dir, now, sessions, generation: { cancel },
    slots: { reserve: () => true, release: () => {} },
  })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vis-unreported-'))
  db = openSpaceDb(join(dir, 'space.db'))
  clock = 1_800_000_000_000
  frozen = false
  calls = []
  cancel.mockClear()
  interrupt.mockClear()
  failures.mockClear()
  dispatch.mockReset().mockImplementation(async input => { calls.push(input) })
  openServices()
  parent = work.create({ requestId: rid(), title: 'Parent', chat: { agentKind: 'codex' } }).item
})

afterEach(async () => {
  sessions.dispose()
  await sessions.idle()
  db.$client.close()
  rmSync(dir, { recursive: true, force: true })
})

const detail = (item: WorkItemView) => work.get({ workItemId: item.workItemId })
const notices = (item: WorkItemView) => {
  const seq = (id: string) => db.select({ seq: s.events.seq }).from(s.events).where(eq(s.events.entityId, id)).get()!.seq
  return detail(item).messages.filter(message => message.from.kind === 'system' && message.from.failure?.reason === 'turn_unreported').sort((a, b) => seq(a.messageId) - seq(b.messageId))
}
const actor = (item: WorkItemView) => ({ workItemId: item.workItemId, sessionId: item.sessions[0]!.sessionId })
const lastTurn = (item: WorkItemView) => calls.filter(call => call.sessionId === actor(item).sessionId).at(-1)!

function secondSession(item: WorkItemView) {
  const sessionId = rid()
  db.insert(s.sessions).values({ id: sessionId, workItemId: item.workItemId, title: 'Second child session', agentKind: 'codex', workDir: item.workDir, createdAt: now() }).run()
  return { sessionId, workItemId: item.workItemId }
}

async function child(brief = 'Do the assigned work') {
  const item = (await work.dispatch({ requestId: rid(), parentId: parent.workItemId, title: 'Child', brief, agentKind: 'codex' }, () => undefined)).item
  await sessions.idle()
  return item
}

async function end(input: DispatchInput, status: 'completed' | 'failed' | 'interrupted' = 'completed') {
  sessions.handleAgentEvent({ type: 'turn_ended', sessionId: input.sessionId, turnId: input.turnId, status })
  await sessions.idle()
}

async function reply(item: WorkItemView) {
  work.reply({ requestId: rid(), workItemId: item.workItemId, body: 'Please continue' })
  await sessions.idle()
  return lastTurn(item)
}

async function restart() {
  sessions.dispose()
  await sessions.idle()
  db.$client.close()
  db = openSpaceDb(join(dir, 'space.db'))
  openServices()
  sessions.recover()
  await sessions.idle()
}

describe('Unreported completed child turns', () => {
  it.each(['stop', 'recall', 'deletion', 'archive'] as const)('does not wake the parent when a turn completes during %s', async action => {
    const item = await child()
    const input = lastTurn(item)
    const parentTurns = calls.filter(call => call.sessionId === actor(parent).sessionId).length
    if (action === 'stop') await sessions.stop({ requestId: rid(), sessionId: input.sessionId, turnId: input.turnId })
    if (action === 'recall') await work.recall({ requestId: rid(), workItemId: item.workItemId })
    if (action === 'deletion') work.prepareDelete({ requestId: rid(), workItemId: item.workItemId })
    if (action === 'archive') db.update(s.workItems).set({ archivedAt: now() }).where(eq(s.workItems.id, item.workItemId)).run()
    await end(input)
    expect(db.select().from(s.workMessages).where(eq(s.workMessages.workItemId, item.workItemId)).all()
      .filter(message => message.from.kind === 'system' && message.from.failure?.reason === 'turn_unreported')).toHaveLength(0)
    expect(calls.filter(call => call.sessionId === actor(parent).sessionId)).toHaveLength(parentTurns)
  })

  it('does not revive an old batch expectation after a move to review and back followed by author chat', async () => {
    const item = await child()
    work.move({ requestId: rid(), workItemId: item.workItemId, status: 'in_review' })
    await end(lastTurn(item))
    work.move({ requestId: rid(), workItemId: item.workItemId, status: 'in_progress' })
    sessions.sendMessage({ requestId: rid(), sessionId: actor(item).sessionId, text: 'Author conversation after the run ended', refs: [] })
    await sessions.idle()
    await end(lastTurn(item))
    expect(notices(item)).toHaveLength(0)
  })

  it.each(['failed', 'interrupted'] as const)('author continue after a %s batch turn does not create a reporting expectation', async status => {
    const item = await child()
    await end(lastTurn(item), status)
    await end(lastTurn(item), status)
    sessions.sendMessage({ requestId: rid(), sessionId: actor(item).sessionId, text: 'Continue', refs: [] })
    sessions.resumeQueue({ requestId: rid(), sessionId: actor(item).sessionId })
    await sessions.idle()
    expect(lastTurn(item).text).toBe('Continue')
    await end(lastTurn(item))
    expect(notices(item)).toHaveLength(0)
  })

  it('does not reconnect a batch across an idle gap before several queued author messages', async () => {
    const item = await child()
    work.move({ requestId: rid(), workItemId: item.workItemId, status: 'in_review' })
    await end(lastTurn(item))
    work.move({ requestId: rid(), workItemId: item.workItemId, status: 'in_progress' })
    sessions.sendMessage({ requestId: rid(), sessionId: actor(item).sessionId, text: 'Start a new author conversation', refs: [] })
    await sessions.idle()
    sessions.sendMessage({ requestId: rid(), sessionId: actor(item).sessionId, text: 'Queued in the new conversation', refs: [] })
    await end(lastTurn(item))
    await end(lastTurn(item))
    expect(notices(item)).toHaveLength(0)
  })

  it('uses the latest successful retry as the start of the reporting run', async () => {
    const item = await child()
    await end(lastTurn(item), 'failed')
    await end(lastTurn(item))
    expect(notices(item)).toHaveLength(1)
  })

  it('extends the run through a sibling turn before checking a message queued after the batch turn ended', async () => {
    const item = await child()
    const first = lastTurn(item)
    const second = secondSession(item)
    sessions.sendMessage({ requestId: rid(), sessionId: second.sessionId, text: 'Continue while the batch is running', refs: [] })
    await sessions.idle()
    const middle = calls.filter(call => call.sessionId === second.sessionId).at(-1)!
    await end(first)
    sessions.sendMessage({ requestId: rid(), sessionId: second.sessionId, text: 'Queued after the batch ended but before the sibling finished', refs: [] })
    await end(middle)
    expect(notices(item)).toHaveLength(0)
    const final = calls.filter(call => call.sessionId === second.sessionId).at(-1)!
    await end(final)
    expect(notices(item)).toHaveLength(1)
    expect(notices(item)[0]!.from).toMatchObject({ failure: { turnId: final.turnId } })
  })

  it.each([false, true])('keeps the warning cleared after returning from review and restarting, with frozen time %s', async freeze => {
    frozen = freeze
    const item = await child()
    await end(lastTurn(item))
    expect(detail(item).item.failure).toMatchObject({ reason: 'turn_unreported' })
    work.move({ requestId: rid(), workItemId: item.workItemId, status: 'in_review' })
    expect(detail(item).item.failure).toBeNull()
    work.move({ requestId: rid(), workItemId: item.workItemId, status: 'in_progress' })
    expect(detail(item).item.failure).toBeNull()
    await restart()
    expect(detail(item).item.failure).toBeNull()
    expect(notices(item)).toHaveLength(1)
    await end(await reply(item))
    expect(detail(item).item.failure).toMatchObject({ reason: 'turn_unreported', turnId: lastTurn(item).turnId })
  })

  it.each(['active', 'draft', 'undelivered'] as const)('ignores dead %s work in an archived sibling session', async kind => {
    const item = await child()
    const second = secondSession(item)
    if (kind === 'active') {
      sessions.sendMessage({ requestId: rid(), sessionId: second.sessionId, text: 'Archived running turn', refs: [] })
      await sessions.idle()
    } else if (kind === 'draft') {
      db.update(s.sessions).set({ queuePaused: true }).where(eq(s.sessions.id, second.sessionId)).run()
      sessions.sendMessage({ requestId: rid(), sessionId: second.sessionId, text: 'Dead archived draft', refs: [] })
    } else {
      db.insert(s.workMessages).values({ id: rid(), workItemId: item.workItemId, kind: 'reply', from: { kind: 'user' }, to: 'child', body: 'Reply addressed to an archived session', targetSessionId: second.sessionId, createdAt: now() }).run()
    }
    db.update(s.sessions).set({ archivedAt: now() }).where(eq(s.sessions.id, second.sessionId)).run()
    await end(lastTurn(item))
    expect(notices(item)).toHaveLength(1)
  })

  it('ignores a terminally rejected batch and its retained dead draft', async () => {
    const item = await child()
    const second = secondSession(item)
    dispatch.mockImplementation(async input => {
      if (input.sessionId === second.sessionId) throw new DispatchError('rejected', 'Rejected by the fake runtime')
      calls.push(input)
    })
    db.insert(s.workMessages).values({ id: 'rejected-reply', workItemId: item.workItemId, kind: 'reply', from: { kind: 'user' }, to: 'child', body: 'Rejected sibling batch', targetSessionId: second.sessionId, createdAt: now() }).run()
    sessions.notifyWorkActivated(second.sessionId)
    await sessions.idle()
    const rejected = db.select().from(s.workMessages).where(eq(s.workMessages.id, 'rejected-reply')).get()!
    expect(rejected.redelivered).toBe(true)
    expect(detail(item).messages.some(message => message.from.kind === 'system' && message.from.failure?.reason === 'dispatch_rejected')).toBe(true)
    // Send-now rejection also leaves this durable undelivered shape.
    db.update(s.workMessages).set({ deliveredAt: null }).where(eq(s.workMessages.id, rejected.id)).run()
    db.insert(s.messages).values({ id: rid(), sessionId: second.sessionId, text: 'Retained rejected draft', deliveryState: 'draft', workDeliveryId: rejected.deliveryId, createdAt: rejected.createdAt }).run()
    await end(lastTurn(item))
    expect(notices(item)).toHaveLength(1)
  })

  it('waits for a fresh manual retry of a rejected batch even when all timestamps tie', async () => {
    frozen = true
    const item = await child()
    const second = secondSession(item)
    dispatch.mockImplementation(async input => {
      if (input.sessionId === second.sessionId) throw new DispatchError('rejected', 'Rejected by the fake runtime')
      calls.push(input)
    })
    db.insert(s.workMessages).values({ id: 'retry-reply', workItemId: item.workItemId, kind: 'reply', from: { kind: 'user' }, to: 'child', body: 'Retry this sibling batch', targetSessionId: second.sessionId, createdAt: now() }).run()
    sessions.notifyWorkActivated(second.sessionId)
    await sessions.idle()
    const rejected = db.select().from(s.messages).where(eq(s.messages.sessionId, second.sessionId)).all().at(-1)!
    expect(rejected.deliveryState).toBe('rejected')
    dispatch.mockImplementation(async input => { calls.push(input) })
    sessions.retryMessage({ requestId: rid(), messageId: rejected.id })
    db.update(s.sessions).set({ queuePaused: true }).where(eq(s.sessions.id, second.sessionId)).run()
    await end(lastTurn(item))
    expect(notices(item)).toHaveLength(0)
    sessions.resumeQueue({ requestId: rid(), sessionId: second.sessionId })
    await sessions.idle()
    await end(calls.filter(call => call.sessionId === second.sessionId).at(-1)!)
    expect(notices(item)).toHaveLength(1)
  })

  it('records a completed turn during shutdown without starting the parent and delivers the notice after restart', async () => {
    const item = await child()
    const input = lastTurn(item)
    sessions.dispose()
    await end(input)
    expect(notices(item)).toHaveLength(1)
    expect(calls.filter(call => call.sessionId === actor(parent).sessionId)).toHaveLength(0)
    const notice = notices(item)[0]!
    expect(db.select().from(s.workMessages).where(eq(s.workMessages.id, notice.messageId)).get()).toMatchObject({ deliveryId: null, targetSessionId: actor(parent).sessionId })
    await restart()
    expect(lastTurn(parent).text).toContain(notice.body)
    expect(notices(item)).toHaveLength(1)
  })

  it.each([false, true])('keeps the last non-empty assistant reply when the final queued turn has only tools, with blank assistant text %s', async blank => {
    const item = await child()
    const first = lastTurn(item)
    sessions.handleAgentEvent({ type: 'item', sessionId: first.sessionId, turnId: first.turnId, itemId: 'question', revision: 1, kind: 'assistant_text', payload: { text: 'Which version should I deliver?' } })
    sessions.sendMessage({ requestId: rid(), sessionId: first.sessionId, text: 'Check the files too', refs: [] })
    await end(first)
    const final = lastTurn(item)
    sessions.handleAgentEvent({ type: 'item', sessionId: final.sessionId, turnId: final.turnId, itemId: 'tool', revision: 1, kind: 'tool_call', payload: { toolUseId: 'read-files', name: 'read_files' } })
    if (blank) sessions.handleAgentEvent({ type: 'item', sessionId: final.sessionId, turnId: final.turnId, itemId: 'empty', revision: 1, kind: 'assistant_text', payload: { text: '  ' } })
    await end(final)
    expect(notices(item)).toHaveLength(1)
    expect(notices(item)[0]!.body).toContain('Which version should I deliver?')
  })

  it('keeps the final 500 code points without splitting an emoji', async () => {
    const item = await child()
    const input = lastTurn(item)
    const text = `Discarded prefix 🙂${'x'.repeat(499)}`
    sessions.handleAgentEvent({ type: 'item', sessionId: input.sessionId, turnId: input.turnId, itemId: 'emoji', revision: 1, kind: 'assistant_text', payload: { text } })
    await end(input)
    const notice = notices(item)[0]!
    expect(notice.from.kind === 'system' && JSON.parse(notice.from.failure!.detail!).reply).toBe(`🙂${'x'.repeat(499)}`)
  })

  it('does not query delivery start events when no report ties its delivery time', async () => {
    const item = await child()
    const prepared = vi.spyOn(db.$client, 'prepare')
    try {
      await end(lastTurn(item))
      expect(prepared.mock.calls.filter(([query]) => query.includes('from "events" inner join "turns"'))).toHaveLength(0)
    } finally { prepared.mockRestore() }
  })

  it('does not read event sequence numbers to order messages in the same delivery or render a tied warning', async () => {
    frozen = true
    const item = (await work.dispatch({ requestId: rid(), parentId: parent.workItemId, title: 'Batched child', brief: 'First input', agentKind: 'codex', activate: false }, () => undefined)).item
    work.activate({ requestId: rid(), workItemId: item.workItemId })
    work.reply({ requestId: rid(), workItemId: item.workItemId, body: 'Second input' })
    work.reply({ requestId: rid(), workItemId: item.workItemId, body: 'Third input' })
    await sessions.idle()
    const input = lastTurn(item)
    const prepared = vi.spyOn(db.$client, 'prepare')
    try {
      await end(input)
      detail(item)
      expect(prepared.mock.calls.filter(([query]) => query.includes('from "events"') && query.includes('"events"."entity_id" = ?'))).toHaveLength(0)
      expect(notices(item)).toHaveLength(1)
    } finally { prepared.mockRestore() }
  })

  it('renders and clears warnings with tied notices and reports without reading event sequences', async () => {
    frozen = true
    const item = await child()
    await end(lastTurn(item))
    await end(await reply(item))
    const latest = lastTurn(item)
    const prepared = vi.spyOn(db.$client, 'prepare')
    try {
      expect(detail(item).item.failure).toMatchObject({ reason: 'turn_unreported', turnId: latest.turnId })
      work.report({ requestId: rid(), kind: 'question', body: 'A report clears the warning' }, actor(item))
      expect(detail(item).item.failure).toBeNull()
      expect(prepared.mock.calls.filter(([query]) => query.includes('from "events"') && query.includes('"events"."entity_id" = ?'))).toHaveLength(0)
    } finally { prepared.mockRestore() }
  })

  it('delivers one durable notice per batch with the final reply tail and unfinished generation count, without stopping or failing work', async () => {
    const item = await child()
    const input = lastTurn(item)
    const final = `${'discard this prefix '.repeat(60)}Should I use option A or option B?`
    sessions.handleAgentEvent({ type: 'item', sessionId: input.sessionId, turnId: input.turnId, itemId: 'early', revision: 1, kind: 'assistant_text', payload: { text: 'An earlier assistant message' } })
    sessions.handleAgentEvent({ type: 'item', sessionId: input.sessionId, turnId: input.turnId, itemId: 'final', revision: 1, kind: 'assistant_text', payload: { text: final } })
    for (const [index, status] of ['queued', 'running', 'finalizing', 'succeeded', 'failed', 'cancelled', 'unknown'].entries()) {
      db.insert(s.generationJobs).values({ id: `job-${index}`, sessionId: input.sessionId, kind: 'image', provider: 'mock', model: 'mock-image-1', params: {}, status: status as typeof s.generationJobs.$inferSelect.status, createdAt: now(), updatedAt: now() }).run()
    }
    await end(input)
    const notice = notices(item)[0]!
    const batch = detail(item).messages.find(message => message.kind === 'brief')!
    expect(notice.messageId).toBe(`wmsg_failure_${item.workItemId}_unreported_${batch.deliveryId}`)
    expect(notice.body).toContain('ended its turn without reporting. Nothing was stopped.')
    expect(notice.body).toContain('Reply to the child, recall it, or keep waiting.')
    expect(notice.body).toContain('Unfinished generation jobs: 3.')
    expect(notice.body.endsWith(final.slice(-500))).toBe(true)
    expect(notice.body).not.toContain('An earlier assistant message')
    expect(notice.from.kind === 'system' && JSON.parse(notice.from.failure!.detail!)).toEqual({ unfinishedJobs: 3, reply: final.slice(-500) })
    expect(db.select().from(s.workMessages).where(eq(s.workMessages.id, notice.messageId)).get()).toMatchObject({ targetSessionId: parent.sessions[0]!.sessionId, to: 'parent' })
    expect(lastTurn(parent).text).toContain(notice.body)
    expect(detail(item).item).toMatchObject({ status: 'in_progress', activity: 'idle', failure: { reason: 'turn_unreported' } })
    expect(interrupt).not.toHaveBeenCalled()
    expect(cancel).not.toHaveBeenCalled()
    await end(input)
    expect(notices(item)).toHaveLength(1)
  })

  it('drops the card warning once the child leaves in_progress, keeping the notice in history', async () => {
    const item = await child()
    await end(lastTurn(item))
    expect(detail(item).item.failure).toMatchObject({ reason: 'turn_unreported' })
    work.move({ requestId: rid(), workItemId: item.workItemId, status: 'done' })
    expect(detail(item).item.failure).toBeNull()
    expect(notices(item)).toHaveLength(1)
  })

  it('retains batch deduplication after reopening the database and ignores subsequent author conversations', async () => {
    const item = await child()
    await end(lastTurn(item))
    await restart()
    sessions.sendMessage({ requestId: rid(), sessionId: actor(item).sessionId, text: 'A follow-up from the author', refs: [] })
    await sessions.idle()
    await end(lastTurn(item))
    expect(notices(item)).toHaveLength(1)
  })

  it('waits for queued ordinary messages to finish before checking the most recent delivered work batch', async () => {
    const item = await child()
    const first = lastTurn(item)
    sessions.sendMessage({ requestId: rid(), sessionId: first.sessionId, text: 'Also check this', refs: [] })
    await end(first)
    expect(notices(item)).toHaveLength(0)
    const final = lastTurn(item)
    expect(final.text).toBe('Also check this')
    await end(final)
    expect(notices(item)).toHaveLength(1)
    expect(notices(item)[0]!.from).toMatchObject({ failure: { turnId: final.turnId } })
  })

  it('waits for pending work messages and checks only the last delivered batch', async () => {
    const item = await child()
    const first = lastTurn(item)
    work.reply({ requestId: rid(), workItemId: item.workItemId, body: 'More context before finishing' })
    await end(first)
    expect(notices(item)).toHaveLength(0)
    const final = lastTurn(item)
    expect(final.text).toContain('More context before finishing')
    await end(final)
    const message = detail(item).messages.find(message => message.kind === 'reply')!
    expect(notices(item)[0]!.messageId).toBe(`wmsg_failure_${item.workItemId}_unreported_${message.deliveryId}`)
  })

  it('waits for an undelivered child message even before it has a target session', async () => {
    const item = await child()
    db.insert(s.workMessages).values({ id: 'unassigned-reply', workItemId: item.workItemId, kind: 'reply', from: { kind: 'user' }, to: 'child', body: 'Pending routing', createdAt: now() }).run()
    await end(lastTurn(item))
    expect(notices(item)).toHaveLength(0)
  })

  it('review feedback creates a fresh expectation after an earlier completion report', async () => {
    const item = await child()
    work.report({ requestId: rid(), kind: 'done', body: 'First delivery' }, actor(item))
    await end(lastTurn(item))
    expect(notices(item)).toHaveLength(0)
    work.review({ requestId: rid(), workItemId: item.workItemId, decision: 'reject', feedback: 'Please revise the delivery' })
    await sessions.idle()
    await end(lastTurn(item))
    const feedback = detail(item).messages.find(message => message.kind === 'review_feedback')!
    expect(notices(item)).toHaveLength(1)
    expect(notices(item)[0]!.messageId).toBe(`wmsg_failure_${item.workItemId}_unreported_${feedback.deliveryId}`)
  })

  it.each(['active', 'queued', 'undelivered'] as const)('waits when another session of the child has %s work', async kind => {
    const item = await child()
    const main = lastTurn(item)
    const second = secondSession(item)
    if (kind === 'active') {
      sessions.sendMessage({ requestId: rid(), sessionId: second.sessionId, text: 'Continue in parallel', refs: [] })
      await sessions.idle()
    } else {
      db.update(s.sessions).set({ queuePaused: true }).where(eq(s.sessions.id, second.sessionId)).run()
      if (kind === 'queued') sessions.sendMessage({ requestId: rid(), sessionId: second.sessionId, text: 'Queued work', refs: [] })
      else db.insert(s.workMessages).values({ id: 'undelivered', workItemId: item.workItemId, kind: 'reply', from: { kind: 'user' }, to: 'child', body: 'Pending reply', targetSessionId: second.sessionId, createdAt: now() }).run()
    }
    await end(main)
    expect(notices(item)).toHaveLength(0)
    if (kind !== 'active') {
      sessions.resumeQueue({ requestId: rid(), sessionId: second.sessionId })
      await sessions.idle()
    }
    await end(calls.filter(call => call.sessionId === second.sessionId).at(-1)!)
    expect(notices(item)).toHaveLength(1)
  })

  it.each(['question', 'blocked', 'escalation', 'done'] as const)('accepts a %s report from any child session, including after a restart', async kind => {
    const item = await child()
    const second = secondSession(item)
    work.report({ requestId: rid(), kind, body: 'This is my report' }, { sessionId: second.sessionId, workItemId: item.workItemId })
    await end(lastTurn(item))
    expect(notices(item)).toHaveLength(0)
    await restart()
    if (kind !== 'done') {
      sessions.sendMessage({ requestId: rid(), sessionId: actor(item).sessionId, text: 'Author follow-up', refs: [] })
      await sessions.idle()
      await end(lastTurn(item))
    }
    expect(notices(item)).toHaveLength(0)
  })

  it('does not notify for an author conversation without a delivered dispatch, reply or feedback', async () => {
    const item = (await work.dispatch({ requestId: rid(), parentId: parent.workItemId, title: 'Conversation', brief: '', agentKind: 'codex' }, () => undefined)).item
    sessions.sendMessage({ requestId: rid(), sessionId: actor(item).sessionId, text: 'A conversation with the author', refs: [] })
    await sessions.idle()
    await end(lastTurn(item))
    expect(notices(item)).toHaveLength(0)
    expect(detail(item).messages).toEqual([])
  })

  it('exempts root workspaces and sessions without a work item', async () => {
    sessions.sendMessage({ requestId: rid(), sessionId: actor(parent).sessionId, text: 'Root results go to the author', refs: [] })
    await sessions.idle()
    await end(lastTurn(parent))
    expect(notices(parent)).toHaveLength(0)
    db.update(s.sessions).set({ workItemId: null }).where(eq(s.sessions.id, actor(parent).sessionId)).run()
    sessions.sendMessage({ requestId: rid(), sessionId: actor(parent).sessionId, text: 'Unlinked conversation', refs: [] })
    await sessions.idle()
    await end(lastTurn(parent))
    expect(notices(parent)).toHaveLength(0)
  })

  it.each(['todo', 'in_review', 'done'] as const)('does not notify after the author moves the child to %s', async status => {
    const item = await child()
    work.move({ requestId: rid(), workItemId: item.workItemId, status })
    await end(lastTurn(item))
    expect(notices(item)).toHaveLength(0)
  })

  it('does not treat a waiting approval as an ended turn or notify after an intentional recall', async () => {
    const item = await child()
    const input = lastTurn(item)
    sessions.handleAgentEvent({ type: 'turn_waiting', sessionId: input.sessionId, turnId: input.turnId, waiting: true })
    expect(notices(item)).toHaveLength(0)
    await work.recall({ requestId: rid(), workItemId: item.workItemId })
    await end(input, 'interrupted')
    expect(notices(item)).toHaveLength(0)
    expect(detail(item).item.status).toBe('todo')
  })

  it.each(['failed', 'interrupted'] as const)('preserves existing notices for %s turns', async status => {
    const item = await child()
    await end(lastTurn(item), status)
    await end(lastTurn(item), status)
    expect(notices(item)).toHaveLength(0)
    expect(detail(item).messages.filter(message => message.kind === 'failure')).toHaveLength(1)
    expect(detail(item).item.activity).toBe('error')
  })

  it('never produces another notice from a batch containing only failures', async () => {
    const item = await child()
    work.report({ requestId: rid(), kind: 'question', body: 'Need a decision' }, actor(item))
    await end(lastTurn(item))
    db.insert(s.workMessages).values({ id: 'failure-only', workItemId: item.workItemId, kind: 'failure', from: { kind: 'system' }, to: 'child', body: 'A failure notice', targetSessionId: actor(item).sessionId, createdAt: now() }).run()
    sessions.notifyWorkActivated(actor(item).sessionId)
    await sessions.idle()
    const count = failures.mock.calls.length
    await end(lastTurn(item))
    expect(failures).toHaveBeenCalledTimes(count)
    expect(notices(item)).toHaveLength(0)
  })

  it('records the third notice for the author without waking the parent, including across restarts and later parent activations', async () => {
    const item = await child()
    await end(lastTurn(item))
    await end(lastTurn(parent))
    await end(await reply(item))
    await end(lastTurn(parent))
    await restart()
    const parentTurns = calls.filter(call => call.sessionId === actor(parent).sessionId).length
    await end(await reply(item))
    const third = notices(item).at(-1)!
    expect(db.select().from(s.workMessages).where(eq(s.workMessages.id, third.messageId)).get()).toMatchObject({ to: 'user', targetSessionId: null, deliveryId: null })
    expect(calls.filter(call => call.sessionId === actor(parent).sessionId)).toHaveLength(parentTurns)
    expect(work.inbox().groups[0]!.items.find(inbox => inbox.workItemId === item.workItemId)!.messages.map(message => message.messageId)).toContain(third.messageId)
    work.move({ requestId: rid(), workItemId: parent.workItemId, status: 'todo' })
    work.activate({ requestId: rid(), workItemId: parent.workItemId, agentKind: 'codex' })
    await sessions.idle()
    expect(db.select().from(s.workMessages).where(eq(s.workMessages.id, third.messageId)).get()?.targetSessionId).toBeNull()
  })

  it('a report resets the wake count and clears the warning even when all writes share a timestamp', async () => {
    frozen = true
    const item = await child()
    await end(lastTurn(item))
    await end(lastTurn(parent))
    await end(await reply(item))
    await end(lastTurn(parent))
    await end(await reply(item))
    expect(notices(item).at(-1)!.to).toBe('user')
    work.report({ requestId: rid(), kind: 'question', body: 'A proper question resets the count' }, actor(item))
    expect(detail(item).item.failure).toBeNull()
    await sessions.idle()
    await end(lastTurn(parent))
    await restart()
    await end(await reply(item))
    expect(notices(item)).toHaveLength(4)
    expect(notices(item).at(-1)!.to).toBe('parent')
    expect(db.select().from(s.workMessages).where(eq(s.workMessages.id, notices(item).at(-1)!.messageId)).get()?.targetSessionId).toBe(actor(parent).sessionId)
  })

  it('a new activation resets the wake count and the next turn clears the old warning', async () => {
    const item = await child()
    await end(lastTurn(item))
    await end(await reply(item))
    await end(await reply(item))
    expect(notices(item).at(-1)!.to).toBe('user')
    await work.recall({ requestId: rid(), workItemId: item.workItemId })
    work.activate({ requestId: rid(), workItemId: item.workItemId, agentKind: 'codex' })
    await sessions.idle()
    expect(detail(item).item.failure).toBeNull()
    await end(lastTurn(item))
    expect(notices(item).at(-1)!.to).toBe('parent')
  })

  it.each(['interrupted', 'failed'] as const)('runs the deferred check when a sibling turn ends %s', async status => {
    const item = await child()
    const sibling = secondSession(item)
    sessions.sendMessage({ requestId: rid(), sessionId: sibling.sessionId, text: 'Author question', refs: [] })
    await sessions.idle()
    const siblingTurn = calls.at(-1)!
    expect(siblingTurn.sessionId).toBe(sibling.sessionId)
    await end(lastTurn(item))
    expect(notices(item)).toHaveLength(0)
    await end(siblingTurn, status)
    expect(notices(item)).toHaveLength(1)
  })

  it('notifies when a sibling turn that started before the batch turn outlives it', async () => {
    const item = await child()
    await end(lastTurn(item))
    const sibling = secondSession(item)
    sessions.sendMessage({ requestId: rid(), sessionId: sibling.sessionId, text: 'Author question', refs: [] })
    await sessions.idle()
    const earlyTurn = calls.at(-1)!
    expect(earlyTurn.sessionId).toBe(sibling.sessionId)
    await end(await reply(item))
    expect(notices(item)).toHaveLength(1)
    await end(earlyTurn)
    expect(notices(item)).toHaveLength(2)
  })

  it('runs the deferred check when the author clears a sibling queue', async () => {
    const item = await child()
    const sibling = secondSession(item)
    db.update(s.sessions).set({ queuePaused: true }).where(eq(s.sessions.id, sibling.sessionId)).run()
    sessions.sendMessage({ requestId: rid(), sessionId: sibling.sessionId, text: 'Queued thought', refs: [] })
    await sessions.idle()
    await end(lastTurn(item))
    expect(notices(item)).toHaveLength(0)
    sessions.clearQueue({ requestId: rid(), sessionId: sibling.sessionId })
    expect(notices(item)).toHaveLength(1)
  })

  it('runs the deferred check when a restart interrupts a sibling turn', async () => {
    const item = await child()
    const sibling = secondSession(item)
    sessions.sendMessage({ requestId: rid(), sessionId: sibling.sessionId, text: 'Author question', refs: [] })
    await sessions.idle()
    await end(lastTurn(item))
    expect(notices(item)).toHaveLength(0)
    await restart()
    expect(notices(item)).toHaveLength(1)
  })

  it('does not notify for a batch turn that was itself interrupted', async () => {
    const item = await child()
    await end(lastTurn(item), 'interrupted')
    expect(notices(item)).toHaveLength(0)
  })

  it('never delivers a notice stored while the parent could not be reached', async () => {
    const item = await child()
    db.update(s.workItems).set({ archivedAt: now() }).where(eq(s.workItems.id, parent.workItemId)).run()
    db.update(s.sessions).set({ archivedAt: now() }).where(eq(s.sessions.id, actor(parent).sessionId)).run()
    await end(lastTurn(item))
    const stored = notices(item)[0]!
    expect(stored.to).toBe('user')
    db.update(s.workItems).set({ archivedAt: null, status: 'todo' }).where(eq(s.workItems.id, parent.workItemId)).run()
    work.activate({ requestId: rid(), workItemId: parent.workItemId, agentKind: 'codex' })
    await sessions.idle()
    expect(db.select().from(s.workMessages).where(eq(s.workMessages.id, stored.messageId)).get()?.targetSessionId).toBeNull()
  })

  it('counts only notices that reached a parent session towards the wake cap', async () => {
    const item = await child()
    db.update(s.workItems).set({ archivedAt: now() }).where(eq(s.workItems.id, parent.workItemId)).run()
    db.update(s.sessions).set({ archivedAt: now() }).where(eq(s.sessions.id, actor(parent).sessionId)).run()
    await end(lastTurn(item))
    await end(await reply(item))
    await end(await reply(item))
    expect(notices(item).map(notice => notice.to)).toEqual(['user', 'user', 'user'])
    db.update(s.workItems).set({ archivedAt: null }).where(eq(s.workItems.id, parent.workItemId)).run()
    db.update(s.sessions).set({ archivedAt: null }).where(eq(s.sessions.id, actor(parent).sessionId)).run()
    await end(await reply(item))
    expect(notices(item).at(-1)!.to).toBe('parent')
  })

  it('keeps the wake cap across an agent recall and activation, until the author activates', async () => {
    const item = await child()
    await end(lastTurn(item))
    await end(await reply(item))
    await end(await reply(item))
    expect(notices(item).at(-1)!.to).toBe('user')
    await work.recall({ requestId: rid(), workItemId: item.workItemId }, actor(parent))
    work.activate({ requestId: rid(), workItemId: item.workItemId, agentKind: 'codex' }, actor(parent))
    await sessions.idle()
    await end(lastTurn(item))
    expect(notices(item)).toHaveLength(4)
    expect(notices(item).at(-1)!.to).toBe('user')
    await work.recall({ requestId: rid(), workItemId: item.workItemId }, actor(parent))
    work.activate({ requestId: rid(), workItemId: item.workItemId, agentKind: 'codex' })
    await sessions.idle()
    await end(lastTurn(item))
    expect(notices(item).at(-1)!.to).toBe('parent')
  })

  it('an author recall restarts the wake count even when the parent activates afterwards', async () => {
    const item = await child()
    await end(lastTurn(item))
    await end(await reply(item))
    await end(await reply(item))
    await work.recall({ requestId: rid(), workItemId: item.workItemId })
    work.activate({ requestId: rid(), workItemId: item.workItemId, agentKind: 'codex' }, actor(parent))
    await sessions.idle()
    await end(lastTurn(item))
    expect(notices(item).at(-1)!.to).toBe('parent')
  })

  it('keeps the notice in the inbox when the parent is archived', async () => {
    const item = await child()
    db.update(s.workItems).set({ archivedAt: now() }).where(eq(s.workItems.id, parent.workItemId)).run()
    db.update(s.sessions).set({ archivedAt: now() }).where(eq(s.sessions.id, actor(parent).sessionId)).run()
    await end(lastTurn(item))
    expect(notices(item)).toHaveLength(1)
    expect(db.select().from(s.workMessages).where(eq(s.workMessages.id, notices(item)[0]!.messageId)).get()?.targetSessionId).toBeNull()
    expect(work.inbox().groups[0]!.items.some(inbox => inbox.workItemId === item.workItemId)).toBe(true)
  })
})
