import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyOps, createCanvasService, type CanvasService } from '@vis/canvas-core'
import { ackWorkMessages, and, appendEvent, claimWorkMessages, eq, markWorkMessagesDelivered, openSpaceDb, spaceSchema as s, type SpaceDb } from '@vis/storage'
import { METHODS, SessionSummary, WorkItemView, WorkMessageView, type AgentModelOption, type MethodParams, type MethodResult } from '@vis/protocol'
import { createSessionService, DispatchError, type DispatchInput } from '@vis/workbench-core'
import { createWorkService, nodeLabel, plainExcerpt, type WorkService, type WorkServiceActor } from './work-service'
import { createWorkDeletionService } from './work-deletion'

let db: SpaceDb, dir: string, work: WorkService, canvas: CanvasService, clock: number, limit: number
let occupied: Set<string>
let runtimeSessions: ReturnType<typeof createSessionService> | undefined
const notifyWorkActivated = vi.fn()
const agentOptions = vi.fn<() => Promise<AgentModelOption[]>>()
const stop = vi.fn(async () => ({ accepted: true as const }))
const cancel = vi.fn(async (_caller: unknown, params: { jobId: string }) => {
  db.update(s.generationJobs).set({ status: 'cancelled', providerCancelled: false }).where(eq(s.generationJobs.id, params.jobId)).run()
  return { jobId: params.jobId, providerCancelled: false } as MethodResult<'generation.cancel'>
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vis-work-')); db = openSpaceDb(join(dir, 'space.db'))
  clock = Date.now(); limit = 6; occupied = new Set(); runtimeSessions = undefined; stop.mockClear(); cancel.mockClear(); notifyWorkActivated.mockClear()
  agentOptions.mockReset().mockResolvedValue([
    { id: 'careful', label: 'Careful', isDefault: true, efforts: [{ id: 'high', label: 'High' }], defaultEffort: 'high', serviceTiers: [{ id: 'fast', label: 'Fast' }] },
    { id: 'quick', label: 'Quick', isDefault: false, efforts: [{ id: 'low', label: 'Low' }], defaultEffort: 'low', serviceTiers: [] },
  ])
  canvas = createCanvasService({ db, now: () => ++clock })
  work = createWorkService({ db, spaceId: 'space_test', rootPath: dir, sessions: { stop, notifyWorkActivated }, generation: { cancel }, runtime: { agentOptions }, now: () => ++clock,
    slots: { reserve(_spaceId, id) { if (occupied.has(id)) return true; if (occupied.size >= limit) return false; occupied.add(id); return true }, release(_spaceId, id) { occupied.delete(id) } },
  })
})
afterEach(async () => { runtimeSessions?.dispose(); await runtimeSessions?.idle(); db.$client.close(); rmSync(dir, { recursive: true, force: true }) })

const dispatch = (params: MethodParams<'work.dispatch'>, actor?: WorkServiceActor) => work.dispatch(params, () => actor)
const setAgentConfig = (params: MethodParams<'work.setAgentConfig'>, actor: WorkServiceActor) => work.setAgentConfig(params, () => actor)
const create = (title = '根任务') => work.create({ requestId: `create-${title}`, title, brief: '完成任务' }).item
const activate = (id: string, requestId = `activate-${id}`) => work.activate({ requestId, workItemId: id, agentKind: 'codex' }).item
function actorFor(workItemId: string): WorkServiceActor {
  const session = db.select().from(s.sessions).where(eq(s.sessions.workItemId, workItemId)).get()!
  return { sessionId: session.id, workItemId }
}
async function child(parentId: string, title = '子任务', activate = true) {
  return (await dispatch({ requestId: `dispatch-${title}`, parentId, title, brief: '子任务说明', agentKind: 'codex', activate })).item
}
function addSession(workItemId: string, sessionId = `session-${workItemId}`, createdAt = ++clock): WorkServiceActor {
  db.insert(s.sessions).values({ id: sessionId, workItemId, agentKind: 'codex', title: 'Codex', workDir: dir, createdAt }).run()
  return { sessionId, workItemId }
}

it('expires a cleanup card at ten minutes without a read or an approval, including after reopening the service', async () => {
  vi.useFakeTimers()
  const root = create('Cleanup timer')
  const actor = addSession(root.workItemId)
  const target = await child(root.workItemId, 'Cleanup target', false)
  db.insert(s.messages).values({ id: 'timer-message', sessionId: actor.sessionId, text: 'Clean up', deliveryState: 'delivered', createdAt: clock }).run()
  db.insert(s.turns).values({ id: 'timer-turn', sessionId: actor.sessionId, messageId: 'timer-message', status: 'completed', startedAt: clock, endedAt: clock }).run()
  let service = createWorkDeletionService(db, work, () => clock)
  try {
    const card = service.request({ requestId: 'timer-request', workItemIds: [target.workItemId] }, actor, 'timer-turn')
    const payload = () => db.select().from(s.transcriptEntries).where(eq(s.transcriptEntries.itemId, card.approvalId)).get()!.payload as { status: string; workDelete: { expiresAt: number } }
    const deadline = payload().workDelete.expiresAt
    service.close()
    clock = deadline - 1
    service = createWorkDeletionService(db, work, () => clock)
    expect(payload().status).toBe('pending')
    clock = deadline
    await vi.advanceTimersByTimeAsync(1)
    expect(payload().status).toBe('expired')
    expect(work.get({ workItemId: target.workItemId }).item.archivedAt).toBeNull()
    expect(stop).not.toHaveBeenCalled()
    expect(cancel).not.toHaveBeenCalled()
  } finally { service.close(); vi.useRealTimers() }
})

