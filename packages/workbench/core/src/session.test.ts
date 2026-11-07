import { beforeEach, describe, expect, it } from 'vitest'
import { and, currentSeq, eq, openSpaceDb, readEventsAfter, spaceSchema as s, type SpaceDb } from '@vis/storage'
import { type AgentRuntimePort, DispatchError, type DispatchInput } from './runtime-port'
import { createSessionService, type SessionService } from './session-service'

let db: SpaceDb
let clock: number
let sessions: SessionService
let runtime: ReturnType<typeof fakeRuntime>

/** Controllable fake runtime: records deliveries and can fail the next readiness or delivery attempt */
function fakeRuntime() {
  const dispatched: DispatchInput[] = []
  const interrupts: { sessionId: string; turnId: string }[] = []
  let readyError: Error | undefined
  let dispatchError: Error | undefined
  let dispatchGate: Promise<void> | undefined
  const port: AgentRuntimePort = {
    async ensureReady() {
      if (readyError) { const e = readyError; readyError = undefined; throw e }
    },
    async dispatchTurn(input) {
      if (dispatchError) { const e = dispatchError; dispatchError = undefined; throw e }
      dispatched.push(input)
      if (dispatchGate) { const gate = dispatchGate; dispatchGate = undefined; await gate }
    },
    async terminateTurn() {},
    async interruptTurn(input) { interrupts.push(input) },
  }
  return {
    port, dispatched, interrupts,
    failReady(e: Error) { readyError = e },
    failDispatch(e: Error) { dispatchError = e },
    /** Hold the next delivery in its startup handshake until the returned function is called */
    holdDispatch() { let release!: () => void; dispatchGate = new Promise(resolve => { release = resolve }); return release },
  }
}

beforeEach(() => {
  db = openSpaceDb(':memory:')
  clock = 1_800_000_000_000
  runtime = fakeRuntime()
  sessions = createSessionService({ db, runtime: runtime.port, now: () => ++clock })
  db.insert(s.operations).values({ id: 'op_seed', actorKind: 'user', createdAt: clock }).run()
})

let reqSeq = 0
const req = () => `req_${++reqSeq}`

function newSession() {
  const { sessionId } = sessions.create({ requestId: req(), title: '分镜创作' })
  sessions.resetTitle({ requestId: req(), sessionId })
  return sessionId
}

async function send(sessionId: string, text: string, refs: Parameters<SessionService['sendMessage']>[0]['refs'] = []) {
  const r = sessions.sendMessage({ requestId: req(), sessionId, text, refs })
  await sessions.idle()
  return r
}

function seedTextSlot(id: string, ...bodies: string[]) {
  db.insert(s.nodes).values({ id: `node_${id}`, kind: 'text', x: 0, y: 0, w: 1, h: 1, z: 0, createdAt: clock }).run()
  db.insert(s.slots).values({ id: `slot_${id}`, nodeId: `node_${id}`, slotKey: 'main', contentType: 'text' }).run()
  for (const body of bodies) revise(`slot_${id}`, body)
  return { nodeId: `node_${id}`, slotId: `slot_${id}` }
}

function revise(slotId: string, body: string) {
  const slot = db.select().from(s.slots).where(eq(s.slots.id, slotId)).get()!
  db.insert(s.slotRevisions).values({ slotId, revision: slot.currentRevision + 1, textBody: body, operationId: 'op_seed', createdAt: clock }).run()
  db.update(s.slots).set({ currentRevision: slot.currentRevision + 1 }).where(eq(s.slots.id, slotId)).run()
}

const message = (id: string) => db.select().from(s.messages).where(eq(s.messages.id, id)).get()!
const turnOf = (messageId: string) => db.select().from(s.turns).where(eq(s.turns.messageId, messageId)).get()
const session = (id: string) => db.select().from(s.sessions).where(eq(s.sessions.id, id)).get()!
const snapshotOf = (snapshotId: string) => db.select().from(s.snapshotItems).where(eq(s.snapshotItems.snapshotId, snapshotId)).all()
const notices = (sessionId: string) =>
  db.select().from(s.transcriptEntries).where(and(eq(s.transcriptEntries.sessionId, sessionId), eq(s.transcriptEntries.kind, 'notice'))).all()
    .map(n => (n.payload as { code: string }).code)

function endTurn(sessionId: string, messageId: string, status: 'completed' | 'failed' | 'interrupted' = 'completed') {
  sessions.handleAgentEvent({ type: 'turn_ended', sessionId, turnId: turnOf(messageId)!.id, status })
}