describe('Work item state machine', () => {
  it('audio generation and related nodes use audio copy', () => {
    const item = create('音频任务')
    const actor = addSession(item.workItemId)
    db.insert(s.generationJobs).values({ id: 'audio-job', sessionId: actor.sessionId, kind: 'audio', provider: 'mock', model: 'mock-music-1', params: {}, status: 'running', createdAt: clock, updatedAt: clock }).run()
    expect(work.get({ workItemId: item.workItemId }).item.sessions[0]?.doing).toBe('正在生成音频')
    canvas.apply({ kind: 'user' }, { requestId: 'audio-label', ops: [{ op: 'node.create', tempId: 'audio', kind: 'audio', prompt: '雨声', x: 0, y: 0, w: 360, h: 140 }] })
    expect(nodeLabel(canvas.get({}).nodes[0])).toBe('音频 · 雨声')
  })

  it('creating directories, activating sessions and briefs do not modify the canvas; retries do not duplicate changes and revision conflicts preserve state', () => {
    const params = { requestId: 'create', title: '画面设计', brief: '先画草图' }
    const created = work.create(params)
    expect(work.create(params)).toEqual(created)
    expect(created.item.lastChangeSeq).toBeNull()
    expect(created.item.workDir).toBe(join(dir, 'workspaces', '画面设计'))
    expect(db.select().from(s.nodes).all()).toEqual([])
    expect(db.select().from(s.slots).all()).toEqual([])
    const item = activate(created.item.workItemId)
    expect(item.status).toBe('in_progress'); expect(item.activationSeq).not.toBeNull()
    const sessionCreated = db.select().from(s.events).where(eq(s.events.type, 'session.created')).get()!
    expect(sessionCreated.payload).toHaveProperty('approvalMode', 'ask')
    expect(SessionSummary.parse(sessionCreated.payload)).toEqual(sessionCreated.payload)
    expect(item.changeCount).toBe(0)
    expect(item.lastChangeSeq).toBeNull()
    expect(work.get({ workItemId: item.workItemId }).messages.map(message => message.kind)).toEqual(['brief'])
    expect(() => work.submitReview({ requestId: 'stale', workItemId: item.workItemId, expectedRevision: 1 })).toThrowError(expect.objectContaining({ code: 'revision_conflict', message: 'Work item has been modified; read it again', details: { expectedRevision: 1, currentRevision: item.revision, reason: 'work.revision_conflict', params: {} } }))
    expect(WorkItemView.parse(item)).toEqual(item)
  })

  it('the second root workspace session can also dispatch idempotently; no child workspace session can dispatch', async () => {
    const root = work.create({ requestId: 'root-chat', title: '根对话', chat: { agentKind: 'codex' } }).item
    const actor = addSession(root.workItemId, 'second-root-session')
    const params = { requestId: 'second-dispatch', title: '验收', brief: '交付物与验收条件', agentKind: 'codex' as const }
    const result = await dispatch(params, actor)
    expect(METHODS['work.dispatch'].result.parse(result)).toEqual(result)
    expect(result.item.parentId).toBe(root.workItemId)
    expect(result).not.toHaveProperty('role')
    expect(result).not.toHaveProperty('notice')
    const events = db.select().from(s.events).all()
    expect(await dispatch(params, actor)).toEqual(result)
    expect(db.select().from(s.events).all()).toEqual(events)
    await expect(dispatch({ ...params, title: '不同请求' }, actor)).rejects.toMatchObject(expect.objectContaining({ code: 'idempotency_conflict' }))
    for (const childActor of [actorFor(result.item.workItemId), addSession(result.item.workItemId, 'second-child-session')]) {
      await expect(dispatch({ ...params, requestId: `nested-${childActor.sessionId}` }, childActor)).rejects.toMatchObject(expect.objectContaining({ code: 'forbidden', message: 'Child workspaces cannot dispatch again; report to the parent' }))
    }
    expect(work.get({ workItemId: root.workItemId }).item.sessions.map(session => session.sessionId)).toEqual([root.sessions[0]!.sessionId, actor.sessionId])
  })

  it('reports, replies, rejections and recalls route to the first unarchived session ordered by creation time', async () => {
    const parent = create(), item = await child(parent.workItemId)
    const laterParent = addSession(parent.workItemId, 'parent-later', clock + 30)
    const mainParent = addSession(parent.workItemId, 'parent-main', clock + 10)
    const archivedParent = addSession(parent.workItemId, 'parent-archived', clock - 10)
    db.update(s.sessions).set({ archivedAt: clock }).where(eq(s.sessions.id, archivedParent.sessionId)).run()
    const laterChild = addSession(item.workItemId, 'child-later', clock + 20)
    const mainChild = actorFor(item.workItemId)
    const first = work.report({ requestId: 'child-question', kind: 'question', body: '请确认' }, laterChild)
    expect(db.select().from(s.workMessages).where(eq(s.workMessages.id, first.messageId)).get()).toMatchObject({ to: 'parent', targetSessionId: mainParent.sessionId, from: { kind: 'session', sessionId: laterChild.sessionId } })
    const reply = work.reply({ requestId: 'reply-from-second', workItemId: item.workItemId, replyTo: first.messageId, body: '继续' }, laterParent)
    expect(db.select().from(s.workMessages).where(eq(s.workMessages.id, reply.messageId)).get()).toMatchObject({ to: 'child', targetSessionId: mainChild.sessionId })
    work.report({ requestId: 'child-done', kind: 'done', body: '完成' }, laterChild)
    const current = work.get({ workItemId: item.workItemId }).item
    work.update({ requestId: 'parent-review', workItemId: item.workItemId, expectedRevision: current.revision, reviewBy: 'parent' })
    work.review({ requestId: 'reject-by-second', workItemId: item.workItemId, decision: 'reject', feedback: '补充' }, laterParent)
    expect(db.select().from(s.workMessages).where(eq(s.workMessages.kind, 'review_feedback')).get()).toMatchObject({ to: 'child', targetSessionId: mainChild.sessionId })
    await work.recall({ requestId: 'recall-by-second', workItemId: item.workItemId }, laterParent)
    expect(db.select().from(s.workMessages).where(eq(s.workMessages.kind, 'recall')).get()).toMatchObject({ to: 'child', targetSessionId: mainChild.sessionId })
    expect(work.get({ workItemId: parent.workItemId }).item.sessions.map(session => session.sessionId)).toEqual([archivedParent.sessionId, mainParent.sessionId, laterParent.sessionId])
    expect(notifyWorkActivated).toHaveBeenCalledWith(mainParent.sessionId)
  })

  it('root workspaces cannot report; parent-child relationships constrain all sessions and ordinary sessions cannot forge workspace identity', async () => {
    const root = activate(create().workItemId), own = actorFor(root.workItemId)
    expect(() => work.report({ requestId: 'root-report', kind: 'question', body: '问' }, own)).toThrowError(expect.objectContaining({ code: 'forbidden' }))
    const unrelated = create('其他根项'), item = await child(root.workItemId, '待办子项', false)
    for (const actor of [own, addSession(root.workItemId, 'root-second')]) {
      expect(work.get({ workItemId: item.workItemId }, actor).item.workItemId).toBe(item.workItemId)
      expect(() => work.activate({ requestId: `outside-${actor.sessionId}`, workItemId: unrelated.workItemId }, actor)).toThrowError(expect.objectContaining({ code: 'forbidden' }))
      expect(() => work.reply({ requestId: `own-${actor.sessionId}`, workItemId: root.workItemId, body: '自己' }, actor)).toThrowError(expect.objectContaining({ code: 'forbidden' }))
      expect(() => work.review({ requestId: `outside-review-${actor.sessionId}`, workItemId: unrelated.workItemId, decision: 'approve' }, actor)).toThrowError(expect.objectContaining({ code: 'forbidden' }))
      expect(() => work.update({ requestId: `edit-${actor.sessionId}`, workItemId: root.workItemId, expectedRevision: root.revision, title: '改名' }, actor)).toThrowError(expect.objectContaining({ code: 'forbidden' }))
    }
    db.insert(s.sessions).values({ id: 'ordinary', agentKind: 'codex', title: '普通会话', workDir: dir, createdAt: clock }).run()
    await expect(dispatch({ requestId: 'ordinary-dispatch', title: '禁止', brief: '禁止', agentKind: 'codex' }, { sessionId: 'ordinary', workItemId: root.workItemId })).rejects.toMatchObject(expect.objectContaining({ code: 'forbidden' }))
  })

  it('completion reports from this activation apply only to the current review; manual review after reopening does not reuse historical reports', async () => {
    const item = await child(create().workItemId), actor = actorFor(item.workItemId)
    expect(item.reviewReportId).toBeNull()
    const first = work.report({ requestId: 'first-done', kind: 'done', body: '第一轮报告' }, actor)
    expect(first.item.reviewReportId).toBe(first.messageId)
    expect(db.select().from(s.workItems).where(eq(s.workItems.id, item.workItemId)).get()?.reviewReportId).toBe(first.messageId)
    expect(work.review({ requestId: 'first-approve', workItemId: item.workItemId, decision: 'approve' }).item.reviewReportId).toBeNull()
    expect(work.reopen({ requestId: 'second-round', workItemId: item.workItemId }).item.reviewReportId).toBeNull()
    expect(work.submitReview({ requestId: 'manual-review', workItemId: item.workItemId }).reviewReportId).toBeNull()
    expect(work.get({ workItemId: item.workItemId }).messages.some(message => message.messageId === first.messageId)).toBe(true)
    expect(work.review({ requestId: 'manual-reject', workItemId: item.workItemId, decision: 'reject', feedback: '补充报告' }).item.reviewReportId).toBeNull()
    const second = work.report({ requestId: 'second-done', kind: 'done', body: '第二轮报告' }, actor)
    expect(second.item.reviewReportId).toBe(second.messageId)
    expect(work.review({ requestId: 'second-reject', workItemId: item.workItemId, decision: 'reject', feedback: '继续修改' }).item.reviewReportId).toBeNull()
    work.report({ requestId: 'third-done', kind: 'done', body: '第三轮报告' }, actor)
    expect((await work.recall({ requestId: 'recall-review', workItemId: item.workItemId })).items[0]?.reviewReportId).toBeNull()
  })

  it('enforces one-level dispatch, roles and parent-child boundaries in the service', async () => {
    const parent = create(), sibling = create('其他根任务'), actor = addSession(parent.workItemId)
    const item = (await dispatch({ requestId: 'dispatch', title: '派发', brief: '工作说明', agentKind: 'codex' }, actor)).item
    expect(item.parentId).toBe(parent.workItemId); expect(item.sessions).toHaveLength(1)
    await expect(dispatch({ requestId: 'nested', parentId: item.workItemId, title: '嵌套', brief: '禁止', agentKind: 'codex' })).rejects.toMatchObject(expect.objectContaining({ code: 'forbidden' }))
    expect(() => work.activate({ requestId: 'cross', workItemId: sibling.workItemId }, actor)).toThrowError(expect.objectContaining({ code: 'forbidden' }))
    await expect(dispatch({ requestId: 'worker-dispatch', title: '禁止', brief: '禁止', agentKind: 'codex' }, actorFor(item.workItemId))).rejects.toMatchObject(expect.objectContaining({ code: 'forbidden' }))
    expect(work.list({}, actor).items.map(item => item.workItemId)).toEqual([parent.workItemId, item.workItemId])
    expect(work.list({}, actorFor(item.workItemId)).items.map(item => item.workItemId)).toEqual([item.workItemId])
    expect(() => work.get({ workItemId: sibling.workItemId }, actor)).toThrowError(expect.objectContaining({ code: 'forbidden' }))
  })

  it('user review submission does not require completed children, coordinator approval still does; approval archives the worker and reopening restores the same worker', async () => {
    const parent = activate(create().workItemId), item = await child(parent.workItemId), actor = actorFor(item.workItemId)
    const manual = await child(create('另一个根任务').workItemId, '另一个子任务')
    const grand = addSession(manual.parentId!)
    work.update({ requestId: 'manual-review-by', workItemId: manual.workItemId, expectedRevision: work.get({ workItemId: manual.workItemId }).item.revision, reviewBy: 'parent' })
    expect(work.submitReview({ requestId: 'user-submit', workItemId: parent.workItemId }).status).toBe('in_review')
    expect(work.review({ requestId: 'user-approve', workItemId: parent.workItemId, decision: 'approve' }).item.status).toBe('done')
    expect(work.submitReview({ requestId: 'manual-submit', workItemId: manual.workItemId }).status).toBe('in_review')
    expect(work.review({ requestId: 'coordinator-approve', workItemId: manual.workItemId, decision: 'approve' }, grand).item.status).toBe('done')
    work.report({ requestId: 'done', kind: 'done', body: '已完成' }, actor)
    const reviewed = work.review({ requestId: 'approve', workItemId: item.workItemId, decision: 'approve' }).item
    expect(reviewed.status).toBe('done'); expect(reviewed.sessions[0]?.archived).toBe(true)
    const reopened = work.reopen({ requestId: 'reopen', workItemId: item.workItemId }).item
    expect(reopened.status).toBe('in_progress'); expect(reopened.sessions[0]?.sessionId).toBe(actor.sessionId); expect(reopened.sessions[0]?.archived).toBe(false)
    work.report({ requestId: 'done-again', kind: 'done', body: '完成第二轮' }, actor)
    work.review({ requestId: 'approve-again', workItemId: item.workItemId, decision: 'approve' })
  })

  it('queued lists exactly the unarchived work waiting for a slot', async () => {
    limit = 1
    const parent = create(), first = await child(parent.workItemId, '第一个'), second = await child(parent.workItemId, '第二个'), third = await child(parent.workItemId, '第三个')
    const waiting = work.list({}).items.filter(item => item.waitingSlotSince !== null)
    expect(waiting.map(item => item.workItemId)).toEqual(expect.arrayContaining([second.workItemId, third.workItemId]))
    expect(waiting.map(item => item.workItemId)).not.toContain(first.workItemId)
    expect(work.queued()).toEqual(expect.arrayContaining(waiting.map(item => ({ workItemId: item.workItemId, title: item.title, waitingSince: item.waitingSlotSince }))))
    expect(work.queued()).toHaveLength(waiting.length)
  })

  it('activation, rejection and reopening queue when slots are full; rejection preserves the baseline, editing and recall cancel queuing', async () => {
    limit = 1
    const parent = create(), first = await child(parent.workItemId, '第一个'), second = await child(parent.workItemId, '第二个')
    expect(second.status).toBe('todo'); expect(second.waitingSlotSince).not.toBeNull()
    expect(work.activateQueued(second.workItemId)?.item.revision).toBe(second.revision)
    const baseline = first.activationSeq
    work.report({ requestId: 'first-done', kind: 'done', body: '完成' }, actorFor(first.workItemId))
    expect(work.activateQueued(second.workItemId)?.item.status).toBe('in_progress')
    const rejected = work.review({ requestId: 'reject', workItemId: first.workItemId, decision: 'reject', feedback: '请补充细节' })
    expect(rejected.queued).toBe(true); expect(rejected.item.pendingFeedback).toBe(true); expect(rejected.item.activationSeq).toBe(baseline)
    await work.recall({ requestId: 'recall-second', workItemId: second.workItemId })
    const resumed = work.activateQueued(first.workItemId)!.item
    expect(resumed.status).toBe('in_progress'); expect(resumed.activationSeq).toBe(baseline); expect(resumed.pendingFeedback).toBe(false)
    work.report({ requestId: 'done-first-again', kind: 'done', body: '补充完成' }, actorFor(first.workItemId))
    work.review({ requestId: 'approve-first', workItemId: first.workItemId, decision: 'approve' })
    activate(second.workItemId, 'second-again')
    const reopened = work.reopen({ requestId: 'reopen-full', workItemId: first.workItemId, note: '再修改' })
    expect(reopened.queued).toBe(true); expect(reopened.item.activationSeq).not.toBe(baseline)
    const edited = work.update({ requestId: 'edit', workItemId: first.workItemId, expectedRevision: reopened.item.revision, pinned: true })
    expect(edited.waitingSlotSince).toBeNull()
    const queued = work.activate({ requestId: 'queue-again', workItemId: first.workItemId })
    const cancelled = await work.recall({ requestId: 'cancel-queue', workItemId: first.workItemId })
    expect(cancelled.items[0]?.status).toBe('todo'); expect(cancelled.items[0]?.waitingSlotSince).toBeNull(); expect(queued.queued).toBe(true)
  })

  it('user rejection can omit feedback and send no message; coordinator rejection requires feedback and coordinators can only review their assigned children', async () => {
    const parent = create(), actor = addSession(parent.workItemId), item = await child(parent.workItemId)
    work.report({ requestId: 'done', kind: 'done', body: '完成' }, actorFor(item.workItemId))
    const silent = work.review({ requestId: 'silent-reject', workItemId: item.workItemId, decision: 'reject' })
    expect(silent.item.status).toBe('in_progress')
    expect(work.get({ workItemId: item.workItemId }).messages.map(message => message.kind)).toEqual(['brief', 'done'])
    work.report({ requestId: 'done-again', kind: 'done', body: '完成' }, actorFor(item.workItemId))
    expect(() => work.review({ requestId: 'coordinator-review', workItemId: item.workItemId, decision: 'approve' }, actor)).toThrowError(expect.objectContaining({ code: 'forbidden' }))
    const current = work.get({ workItemId: item.workItemId }).item
    work.update({ requestId: 'review-by', workItemId: item.workItemId, expectedRevision: current.revision, reviewBy: 'parent' })
    expect(() => work.review({ requestId: 'coordinator-bad-reject', workItemId: item.workItemId, decision: 'reject' }, actor)).toThrowError(expect.objectContaining({ code: 'invalid_params' }))
    expect(work.review({ requestId: 'coordinator-review-ok', workItemId: item.workItemId, decision: 'approve' }, actor).item.status).toBe('done')
  })

  it('users can move to any status, changing only status without interrupting turns, cancelling generation or cascading to children; moving back does not notify executors', async () => {
    const parent = activate(create().workItemId), item = await child(parent.workItemId), actor = actorFor(item.workItemId)
    const move = (requestId: string, workItemId: string, status: 'todo' | 'in_progress' | 'in_review' | 'done') => work.move({ requestId, workItemId, status }).item
    db.insert(s.messages).values({ id: 'msg-running', sessionId: actor.sessionId, text: '执行', deliveryState: 'delivered', createdAt: clock }).run()
    db.insert(s.turns).values({ id: 'turn-running', sessionId: actor.sessionId, messageId: 'msg-running', status: 'running', startedAt: clock }).run()
    db.insert(s.generationJobs).values({ id: 'job-running', sessionId: actor.sessionId, kind: 'image', provider: 'mock', model: 'mock', params: {}, status: 'running', createdAt: clock, updatedAt: clock }).run()
    const todo = move('progress-to-todo', item.workItemId, 'todo')
    expect(todo.status).toBe('todo'); expect(occupied.has(item.workItemId)).toBe(false)
    expect(db.select().from(s.sessions).where(eq(s.sessions.id, actor.sessionId)).get()?.queuePaused).toBe(true)
    expect(work.get({ workItemId: item.workItemId }).messages.some(message => message.kind === 'recall')).toBe(false)
    expect(move('todo-to-progress', item.workItemId, 'in_progress').status).toBe('in_progress')
    const done = move('progress-to-done', item.workItemId, 'done')
    expect(done.status).toBe('done'); expect(done.sessions[0]?.archived).toBe(true); expect(occupied.has(item.workItemId)).toBe(false)
    expect(stop).not.toHaveBeenCalled(); expect(cancel).not.toHaveBeenCalled()
    expect(db.select().from(s.turns).where(eq(s.turns.id, 'turn-running')).get()?.status).toBe('running')
    // A parent can move directly even with unfinished children, without cascading.
    expect(move('parent-to-review', parent.workItemId, 'in_review').status).toBe('in_review')
    expect(move('parent-to-todo', parent.workItemId, 'todo').status).toBe('todo')
    expect(work.get({ workItemId: item.workItemId }).item.status).toBe('done')
    expect(move('done-to-review', item.workItemId, 'in_review').status).toBe('in_review')
    const messages = work.get({ workItemId: item.workItemId }).messages.length
    expect(move('review-to-progress', item.workItemId, 'in_progress').status).toBe('in_progress')
    expect(work.get({ workItemId: item.workItemId }).messages).toHaveLength(messages)
    expect(move('todo-to-done', parent.workItemId, 'done').status).toBe('done')
    expect(move('done-to-todo', parent.workItemId, 'todo').status).toBe('todo')
    expect(move('todo-to-review', parent.workItemId, 'in_review').status).toBe('in_review')
    expect(move('same', parent.workItemId, 'in_review').status).toBe('in_review')
    expect(() => work.move({ requestId: 'stale', workItemId: item.workItemId, status: 'done', expectedRevision: 1 })).toThrowError(expect.objectContaining({ code: 'revision_conflict' }))
  })

  it('move completion: leaving in_progress always pauses queues; cards without sessions need agentKind to enter in_progress; dragging back into in_progress with full slots resets the baseline', async () => {
    const root = activate(create('协调根项').workItemId)
    expect(work.move({ requestId: 'root-review', workItemId: root.workItemId, status: 'in_review' }).item.status).toBe('in_review')
    expect(db.select().from(s.sessions).where(eq(s.sessions.workItemId, root.workItemId)).all().every(session => session.queuePaused)).toBe(true)
    expect(work.move({ requestId: 'root-back', workItemId: root.workItemId, status: 'in_progress' }).item.sessions[0]?.archived).toBe(false)
    expect(db.select().from(s.sessions).where(eq(s.sessions.workItemId, root.workItemId)).get()?.queuePaused).toBe(false)

    const fresh = create('从没开始')
    work.move({ requestId: 'fresh-done', workItemId: fresh.workItemId, status: 'done' })
    expect(() => work.move({ requestId: 'fresh-progress', workItemId: fresh.workItemId, status: 'in_progress' })).toThrowError(expect.objectContaining({ code: 'invalid_params' }))
    expect(work.move({ requestId: 'fresh-progress-codex', workItemId: fresh.workItemId, status: 'in_progress', agentKind: 'codex' }).item.sessions).toHaveLength(1)
    const review = create('直接待审阅')
    work.move({ requestId: 'review-direct', workItemId: review.workItemId, status: 'in_review' })
    expect(work.review({ requestId: 'review-reject-codex', workItemId: review.workItemId, decision: 'reject', agentKind: 'codex' }).item.status).toBe('in_progress')

    const parent = create('满额父项'), first = await child(parent.workItemId, '已完成项')
    work.move({ requestId: 'first-done', workItemId: first.workItemId, status: 'done' })
    const baseline = work.get({ workItemId: first.workItemId }).item.activationSeq
    limit = occupied.size
    const queued = work.move({ requestId: 'first-reopen-queued', workItemId: first.workItemId, status: 'in_progress' })
    expect(queued.queued).toBe(true); expect(queued.item.activationSeq).not.toBe(baseline)
  })

  it.each(['todo', 'in_progress', 'in_review', 'done'] as const)('%s rejects all invalid transitions and returns the current status', async status => {
    const item = await child(create().workItemId), actor = actorFor(item.workItemId)
    db.update(s.workItems).set({ status, waitingSlotSince: null }).where(eq(s.workItems.id, item.workItemId)).run()
    const transitions = [
      { allowed: 'todo', run: () => work.activate({ requestId: 'invalid-activate', workItemId: item.workItemId }) },
      { allowed: 'done', run: () => work.reopen({ requestId: 'invalid-reopen', workItemId: item.workItemId }) },
      { allowed: 'in_progress', run: () => work.submitReview({ requestId: 'invalid-submit', workItemId: item.workItemId }) },
      { allowed: 'in_review', run: () => work.review({ requestId: 'invalid-review', workItemId: item.workItemId, decision: 'approve' }) },
      { allowed: 'in_progress', run: () => work.report({ requestId: 'invalid-report', kind: 'done', body: '完成' }, actor) },
    ]
    for (const action of transitions) if (action.allowed !== status) expect(action.run).toThrowError(expect.objectContaining({ code: 'invalid_transition', details: { status, reason: 'work.invalid_transition', params: { status } } }))
    if (status === 'todo' || status === 'done') await expect(work.recall({ requestId: 'invalid-recall', workItemId: item.workItemId })).rejects.toMatchObject({ code: 'invalid_transition', details: { status, reason: 'work.invalid_transition', params: { status } } })
    expect(work.get({ workItemId: item.workItemId }).item.status).toBe(status)
  })
})

describe('Work messages and review', () => {
  it('waiting summaries strip Markdown and inbox related nodes include display names', async () => {
    expect(plainExcerpt('## 选色\n霓虹招牌用**暖橙**还是`冷蓝`？见 [参考](https://example.com)\n- _A_ 方案')).toBe('选色 霓虹招牌用暖橙还是冷蓝？见 参考 A 方案')
    expect(plainExcerpt('a'.repeat(100))).toHaveLength(80)
    const item = await child(create().workItemId), actor = actorFor(item.workItemId)
    const made = canvas.apply({ kind: 'agent', sessionId: actor.sessionId }, { requestId: 'labels', ops: [
      { op: 'node.create', tempId: 'text', kind: 'text', x: 0, y: 0, w: 200, h: 100, content: { text: '镜头 2 草稿\n正文' } },
      { op: 'node.create', tempId: 'image', kind: 'image', x: 0, y: 200, w: 200, h: 200, prompt: '雨后街角\n霓虹倒影' },
      { op: 'node.create', tempId: 'gone', kind: 'text', x: 0, y: 500, w: 200, h: 100, content: { text: '会删除' } },
    ] })
    canvas.apply({ kind: 'user' }, { requestId: 'labels-delete', ops: [{ op: 'node.delete', nodeId: made.idMap.gone! }] })
    const nodeIds = [made.idMap.text!, made.idMap.image!, made.idMap.gone!]
    const reported = work.report({ requestId: 'labels-question', kind: 'question', body: '招牌用**暖橙**还是**冷蓝**？', refs: { nodeIds } }, actor)
    expect(reported.item.waitingOn?.excerpt).toBe('招牌用暖橙还是冷蓝？')
    expect(work.inbox().groups[0]?.items[0]?.nodeLabels).toEqual({ [nodeIds[0]!]: '镜头 2 草稿', [nodeIds[1]!]: '图片 · 雨后街角', [nodeIds[2]!]: '已删除的节点' })
  })

  it('message pagination returns the complete group at the boundary millisecond without losing history when multiple messages share a millisecond', () => {
    const item = create()
    for (const at of [1000, 2000]) for (const suffix of ['a', 'b', 'c']) {
      db.insert(s.workMessages).values({ id: `wmsg_${at}_${suffix}`, workItemId: item.workItemId, kind: 'question', from: { kind: 'user' }, to: 'user', body: suffix, createdAt: at }).run()
    }
    const first = work.get({ workItemId: item.workItemId, limit: 1 })
    expect(first.messages.map(message => message.messageId)).toEqual(['wmsg_2000_a', 'wmsg_2000_b', 'wmsg_2000_c'])
    expect(first.hasMore).toBe(true)
    const second = work.get({ workItemId: item.workItemId, limit: 1, beforeCreatedAt: first.messages[0]!.createdAt })
    expect(second.messages.map(message => message.messageId)).toEqual(['wmsg_1000_a', 'wmsg_1000_b', 'wmsg_1000_c'])
    expect(second.hasMore).toBe(false)
    expect(new Set([...second.messages, ...first.messages].map(message => message.messageId)).size).toBe(6)
  })

  it('reading does not resolve; the first reply persists and repeated replies return the initial resolution record', async () => {
    const parent = create(), coord = addSession(parent.workItemId), item = await child(parent.workItemId), actor = actorFor(item.workItemId)
    const reported = work.report({ requestId: 'question', kind: 'question', body: '需要哪个版本？' }, actor)
    const stored = db.select().from(s.workMessages).where(eq(s.workMessages.id, reported.messageId)).get()!
    expect(stored.to).toBe('parent'); expect(stored.targetSessionId).toBe(coord.sessionId)
    expect(reported.item.activity).toBe('waiting'); expect(reported.item.unreadCount).toBe(1); expect(reported.item.unresolvedCount).toBe(1)
    work.markRead({ workItemId: item.workItemId })
    expect(work.get({ workItemId: item.workItemId }).item.revision).toBe(reported.item.revision + 1)
    expect(work.inbox().counts).toMatchObject({ unread: 0, unresolved: 1 })
    const replied = work.reply({ requestId: 'reply', workItemId: item.workItemId, replyTo: reported.messageId, body: '版本 A' }, coord)
    expect(work.reply({ requestId: 'reply', workItemId: item.workItemId, replyTo: reported.messageId, body: '版本 A' }, coord)).toEqual(replied)
    expect(() => work.reply({ requestId: 'too-late', workItemId: item.workItemId, replyTo: reported.messageId, body: '版本 B' })).toThrowError(expect.objectContaining({ code: 'already_resolved', details: { reason: 'work.message_resolved', params: {}, resolution: expect.objectContaining({ messageId: replied.messageId }) } }))
    expect(work.inbox().groups).toEqual([])
    expect(work.reply({ requestId: 'supplement', workItemId: item.workItemId, body: '追加说明' }).messageId).toBeTruthy()
    for (const message of work.get({ workItemId: item.workItemId }).messages) expect(WorkMessageView.safeParse(message).success).toBe(true)
  })

  it('recalling a parent cascades session stops, generation cancellation and question resolution without repeating side effects on retry', async () => {
    const parent = activate(create().workItemId), item = await child(parent.workItemId), actor = actorFor(item.workItemId)
    const question = work.report({ requestId: 'blocked', kind: 'blocked', body: '等待权限' }, actor)
    const chat = parent.sessions[0]!
    for (const sessionId of [chat.sessionId, actor.sessionId]) {
      db.insert(s.messages).values({ id: `msg-${sessionId}`, sessionId, text: '执行', deliveryState: 'delivered', createdAt: clock }).run()
      db.insert(s.turns).values({ id: `turn-${sessionId}`, sessionId, messageId: `msg-${sessionId}`, status: 'running', startedAt: clock }).run()
      db.insert(s.generationJobs).values({ id: `job-${sessionId}`, sessionId, kind: 'image', provider: 'mock', model: 'mock', params: {}, status: 'running', createdAt: clock, updatedAt: clock }).run()
    }
    const params = { requestId: 'recall-parent', workItemId: parent.workItemId }, result = await work.recall(params)
    expect(result.items).toHaveLength(2); expect(result.items.every(item => item.status === 'todo')).toBe(true)
    expect(result.cancelledJobs).toHaveLength(2); expect(result.cancelledJobs.every(job => job.providerCancelled === false)).toBe(true)
    expect(stop).toHaveBeenCalledTimes(2); expect(cancel).toHaveBeenCalledTimes(2); expect(occupied.size).toBe(0)
    work.update({ requestId: 'rename-after-recall', workItemId: parent.workItemId, expectedRevision: work.get({ workItemId: parent.workItemId }).item.revision, title: '回收后改名' })
    expect(await work.recall(params)).toEqual(result); expect(stop).toHaveBeenCalledTimes(2); expect(cancel).toHaveBeenCalledTimes(2)
    expect(work.get({ workItemId: item.workItemId }).item.unresolvedCount).toBe(0)
    expect(() => work.reply({ requestId: 'reply-recalled', workItemId: item.workItemId, replyTo: question.messageId, body: '迟到回复' })).toThrowError(expect.objectContaining({ code: 'already_resolved', details: { reason: 'work.message_resolved', params: {}, resolution: expect.objectContaining({ kind: 'recall' }) } }))
  })

  it.each([true, false])('legacy recall plans with finished=%s only refresh returned cards, preserving original snapshots without stopping again', async finished => {
    const item = activate(create().workItemId), sessionId = item.sessions[0]!.sessionId
    db.insert(s.messages).values({ id: 'legacy-message', sessionId, text: '执行', deliveryState: 'delivered', createdAt: clock }).run()
    db.insert(s.turns).values({ id: 'legacy-turn', sessionId, messageId: 'legacy-message', status: 'running', startedAt: clock }).run()
    db.insert(s.generationJobs).values({ id: 'legacy-job', sessionId, kind: 'image', provider: 'mock', model: 'mock', params: {}, status: 'running', createdAt: clock, updatedAt: clock }).run()
    stop.mockImplementationOnce(async () => {
      db.update(s.turns).set({ status: 'interrupted', endedAt: ++clock }).where(eq(s.turns.id, 'legacy-turn')).run()
      return { accepted: true as const }
    })
    const params = { requestId: 'legacy-recall', workItemId: item.workItemId }
    if (finished) await work.recall(params)
    else {
      cancel.mockRejectedValueOnce(new Error('Temporarily disconnected'))
      await expect(work.recall(params)).rejects.toThrow('Temporarily disconnected')
    }
    const key = db.select().from(s.idempotencyKeys).where(eq(s.idempotencyKeys.requestId, params.requestId)).get()!
    const plan = key.result as MethodResult<'work.recall'> & { finished: boolean }
    const legacyItems = plan.items.map(({ changeCount: _count, lastChangeSeq: _seq, ...snapshot }) => ({ ...snapshot, frameNodeId: null, frameNodeCount: 0, sessions: snapshot.sessions.map(session => ({ ...session, role: 'coordinator' })) }))
    db.update(s.idempotencyKeys).set({ result: { ...plan, items: legacyItems } }).where(eq(s.idempotencyKeys.requestId, params.requestId)).run()
    db.$client.prepare('UPDATE contract_migrations SET idempotency_rowid = (SELECT max(rowid) FROM idempotency_keys) WHERE id = ?').run('0010')
    const recovered = createWorkService({ db, spaceId: 'space_test', rootPath: dir, sessions: { stop }, generation: { cancel }, now: () => ++clock,
      slots: { reserve: () => true, release(_spaceId, id) { occupied.delete(id) } },
    })
    await recovered.recoverRecalls()
    recovered.update({ requestId: 'rename-legacy-recall', workItemId: item.workItemId, expectedRevision: recovered.get({ workItemId: item.workItemId }).item.revision, title: '迁移后标题' })
    const events = db.select().from(s.events).all()
    const result = await recovered.recall(params)
    expect(METHODS['work.recall'].result.parse(result)).toEqual(result)
    expect(result.items).toEqual([recovered.get({ workItemId: item.workItemId }).item])
    expect(result.items[0]).toMatchObject({ title: '迁移后标题', changeCount: 0, lastChangeSeq: null })
    expect(result.items[0]).not.toHaveProperty('frameNodeId')
    expect(result.items[0]!.sessions[0]).not.toHaveProperty('role')
    const completed = db.select().from(s.idempotencyKeys).where(eq(s.idempotencyKeys.requestId, params.requestId)).get()!.result
    expect(completed).toEqual({ ...plan, items: legacyItems, finished: true })
    expect(await recovered.recall(params)).toEqual(result)
    expect(db.select().from(s.events).all()).toEqual(events)
    expect(stop).toHaveBeenCalledTimes(1)
    expect(cancel).toHaveBeenCalledTimes(finished ? 1 : 2)
    expect(occupied.size).toBe(0)
  })

  it('activation changes include only nodes from this work item sessions, survive rejection and reset on reopening', async () => {
    const parent = create(), item = await child(parent.workItemId), actor = actorFor(item.workItemId)
    const made = canvas.apply({ kind: 'agent', sessionId: actor.sessionId }, { requestId: 'draw', ops: [{ op: 'node.create', tempId: 'draft', kind: 'text', x: 0, y: 0, w: 200, h: 100, content: { text: '草稿' } }] })
    const nodeId = made.idMap.draft!, slotId = Object.keys(made.slotRevisions)[0]!
    canvas.apply({ kind: 'agent', sessionId: actor.sessionId }, { requestId: 'edit-node', ops: [{ op: 'slot.setText', slotId, expectedRevision: 1, body: '新草稿' }] })
    canvas.apply({ kind: 'user' }, { requestId: 'user-edit', ops: [{ op: 'node.layout', nodeId, x: 10 }] })
    const changes = work.changes({ workItemId: item.workItemId })
    expect(changes.changes).toEqual([
      { nodeId, nodeKind: 'text', slotId, change: 'created', fromRevision: null, toRevision: 2, sessionId: actor.sessionId, lastSeq: expect.any(Number) },
    ])
    work.report({ requestId: 'done', kind: 'done', body: '完成' }, actor)
    work.review({ requestId: 'reject', workItemId: item.workItemId, decision: 'reject', feedback: '再改' })
    expect(work.changes({ workItemId: item.workItemId })).toEqual(changes)
    work.report({ requestId: 'done-2', kind: 'done', body: '完成' }, actor)
    work.review({ requestId: 'approve', workItemId: item.workItemId, decision: 'approve' })
    work.reopen({ requestId: 'reopen', workItemId: item.workItemId })
    expect(work.changes({ workItemId: item.workItemId }).changes).toEqual([])
    expect(work.get({ workItemId: item.workItemId }).item).toMatchObject({ changeCount: 0, lastChangeSeq: null })
  })

  it('activation changes deduplicate nodes and sort by the last edit from this workspace sessions, ignoring later edits by other sessions', async () => {
    const root = create(), item = await child(root.workItemId), actor = actorFor(item.workItemId)
    const second = addSession(item.workItemId, 'second-drawing-session')
    const other = actorFor((await child(root.workItemId, '其他子任务')).workItemId)
    const first = canvas.apply({ kind: 'agent', sessionId: actor.sessionId }, { requestId: 'first-image', ops: [{ op: 'node.create', tempId: 'first', kind: 'image', prompt: '初始提示词', x: 0, y: 0, w: 200, h: 100 }] })
    const olderId = first.idMap.first!
    const next = canvas.apply({ kind: 'agent', sessionId: second.sessionId }, { requestId: 'second-image', ops: [{ op: 'node.create', tempId: 'next', kind: 'image', x: 300, y: 0, w: 200, h: 100 }] })
    const newerId = next.idMap.next!
    expect([...new Set(work.changes({ workItemId: item.workItemId }).changes.map(change => change.nodeId))]).toEqual([newerId, olderId])
    const beforeRepeat = work.get({ workItemId: item.workItemId }).item
    expect(beforeRepeat).toMatchObject({ changeCount: 2, lastChangeSeq: work.changes({ workItemId: item.workItemId }).changes[0]!.lastSeq })
    const slotId = canvas.get({ nodeIds: [olderId] }).nodes[0]!.slots.find(slot => slot.slotKey === 'prompt')!.slotId
    canvas.apply({ kind: 'agent', sessionId: second.sessionId }, { requestId: 'older-edited-again', ops: [{ op: 'slot.setText', slotId, expectedRevision: 1, body: '补充提示词' }] })
    const ordered = work.changes({ workItemId: item.workItemId })
    expect([...new Set(ordered.changes.map(change => change.nodeId))]).toEqual([olderId, newerId])
    expect(ordered.changes[0]!.lastSeq).toBeGreaterThan(ordered.changes.at(-1)!.lastSeq)
    const afterRepeat = work.get({ workItemId: item.workItemId }).item
    expect(afterRepeat.changeCount).toBe(beforeRepeat.changeCount)
    expect(afterRepeat.lastChangeSeq).toBe(ordered.changes[0]!.lastSeq)
    expect(afterRepeat.lastChangeSeq).toBeGreaterThan(beforeRepeat.lastChangeSeq!)
    canvas.apply({ kind: 'agent', sessionId: other.sessionId }, { requestId: 'other-later-edit', ops: [{ op: 'node.layout', nodeId: newerId, x: 500 }] })
    canvas.apply({ kind: 'user' }, { requestId: 'user-later-edit', ops: [{ op: 'node.layout', nodeId: newerId, y: 500 }] })
    expect(work.changes({ workItemId: item.workItemId })).toEqual(ordered)
    expect(work.get({ workItemId: item.workItemId }).item.changeCount).toBe(new Set(ordered.changes.map(change => change.nodeId)).size)
    expect(work.get({ workItemId: item.workItemId }).item.lastChangeSeq).toBe(afterRepeat.lastChangeSeq)
  })

  it('generation bindings that add provenance refresh the changes cache even without new canvas events', async () => {
    const item = await child(create().workItemId), actor = actorFor(item.workItemId)
    const made = canvas.apply({ kind: 'user' }, { requestId: 'system-delivery', ops: [{ op: 'node.create', tempId: 'image', kind: 'image', x: 0, y: 0, w: 200, h: 100 }] })
    db.update(s.operations).set({ actorKind: 'system' }).where(eq(s.operations.id, made.operationId)).run()
    expect(work.changes({ workItemId: item.workItemId }).changes).toEqual([])
    expect(work.get({ workItemId: item.workItemId }).item.changeCount).toBe(0)
    db.transaction(t => {
      t.insert(s.generationJobs).values({ id: 'attributed-job', sessionId: actor.sessionId, kind: 'image', provider: 'mock', model: 'mock', params: {}, status: 'succeeded', createdAt: clock, updatedAt: clock }).run()
      t.insert(s.deliveryBindings).values({ id: 'attributed-binding', jobId: 'attributed-job', outputIndex: 0, targetKind: 'new_node', status: 'delivered', createdNodeId: made.idMap.image!, deliveredOperationId: made.operationId }).run()
      appendEvent(t, { type: 'binding.stateChanged', entityType: 'binding', entityId: 'attributed-binding', operationId: made.operationId, payload: { bindingId: 'attributed-binding', status: 'delivered' } }, ++clock)
    })
    expect(work.changes({ workItemId: item.workItemId }).changes).toEqual([expect.objectContaining({ nodeId: made.idMap.image, sessionId: actor.sessionId, lastSeq: expect.any(Number) })])
    expect(work.get({ workItemId: item.workItemId }).item.changeCount).toBe(1)
  })

  it('reading uncommitted changes in a transaction does not contaminate card or change caches after rollback', async () => {
    const item = await child(create().workItemId), actor = actorFor(item.workItemId)
    canvas.apply({ kind: 'agent', sessionId: actor.sessionId }, { requestId: 'committed-drawing', ops: [{ op: 'node.create', tempId: 'first', kind: 'text', x: 0, y: 0, w: 200, h: 100 }] })
    const committed = work.changes({ workItemId: item.workItemId })
    expect(work.get({ workItemId: item.workItemId }).item.changeCount).toBe(1)
    expect(() => db.transaction(t => {
      applyOps(t, { kind: 'agent', sessionId: actor.sessionId }, { requestId: 'rollback-drawing', ops: [{ op: 'node.create', tempId: 'second', kind: 'text', x: 300, y: 0, w: 200, h: 100 }] }, ++clock)
      expect(work.get({ workItemId: item.workItemId }).item.changeCount).toBe(2)
      expect(work.changes({ workItemId: item.workItemId }).changes).toHaveLength(2)
      throw new Error('Rollback')
    })).toThrow('Rollback')
    expect(work.changes({ workItemId: item.workItemId })).toEqual(committed)
    expect(work.get({ workItemId: item.workItemId }).item.changeCount).toBe(1)
  })

  it('activation changes return the types of added, modified and deleted nodes at the time; frames retain types even without slots', async () => {
    const seeded = canvas.apply({ kind: 'user' }, { requestId: 'seed-node-kinds', ops: [
      { op: 'node.create', tempId: 'image', kind: 'image', x: 0, y: 0, w: 200, h: 100 },
      { op: 'node.create', tempId: 'text', kind: 'text', x: 300, y: 0, w: 200, h: 100, content: { text: '原文' } },
      { op: 'frame.create', tempId: 'frame', x: 600, y: 0, w: 200, h: 100, title: '原框' },
    ] })
    const imageId = seeded.idMap.image!, textId = seeded.idMap.text!, frameId = seeded.idMap.frame!
    const textSlotId = db.select().from(s.slots).where(eq(s.slots.nodeId, textId)).get()!.id
    const item = await child(create().workItemId), actor = actorFor(item.workItemId)
    const made = canvas.apply({ kind: 'agent', sessionId: actor.sessionId }, { requestId: 'change-node-kinds', ops: [
      { op: 'node.delete', nodeId: imageId },
      { op: 'slot.setText', slotId: textSlotId, expectedRevision: 1, body: '新文' },
      { op: 'frame.update', nodeId: frameId, title: '新框' },
      { op: 'node.create', tempId: 'video', kind: 'video', x: 900, y: 0, w: 200, h: 100 },
    ] })
    expect(work.changes({ workItemId: item.workItemId }).changes).toEqual([
      expect.objectContaining({ nodeId: made.idMap.video, nodeKind: 'video', change: 'created', fromRevision: null, toRevision: 0 }),
      expect.objectContaining({ nodeId: frameId, nodeKind: 'frame', slotId: null, change: 'updated', fromRevision: 1, toRevision: 2 }),
      expect.objectContaining({ nodeId: textId, nodeKind: 'text', slotId: textSlotId, change: 'updated', fromRevision: 1, toRevision: 2 }),
      expect.objectContaining({ nodeId: imageId, nodeKind: 'image', change: 'deleted', fromRevision: 0, toRevision: null }),
    ])
  })

  it('rejects reactivation during failed recall, recovers from the persistent plan after service reconstruction and releases slots only on completion', async () => {
    const item = await child(create().workItemId), actor = actorFor(item.workItemId)
    db.insert(s.generationJobs).values({ id: 'recover-job', sessionId: actor.sessionId, kind: 'image', provider: 'mock', model: 'mock', params: {}, status: 'running', createdAt: clock, updatedAt: clock }).run()
    cancel.mockRejectedValueOnce(new Error('Temporarily disconnected'))
    await expect(work.recall({ requestId: 'recover-recall', workItemId: item.workItemId })).rejects.toThrow('Temporarily disconnected')
    expect(occupied.has(item.workItemId)).toBe(true)
    expect(() => work.activate({ requestId: 'activate-during-recall', workItemId: item.workItemId })).toThrowError(expect.objectContaining({ code: 'busy' }))
    const recovered = createWorkService({ db, spaceId: 'space_test', rootPath: dir, sessions: { stop }, generation: { cancel }, now: () => ++clock,
      slots: { reserve(_spaceId, id) { occupied.add(id); return true }, release(_spaceId, id) { occupied.delete(id) } },
    })
    await recovered.recoverRecalls()
    expect(occupied.has(item.workItemId)).toBe(false)
    expect(recovered.activate({ requestId: 'activate-after-recovery', workItemId: item.workItemId }).item.status).toBe('in_progress')
    expect(cancel).toHaveBeenCalledTimes(2)
  })

  it('ordinary messages queued by legacy session.create automatically dequeue after FIFO activation commits', async () => {
    const dispatchTurn = vi.fn(async (_input: { sessionId: string; text: string }) => {})
    const sessions = createSessionService({ db, rootPath: dir, now: () => ++clock, acquireWorkSlot: () => false,
      runtime: { ensureReady: async () => {}, dispatchTurn, terminateTurn: async () => {}, interruptTurn: async () => {} },
    })
    const created = sessions.create({ requestId: 'old-create', title: '已有对话' })
    sessions.sendMessage({ requestId: 'old-message', sessionId: created.sessionId, text: '继续这条消息', refs: [] })
    await sessions.idle()
    expect(dispatchTurn).not.toHaveBeenCalled()
    const service = createWorkService({ db, spaceId: 'space_test', rootPath: dir, sessions, generation: { cancel }, now: () => ++clock,
      slots: { reserve(_spaceId, id) { occupied.add(id); return true }, release(_spaceId, id) { occupied.delete(id) } },
    })
    expect(service.activateQueued(created.workItemId!)?.item.status).toBe('in_progress')
    await sessions.idle()
    expect(dispatchTurn).toHaveBeenCalledTimes(1)
    expect(dispatchTurn.mock.calls[0]?.[0]).toMatchObject({ sessionId: created.sessionId, text: '继续这条消息' })
    sessions.dispose()
  })
})