describe('Session work-item association', () => {
  it('Create a root work item and session without a canvas frame; retries acquire a slot only once', () => {
    const acquired: string[] = []
    sessions = createSessionService({ db, runtime: runtime.port, now: () => ++clock,
      acquireWorkSlot: id => { acquired.push(id); return true },
    })
    const params = { requestId: req(), title: '分镜创作', agentKind: 'claude' as const }
    const created = sessions.create(params)
    expect(created).toMatchObject({ workItemId: expect.stringMatching(/^work_/) })
    expect(db.select().from(s.workItems).all()).toEqual([expect.objectContaining({
      id: created.workItemId, parentId: null, title: '分镜创作', brief: '', status: 'in_progress',
      agentKind: 'claude', workDir: created.workDir, createdBy: { kind: 'user' },
      revision: 1, waitingSlotSince: null, pendingFeedback: false, activationSeq: expect.any(Number),
    })])
    expect(session(created.sessionId)).toMatchObject({ workItemId: created.workItemId })
    expect(sessions.create(params)).toEqual(created)
    expect(acquired).toEqual([created.workItemId])
    expect(db.select().from(s.sessions).all()).toHaveLength(1)
    expect(db.select().from(s.nodes).all()).toHaveLength(0)
  })

  it('Queue when slots are full and retain drafts; dequeue only after activation', async () => {
    sessions = createSessionService({ db, runtime: runtime.port, now: () => ++clock, acquireWorkSlot: () => false })
    const created = sessions.create({ requestId: req() })
    expect(db.select().from(s.workItems).all()).toEqual([expect.objectContaining({
      id: created.workItemId, status: 'todo', waitingSlotSince: expect.any(Number), activationSeq: null,
    })])
    const queued = await send(created.sessionId, '等待空位')
    expect(queued).toMatchObject({ deliveryState: 'draft', queuePosition: 0 })
    expect(runtime.dispatched).toHaveLength(0)
    db.update(s.workItems).set({ status: 'in_progress', waitingSlotSince: null }).where(eq(s.workItems.id, created.workItemId!)).run()
    sessions.notifyWorkActivated(created.sessionId)
    await sessions.idle()
    expect(runtime.dispatched.map(input => input.text)).toEqual(['等待空位'])
  })

  it('Transaction failure releases the slot without leaving work items or idempotency records', () => {
    const acquired: string[] = []
    const released: string[] = []
    sessions = createSessionService({ db, runtime: runtime.port, now: () => ++clock,
      acquireWorkSlot: id => { acquired.push(id); return true }, releaseWorkSlot: id => { released.push(id) },
    })
    db.$client.exec("CREATE TRIGGER reject_session BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT, 'creation failed'); END")
    const params = { requestId: req() }
    expect(() => sessions.create(params)).toThrow('creation failed')
    expect(released).toEqual(acquired)
    expect(db.select().from(s.workItems).all()).toHaveLength(0)
    expect(db.select().from(s.idempotencyKeys).all()).toHaveLength(0)
    db.$client.exec('DROP TRIGGER reject_session')
    expect(sessions.create(params).workItemId).toBeTruthy()
  })

  it('Each turn returns parent and unarchived child facts from the database', async () => {
    const parent = sessions.create({ requestId: req() })
    const child = sessions.create({ requestId: req() })
    db.update(s.workItems).set({ parentId: parent.workItemId }).where(eq(s.workItems.id, child.workItemId!)).run()
    await send(parent.sessionId, '查看子项')
    expect(runtime.dispatched.at(-1)!.workContext).toEqual({ workItemId: parent.workItemId, parentId: null, hasChildren: true })
    await send(child.sessionId, '执行工作')
    expect(runtime.dispatched.at(-1)!.workContext).toEqual({ workItemId: child.workItemId, parentId: parent.workItemId, hasChildren: false })
    sessions.handleAgentEvent({ type: 'turn_ended', sessionId: parent.sessionId, turnId: runtime.dispatched[0]!.turnId, status: 'completed' })
    db.update(s.workItems).set({ archivedAt: clock }).where(eq(s.workItems.id, child.workItemId!)).run()
    await send(parent.sessionId, '重新查看子项')
    expect(runtime.dispatched.at(-1)!.workContext).toEqual({ workItemId: parent.workItemId, parentId: null, hasChildren: false })
  })

  it('Lists and update events return workspace membership from the database', () => {
    const created = sessions.create({ requestId: req() })
    expect(sessions.list({}).sessions[0]).toMatchObject({ workItemId: created.workItemId })
    const before = currentSeq(db)
    sessions.rename({ requestId: req(), sessionId: created.sessionId, title: '创作会话' })
    expect(readEventsAfter(db, before)[0]?.payload).toMatchObject({ workItemId: created.workItemId })
  })
})

describe('Session naming', () => {
  it('Agents can name default and automatic titles; manual names are protected; restoring automatic naming retains the title', () => {
    const sessionId = newSession()
    expect(sessions.list({}).sessions[0]).toMatchObject({ title: '分镜创作', titleSource: 'default' })
    expect(sessions.setTitle(sessionId, { requestId: req(), title: '屋顶海报' })).toEqual({ applied: true, title: '屋顶海报' })
    expect(sessions.setTitle(sessionId, { requestId: req(), title: '屋顶花园海报' })).toEqual({ applied: true, title: '屋顶花园海报' })
    const renamed = sessions.rename({ requestId: req(), sessionId, title: '我的海报' })
    expect(renamed).toMatchObject({ title: '我的海报', titleSource: 'user' })
    const before = currentSeq(db)
    expect(sessions.setTitle(sessionId, { requestId: req(), title: '覆盖标题' })).toEqual({ applied: false, reason: 'user_named', title: '我的海报' })
    expect(currentSeq(db)).toBe(before)
    expect(sessions.resetTitle({ requestId: req(), sessionId })).toMatchObject({ title: '我的海报', titleSource: 'default' })
    expect(sessions.setTitle(sessionId, { requestId: req(), title: '继续创作' })).toEqual({ applied: true, title: '继续创作' })
    expect(session(sessionId)).toMatchObject({ title: '继续创作', titleSource: 'agent' })
    expect(readEventsAfter(db, before).map(e => e.payload)).toEqual([
      expect.objectContaining({ title: '我的海报', titleSource: 'default' }),
      expect.objectContaining({ title: '继续创作', titleSource: 'agent' }),
    ])
  })

  it('All three naming requests are idempotent; reusing requestId across methods or Agent sessions conflicts', () => {
    const sessionId = newSession()
    const named = { requestId: req(), title: '第一版' }
    const first = sessions.setTitle(sessionId, named)
    const renamed = { requestId: req(), sessionId, title: '手动标题' }
    const user = sessions.rename(renamed)
    const reset = { requestId: req(), sessionId }
    const automatic = sessions.resetTitle(reset)
    const before = currentSeq(db)
    expect(sessions.setTitle(sessionId, named)).toEqual(first)
    expect(sessions.rename(renamed)).toEqual(user)
    expect(sessions.resetTitle(reset)).toEqual(automatic)
    expect(currentSeq(db)).toBe(before)
    expect(session(sessionId)).toMatchObject({ title: '手动标题', titleSource: 'default' })
    expect(() => sessions.rename({ ...renamed, title: '不同标题' })).toThrow(expect.objectContaining({ code: 'idempotency_conflict' }))
    expect(() => sessions.setTitle(sessionId, { ...named, title: '不同标题' })).toThrow(expect.objectContaining({ code: 'idempotency_conflict' }))
    expect(() => sessions.resetTitle({ ...reset, sessionId: newSession() })).toThrow(expect.objectContaining({ code: 'idempotency_conflict' }))
    expect(() => sessions.rename({ ...renamed, requestId: reset.requestId })).toThrow(expect.objectContaining({ code: 'idempotency_conflict' }))
    expect(() => sessions.setTitle(newSession(), named)).toThrow(expect.objectContaining({ code: 'idempotency_conflict' }))
  })

  it('Duplicate titles do not update sessions or emit events; manual naming with the same title still enables protection', () => {
    const sessionId = newSession()
    const before = currentSeq(db)
    sessions.setTitle(sessionId, { requestId: req(), title: '分镜创作' })
    expect(currentSeq(db)).toBe(before)
    expect(session(sessionId).titleSource).toBe('default')
    sessions.rename({ requestId: req(), sessionId, title: '分镜创作' })
    expect(currentSeq(db)).toBe(before + 1)
    expect(session(sessionId).titleSource).toBe('user')
    sessions.rename({ requestId: req(), sessionId, title: '分镜创作' })
    expect(currentSeq(db)).toBe(before + 1)
  })

  it('Missing sessions return not_found', () => {
    expect(() => sessions.rename({ requestId: req(), sessionId: 'missing', title: '标题' })).toThrow(expect.objectContaining({ code: 'not_found' }))
    expect(() => sessions.resetTitle({ requestId: req(), sessionId: 'missing' })).toThrow(expect.objectContaining({ code: 'not_found' }))
    expect(() => sessions.setTitle('missing', { requestId: req(), title: '标题' })).toThrow(expect.objectContaining({ code: 'not_found' }))
  })

  it('Read the current title and source at delivery; renaming while queued reaches the next turn', async () => {
    const sessionId = newSession()
    const first = await send(sessionId, '第一轮')
    await send(sessionId, '第二轮')
    sessions.rename({ requestId: req(), sessionId, title: '用户任务名' })
    endTurn(sessionId, first.messageId)
    await sessions.idle()
    expect(runtime.dispatched.map(({ sessionTitle, titleSource }) => ({ sessionTitle, titleSource }))).toEqual([
      { sessionTitle: '分镜创作', titleSource: 'default' },
      { sessionTitle: '用户任务名', titleSource: 'user' },
    ])
  })
})

describe('Sending and queuing', () => {
  it('Idle sessions start immediately: fix snapshot -> deliver -> delivered', async () => {
    const sid = newSession()
    const ref = seedTextSlot('a', '设定 v1')
    const r = await send(sid, '把旁白写得更紧凑', [{ nodeId: ref.nodeId, versionPolicy: 'latest-at-execution' }])
    expect(r.deliveryState).toBe('submitted')
    expect(message(r.messageId).deliveryState).toBe('delivered')

    const turn = turnOf(r.messageId)!
    expect(turn).toMatchObject({ status: 'running', inputSnapshotId: expect.any(String), startedAt: expect.any(Number) })
    expect(runtime.dispatched).toEqual([
      { agentConfig: { model: null, effort: null, serviceTier: null }, sessionId: sid, sessionTitle: '分镜创作', titleSource: 'default', turnId: turn.id, text: '把旁白写得更紧凑', inputSnapshotId: turn.inputSnapshotId, refs: [{ nodeId: ref.nodeId, slotId: ref.slotId, revision: 1 }], resumeId: null, workContext: { workItemId: sessions.list({}).sessions.find(session => session.sessionId === sid)!.workItemId, parentId: null, hasChildren: false } },
    ])
    expect(sessions.getTranscript({ sessionId: sid }).items).toEqual([expect.objectContaining({ kind: 'user', payload: expect.objectContaining({ text: '把旁白写得更紧凑' }) })])
  })

  it('Retrying the same requestId sends no second message', async () => {
    const sid = newSession()
    const params = { requestId: 'req_dup', sessionId: sid, text: 'hi', refs: [] }
    const a = sessions.sendMessage(params)
    const b = sessions.sendMessage(params)
    await sessions.idle()
    expect(b).toEqual(a)
    expect(db.select().from(s.messages).all()).toHaveLength(1)
    expect(runtime.dispatched).toHaveLength(1)
  })

  it('Queue while the Agent works and dequeue in order after the current turn ends', async () => {
    const sid = newSession()
    const a = await send(sid, 'A')
    const b = await send(sid, 'B')
    const c = await send(sid, 'C')
    expect(b).toMatchObject({ deliveryState: 'draft', queuePosition: 0 })
    expect(c).toMatchObject({ deliveryState: 'draft', queuePosition: 1 })
    expect(runtime.dispatched.map(d => d.text)).toEqual(['A'])

    endTurn(sid, a.messageId)
    await sessions.idle()
    expect(runtime.dispatched.map(d => d.text)).toEqual(['A', 'B'])
    endTurn(sid, b.messageId)
    await sessions.idle()
    expect(runtime.dispatched.map(d => d.text)).toEqual(['A', 'B', 'C'])
  })

  it('Follow the latest version while queued and fix it at execution start; later edits do not affect this turn', async () => {
    const sid = newSession()
    const ref = seedTextSlot('a', 'v1')
    const a = await send(sid, 'A')
    const b = await send(sid, 'B', [{ nodeId: ref.nodeId, versionPolicy: 'latest-at-execution' }])

    revise(ref.slotId, 'v2') // Edit while waiting
    endTurn(sid, a.messageId)
    await sessions.idle()
    revise(ref.slotId, 'v3') // Continue editing during execution

    const snap = turnOf(b.messageId)!.inputSnapshotId!
    expect(snapshotOf(snap)).toEqual([expect.objectContaining({ slotId: ref.slotId, slotRevision: 2 })])
  })

  it('pinned references fix the specified revision; empty slots are targets only and do not enter the snapshot', async () => {
    const sid = newSession()
    const pinned = seedTextSlot('p', 'v1', 'v2', 'v3')
    const empty = seedTextSlot('e')
    const r = await send(sid, 'x', [
      { nodeId: pinned.nodeId, versionPolicy: 'pinned', pinnedRevision: 2 },
      { nodeId: empty.nodeId, versionPolicy: 'latest-at-execution' },
    ])
    expect(runtime.dispatched[0]!.refs).toEqual([
      { nodeId: pinned.nodeId, slotId: pinned.slotId, revision: 2 },
      { nodeId: empty.nodeId, slotId: empty.slotId, revision: null },
    ])
    expect(snapshotOf(turnOf(r.messageId)!.inputSnapshotId!)).toEqual([expect.objectContaining({ slotId: pinned.slotId, slotRevision: 2 })])
  })
})