describe('Reparenting work items', () => {
  it('roots can become children, switch parents or become roots again, updating both child lists idempotently', () => {
    const item = create(), oldParent = create('原父项'), newParent = create('新父项')
    const attached = work.reparent({ requestId: 'attach', workItemId: item.workItemId, parentId: oldParent.workItemId })
    expect(METHODS['work.reparent'].result.parse(attached)).toEqual(attached)
    expect(attached).toMatchObject({ oldParentId: null, item: { parentId: oldParent.workItemId, revision: item.revision + 1 } })
    const beforeOld = work.get({ workItemId: oldParent.workItemId }).item
    const beforeSeq = db.select().from(s.events).all().length
    const params = { requestId: 'new-parent', workItemId: item.workItemId, parentId: newParent.workItemId }
    const moved = work.reparent(params)
    expect(moved).toMatchObject({ oldParentId: oldParent.workItemId, item: { parentId: newParent.workItemId } })
    expect(work.get({ workItemId: oldParent.workItemId }).item).toMatchObject({ childIds: [], revision: beforeOld.revision + 1 })
    expect(work.get({ workItemId: newParent.workItemId }).item).toMatchObject({ childIds: [item.workItemId], revision: newParent.revision + 1 })
    const events = db.select().from(s.events).all()
    expect(events.slice(beforeSeq).map(event => [event.type, event.entityId])).toEqual([
      ['work.itemChanged', oldParent.workItemId], ['work.itemChanged', newParent.workItemId], ['work.itemChanged', item.workItemId],
    ])
    expect(work.reparent(params)).toEqual(moved)
    expect(db.select().from(s.events).all()).toEqual(events)
    expect(() => work.reparent({ ...params, parentId: null })).toThrowError(expect.objectContaining({ code: 'idempotency_conflict' }))
    expect(work.reparent({ ...params, requestId: 'same-parent' })).toEqual({ item: moved.item, oldParentId: newParent.workItemId })
    expect(db.select().from(s.events).all()).toEqual(events)
    expect(work.reparent({ ...params, requestId: 'detach', parentId: null })).toMatchObject({ oldParentId: newParent.workItemId, item: { parentId: null } })
    expect(work.get({ workItemId: newParent.workItemId }).item.childIds).toEqual([])
  })

  it.each(['todo', 'in_progress', 'in_review', 'done'] as const)('reparenting preserves %s status, sessions, directories, slots and queue information', status => {
    const item = activate(create().workItemId), parent = create('新父项')
    db.update(s.workItems).set({ status, waitingSlotSince: clock, pendingFeedback: true }).where(eq(s.workItems.id, item.workItemId)).run()
    const before = work.get({ workItemId: item.workItemId }).item
    const reserved = [...occupied]
    const moved = work.reparent({ requestId: 'move-preserve', workItemId: item.workItemId, parentId: parent.workItemId })
    expect(moved.item).toEqual({ ...before, parentId: parent.workItemId, revision: before.revision + 1 })
    expect([...occupied]).toEqual(reserved)
    expect(stop).not.toHaveBeenCalled(); expect(cancel).not.toHaveBeenCalled()
  })

  it('active turns and generation remain unchanged', () => {
    const item = activate(create().workItemId), parent = create('新父项'), actor = actorFor(item.workItemId)
    db.insert(s.messages).values({ id: 'running-message', sessionId: actor.sessionId, text: '执行', deliveryState: 'delivered', createdAt: clock }).run()
    db.insert(s.turns).values({ id: 'running-turn', sessionId: actor.sessionId, messageId: 'running-message', status: 'running', startedAt: clock }).run()
    db.insert(s.generationJobs).values({ id: 'running-job', sessionId: actor.sessionId, kind: 'image', provider: 'mock', model: 'mock', params: {}, status: 'running', createdAt: clock, updatedAt: clock }).run()
    const before = { turns: db.select().from(s.turns).all(), jobs: db.select().from(s.generationJobs).all(), sessions: db.select().from(s.sessions).all() }
    expect(work.reparent({ requestId: 'running-reparent', workItemId: item.workItemId, parentId: parent.workItemId }).item.sessions[0]?.activeTurnId).toBe('running-turn')
    expect({ turns: db.select().from(s.turns).all(), jobs: db.select().from(s.generationJobs).all(), sessions: db.select().from(s.sessions).all() }).toEqual(before)
    expect(stop).not.toHaveBeenCalled(); expect(cancel).not.toHaveBeenCalled()
  })

  it('rejects self, children, archived or cross-project parents without writing events', async () => {
    const item = create(), parent = create('有效父项'), nested = await child(parent.workItemId, '子项', false), archived = create('已归档')
    db.update(s.workItems).set({ archivedAt: clock }).where(eq(s.workItems.id, archived.workItemId)).run()
    const events = db.select().from(s.events).all()
    for (const parentId of [item.workItemId, nested.workItemId, archived.workItemId, 'other-project-work']) {
      expect(() => work.reparent({ requestId: `invalid-${parentId}`, workItemId: item.workItemId, parentId })).toThrowError(expect.objectContaining({ code: 'invalid_params', message: expect.stringMatching(/^(Cannot move a work item under itself|Parent work item must be an unarchived root work item in the same project|Can only move under a root work item)$/) }))
    }
    expect(work.get({ workItemId: item.workItemId }).item).toEqual(item)
    expect(db.select().from(s.events).all()).toEqual(events)
  })

  it('roots with children cannot be reparented and Agents cannot reparent work items', async () => {
    const parent = create(), item = await child(parent.workItemId, '子项', false), target = create('新父项')
    expect(() => work.reparent({ requestId: 'has-children', workItemId: parent.workItemId, parentId: target.workItemId })).toThrowError(expect.objectContaining({ code: 'invalid_params', message: 'It still has children' }))
    expect(() => work.reparent({ requestId: 'agent-reparent', workItemId: item.workItemId, parentId: null }, actorFor(item.workItemId))).toThrowError(expect.objectContaining({ code: 'forbidden' }))
  })

  it('unacknowledged reports reroute to the new parent main session; acknowledged reports and child messages remain, and old batches cannot acknowledge new deliveries', async () => {
    const oldParent = create(), oldActor = addSession(oldParent.workItemId), newParent = create('新父项')
    addSession(newParent.workItemId, 'new-later', clock + 20)
    const newActor = addSession(newParent.workItemId, 'new-main', clock + 10)
    const archived = addSession(newParent.workItemId, 'new-archived', clock - 10)
    db.update(s.sessions).set({ archivedAt: clock }).where(eq(s.sessions.id, archived.sessionId)).run()
    const item = await child(oldParent.workItemId), actor = actorFor(item.workItemId)
    const acked = work.report({ requestId: 'acked-report', kind: 'question', body: '已确认报告' }, actor)
    claimWorkMessages(db, oldActor.sessionId, 'old-acked')
    markWorkMessagesDelivered(db, oldActor.sessionId, 'old-acked', ++clock)
    ackWorkMessages(db, oldActor.sessionId, 'old-acked', ++clock)
    const delivered = work.report({ requestId: 'delivered-report', kind: 'blocked', body: '已送达但未确认' }, actor)
    claimWorkMessages(db, oldActor.sessionId, 'old-unacked')
    markWorkMessagesDelivered(db, oldActor.sessionId, 'old-unacked', ++clock)
    db.update(s.workMessages).set({ redelivered: true }).where(eq(s.workMessages.id, delivered.messageId)).run()
    const pending = work.report({ requestId: 'pending-report', kind: 'escalation', body: '尚未送达' }, actor)
    const before = db.select().from(s.workMessages).all()
    notifyWorkActivated.mockClear()
    work.reparent({ requestId: 'reroute', workItemId: item.workItemId, parentId: newParent.workItemId })
    const after = db.select().from(s.workMessages).all()
    for (const message of before) {
      expect(after.find(row => row.id === message.id)).toEqual([delivered.messageId, pending.messageId].includes(message.id)
        ? { ...message, targetSessionId: newActor.sessionId, deliveryId: null, deliveredAt: null, redelivered: false }
        : message)
    }
    expect(after.find(message => message.id === acked.messageId)?.targetSessionId).toBe(oldActor.sessionId)
    expect(notifyWorkActivated).toHaveBeenCalledWith(newActor.sessionId)
    expect(ackWorkMessages(db, oldActor.sessionId, 'old-unacked', ++clock)).toBe(0)
    expect(claimWorkMessages(db, newActor.sessionId, 'new-batch').map(message => message.id)).toEqual([delivered.messageId, pending.messageId])
    const later = work.report({ requestId: 'later-report', kind: 'question', body: '挪动之后' }, actor)
    expect(db.select().from(s.workMessages).where(eq(s.workMessages.id, later.messageId)).get()?.targetSessionId).toBe(newActor.sessionId)
    expect(() => work.reply({ requestId: 'old-parent-reply', workItemId: item.workItemId, body: '旧父项回复' }, oldActor)).toThrowError(expect.objectContaining({ code: 'forbidden' }))
    expect(work.reply({ requestId: 'new-parent-reply', workItemId: item.workItemId, body: '新父项回复' }, newActor)).toHaveProperty('messageId')
    work.reparent({ requestId: 'detach-report', workItemId: item.workItemId, parentId: null })
    expect(db.select().from(s.workMessages).where(eq(s.workMessages.id, later.messageId)).get()).toMatchObject({ targetSessionId: null, deliveryId: null, deliveredAt: null })
    expect(() => work.report({ requestId: 'detached-report', kind: 'question', body: '独立项' }, actor)).toThrowError(expect.objectContaining({ code: 'forbidden' }))
  })

  it('withdraws unsent retry drafts from the old parent while reports from other children in the same batch remain claimable', async () => {
    const oldParent = create(), oldActor = addSession(oldParent.workItemId), newParent = create('新父项'), newActor = addSession(newParent.workItemId)
    const item = await child(oldParent.workItemId), sibling = await child(oldParent.workItemId, '同批子项')
    const report = work.report({ requestId: 'move-batch-report', kind: 'question', body: '挪动回报' }, actorFor(item.workItemId))
    const remaining = work.report({ requestId: 'keep-batch-report', kind: 'question', body: '保留回报' }, actorFor(sibling.workItemId))
    claimWorkMessages(db, oldActor.sessionId, 'retry-batch')
    markWorkMessagesDelivered(db, oldActor.sessionId, 'retry-batch', ++clock)
    db.insert(s.messages).values([
      { id: 'old-rejected-report', sessionId: oldActor.sessionId, text: '挪动回报、保留回报', workDeliveryId: 'retry-batch', deliveryState: 'unknown', createdAt: clock },
      { id: 'old-retry-draft', sessionId: oldActor.sessionId, text: '挪动回报、保留回报', workDeliveryId: 'retry-batch', deliveryState: 'draft', createdAt: clock, queueOrder: 1 },
    ]).run()
    work.reparent({ requestId: 'reroute-draft', workItemId: item.workItemId, parentId: newParent.workItemId })
    expect(db.select().from(s.messages).all().map(message => message.deliveryState)).toEqual(['withdrawn', 'withdrawn'])
    expect(db.select().from(s.events).all()).toContainEqual(expect.objectContaining({ type: 'message.stateChanged', entityId: 'old-retry-draft', payload: { messageId: 'old-retry-draft', deliveryState: 'withdrawn' } }))
    expect(claimWorkMessages(db, oldActor.sessionId, 'old-remaining').map(message => message.id)).toEqual([remaining.messageId])
    expect(claimWorkMessages(db, newActor.sessionId, 'new-moved').map(message => message.id)).toEqual([report.messageId])
  })
})