describe('Failures before and after delivery', () => {
  it('A referenced node deleted while queued prevents delivery and silent asset replacement, notifies the user, and pauses the queue', async () => {
    const sid = newSession()
    const ref = seedTextSlot('a', 'v1')
    const a = await send(sid, 'A')
    const b = await send(sid, 'B', [{ nodeId: ref.nodeId, versionPolicy: 'latest-at-execution' }])
    db.update(s.nodes).set({ deletedAt: clock }).where(eq(s.nodes.id, ref.nodeId)).run()

    endTurn(sid, a.messageId)
    await sessions.idle()
    expect(message(b.messageId).deliveryState).toBe('rejected')
    expect(turnOf(b.messageId)!.status).toBe('failed')
    expect(session(sid).queuePaused).toBe(true)
    expect(notices(sid)).toEqual(['ref_unresolvable'])
    expect(sessions.getTranscript({ sessionId: sid }).items.find(item => item.kind === 'notice')?.payload).toMatchObject({
      code: 'ref_unresolvable', reason: 'session.ref_unresolvable',
      params: { detail: `Referenced node ${ref.nodeId} has been deleted or does not exist` },
      cause: { code: 'not_found', data: { reason: 'session.ref_node_not_found', params: { nodeId: ref.nodeId } } },
    })
    expect(runtime.dispatched).toHaveLength(1)
  })

  it('Agent startup failure marks the message rejected and pauses the queue; resuming processes later drafts', async () => {
    const sid = newSession()
    runtime.failReady(new Error('Cannot find the claude executable'))
    const a = await send(sid, 'A')
    expect(message(a.messageId).deliveryState).toBe('rejected')
    expect(notices(sid)).toEqual(['agent_start_failed'])

    const b = await send(sid, 'B')
    expect(b.deliveryState).toBe('draft')
    sessions.resumeQueue({ requestId: req(), sessionId: sid })
    await sessions.idle()
    expect(runtime.dispatched.map(d => d.text)).toEqual(['B'])
  })

  it('Unknown delivery results are marked unknown without automatic resend; user retry creates a new message and withdraws the original', async () => {
    const sid = newSession()
    runtime.failDispatch(new DispatchError('unknown', 'Delivery timed out'))
    const a = await send(sid, '生成五秒视频')
    expect(message(a.messageId).deliveryState).toBe('unknown')
    expect(turnOf(a.messageId)!.status).toBe('interrupted')
    expect(session(sid).queuePaused).toBe(true)
    expect(runtime.dispatched).toHaveLength(0)

    const retry = sessions.retryMessage({ requestId: req(), messageId: a.messageId })
    await sessions.idle()
    expect(retry).toMatchObject({ withdrawnMessageId: a.messageId, deliveryState: 'submitted' })
    expect(retry.messageId).not.toBe(a.messageId)
    expect(message(a.messageId).deliveryState).toBe('withdrawn')
    expect(message(retry.messageId).deliveryState).toBe('delivered')
    expect(runtime.dispatched.map(d => d.text)).toEqual(['生成五秒视频'])
  })

  it('Only unacknowledged or rejected messages can be retried', async () => {
    const sid = newSession()
    const a = await send(sid, 'A')
    expect(() => sessions.retryMessage({ requestId: req(), messageId: a.messageId })).toThrow(expect.objectContaining({ code: 'busy' }))
  })
})

describe('Stopping and waiting', () => {
  it('After closure, turn completion does not start the next draft; new delivery and resume requests are rejected', async () => {
    const sid = newSession()
    const first = await send(sid, 'A')
    const queued = await send(sid, 'B')
    sessions.dispose()
    endTurn(sid, first.messageId, 'interrupted')
    await sessions.idle()
    expect(runtime.dispatched.map(d => d.text)).toEqual(['A'])
    expect(message(queued.messageId).deliveryState).toBe('draft')
    expect(turnOf(queued.messageId)).toBeUndefined()
    expect(() => sessions.sendMessage({ requestId: req(), sessionId: sid, text: 'C', refs: [] })).toThrow(expect.objectContaining({ code: 'unavailable' }))
    expect(() => sessions.resumeQueue({ requestId: req(), sessionId: sid })).toThrow(expect.objectContaining({ code: 'unavailable' }))
    expect(() => sessions.retryMessage({ requestId: req(), messageId: first.messageId })).toThrow(expect.objectContaining({ code: 'unavailable' }))
  })

  it('Dequeue tasks queued but not yet executed at closure remain drafts', async () => {
    const sid = newSession()
    const queued = sessions.sendMessage({ requestId: req(), sessionId: sid, text: 'A', refs: [] })
    sessions.dispose()
    await sessions.idle()
    expect(runtime.dispatched).toEqual([])
    expect(message(queued.messageId).deliveryState).toBe('draft')
    expect(turnOf(queued.messageId)).toBeUndefined()
  })

  it('Closing while waiting for Agent readiness prevents turn delivery after execution resumes', async () => {
    let ready!: () => void
    let resume!: () => void
    const entered = new Promise<void>(resolve => { ready = resolve })
    const blocked = new Promise<void>(resolve => { resume = resolve })
    runtime.port.ensureReady = async () => { ready(); await blocked }
    const sid = newSession()
    sessions.sendMessage({ requestId: req(), sessionId: sid, text: 'A', refs: [] })
    await entered
    sessions.dispose()
    resume()
    await sessions.idle()
    expect(runtime.dispatched).toEqual([])
  })

  it('Stop verifies the turn, pauses the queue, and retains drafts; completion does not auto-dequeue, but resuming continues', async () => {
    const sid = newSession()
    const a = await send(sid, 'A')
    await send(sid, 'B')
    const turnId = turnOf(a.messageId)!.id

    expect(sessions.isTurnStopping(turnId)).toBe(false)
    await expect(sessions.stop({ requestId: req(), sessionId: sid, turnId: 'turn_stale' })).rejects.toMatchObject({ code: 'busy' })
    const stopping = sessions.stop({ requestId: req(), sessionId: sid, turnId })
    expect(sessions.isTurnStopping(turnId)).toBe(true)
    await stopping
    expect(sessions.isTurnStopping(turnId)).toBe(true)
    expect(runtime.interrupts).toEqual([{ sessionId: sid, turnId }])
    expect(session(sid).queuePaused).toBe(true)

    endTurn(sid, a.messageId, 'interrupted')
    expect(sessions.isTurnStopping(turnId)).toBe(false)
    await sessions.idle()
    expect(runtime.dispatched.map(d => d.text)).toEqual(['A'])

    sessions.resumeQueue({ requestId: req(), sessionId: sid })
    await sessions.idle()
    expect(runtime.dispatched.map(d => d.text)).toEqual(['A', 'B'])
  })

  it('Clearing the queue withdraws only queued user messages, retains work reports, is idempotent by requestId, and updates queue counts', async () => {
    const sid = newSession()
    const a = await send(sid, 'A')
    const b = await send(sid, 'B')
    const c = await send(sid, 'C')
    const summary = () => sessions.list({}).sessions.find(x => x.sessionId === sid)!
    expect(summary().queuedMessageCount).toBe(2)
    await sessions.stop({ requestId: req(), sessionId: sid, turnId: turnOf(a.messageId)!.id })
    endTurn(sid, a.messageId, 'interrupted')
    await sessions.idle()
    // Simulate a work-item report batch waiting in the queue
    db.update(s.messages).set({ workDeliveryId: 'delivery_x' }).where(eq(s.messages.id, c.messageId)).run()

    const before = currentSeq(db)
    const requestId = req()
    const cleared = sessions.clearQueue({ requestId, sessionId: sid })
    expect(cleared).toEqual({ withdrawnMessageIds: [b.messageId] })
    expect(sessions.clearQueue({ requestId, sessionId: sid })).toEqual(cleared)
    const state = (id: string) => db.select().from(s.messages).where(eq(s.messages.id, id)).get()!.deliveryState
    expect(state(b.messageId)).toBe('withdrawn')
    expect(state(c.messageId)).toBe('draft')
    expect(summary()).toMatchObject({ queuePaused: true, queuedMessageCount: 1 })
    const updates = readEventsAfter(db, before).filter(e => e.type === 'session.updated')
    expect(updates.at(-1)?.payload).toMatchObject({ queuedMessageCount: 1 })
  })

  it('Stopping during delivery handshake resends interruption after runtime acceptance so it is not lost', async () => {
    const sid = newSession()
    const release = runtime.holdDispatch()
    const a = sessions.sendMessage({ requestId: req(), sessionId: sid, text: 'A', refs: [] })
    await expect.poll(() => runtime.dispatched.length).toBe(1)
    const turnId = turnOf(a.messageId)!.id
    await sessions.stop({ requestId: req(), sessionId: sid, turnId })
    expect(runtime.interrupts).toEqual([{ sessionId: sid, turnId }])
    release()
    await sessions.idle()
    expect(runtime.interrupts).toEqual([{ sessionId: sid, turnId }, { sessionId: sid, turnId }])
    endTurn(sid, a.messageId, 'interrupted')
    expect(sessions.list({}).sessions[0]!.activeTurnId).toBeNull()
  })

  it('Do not dequeue while the Agent waits for a user answer', async () => {
    const sid = newSession()
    const a = await send(sid, 'A')
    await send(sid, 'B')
    const turnId = turnOf(a.messageId)!.id
    sessions.handleAgentEvent({ type: 'turn_waiting', sessionId: sid, turnId, waiting: true })
    expect(turnOf(a.messageId)!.status).toBe('waiting_user')
    await sessions.idle()
    expect(runtime.dispatched).toHaveLength(1)
    expect(sessions.list({}).sessions[0]!.activeTurnId).toBe(turnId)
  })
})