describe('Work items integrated with real session queues', () => {
  let sessions: ReturnType<typeof createSessionService>
  let dispatchTurn: ReturnType<typeof vi.fn<(input: DispatchInput) => Promise<void>>>
  let interruptTurn: ReturnType<typeof vi.fn<(input: { sessionId: string; turnId: string }) => Promise<void>>>

  beforeEach(() => {
    dispatchTurn = vi.fn(async (_input: DispatchInput) => {})
    interruptTurn = vi.fn(async (_input: { sessionId: string; turnId: string }) => {})
    sessions = runtimeSessions = createSessionService({ db, rootPath: dir, now: () => ++clock,
      runtime: { ensureReady: async () => {}, dispatchTurn, terminateTurn: async () => {}, interruptTurn },
      onWorkFailure: (t, failure, key) => work.notifySessionFailure(t, failure, key),
    })
    work = createWorkService({ db, spaceId: 'space_test', rootPath: dir, sessions, generation: { cancel }, now: () => ++clock,
      slots: { reserve(_spaceId, id) { if (occupied.has(id)) return true; if (occupied.size >= limit) return false; occupied.add(id); return true }, release(_spaceId, id) { occupied.delete(id) } },
    })
  })

  async function complete(input: DispatchInput) {
    sessions.handleAgentEvent({ type: 'turn_ended', sessionId: input.sessionId, turnId: input.turnId, status: 'completed' })
    await sessions.idle()
  }

  it('warns the parent main session once per silent child turn and clears the card on recovery, without warning roots', async () => {
    const parent = activate(create('Parent').workItemId)
    await sessions.idle()
    const parentTurn = dispatchTurn.mock.calls[0]![0]
    clock += 10 * 60_000
    sessions.checkWatchdog()
    expect(work.get({ workItemId: parent.workItemId }).messages.filter(message => message.kind === 'failure')).toEqual([])
    expect(work.get({ workItemId: parent.workItemId }).item.sessions[0]!.silentSince).not.toBeNull()
    await complete(parentTurn)
    const item = await child(parent.workItemId, 'Quiet child')
    await sessions.idle()
    const turn = dispatchTurn.mock.calls.find(([input]) => input.sessionId === item.sessions[0]!.sessionId)![0]
    clock += 10 * 60_000
    sessions.checkWatchdog()
    await sessions.idle()
    const detail = work.get({ workItemId: item.workItemId })
    const warning = detail.messages.filter(message => message.kind === 'failure')
    expect(warning).toHaveLength(1)
    expect(warning[0]).toMatchObject({ from: { kind: 'system', failure: { reason: 'turn_silent', turnId: turn.turnId } } })
    expect(db.select().from(s.workMessages).where(eq(s.workMessages.id, warning[0]!.messageId)).get()?.targetSessionId).toBe(parent.sessions[0]!.sessionId)
    expect(warning[0]!.body).toContain('no activity for 10 minutes')
    expect(warning[0]!.body).toContain('has not been stopped. Recall it or keep waiting')
    expect(detail.item.sessions[0]!.silentSince).not.toBeNull()
    expect(detail.item.failure).toBeNull()
    sessions.recordActivity(turn.sessionId, turn.turnId)
    expect(work.get({ workItemId: item.workItemId }).item.sessions[0]!.silentSince).toBeNull()
    clock += 10 * 60_000
    sessions.checkWatchdog()
    expect(work.get({ workItemId: item.workItemId }).messages.filter(message => message.kind === 'failure')).toHaveLength(1)
    await complete(turn)
    expect(work.get({ workItemId: item.workItemId }).item.sessions[0]!.silentSince).toBeNull()
  })

  it.each(['recall', 'delete'] as const)('%s finishes and cleans the interrupted turn when the Agent ignores interrupts', async action => {
    vi.useFakeTimers()
    try {
      const item = activate(create('Hung worker').workItemId)
      await sessions.idle()
      const turn = dispatchTurn.mock.calls[0]![0]
      interruptTurn.mockImplementation(() => new Promise<void>(() => {}))
      const result = work[action]({ requestId: crypto.randomUUID(), workItemId: item.workItemId })
      await vi.advanceTimersByTimeAsync(29_999)
      expect(db.select().from(s.turns).where(eq(s.turns.id, turn.turnId)).get()?.status).toBe('running')
      await vi.advanceTimersByTimeAsync(1)
      await result
      expect(db.select().from(s.turns).where(eq(s.turns.id, turn.turnId)).get()?.status).toBe('interrupted')
      expect(sessions.list({ includeArchived: true }).sessions.find(session => session.sessionId === turn.sessionId)).toMatchObject({ activeTurnId: null, pendingApprovals: 0, queuePaused: true })
      expect(occupied.has(item.workItemId)).toBe(false)
      const updated = db.select().from(s.workItems).where(eq(s.workItems.id, item.workItemId)).get()!
      if (action === 'delete') expect(updated.archivedAt).not.toBeNull()
      else expect(updated.status).toBe('todo')
    } finally { vi.useRealTimers() }
  })

  it('notifies the parent main session once after a child batch exhausts redelivery and exposes its failure', async () => {
    const parent = activate(create('Parent').workItemId)
    await sessions.idle()
    await complete(dispatchTurn.mock.calls[0]![0])
    dispatchTurn.mockRejectedValue(new DispatchError('rejected', 'Agent unavailable'))
    const item = await child(parent.workItemId, 'Failed child')
    await sessions.idle()
    const detail = work.get({ workItemId: item.workItemId })
    const failures = detail.messages.filter(message => message.kind === 'failure')
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatchObject({ to: 'parent', from: { kind: 'system', failure: { reason: 'dispatch_rejected' } } })
    expect(failures[0]?.body).toContain('Failed child')
    expect(failures[0]?.body).toContain('Message delivery failed')
    expect(detail.item).toMatchObject({ activity: 'error', failure: { reason: 'dispatch_rejected' } })
    expect(dispatchTurn.mock.calls.filter(([input]) => input.sessionId === item.sessions[0]!.sessionId)).toHaveLength(2)
    expect(dispatchTurn.mock.calls.filter(([input]) => input.sessionId === parent.sessions[0]!.sessionId)).toHaveLength(3)
    // A failed parent notification cannot recursively generate more system work messages.
    expect(db.select().from(s.workMessages).all().filter(message => message.kind === 'failure')).toHaveLength(1)
    sessions.recover()
    await sessions.idle()
    expect(db.select().from(s.workMessages).all().filter(message => message.kind === 'failure')).toHaveLength(1)
    const rejected = db.select().from(s.messages).where(eq(s.messages.sessionId, item.sessions[0]!.sessionId)).all().at(-1)!
    sessions.retryMessage({ requestId: 'manual-retry-same-failure', messageId: rejected.id })
    await sessions.idle()
    expect(db.select().from(s.workMessages).all().filter(message => message.kind === 'failure')).toHaveLength(1)
    expect(work.get({ workItemId: item.workItemId }).item.failure?.reason).toBe('dispatch_rejected')
  })

  it('keeps root failures visible to the user and retains child notifications when no parent session is reachable', async () => {
    dispatchTurn.mockRejectedValue(new DispatchError('unknown', 'Receipt unavailable'))
    const root = activate(create('Root failure').workItemId)
    await sessions.idle()
    expect(work.get({ workItemId: root.workItemId })).toMatchObject({ item: { activity: 'error', failure: { reason: 'dispatch_unknown' } }, messages: [expect.anything(), expect.objectContaining({ kind: 'failure', to: 'user' })] })
    const parent = create('No parent session')
    const item = await child(parent.workItemId, 'Unreachable child')
    await sessions.idle()
    const failure = db.select().from(s.workMessages).all().find(message => message.workItemId === item.workItemId && message.kind === 'failure')!
    expect(failure).toMatchObject({ targetSessionId: null, to: 'parent' })
    expect(work.inbox().groups[0]?.items.some(group => group.workItemId === item.workItemId)).toBe(true)
  })

  it('reports a failed ordinary turn once and clears the card failure after a later successful turn', async () => {
    const parent = activate(create('Turn parent').workItemId)
    await sessions.idle(); await complete(dispatchTurn.mock.calls[0]![0])
    const item = await child(parent.workItemId, 'Turn child')
    await sessions.idle()
    work.report({ requestId: 'ordinary-turn-setup-report', kind: 'question', body: 'Ready for the next instruction' }, actorFor(item.workItemId))
    await complete(dispatchTurn.mock.calls.at(-1)![0])
    const sessionId = item.sessions[0]!.sessionId
    sessions.sendMessage({ requestId: 'fail-user-turn', sessionId, text: 'Do work', refs: [] })
    await sessions.idle()
    const input = dispatchTurn.mock.calls.at(-1)![0]
    sessions.handleAgentEvent({ type: 'turn_ended', sessionId, turnId: input.turnId, status: 'failed' })
    sessions.handleAgentEvent({ type: 'turn_ended', sessionId, turnId: input.turnId, status: 'failed' })
    await sessions.idle()
    expect(work.get({ workItemId: item.workItemId }).messages.filter(message => message.kind === 'failure')).toHaveLength(1)
    expect(work.get({ workItemId: item.workItemId }).item.failure?.reason).toBe('turn_failed')
    sessions.sendMessage({ requestId: 'recover-user-turn', sessionId, text: 'Continue', refs: [] })
    await sessions.idle(); await complete(dispatchTurn.mock.calls.at(-1)![0])
    expect(work.get({ workItemId: item.workItemId }).item.failure).toBeNull()
  })

  it.each(['done', 'in_review', 'todo', 'archived'] as const)('retains queued user messages after %s and resumes them through explicit reopening', async status => {
    const item = activate(create(`Queued ${status}`).workItemId)
    await sessions.idle()
    const running = dispatchTurn.mock.calls.at(-1)![0]
    const sessionId = item.sessions[0]!.sessionId
    const draft = sessions.sendMessage({ requestId: `queued-${status}`, sessionId, text: 'Keep this message', refs: [] })
    if (status === 'archived') db.update(s.sessions).set({ archivedAt: ++clock, queuePaused: true }).where(eq(s.sessions.id, sessionId)).run()
    else work.move({ requestId: `end-${status}`, workItemId: item.workItemId, status })
    await complete(running)
    expect(db.select().from(s.messages).where(eq(s.messages.id, draft.messageId)).get()?.deliveryState).toBe('draft')
    expect(dispatchTurn).toHaveBeenCalledTimes(1)
    work.reopen({ requestId: `reopen-${status}`, workItemId: item.workItemId, resumeSessionId: sessionId })
    await sessions.idle()
    expect(dispatchTurn.mock.calls.some(([input]) => input.sessionId === sessionId && input.text === 'Keep this message')).toBe(true)
    expect(db.select().from(s.messages).where(eq(s.messages.id, draft.messageId)).get()?.deliveryState).toBe('delivered')
  })

  it('unacknowledged reports reach the new parent after reparenting; old parent records remain and completion of old turns cannot acknowledge them incorrectly', async () => {
    const oldParent = activate(create('原父项').workItemId), newParent = activate(create('新父项').workItemId)
    await sessions.idle()
    await complete(dispatchTurn.mock.calls[0]![0]); await complete(dispatchTurn.mock.calls[1]![0])
    const item = await child(oldParent.workItemId)
    await sessions.idle()
    const report = work.report({ requestId: 'runtime-reparent-report', kind: 'question', body: '请新父项确认颜色' }, actorFor(item.workItemId))
    await sessions.idle()
    const oldDelivery = dispatchTurn.mock.calls[3]![0]
    expect(oldDelivery.sessionId).toBe(oldParent.sessions[0]!.sessionId)
    expect(oldDelivery.text).toContain('请新父项确认颜色')
    work.reparent({ requestId: 'runtime-reparent', workItemId: item.workItemId, parentId: newParent.workItemId })
    await sessions.idle()
    const newDelivery = dispatchTurn.mock.calls[4]![0]
    expect(newDelivery.sessionId).toBe(newParent.sessions[0]!.sessionId)
    expect(newDelivery.text).toContain('请新父项确认颜色')
    expect(db.select().from(s.messages).where(eq(s.messages.sessionId, oldDelivery.sessionId)).all().some(message => message.text.includes('请新父项确认颜色'))).toBe(true)
    expect(db.select().from(s.turns).where(eq(s.turns.id, oldDelivery.turnId)).get()?.status).toBe('running')
    expect(interruptTurn).not.toHaveBeenCalled()
    await complete(oldDelivery)
    expect(db.select().from(s.workMessages).where(eq(s.workMessages.id, report.messageId)).get()?.ackedAt).toBeNull()
    await complete(newDelivery)
    expect(db.select().from(s.workMessages).where(eq(s.workMessages.id, report.messageId)).get()).toMatchObject({ targetSessionId: newDelivery.sessionId, ackedAt: expect.any(Number) })
  })

  it('activating a new parent without prior sessions delivers pending unacknowledged reports after reparenting', async () => {
    const oldParent = create('原父项'), newParent = create('尚无会话的新父项'), item = await child(oldParent.workItemId)
    await sessions.idle()
    const report = work.report({ requestId: 'no-session-report', kind: 'question', body: '等待新父项主会话' }, actorFor(item.workItemId))
    work.reparent({ requestId: 'no-session-reparent', workItemId: item.workItemId, parentId: newParent.workItemId })
    await sessions.idle()
    expect(dispatchTurn).toHaveBeenCalledTimes(1)
    expect(db.select().from(s.workMessages).where(eq(s.workMessages.id, report.messageId)).get()?.targetSessionId).toBeNull()
    const parent = activate(newParent.workItemId)
    await sessions.idle()
    const delivery = dispatchTurn.mock.calls[1]![0]
    expect(delivery.sessionId).toBe(parent.sessions[0]!.sessionId)
    expect(delivery.text).toContain('等待新父项主会话')
    await complete(delivery)
    expect(db.select().from(s.workMessages).where(eq(s.workMessages.id, report.messageId)).get()).toMatchObject({ targetSessionId: delivery.sessionId, ackedAt: expect.any(Number) })
  })

  it('activating a worker automatically delivers the brief; multiple replies while busy merge into the next turn', async () => {
    const item = await child(create().workItemId, '待激活执行者', false), actor = actorFor(item.workItemId)
    await sessions.idle()
    expect(dispatchTurn).not.toHaveBeenCalled()
    activate(item.workItemId)
    await sessions.idle()
    expect(dispatchTurn).toHaveBeenCalledTimes(1)
    const brief = dispatchTurn.mock.calls[0]![0]
    expect(brief).toMatchObject({ sessionId: actor.sessionId, workContext: { workItemId: item.workItemId, parentId: item.parentId, hasChildren: false } })
    expect(brief.text).toContain('子任务说明')
    const first = work.reply({ requestId: 'busy-reply-a', workItemId: item.workItemId, body: '先改颜色' })
    const second = work.reply({ requestId: 'busy-reply-b', workItemId: item.workItemId, body: '再调整排版' })
    await sessions.idle()
    expect(dispatchTurn).toHaveBeenCalledTimes(1)
    await complete(brief)
    expect(dispatchTurn).toHaveBeenCalledTimes(2)
    const reply = dispatchTurn.mock.calls[1]![0]
    expect(reply.text).toContain('先改颜色'); expect(reply.text).toContain('再调整排版')
    const batch = db.select().from(s.workMessages).where(eq(s.workMessages.kind, 'reply')).all()
    expect(batch.map(message => message.id)).toEqual([first.messageId, second.messageId])
    expect(batch[0]?.deliveryId).not.toBeNull(); expect(batch[0]?.deliveryId).toBe(batch[1]?.deliveryId)
    work.submitReview({ requestId: 'queue-test-review', workItemId: item.workItemId })
    await complete(reply)
    expect(db.select().from(s.workMessages).all().every(message => message.ackedAt !== null)).toBe(true)
  })

  it('rejection resumes the original worker immediately or after waiting for a slot, delivers only feedback and preserves the activation baseline', async () => {
    limit = 1
    const parent = create(), item = await child(parent.workItemId), actor = actorFor(item.workItemId)
    await sessions.idle()
    await complete(dispatchTurn.mock.calls[0]![0])
    work.report({ requestId: 'done-for-feedback', kind: 'done', body: '完成草稿' }, actor)
    const immediate = work.review({ requestId: 'feedback-now', workItemId: item.workItemId, decision: 'reject', feedback: '颜色更明亮' })
    await sessions.idle()
    expect(immediate.queued).toBe(false); expect(immediate.item.activationSeq).toBe(item.activationSeq)
    expect(dispatchTurn).toHaveBeenCalledTimes(2)
    expect(dispatchTurn.mock.calls[1]![0].text).toContain('颜色更明亮')
    expect(dispatchTurn.mock.calls[1]![0].text).not.toContain('· brief ·')
    await complete(dispatchTurn.mock.calls[1]![0])
    work.report({ requestId: 'done-before-full', kind: 'done', body: '颜色已改' }, actor)
    const blocker = await child(parent.workItemId, '占满名额')
    await sessions.idle()
    const queued = work.review({ requestId: 'feedback-queued', workItemId: item.workItemId, decision: 'reject', feedback: '文字再放大' })
    await sessions.idle()
    expect(queued).toMatchObject({ queued: true, item: { status: 'todo', pendingFeedback: true, reviewReportId: null } })
    expect(dispatchTurn).toHaveBeenCalledTimes(3)
    await complete(dispatchTurn.mock.calls[2]![0])
    work.submitReview({ requestId: 'release-blocker', workItemId: blocker.workItemId })
    const resumed = work.activateQueued(item.workItemId)!
    await sessions.idle()
    expect(resumed.item).toMatchObject({ status: 'in_progress', activationSeq: item.activationSeq, pendingFeedback: false })
    expect(dispatchTurn).toHaveBeenCalledTimes(4)
    expect(dispatchTurn.mock.calls[3]![0]).toMatchObject({ sessionId: actor.sessionId })
    expect(dispatchTurn.mock.calls[3]![0].text).toContain('文字再放大')
    expect(dispatchTurn.mock.calls[3]![0].text).not.toContain('· brief ·')
  })

  it('child reports wake the coordinator and copy the user; approval archives the worker and stops further dequeuing', async () => {
    const parent = activate(create().workItemId)
    await sessions.idle()
    await complete(dispatchTurn.mock.calls[0]![0])
    work.reply({ requestId: 'root-coordinator-reply', workItemId: parent.workItemId, body: '请继续协调' })
    await sessions.idle()
    expect(dispatchTurn.mock.calls[1]![0]).toMatchObject({ sessionId: parent.sessions[0]!.sessionId })
    expect(dispatchTurn.mock.calls[1]![0].text).toContain('请继续协调')
    await complete(dispatchTurn.mock.calls[1]![0])
    const item = await child(parent.workItemId), actor = actorFor(item.workItemId)
    await sessions.idle()
    const question = work.report({ requestId: 'wake-question', kind: 'question', body: '使用哪个版本？' }, actor)
    await sessions.idle()
    expect(dispatchTurn).toHaveBeenCalledTimes(4)
    expect(dispatchTurn.mock.calls[3]![0]).toMatchObject({ sessionId: parent.sessions[0]!.sessionId, workContext: { workItemId: parent.workItemId, parentId: null, hasChildren: true } })
    expect(dispatchTurn.mock.calls[3]![0].text).toContain('使用哪个版本？')
    expect(work.inbox().groups[0]?.items[0]?.messages).toEqual([expect.objectContaining({ messageId: question.messageId })])
    await complete(dispatchTurn.mock.calls[3]![0])
    const done = work.report({ requestId: 'wake-done', kind: 'done', body: '已完成可审阅' }, actor)
    await sessions.idle()
    expect(dispatchTurn).toHaveBeenCalledTimes(5)
    expect(dispatchTurn.mock.calls[4]![0].text).toContain('已完成可审阅')
    expect(work.inbox().groups[0]?.items[0]?.messages.map(message => message.messageId)).toEqual([question.messageId, done.messageId])
    expect(work.review({ requestId: 'approve-runtime', workItemId: item.workItemId, decision: 'approve' }).item.sessions[0]?.archived).toBe(true)
    await complete(dispatchTurn.mock.calls[2]![0])
    work.reply({ requestId: 'archived-supplement', workItemId: item.workItemId, body: '归档后的补充' })
    sessions.notifyWorkActivated(actor.sessionId)
    await sessions.idle()
    expect(dispatchTurn).toHaveBeenCalledTimes(5)
    expect(db.select().from(s.sessions).where(eq(s.sessions.id, actor.sessionId)).get()).toMatchObject({ archivedAt: expect.any(Number), queuePaused: true })
  })

  it('parent recall interrupts the coordinator and child workers without redelivery after terminal events', async () => {
    const parent = activate(create().workItemId), item = await child(parent.workItemId), actor = actorFor(item.workItemId)
    await sessions.idle()
    expect(dispatchTurn).toHaveBeenCalledTimes(2)
    const recalled = await work.recall({ requestId: 'runtime-recall', workItemId: parent.workItemId })
    expect(recalled.items.map(item => item.status)).toEqual(['todo', 'todo'])
    expect(interruptTurn.mock.calls.map(([input]) => input.sessionId).sort()).toEqual([parent.sessions[0]!.sessionId, actor.sessionId].sort())
    for (const [input] of dispatchTurn.mock.calls) {
      expect(sessions.isTurnStopping(input.turnId)).toBe(true)
      sessions.handleAgentEvent({ type: 'turn_ended', sessionId: input.sessionId, turnId: input.turnId, status: 'interrupted' })
    }
    await sessions.idle()
    work.reply({ requestId: 'recalled-supplement', workItemId: item.workItemId, body: '等下次激活' })
    await sessions.idle()
    expect(dispatchTurn).toHaveBeenCalledTimes(2)
    expect(occupied.size).toBe(0)
    expect(db.select().from(s.sessions).all().every(session => session.queuePaused)).toBe(true)
  })
})