describe('Transcript', () => {
  it('Higher revisions replace lower ones and late older revisions are discarded; order follows first creation', async () => {
    const sid = newSession()
    const a = await send(sid, 'A')
    const turnId = turnOf(a.messageId)!.id
    const item = (itemId: string, revision: number, text: string) =>
      sessions.handleAgentEvent({ type: 'item', sessionId: sid, turnId, itemId, revision, kind: 'assistant_text', payload: { text } })
    item('itm_1', 1, '正在')
    item('itm_2', 1, '工具调用')
    item('itm_1', 3, '正在构思四个镜头')
    item('itm_1', 2, '正在构思') // Late arrival

    const items = sessions.getTranscript({ sessionId: sid }).items
    expect(items.map(i => [i.itemId, i.revision, (i.payload as { text?: string }).text])).toEqual([
      [expect.stringMatching(/^user_/), 1, 'A'],
      ['itm_1', 3, '正在构思四个镜头'],
      ['itm_2', 1, '工具调用'],
    ])
  })

  it('Paginated reads', async () => {
    const sid = newSession()
    for (const t of ['1', '2', '3']) await send(sid, t)
    const last2 = sessions.getTranscript({ sessionId: sid, limit: 2 })
    expect(last2).toMatchObject({ hasMore: true })
    expect(last2.items.map(i => (i.payload as { text: string }).text)).toEqual(['2', '3'])
    const rest = sessions.getTranscript({ sessionId: sid, beforeSeq: last2.items[0]!.createdSeq, limit: 2 })
    expect(rest).toMatchObject({ hasMore: false })
    expect(rest.items.map(i => (i.payload as { text: string }).text)).toEqual(['1'])
  })

  it('Insert a notice on context compaction; record resume id and anchor', async () => {
    const sid = newSession()
    sessions.handleAgentEvent({ type: 'context_compacted', sessionId: sid })
    sessions.handleAgentEvent({ type: 'resume_id', sessionId: sid, resumeId: 'claude-session-1' })
    sessions.handleAgentEvent({ type: 'leaf', sessionId: sid, leafUuid: 'uuid-9' })
    expect(notices(sid)).toEqual(['context_compacted'])
    expect(session(sid)).toMatchObject({ agentResumeId: 'claude-session-1', providerLeafUuid: 'uuid-9' })

    await send(sid, 'A')
    expect(runtime.dispatched[0]!.resumeId).toBe('claude-session-1')
  })
})

describe('Crash recovery', () => {
  it('After restart, interrupt active turns, mark unacknowledged messages unknown, pause the queue, and never resend automatically', async () => {
    const sid = newSession()
    db.insert(s.agentInstances).values({ id: 'ain_1', sessionId: sid, status: 'ready', tokenHash: 'h', startedAt: clock }).run()
    const a = await send(sid, 'A')
    // Simulate B submitted but not yet confirmed delivered at the time of the crash
    const b = await send(sid, 'B')
    db.update(s.messages).set({ deliveryState: 'submitted' }).where(eq(s.messages.id, b.messageId)).run()

    const restarted = createSessionService({ db, runtime: runtime.port, now: () => ++clock })
    restarted.recover()
    expect(turnOf(a.messageId)!.status).toBe('interrupted')
    expect(message(a.messageId).deliveryState).toBe('delivered')
    expect(message(b.messageId).deliveryState).toBe('unknown')
    expect(session(sid).queuePaused).toBe(true)
    expect(db.select().from(s.agentInstances).get()).toMatchObject({ status: 'exited', exitReason: 'studiod_restart' })
    expect(notices(sid)).toEqual(['runtime_restarted'])
    expect(runtime.dispatched).toHaveLength(1)
  })
})

describe('Session model and reasoning effort', () => {
  function options() {
    runtime.port.agentOptions = async () => [
      { id: 'default-model', label: '默认模型', isDefault: true, efforts: [{ id: 'high', label: '高' }], defaultEffort: 'high', serviceTiers: [{ id: 'priority', label: 'Fast' }] },
      { id: 'fast', label: '快', isDefault: false, efforts: [], defaultEffort: null, serviceTiers: [] },
    ]
  }

  it('Validate the model, selected model effort, and default model effort; persist and broadcast', async () => {
    options()
    const sid = newSession()
    expect(sessions.list({}).sessions[0]!.agentConfig).toEqual({ model: null, effort: null, serviceTier: null })
    expect((await sessions.agentOptions({ sessionId: sid })).models).toHaveLength(2)
    for (const config of [{ model: 'missing', effort: null, serviceTier: null }, { model: 'fast', effort: 'high', serviceTier: null }, { model: null, effort: 'max', serviceTier: null }]) {
      await expect(sessions.setAgentConfig({ requestId: req(), sessionId: sid, ...config })).rejects.toMatchObject({ code: 'invalid_params', details: { reason: 'session.invalid_agent_config', params: {} } })
    }
    const seq = currentSeq(db)
    const updated = await sessions.setAgentConfig({ requestId: req(), sessionId: sid, model: null, effort: 'high', serviceTier: null })
    expect(updated.agentConfig).toEqual({ model: null, effort: 'high', serviceTier: null })
    expect(db.select().from(s.sessions).where(eq(s.sessions.id, sid)).get()!.reasoningEffort).toBe('high')
    expect(readEventsAfter(db, seq).filter(event => event.type === 'session.updated')).toHaveLength(1)
    expect((await sessions.setAgentConfig({ requestId: req(), sessionId: sid, model: 'fast', effort: null, serviceTier: null })).agentConfig).toEqual({ model: 'fast', effort: null, serviceTier: null })
  })

  it('Speed accepts only tiers declared by the selected model or standard speed default, and is passed with the turn', async () => {
    options()
    const sid = newSession()
    // The fast model has no speed tiers; the default model's tier is priority
    for (const config of [{ model: 'fast', serviceTier: 'priority' }, { model: null, serviceTier: 'turbo' }]) {
      await expect(sessions.setAgentConfig({ requestId: req(), sessionId: sid, effort: null, ...config })).rejects.toMatchObject({ code: 'invalid_params', details: { reason: 'session.invalid_agent_config' } })
    }
    expect((await sessions.setAgentConfig({ requestId: req(), sessionId: sid, model: 'fast', effort: null, serviceTier: 'default' })).agentConfig).toEqual({ model: 'fast', effort: null, serviceTier: 'default' })
    const updated = await sessions.setAgentConfig({ requestId: req(), sessionId: sid, model: null, effort: null, serviceTier: 'priority' })
    expect(updated.agentConfig).toEqual({ model: null, effort: null, serviceTier: 'priority' })
    expect(db.select().from(s.sessions).where(eq(s.sessions.id, sid)).get()!.serviceTier).toBe('priority')
    sessions.sendMessage({ requestId: req(), sessionId: sid, text: 'A', refs: [] })
    await sessions.idle()
    expect(runtime.dispatched[0]!.agentConfig).toEqual({ model: null, effort: null, serviceTier: 'priority' })
  })

  it('Idempotent replay does not probe again, still rejects conflicts, and can restore defaults when the Agent is unavailable', async () => {
    options()
    const sid = newSession()
    const params = { requestId: req(), sessionId: sid, model: 'fast', effort: null, serviceTier: null }
    const first = await sessions.setAgentConfig(params)
    const seq = currentSeq(db)
    runtime.port.agentOptions = async () => { throw new Error('Agent is not installed') }
    expect(await sessions.setAgentConfig(params)).toEqual(first)
    expect(currentSeq(db)).toBe(seq)
    await expect(sessions.setAgentConfig({ ...params, model: null })).rejects.toMatchObject({ code: 'idempotency_conflict' })
    await expect(sessions.agentOptions({ sessionId: sid })).rejects.toMatchObject({ code: 'unavailable', message: 'Cannot read the model list: Agent is not installed', details: { reason: 'session.models_unavailable', params: { detail: 'Agent is not installed' } } })
    await expect(sessions.setAgentConfig({ ...params, requestId: req() })).rejects.toMatchObject({ code: 'unavailable' })
    expect((await sessions.setAgentConfig({ requestId: req(), sessionId: sid, model: null, effort: null, serviceTier: null })).agentConfig).toEqual({ model: null, effort: null, serviceTier: null })
  })

  it('Changes during startup affect only the next turn; queued messages read settings when they start', async () => {
    options()
    const sid = newSession()
    let ready!: () => void
    const blocked = new Promise<void>(resolve => { ready = resolve })
    runtime.port.ensureReady = () => blocked
    sessions.sendMessage({ requestId: req(), sessionId: sid, text: 'A', refs: [] })
    await expect.poll(() => sessions.list({}).sessions[0]!.activeTurnId).not.toBeNull()
    await sessions.setAgentConfig({ requestId: req(), sessionId: sid, model: 'fast', effort: null, serviceTier: null })
    sessions.sendMessage({ requestId: req(), sessionId: sid, text: 'B', refs: [] })
    ready()
    await sessions.idle()
    expect(runtime.dispatched[0]!.agentConfig).toEqual({ model: null, effort: null, serviceTier: null })
    sessions.handleAgentEvent({ type: 'turn_ended', sessionId: sid, turnId: runtime.dispatched[0]!.turnId, status: 'completed' })
    await sessions.idle()
    expect(runtime.dispatched[1]!.agentConfig).toEqual({ model: 'fast', effort: null, serviceTier: null })
  })
})

describe('Asset attachments', () => {
  function seedAsset() {
    db.insert(s.blobs).values({ hash: 'a'.repeat(64), byteSize: 1, createdAt: clock }).run()
    db.insert(s.assets).values({ id: 'asset_attachment', kind: 'image', origin: 'import', displayName: '参考.png', createdAt: clock }).run()
    db.insert(s.assetVersions).values({ id: 'av_attachment', assetId: 'asset_attachment', version: 1, blobHash: 'a'.repeat(64), mime: 'image/png', createdAt: clock }).run()
    return { assetVersionId: 'av_attachment' }
  }

  it('Asset metadata and public paths enter user text, original refs stay in the record, and node snapshots remain unchanged', async () => {
    sessions = createSessionService({ db, runtime: runtime.port, assetPath: () => '/project/assets/参考.png', now: () => ++clock })
    const sessionId = newSession()
    const asset = seedAsset()
    const node = { ...seedTextSlot('attachment', '原文'), versionPolicy: 'latest-at-execution' as const }
    await send(sessionId, '参照附件绘制', [asset, node])
    expect(runtime.dispatched[0]!.text).toContain(JSON.stringify({ assetId: 'asset_attachment', assetVersionId: 'av_attachment', kind: 'image', filename: '参考.png', path: '/project/assets/参考.png' }))
    expect(runtime.dispatched[0]!.refs).toEqual([{ nodeId: node.nodeId, slotId: node.slotId, revision: 1 }])
    expect(sessions.getTranscript({ sessionId }).items.find(item => item.kind === 'user')?.payload).toMatchObject({ text: '参照附件绘制', refs: [asset, node] })
  })

  it('Reject assets outside this project before creating a message', () => {
    const sessionId = newSession()
    expect(() => sessions.sendMessage({ requestId: req(), sessionId, text: '附件', refs: [{ assetVersionId: 'av_other_project' }] })).toThrow(expect.objectContaining({ code: 'not_found' }))
    expect(db.select().from(s.messages).all()).toHaveLength(0)
  })

  it('Attachment file resolution failure prevents silent delivery', async () => {
    sessions = createSessionService({ db, runtime: runtime.port, assetPath: () => { throw new Error('Attachment file is missing') }, now: () => ++clock })
    const sessionId = newSession()
    const result = await send(sessionId, '附件', [seedAsset()])
    expect(runtime.dispatched).toHaveLength(0)
    expect(message(result.messageId).deliveryState).toBe('rejected')
    expect(notices(sessionId)).toContain('ref_unresolvable')
  })
})