describe('Work item deletion', () => {
  function running(sessionId: string, id: string) {
    db.insert(s.messages).values({ id: `delete-msg-${id}`, sessionId, text: '执行', deliveryState: 'delivered', createdAt: clock }).run()
    db.insert(s.turns).values({ id: `delete-turn-${id}`, sessionId, messageId: `delete-msg-${id}`, status: 'running', startedAt: clock }).run()
    db.insert(s.generationJobs).values({ id: `delete-job-${id}`, sessionId, kind: 'image', provider: 'mock', model: 'mock', params: {}, status: 'running', createdAt: clock, updatedAt: clock }).run()
  }

  it('plans cover children in all states, stop before archiving, clear queues and release slots, and preserve ordinary frames and directories by default', async () => {
    const parent = activate(create('删除父项').workItemId)
    const active = await child(parent.workItemId, '进行中子项'), done = await child(parent.workItemId, '已完成子项'), review = await child(parent.workItemId, '待审阅子项')
    const question = work.report({ requestId: 'delete-question', kind: 'question', body: '还需要处理吗？' }, actorFor(active.workItemId))
    work.move({ requestId: 'delete-done', workItemId: done.workItemId, status: 'done' })
    work.report({ requestId: 'delete-report', kind: 'done', body: '尚未审阅' }, actorFor(review.workItemId))
    limit = occupied.size
    const queued = await child(parent.workItemId, '排队子项')
    expect(queued.waitingSlotSince).not.toBeNull()
    running(parent.sessions[0]!.sessionId, 'parent')
    running(actorFor(done.workItemId).sessionId, 'done')
    expect(work.deletePlan({ workItemId: parent.workItemId })).toEqual({ runningTurns: 2, unfinishedJobs: 2, childrenTotal: 4, childrenInProgress: 1, unresolvedMessages: 1, hasUnreviewedReport: true, queued: true, workDir: parent.workDir })
    const params = { requestId: 'delete-parent', workItemId: parent.workItemId }
    const result = await work.delete(params)
    expect(result.workItemIds).toEqual([parent.workItemId, active.workItemId, done.workItemId, review.workItemId, queued.workItemId])
    expect(result.cancelledJobs).toEqual([{ jobId: 'delete-job-parent', providerCancelled: false }, { jobId: 'delete-job-done', providerCancelled: false }])
    expect(stop).toHaveBeenCalledTimes(2); expect(cancel).toHaveBeenCalledTimes(2); expect(occupied.size).toBe(0)
    expect(db.select().from(s.workItems).all().every(item => item.archivedAt !== null && item.waitingSlotSince === null)).toBe(true)
    expect(db.select().from(s.sessions).all().every(session => session.archivedAt !== null && session.queuePaused)).toBe(true)
    expect(work.list({}).items).toEqual([])
    expect(work.inbox().groups).toEqual([])
    expect(work.inbox().counts).toMatchObject({ unread: 0, unresolved: 0 })
    expect(canvas.get({}).nodes).toEqual([])
    expect(() => statSync(parent.workDir)).not.toThrow()
    expect(() => work.reply({ requestId: 'delete-late-reply', workItemId: active.workItemId, replyTo: question.messageId, body: '迟到' })).toThrowError(expect.objectContaining({ code: 'already_resolved', details: { reason: 'work.message_resolved', params: {}, resolution: expect.objectContaining({ kind: 'deleted' }) } }))
    expect(() => work.reply({ requestId: 'delete-no-question', workItemId: active.workItemId, body: '追加' })).toThrowError(expect.objectContaining({ code: 'not_found' }))
    for (const id of result.workItemIds) {
      expect(() => work.get({ workItemId: id })).toThrowError(expect.objectContaining({ code: 'not_found' }))
      expect(() => work.deletePlan({ workItemId: id })).toThrowError(expect.objectContaining({ code: 'not_found' }))
      expect(() => work.markRead({ workItemId: id })).toThrowError(expect.objectContaining({ code: 'not_found' }))
      expect(() => work.changes({ workItemId: id })).toThrowError(expect.objectContaining({ code: 'not_found' }))
      expect(() => work.activate({ requestId: `deleted-activate-${id}`, workItemId: id })).toThrowError(expect.objectContaining({ code: 'not_found' }))
      expect(() => work.update({ requestId: `deleted-update-${id}`, workItemId: id, expectedRevision: 1, title: '无效' })).toThrowError(expect.objectContaining({ code: 'not_found' }))
    }
    const events = db.select().from(s.events).all()
    expect(events.filter(event => event.type === 'work.itemChanged' && (event.payload as WorkItemView).archivedAt !== null)).toHaveLength(5)
    expect(await work.delete(params)).toEqual(result)
    expect(stop).toHaveBeenCalledTimes(2); expect(cancel).toHaveBeenCalledTimes(2)
    expect(db.select().from(s.events).all()).toEqual(events)
    await expect(work.delete({ ...params, workItemId: active.workItemId })).rejects.toMatchObject({ code: 'idempotency_conflict' })
  })

  it('deleting children notifies the coordinator and removes parent references; Agents cannot read plans or delete', async () => {
    const parent = activate(create().workItemId), item = await child(parent.workItemId)
    const actor = actorFor(item.workItemId)
    expect(() => work.deletePlan({ workItemId: item.workItemId }, actor)).toThrowError(expect.objectContaining({ code: 'forbidden' }))
    await expect(work.delete({ requestId: 'agent-delete', workItemId: item.workItemId }, actor)).rejects.toMatchObject({ code: 'forbidden' })
    notifyWorkActivated.mockClear()
    await work.delete({ requestId: 'delete-child', workItemId: item.workItemId })
    expect(work.get({ workItemId: parent.workItemId })).toMatchObject({ item: { childIds: [] }, messages: expect.arrayContaining([expect.objectContaining({ kind: 'deleted', to: 'parent', body: '用户删除了子工作项「子任务」，不要再跟进。' })]) })
    expect(notifyWorkActivated).toHaveBeenCalledWith(parent.sessions[0]!.sessionId)
  })

  it('deleting workspaces and children does not change ordinary frames, nodes inside or outside frames, or canvas history', async () => {
    const parent = create('画布删除'), item = await child(parent.workItemId)
    const actor = actorFor(item.workItemId)
    const drawn = canvas.apply({ kind: 'agent', sessionId: actor.sessionId }, { requestId: 'delete-canvas-seed', ops: [
      { op: 'frame.create', tempId: 'frame', title: '普通框', x: 0, y: 0, w: 1000, h: 800 },
      { op: 'frame.create', tempId: 'nested', title: '普通子框', x: 100, y: 100, w: 300, h: 300 },
      { op: 'node.create', tempId: 'inside', kind: 'text', x: 150, y: 150, w: 100, h: 100, content: { text: '内容' } },
      { op: 'node.create', tempId: 'outside', kind: 'image', x: 4000, y: 0, w: 100, h: 100 },
    ] })
    canvas.apply({ kind: 'user' }, { requestId: 'user-move-before-delete', ops: [{ op: 'node.layout', nodeId: drawn.idMap.outside!, x: 4100 }] })
    const before = canvas.get({})
    const history = db.select().from(s.undoEntries).all()
    const operations = db.select().from(s.operations).all()
    expect(work.deletePlan({ workItemId: parent.workItemId })).not.toHaveProperty('frameNodeCount')
    await work.delete({ requestId: 'delete-canvas', workItemId: parent.workItemId })
    expect(canvas.get({})).toEqual(before)
    expect(db.select().from(s.operations).all()).toEqual(operations)
    expect(db.select().from(s.undoEntries).all()).toEqual(history)
    expect(work.list({}).items).toEqual([])
    canvas.undo({ requestId: 'undo-last-canvas' })
    expect(canvas.get({}).nodes).toHaveLength(4)
    expect(canvas.get({ nodeIds: [drawn.idMap.outside!] }).nodes[0]?.x).toBe(4000)
    canvas.redo({ requestId: 'redo-last-canvas' })
    expect(canvas.get({ nodeIds: [drawn.idMap.outside!] }).nodes[0]?.x).toBe(4100)
  })

  it('locks parents and children during failure; concurrent calls with the same requestId share finalization, and reconstructed services recover persistent deletion plans', async () => {
    const parent = activate(create().workItemId), item = await child(parent.workItemId)
    running(actorFor(item.workItemId).sessionId, 'recover')
    let reject!: (error: Error) => void
    cancel.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
    const params = { requestId: 'recover-delete', workItemId: parent.workItemId }
    const first = work.delete(params), second = work.delete(params)
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1))
    expect(stop).toHaveBeenCalledTimes(1)
    expect(work.isDeleting(parent.workItemId)).toBe(true)
    expect(() => work.move({ requestId: 'move-during-delete', workItemId: item.workItemId, status: 'done' })).toThrowError(expect.objectContaining({ code: 'busy' }))
    await expect(dispatch({ requestId: 'dispatch-during-delete', parentId: parent.workItemId, title: '新子项', brief: '禁止', agentKind: 'codex' })).rejects.toMatchObject(expect.objectContaining({ code: 'busy' }))
    const failures = Promise.allSettled([first, second])
    reject(new Error('Temporarily disconnected'))
    expect((await failures).every(result => result.status === 'rejected')).toBe(true)
    expect(occupied.size).toBe(2)
    const recovered = createWorkService({ db, spaceId: 'space_test', rootPath: dir, sessions: { stop }, generation: { cancel }, now: () => ++clock,
      slots: { reserve: () => true, release(_spaceId, id) { occupied.delete(id) } },
    })
    await recovered.recoverRecalls()
    expect(recovered.list({}).items).toEqual([])
    expect(occupied.size).toBe(0)
    expect(await recovered.delete(params)).toMatchObject({ workItemIds: [parent.workItemId, item.workItemId], cancelledJobs: [{ jobId: 'delete-job-recover', providerCancelled: false }] })
    expect(cancel).toHaveBeenCalledTimes(2)
  })

  it('a new requestId can continue the same deletion after stop failure; retries create only one deletion record and preserve cancellation responses', async () => {
    const item = activate(create().workItemId)
    expect(work.deletePlan({ workItemId: item.workItemId }).runningTurns).toBe(0)
    running(item.sessions[0]!.sessionId, 'new-turn-after-plan')
    cancel.mockImplementationOnce(async (_caller, params) => {
      db.update(s.generationJobs).set({ status: 'cancelled', providerCancelled: true }).where(eq(s.generationJobs.id, params.jobId)).run()
      return { jobId: params.jobId, providerCancelled: true } as MethodResult<'generation.cancel'>
    })
    stop.mockRejectedValueOnce(new Error('Stop failed'))
    await expect(work.delete({ requestId: 'failed-delete-stop', workItemId: item.workItemId })).rejects.toThrow('Stop failed')
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(work.list({}).items).toHaveLength(1)
    const resumed = await work.delete({ requestId: 'reopened-delete-dialog', workItemId: item.workItemId })
    expect(resumed.cancelledJobs).toEqual([{ jobId: 'delete-job-new-turn-after-plan', providerCancelled: true }])
    expect(await work.delete({ requestId: 'failed-delete-stop', workItemId: item.workItemId })).toEqual(resumed)
    expect(await work.delete({ requestId: 'reopened-delete-dialog', workItemId: item.workItemId })).toEqual(resumed)
    expect(db.select().from(s.workMessages).where(eq(s.workMessages.kind, 'deleted')).all()).toHaveLength(1)
    expect(stop).toHaveBeenCalledTimes(2); expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('overlapping deletion prevents separate child plans; a new requestId for the same parent joins ongoing deletion', async () => {
    const parent = activate(create().workItemId), item = await child(parent.workItemId)
    running(item.sessions[0]!.sessionId, 'overlap')
    let finish!: () => void
    cancel.mockImplementationOnce((_caller, params) => new Promise(resolve => {
      finish = () => {
        db.update(s.generationJobs).set({ status: 'cancelled', providerCancelled: false }).where(eq(s.generationJobs.id, params.jobId)).run()
        resolve({ jobId: params.jobId, providerCancelled: false } as MethodResult<'generation.cancel'>)
      }
    }))
    const first = work.delete({ requestId: 'overlap-parent', workItemId: parent.workItemId })
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1))
    const joined = work.delete({ requestId: 'overlap-parent-retry', workItemId: parent.workItemId })
    await expect(work.delete({ requestId: 'overlap-child', workItemId: item.workItemId })).rejects.toMatchObject({ code: 'busy' })
    finish()
    const results = await Promise.all([first, joined])
    expect(results[1]).toEqual(results[0])
    expect(cancel).toHaveBeenCalledTimes(1); expect(stop).toHaveBeenCalledTimes(1)
    expect(db.select().from(s.workMessages).where(eq(s.workMessages.kind, 'deleted')).all()).toHaveLength(2)
  })

  it('stop or cancellation failures still wait for all operations before returning, retaining persistent plans and slots for retry', async () => {
    const parent = activate(create().workItemId), item = await child(parent.workItemId)
    running(parent.sessions[0]!.sessionId, 'all-settled-parent')
    running(item.sessions[0]!.sessionId, 'all-settled-child')
    let release!: () => void
    cancel.mockRejectedValueOnce(new Error('First cancellation failed'))
    cancel.mockImplementationOnce((_caller, params) => new Promise(resolve => {
      release = () => {
        db.update(s.generationJobs).set({ status: 'cancelled', providerCancelled: false }).where(eq(s.generationJobs.id, params.jobId)).run()
        resolve({ jobId: params.jobId, providerCancelled: false } as MethodResult<'generation.cancel'>)
      }
    }))
    stop.mockRejectedValueOnce(new Error('Stop failed'))
    let settled = false
    const deleting = work.delete({ requestId: 'settle-all-delete', workItemId: parent.workItemId }).finally(() => { settled = true })
    const outcome = Promise.allSettled([deleting])
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(2))
    expect(stop).toHaveBeenCalledTimes(2)
    expect(settled).toBe(false)
    release()
    expect(await outcome).toEqual([{ status: 'rejected', reason: expect.objectContaining({ message: 'Stop failed' }) }])
    expect(work.isDeleting(parent.workItemId)).toBe(true)
    expect(work.list({}).items).toHaveLength(2)
    expect(occupied.size).toBe(2)
  })

})