it('reads persisted delivery states on transcript reload, including retained and withdrawn drafts', async () => {
  const sessionId = newSession()
  await send(sessionId, 'Running message')
  const queued = await send(sessionId, 'Retained draft')
  const read = () => sessions.getTranscript({ sessionId }).items.find(item => (item.payload as { messageId?: string }).messageId === queued.messageId)?.payload
  expect(read()).toMatchObject({ text: 'Retained draft', deliveryState: 'draft' })
  sessions.clearQueue({ requestId: req(), sessionId })
  expect(read()).toMatchObject({ text: 'Retained draft', deliveryState: 'withdrawn' })
  expect(sessions.getTranscript({ sessionId }).items.find(item => (item.payload as { text?: string }).text === 'Running message')?.payload).toMatchObject({ deliveryState: 'delivered' })
})

describe('Send now', () => {
  it('moves the selected message next, keeps other drafts in order, and retries never interrupt or deliver twice', async () => {
    const sessionId = newSession()
    const running = await send(sessionId, 'Current turn')
    const first = await send(sessionId, 'First queued')
    const selected = await send(sessionId, 'Send this next')
    const last = await send(sessionId, 'Last queued')
    const params = { requestId: req(), sessionId, messageId: selected.messageId }
    expect(await sessions.sendNow(params)).toEqual({ accepted: true })
    expect(runtime.interrupts).toEqual([{ sessionId, turnId: turnOf(running.messageId)!.id }])
    expect(session(sessionId).queuePaused).toBe(false)
    endTurn(sessionId, running.messageId, 'interrupted')
    await sessions.idle()
    expect(runtime.dispatched.map(input => input.text)).toEqual(['Current turn', 'Send this next'])
    const before = currentSeq(db)
    expect(await sessions.sendNow(params)).toEqual({ accepted: true })
    await sessions.idle()
    expect(currentSeq(db)).toBe(before)
    expect(runtime.interrupts).toHaveLength(1)
    endTurn(sessionId, selected.messageId)
    await sessions.idle()
    expect(runtime.dispatched.at(-1)!.text).toBe('First queued')
    endTurn(sessionId, first.messageId)
    await sessions.idle()
    expect(runtime.dispatched.map(input => input.text)).toEqual(['Current turn', 'Send this next', 'First queued', 'Last queued'])
    expect(message(last.messageId).deliveryState).toBe('delivered')
  })

  it('concurrent request retries share cancellation, and do not dispatch until cancellation finishes', async () => {
    let release!: () => void
    let stops = 0
    sessions = createSessionService({ db, runtime: runtime.port, now: () => ++clock, onStop: () => { stops++; return new Promise<void>(resolve => { release = resolve }) } })
    const sessionId = newSession()
    const running = await send(sessionId, 'Running')
    const selected = await send(sessionId, 'Next')
    const params = { requestId: req(), sessionId, messageId: selected.messageId }
    const a = sessions.sendNow(params)
    const b = sessions.sendNow(params)
    endTurn(sessionId, running.messageId, 'interrupted')
    await sessions.idle()
    expect(runtime.dispatched.map(input => input.text)).toEqual(['Running'])
    expect(stops).toBe(1)
    release()
    expect(await Promise.all([a, b])).toEqual([{ accepted: true }, { accepted: true }])
    await sessions.idle()
    expect(runtime.dispatched.map(input => input.text)).toEqual(['Running', 'Next'])
    expect(runtime.interrupts).toHaveLength(1)
  })

  it('only accepts queued user messages belonging to a session that can run', async () => {
    const sessionId = newSession()
    const running = await send(sessionId, 'Running')
    await expect(sessions.sendNow({ requestId: req(), sessionId, messageId: running.messageId })).rejects.toMatchObject({ code: 'busy' })
    const queued = await send(sessionId, 'Queued')
    const other = newSession()
    await expect(sessions.sendNow({ requestId: req(), sessionId: other, messageId: queued.messageId })).rejects.toMatchObject({ code: 'busy' })
    db.update(s.sessions).set({ archivedAt: clock }).where(eq(s.sessions.id, sessionId)).run()
    await expect(sessions.sendNow({ requestId: req(), sessionId, messageId: queued.messageId })).rejects.toMatchObject({ code: 'busy' })
    expect(runtime.interrupts).toEqual([])
    expect(message(queued.messageId).deliveryState).toBe('draft')
  })
})

it('Send now unpauses an idle session and sends once without stopping; changed retry parameters conflict', async () => {
  const sessionId = newSession()
  db.update(s.sessions).set({ queuePaused: true }).where(eq(s.sessions.id, sessionId)).run()
  const first = await send(sessionId, 'Earlier draft')
  const selected = await send(sessionId, 'Selected idle draft')
  const params = { requestId: req(), sessionId, messageId: selected.messageId }
  await sessions.sendNow(params)
  await sessions.idle()
  expect(runtime.dispatched.map(input => input.text)).toEqual(['Selected idle draft'])
  await sessions.sendNow(params)
  await expect(sessions.sendNow({ ...params, messageId: first.messageId })).rejects.toMatchObject({ code: 'idempotency_conflict' })
  expect(runtime.interrupts).toEqual([])
  expect(runtime.dispatched).toHaveLength(1)
})