describe('Child session model configuration', () => {
  const config = { model: 'careful', effort: 'high', serviceTier: 'fast' }

  it('dispatches with settings atomically and replays without catalog access or overwriting later UI changes', async () => {
    const root = create('Configured root'), actor = addSession(root.workItemId)
    db.update(s.sessions).set({ agentModel: 'quick', reasoningEffort: 'low' }).where(eq(s.sessions.id, actor.sessionId)).run()
    const params = { requestId: 'configured-dispatch', title: 'Configured child', brief: 'Explore', agentKind: 'codex', agentConfig: config }
    const result = await dispatch(params, actor)
    expect(result.item.sessions[0]!.agentConfig).toEqual(config)
    expect(work.list({}, actor).items.find(item => item.workItemId === result.item.workItemId)?.sessions[0]!.agentConfig).toEqual(config)
    const created = db.select().from(s.events).where(eq(s.events.type, 'session.created')).all().at(-1)!
    expect(created.payload).toHaveProperty('agentConfig', config)
    db.update(s.sessions).set({ agentModel: 'quick' }).where(eq(s.sessions.id, result.item.sessions[0]!.sessionId)).run()
    const events = db.select().from(s.events).all()
    agentOptions.mockRejectedValue(new Error('Not signed in'))
    expect(await dispatch(params, actor)).toEqual(result)
    expect(db.select().from(s.events).all()).toEqual(events)
    await expect(dispatch({ ...params, title: 'Conflict' }, actor)).rejects.toMatchObject({ code: 'idempotency_conflict' })
    const defaults = await child(root.workItemId, 'Agent defaults', false)
    expect(defaults.sessions[0]!.agentConfig).toEqual({ model: null, effort: null, serviceTier: null })
  })

  it('rejects unknown ids or unreadable catalogs before creating any item, session, event or request receipt', async () => {
    const root = create('Validation root'), actor = addSession(root.workItemId)
    const params = { requestId: 'invalid-dispatch', title: 'Invalid child', brief: 'Explore', agentKind: 'codex', agentConfig: config }
    const before = { items: db.select().from(s.workItems).all(), sessions: db.select().from(s.sessions).all(), events: db.select().from(s.events).all(), receipts: db.select().from(s.idempotencyKeys).all() }
    for (const [field, value, valid] of [['model', 'missing', 'careful'], ['effort', 'xhigh', 'high'], ['serviceTier', 'turbo', 'fast']]) {
      await expect(dispatch({ ...params, agentConfig: { ...config, [field!]: value } }, actor)).rejects.toMatchObject({ code: 'invalid_params', message: expect.stringContaining(field!) })
      await expect(dispatch({ ...params, agentConfig: { ...config, [field!]: value } }, actor)).rejects.toThrow(valid)
    }
    agentOptions.mockRejectedValue(new Error('Not signed in'))
    await expect(dispatch(params, actor)).rejects.toMatchObject({ code: 'unavailable', message: expect.stringContaining('Not signed in') })
    expect({ items: db.select().from(s.workItems).all(), sessions: db.select().from(s.sessions).all(), events: db.select().from(s.events).all(), receipts: db.select().from(s.idempotencyKeys).all() }).toEqual(before)
    const defaults = await dispatch({ ...params, agentConfig: { model: null, effort: null, serviceTier: null } }, actor)
    expect(defaults.item.sessions[0]!.agentConfig).toEqual({ model: null, effort: null, serviceTier: null })
  })

  it('updates only the first unarchived direct-child session and emits the existing session update event once', async () => {
    const root = create('Parent'), actor = addSession(root.workItemId)
    const target = await child(root.workItemId, 'Target', false)
    const archived = target.sessions[0]!.sessionId
    db.update(s.sessions).set({ archivedAt: clock }).where(eq(s.sessions.id, archived)).run()
    const at = ++clock
    addSession(target.workItemId, 'session-z', at)
    const main = addSession(target.workItemId, 'session-a', at)
    const params = { requestId: 'set-config', workItemId: target.workItemId, ...config }
    const result = await setAgentConfig(params, actor)
    expect(result).toMatchObject({ sessionId: main.sessionId, agentConfig: config })
    expect(work.get({ workItemId: target.workItemId }).item.revision).toBe(target.revision + 1)
    expect(work.get({ workItemId: target.workItemId }).item.sessions.map(session => session.agentConfig.model)).toEqual([null, 'careful', null])
    const events = db.select().from(s.events).where(eq(s.events.type, 'session.updated')).all()
    expect(events.map(event => event.payload)).toEqual([result])
    agentOptions.mockRejectedValue(new Error('Agent missing'))
    expect(await setAgentConfig(params, actor)).toEqual(result)
    expect(db.select().from(s.events).where(eq(s.events.type, 'session.updated')).all()).toEqual(events)
    await expect(setAgentConfig({ ...params, effort: null }, actor)).rejects.toMatchObject({ code: 'idempotency_conflict' })
    await expect(setAgentConfig({ ...params, requestId: 'unavailable-set' }, actor)).rejects.toMatchObject({ code: 'unavailable' })
    expect((await setAgentConfig({ ...params, requestId: 'restore-default', model: null, effort: null, serviceTier: null }, actor)).agentConfig).toEqual({ model: null, effort: null, serviceTier: null })
  })

  it('does not write when validation fails or the main session changes during a catalog probe', async () => {
    const root = create('Session routing root'), actor = addSession(root.workItemId)
    const target = await child(root.workItemId, 'Session routing child', false)
    const params = { requestId: 'routing-config', workItemId: target.workItemId, ...config }
    const events = db.select().from(s.events).all()
    await expect(setAgentConfig({ ...params, effort: 'unsupported' }, actor)).rejects.toMatchObject({ code: 'invalid_params', message: expect.stringContaining('effort') })
    expect(db.select().from(s.events).all()).toEqual(events)
    agentOptions.mockImplementationOnce(async () => {
      addSession(target.workItemId, 'new-main-session', 0)
      return [{ id: 'careful', label: 'Careful', isDefault: true, efforts: [{ id: 'high', label: 'High' }], defaultEffort: 'high', serviceTiers: [{ id: 'fast', label: 'Fast' }] }]
    })
    await expect(setAgentConfig(params, actor)).rejects.toMatchObject({ code: 'busy' })
    expect(db.select().from(s.idempotencyKeys).where(eq(s.idempotencyKeys.requestId, params.requestId)).get()).toBeUndefined()
    expect(work.get({ workItemId: target.workItemId }).item.sessions.every(session => session.agentConfig.model === null)).toBe(true)
    expect((await setAgentConfig(params, actor)).sessionId).toBe('new-main-session')
  })

  it('forbids self, sibling, grandchild and archived caller writes and rechecks relationships after a catalog probe', async () => {
    const root = create('Permissions root'), actor = addSession(root.workItemId)
    const target = await child(root.workItemId, 'Permissions child', false)
    const sibling = await child(root.workItemId, 'Permissions sibling', false)
    const nested = await child(create('Other root').workItemId, 'Grandchild fixture', false)
    db.update(s.workItems).set({ parentId: target.workItemId }).where(eq(s.workItems.id, nested.workItemId)).run()
    const set = (workItemId: string, caller = actor) => setAgentConfig({ requestId: crypto.randomUUID(), workItemId, ...config }, caller)
    await expect(set(root.workItemId)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(set(sibling.workItemId, actorFor(target.workItemId))).rejects.toMatchObject({ code: 'forbidden' })
    await expect(set(nested.workItemId)).rejects.toMatchObject({ code: 'forbidden' })
    agentOptions.mockImplementationOnce(async () => {
      db.update(s.workItems).set({ parentId: sibling.workItemId }).where(eq(s.workItems.id, target.workItemId)).run()
      return [{ id: 'careful', label: 'Careful', isDefault: true, efforts: [{ id: 'high', label: 'High' }], defaultEffort: 'high', serviceTiers: [{ id: 'fast', label: 'Fast' }] }]
    })
    await expect(set(target.workItemId)).rejects.toMatchObject({ code: 'forbidden' })
    expect(work.get({ workItemId: target.workItemId }).item.sessions[0]!.agentConfig.model).toBeNull()
    db.update(s.sessions).set({ archivedAt: clock }).where(eq(s.sessions.id, actor.sessionId)).run()
    await expect(set(sibling.workItemId)).rejects.toMatchObject({ code: 'forbidden' })
  })
})


describe('Child configuration review regressions', () => {
  it.each([true, false])('normalizes omitted and all-null dispatch configs with empty-first %s', async emptyFirst => {
    const parent = create('Normalized parent')
    const params = { requestId: 'normalized-dispatch', parentId: parent.workItemId, title: 'Normalized child', brief: 'Explore', agentKind: 'codex', activate: false }
    const empty = { ...params, agentConfig: { model: null, effort: null, serviceTier: null } }
    const first = await dispatch(emptyFirst ? empty : params)
    expect(await dispatch(emptyFirst ? params : empty)).toEqual(first)
    expect(work.list({ parentId: parent.workItemId }).items).toHaveLength(1)
  })

  it.each(['work.recall', 'work.delete'])('replays before pending %s guards and archived-session checks', async method => {
    const root = create('Replay parent'), actor = addSession(root.workItemId)
    const params = { requestId: 'replay-dispatch', title: 'Replay child', brief: 'Explore', agentKind: 'codex', activate: false }
    const first = await dispatch(params, actor)
    const settings = { requestId: 'replay-config', workItemId: first.item.workItemId, model: 'careful', effort: 'high', serviceTier: null }
    const configured = await setAgentConfig(settings, actor)
    db.insert(s.idempotencyKeys).values({ requestId: 'pending-transition', method, fingerprint: 'fixture', result: method === 'work.recall' ? { finished: false, items: [root, first.item] } : { finished: false, workItemIds: [root.workItemId, first.item.workItemId] }, createdAt: clock }).run()
    agentOptions.mockRejectedValue(new Error('Unavailable'))
    expect(await dispatch(params, actor)).toEqual(first)
    expect(await setAgentConfig(settings, actor)).toEqual(configured)
    await expect(dispatch({ ...params, requestId: 'new-during-transition' }, actor)).rejects.toMatchObject({ code: 'busy' })
    db.update(s.sessions).set({ archivedAt: clock }).where(eq(s.sessions.id, actor.sessionId)).run()
    expect(await dispatch(params, actor)).toEqual(first)
    expect(await setAgentConfig(settings, actor)).toEqual(configured)
    await expect(dispatch({ ...params, title: 'Conflict' }, actor)).rejects.toMatchObject({ code: 'idempotency_conflict' })
  })

  it.each(['dispatch', 'setAgentConfig'] as const)('uses the fresh actor for %s after probing', async method => {
    const root = create('Fresh actor parent'), actor = addSession(root.workItemId)
    const target = await child(root.workItemId, 'Fresh actor target', false)
    const other = create('Fresh actor other root')
    const nested = await child(other.workItemId, 'Fresh actor nested', false)
    const source = vi.fn(() => {
      const session = db.select().from(s.sessions).where(eq(s.sessions.id, actor.sessionId)).get()!
      return { sessionId: session.id, workItemId: session.workItemId! }
    })
    agentOptions.mockImplementationOnce(async () => {
      db.update(s.sessions).set({ workItemId: nested.workItemId }).where(eq(s.sessions.id, actor.sessionId)).run()
      return [{ id: 'careful', label: 'Careful', isDefault: true, efforts: [], defaultEffort: null, serviceTiers: [] }]
    })
    const params = { requestId: 'fresh-actor-write', model: 'careful', effort: null, serviceTier: null }
    const pending = method === 'dispatch'
      ? work.dispatch({ requestId: params.requestId, title: 'Fresh child', brief: 'Explore', agentKind: 'codex', agentConfig: params }, source)
      : work.setAgentConfig({ ...params, workItemId: target.workItemId }, source)
    await expect(pending).rejects.toMatchObject({ code: 'forbidden' })
    expect(source).toHaveBeenCalledTimes(2)
    expect(db.select().from(s.idempotencyKeys).where(eq(s.idempotencyKeys.requestId, params.requestId)).get()).toBeUndefined()
    expect(work.get({ workItemId: target.workItemId }).item.sessions[0]!.agentConfig.model).toBeNull()
  })
})
