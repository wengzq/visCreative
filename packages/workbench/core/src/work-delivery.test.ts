import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq, openSpaceDb, readEventsAfter, spaceSchema as s, type SpaceDb } from '@vis/storage'
import { createSessionService, type SessionService } from './session-service'
import { DispatchError, type AgentRuntimePort, type DispatchInput } from './runtime-port'

let db: SpaceDb
let service: SessionService
let dispatched: DispatchInput[]
let runtime: AgentRuntimePort
let sessionId: string
let workItemId: string
let clock = 1_800_000_000_000
let serial = 0
const id = () => `req_${++serial}`

beforeEach(() => {
  db = openSpaceDb(':memory:')
  dispatched = []
  runtime = { ensureReady: async () => {}, dispatchTurn: async input => { dispatched.push(input) }, terminateTurn: async () => {}, interruptTurn: async () => {} }
  service = createSessionService({ db, runtime, now: () => ++clock })
  const session = service.create({ requestId: id(), title: '镜头' })
  sessionId = session.sessionId
  workItemId = session.workItemId!
})
afterEach(() => { service.dispose(); db.$client.close() })

function add(body: string) {
  const messageId = id()
  db.insert(s.workMessages).values({ id: messageId, workItemId, kind: 'brief', from: { kind: 'system' }, to: 'child', targetSessionId: sessionId, body, createdAt: ++clock }).run()
  service.notifyWorkActivated(sessionId)
  return messageId
}
function end(status: 'completed' | 'failed' | 'interrupted', input = dispatched.at(-1)!) {
  service.handleAgentEvent({ type: 'turn_ended', sessionId, turnId: input.turnId, status })
}
const messages = () => db.select().from(s.workMessages).all()

it('checks a completed turn through the work-failure seam after acknowledging its batch and ignores duplicate endings', async () => {
  service.dispose()
  const onWorkFailure = vi.fn((_t, failure, _key) => {
    if (failure.reason === 'turn_unreported') expect(messages()[0]!.ackedAt).not.toBeNull()
  })
  service = createSessionService({ db, runtime, now: () => ++clock, onWorkFailure })
  add('Report after this assignment')
  await service.idle()
  const input = dispatched[0]!
  end('completed', input)
  expect(onWorkFailure.mock.calls.map(([, failure, key]) => ({ failure, key }))).toEqual([
    { failure: { sessionId, turnId: input.turnId, reason: 'turn_unreported' }, key: messages()[0]!.deliveryId },
  ])
  end('completed', input)
  expect(onWorkFailure).toHaveBeenCalledTimes(1)
})

it('does not check an unreported turn when its delivered batch contains only failure messages', async () => {
  service.dispose()
  const onWorkFailure = vi.fn()
  service = createSessionService({ db, runtime, now: () => ++clock, onWorkFailure })
  const messageId = add('A system failure notice')
  db.update(s.workMessages).set({ kind: 'failure' }).where(eq(s.workMessages.id, messageId)).run()
  await service.idle()
  end('completed')
  expect(onWorkFailure).not.toHaveBeenCalled()
})

describe('Work messages reuse the session queue', () => {
  it('Merge the full batch when idle, mark delivered on start, and acknowledge the full batch on success', async () => {
    add('第一条'); add('第二条')
    expect(messages().every(message => message.deliveredAt === null)).toBe(true)
    await service.idle()
    expect(dispatched).toHaveLength(1)
    expect(dispatched[0]!.text).toContain('第一条')
    expect(dispatched[0]!.text).toContain('第二条')
    expect(new Set(messages().map(message => message.deliveryId)).size).toBe(1)
    expect(messages().every(message => message.deliveredAt !== null && message.ackedAt === null)).toBe(true)
    expect(dispatched[0]!.workContext).toEqual({ workItemId, parentId: null, hasChildren: false })
    end('completed')
    await service.idle()
    expect(messages().every(message => message.ackedAt !== null)).toBe(true)
    const ack = readEventsAfter(db, 0).filter(event => event.type === 'work.messageAcked')
    expect(ack).toHaveLength(1)
    expect(ack[0]!.payload).toMatchObject({ messageIds: messages().map(message => message.id).sort() })
    end('completed')
    expect(readEventsAfter(db, 0).filter(event => event.type === 'work.messageAcked')).toHaveLength(1)
  })

  it('Do not deliver or claim while busy; merge pending messages after completion', async () => {
    service.sendMessage({ requestId: id(), sessionId, text: '用户当前回合', refs: [] })
    await service.idle()
    add('待投递一'); await service.idle(); add('待投递二'); await service.idle()
    expect(dispatched).toHaveLength(1)
    expect(messages().every(message => message.deliveryId === null)).toBe(true)
    end('completed'); await service.idle()
    expect(dispatched).toHaveLength(2)
    expect(dispatched[1]!.text).toContain('待投递一')
    expect(dispatched[1]!.text).toContain('待投递二')
  })

  it('Running an existing ordinary draft first does not freeze the work batch early; new work messages still merge meanwhile', async () => {
    service.sendMessage({ requestId: id(), sessionId, text: '普通回合一', refs: [] })
    await service.idle()
    add('工作 A')
    service.sendMessage({ requestId: id(), sessionId, text: '普通回合二', refs: [] })
    end('completed'); await service.idle()
    expect(dispatched[1]!.text).toBe('普通回合二')
    expect(messages()[0]!.deliveryId).toBeNull()
    add('工作 B')
    end('completed'); await service.idle()
    expect(dispatched).toHaveLength(3)
    expect(dispatched[2]!.text).toContain('工作 A')
    expect(dispatched[2]!.text).toContain('工作 B')
    expect(new Set(messages().map(message => message.deliveryId)).size).toBe(1)
  })

  it('Failure triggers only one automatic redelivery, preserves deliveryId, and does not acknowledge the failed batch', async () => {
    add('失败重投'); await service.idle()
    const deliveryId = messages()[0]!.deliveryId
    end('failed'); await service.idle()
    expect(dispatched).toHaveLength(2)
    expect(dispatched[1]!.text).toContain('重新投递')
    expect(messages()[0]).toMatchObject({ deliveryId, redelivered: true, ackedAt: null })
    end('failed'); await service.idle()
    expect(dispatched).toHaveLength(2)
    expect(messages()[0]!.ackedAt).toBeNull()
  })

  it('Restore unacknowledged batches after restart and acknowledge only after a new turn succeeds', async () => {
    add('崩溃之前'); await service.idle()
    const deliveryId = messages()[0]!.deliveryId
    service.dispose()
    service = createSessionService({ db, runtime, now: () => ++clock })
    service.recover(); await service.idle()
    expect(dispatched).toHaveLength(2)
    expect(dispatched[1]!.text).toContain('重新投递')
    expect(messages()[0]).toMatchObject({ deliveryId, ackedAt: null })
    end('completed'); await service.idle()
    expect(messages()[0]!.ackedAt).not.toBeNull()
    service.recover(); await service.idle()
    expect(dispatched).toHaveLength(2)
  })

  it.each([false, true])('The stop fence covers waiting for ensureReady (readiness fails=%s); old turns cannot continue delivery', async failReady => {
    let ready!: () => void
    runtime.ensureReady = () => new Promise<void>((resolve, reject) => { ready = () => failReady ? reject(new Error('Startup failed while stopping')) : resolve() })
    add('旧 brief')
    await Promise.resolve(); await Promise.resolve()
    const turn = db.select().from(s.turns).get()!
    await service.stop({ requestId: id(), sessionId, turnId: turn.id })
    db.update(s.sessions).set({ queuePaused: false }).where(eq(s.sessions.id, sessionId)).run()
    service.notifyWorkActivated(sessionId)
    ready(); await service.idle()
    expect(service.isTurnStopping(turn.id)).toBe(false)
    expect(service.list({}).sessions[0]!.activeTurnId).toBeNull()
    expect(dispatched).toHaveLength(0)
    expect(messages()[0]!.deliveredAt).toBeNull()
  })

  it('Sessions being recalled or archived do not consume work messages', async () => {
    db.update(s.workItems).set({ status: 'todo' }).where(eq(s.workItems.id, workItemId)).run()
    add('待激活'); await service.idle()
    expect(dispatched).toHaveLength(0)
    db.update(s.workItems).set({ status: 'in_progress' }).where(eq(s.workItems.id, workItemId)).run()
    db.update(s.sessions).set({ archivedAt: ++clock }).where(eq(s.sessions.id, sessionId)).run()
    service.notifyWorkActivated(sessionId); await service.idle()
    expect(dispatched).toHaveLength(0)
    expect(messages()[0]!.deliveryId).toBeNull()
  })

  it('Unexpected runtime process exit also triggers redelivery; explicit stopping does not', async () => {
    add('运行时退出'); await service.idle()
    end('interrupted'); await service.idle()
    expect(dispatched).toHaveLength(2)
    expect(dispatched[1]!.text).toContain('重新投递')
    await service.stop({ requestId: id(), sessionId, turnId: dispatched[1]!.turnId })
    end('interrupted'); await service.idle()
    expect(dispatched).toHaveLength(2)
  })

  it('Retry readiness failure once; a second failure pauses without an infinite loop', async () => {
    runtime.ensureReady = async () => { throw new Error('Startup failed') }
    add('重试启动'); await service.idle()
    expect(db.select().from(s.turns).all()).toHaveLength(2)
    expect(messages()[0]).toMatchObject({ redelivered: true, ackedAt: null, deliveredAt: null })
    expect(service.list({}).sessions[0]!.queuePaused).toBe(true)
  })

  it('Manual user retry preserves batch association, acknowledges on completion, and forbids retrying old batches again', async () => {
    runtime.dispatchTurn = async () => { throw new DispatchError('unknown', 'Connection closed') }
    add('手动重试'); await service.idle()
    expect(db.select().from(s.turns).all()).toHaveLength(1)
    const original = db.select().from(s.messages).get()!
    expect(original.deliveryState).toBe('unknown')
    runtime.dispatchTurn = async input => { dispatched.push(input) }
    service.retryMessage({ requestId: id(), messageId: original.id })
    await service.idle()
    expect(dispatched).toHaveLength(1)
    expect(dispatched[0]!.text).toContain('重新投递')
    end('completed'); await service.idle()
    expect(messages()[0]!.ackedAt).not.toBeNull()
    service.recover(); await service.idle()
    expect(dispatched).toHaveLength(1)
  })

  it('An old rejected message cannot be retried while automatic redelivery has arrived but is still running', async () => {
    let first = true
    runtime.dispatchTurn = async input => {
      if (first) { first = false; throw new DispatchError('rejected', 'Reject first delivery') }
      dispatched.push(input)
    }
    add('自动重投中'); await service.idle()
    const original = db.select().from(s.messages).all().find(message => message.deliveryState === 'rejected')!
    expect(dispatched).toHaveLength(1)
    expect(() => service.retryMessage({ requestId: id(), messageId: original.id })).toThrow(expect.objectContaining({ code: 'busy' }))
    end('completed'); await service.idle()
    expect(() => service.retryMessage({ requestId: id(), messageId: original.id })).toThrow(expect.objectContaining({ code: 'busy' }))
    expect(dispatched).toHaveLength(1)
  })

  it('Restart after manual retry is queued but before dequeuing restores the draft at the queue front', async () => {
    runtime.dispatchTurn = async () => { throw new DispatchError('unknown', 'Connection closed') }
    add('手动重试后重启'); await service.idle()
    const original = db.select().from(s.messages).get()!
    service.retryMessage({ requestId: id(), messageId: original.id })
    service.dispose()
    await service.idle()
    runtime.dispatchTurn = async input => { dispatched.push(input) }
    service = createSessionService({ db, runtime, now: () => ++clock })
    service.recover(); await service.idle()
    expect(dispatched).toHaveLength(1)
    expect(dispatched[0]!.text).toContain('重新投递')
    end('completed'); await service.idle()
    expect(messages()[0]!.ackedAt).not.toBeNull()
  })

  it('Restart does not unpause a queue explicitly stopped by the user', async () => {
    service.sendMessage({ requestId: id(), sessionId, text: '用户当前回合', refs: [] })
    await service.idle()
    await service.stop({ requestId: id(), sessionId, turnId: dispatched[0]!.turnId })
    end('interrupted'); await service.idle()
    service.sendMessage({ requestId: id(), sessionId, text: '用户草稿', refs: [] })
    add('待投递工作消息'); await service.idle()
    service.recover(); await service.idle()
    expect(dispatched).toHaveLength(1)
    expect(service.list({}).sessions[0]!.queuePaused).toBe(true)
    expect(messages()[0]!.deliveryId).toBeNull()
  })

  it('Ordinary user turns remain paused after restart and are not redelivered', async () => {
    service.sendMessage({ requestId: id(), sessionId, text: '普通消息', refs: [] })
    await service.idle()
    service.recover(); await service.idle()
    expect(dispatched).toHaveLength(1)
    expect(service.list({}).sessions[0]!.queuePaused).toBe(true)
  })
})

describe('Deletion fence', () => {
  it('Persisted deletion plans block resume, ordinary drafts, work delivery, and restart recovery; archived sessions cannot run again', async () => {
    db.insert(s.idempotencyKeys).values({ requestId: 'pending-delete', method: 'work.delete', fingerprint: 'delete', result: { workItemIds: [workItemId], finished: false }, createdAt: ++clock }).run()
    add('删除期间待投递')
    service.sendMessage({ requestId: id(), sessionId, text: '删除期间的普通消息', refs: [] })
    service.resumeQueue({ requestId: id(), sessionId })
    await service.idle()
    expect(dispatched).toEqual([])
    expect(messages()[0]!.deliveryId).toBeNull()
    service.dispose()
    service = createSessionService({ db, runtime, now: () => ++clock })
    service.recover(); await service.idle()
    expect(dispatched).toEqual([])
    db.update(s.idempotencyKeys).set({ result: { workItemIds: [workItemId], finished: true } }).where(eq(s.idempotencyKeys.requestId, 'pending-delete')).run()
    db.update(s.workItems).set({ archivedAt: ++clock }).where(eq(s.workItems.id, workItemId)).run()
    db.update(s.sessions).set({ archivedAt: ++clock }).where(eq(s.sessions.id, sessionId)).run()
    service.resumeQueue({ requestId: id(), sessionId }); service.notifyWorkActivated(sessionId)
    await service.idle()
    expect(dispatched).toEqual([])
  })
})

it.each([false, true])('Reports rerouted during startup do not send stale bodies from the old session (retain other reports in the batch: %s)', async keepSibling => {
  let release!: () => void
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  runtime.ensureReady = async () => { entered(); await gate }
  const moved = add('已改投的回报')
  if (keepSibling) add('仍给旧父项的回报')
  await started
  db.update(s.workMessages).set({ targetSessionId: null, deliveryId: null, deliveredAt: null }).where(eq(s.workMessages.id, moved)).run()
  release()
  await service.idle()
  expect(dispatched).toHaveLength(keepSibling ? 1 : 0)
  if (keepSibling) {
    expect(dispatched[0]!.text).toContain('仍给旧父项的回报')
    expect(dispatched[0]!.text).not.toContain('已改投的回报')
    end('completed')
    expect(messages().find(message => message.id === moved)!.ackedAt).toBeNull()
  } else {
    expect(db.select().from(s.messages).all()[0]!.deliveryState).toBe('withdrawn')
    expect(service.list({}).sessions[0]!.activeTurnId).toBeNull()
    expect(service.list({}).sessions[0]!.queuePaused).toBe(false)
  }
})

it('Send now preserves unclaimed work messages in their order behind the selected user draft', async () => {
  service.sendMessage({ requestId: id(), sessionId, text: 'Running', refs: [] })
  await service.idle()
  const running = dispatched[0]!
  add('First work message'); add('Second work message')
  const selected = service.sendMessage({ requestId: id(), sessionId, text: 'Selected next', refs: [] })
  await service.sendNow({ requestId: id(), sessionId, messageId: selected.messageId })
  end('interrupted', running)
  await service.idle()
  expect(dispatched.map(input => input.text)).toEqual(['Running', 'Selected next'])
  expect(messages().every(message => message.deliveryId === null && message.ackedAt === null)).toBe(true)
  end('completed')
  await service.idle()
  expect(dispatched).toHaveLength(3)
  expect(dispatched[2]!.text).toContain('First work message')
  expect(dispatched[2]!.text).toContain('Second work message')
  expect(dispatched[2]!.text.indexOf('First work message')).toBeLessThan(dispatched[2]!.text.indexOf('Second work message'))
  end('completed')
  expect(messages().every(message => message.ackedAt !== null)).toBe(true)
})

it.each([false, true])('Send now retains a claimed work batch interrupted during readiness (startup fails: %s)', async failReady => {
  let release!: () => void
  let entered!: () => void
  const ready = new Promise<void>(resolve => { entered = resolve })
  let first = true
  runtime.ensureReady = async () => {
    if (!first) return
    first = false
    entered()
    await new Promise<void>((resolve, reject) => { release = () => failReady ? reject(new Error('Startup failed while stopping')) : resolve() })
  }
  add('First retained work'); add('Second retained work')
  await ready
  const selected = service.sendMessage({ requestId: id(), sessionId, text: 'Urgent direction', refs: [] })
  const params = { requestId: id(), sessionId, messageId: selected.messageId }
  await service.sendNow(params)
  release()
  await service.idle()
  expect(dispatched.map(input => input.text)).toEqual(['Urgent direction'])
  expect(messages().every(message => message.deliveredAt === null && message.ackedAt === null)).toBe(true)
  await service.sendNow(params)
  end('completed')
  await service.idle()
  expect(dispatched).toHaveLength(2)
  expect(dispatched[1]!.text).toContain('First retained work')
  expect(dispatched[1]!.text).toContain('Second retained work')
  expect(dispatched[1]!.text.indexOf('First retained work')).toBeLessThan(dispatched[1]!.text.indexOf('Second retained work'))
  end('completed')
  expect(messages().every(message => message.ackedAt !== null)).toBe(true)
})

it('Send now preserves a work batch rejected during dispatch and still sends the selected draft first', async () => {
  let rejectDispatch!: () => void
  let entered!: () => void
  const enteredDispatch = new Promise<void>(resolve => { entered = resolve })
  let first = true
  runtime.dispatchTurn = async input => {
    if (!first) { dispatched.push(input); return }
    first = false
    entered()
    await new Promise<void>((_, reject) => { rejectDispatch = () => reject(new DispatchError('rejected', 'Dispatch stopped before acceptance')) })
  }
  add('Retained work after rejected dispatch')
  await enteredDispatch
  const selected = service.sendMessage({ requestId: id(), sessionId, text: 'Selected next', refs: [] })
  await service.sendNow({ requestId: id(), sessionId, messageId: selected.messageId })
  rejectDispatch()
  await service.idle()
  expect(dispatched.map(input => input.text)).toEqual(['Selected next'])
  end('completed')
  await service.idle()
  expect(dispatched[1]!.text).toContain('Retained work after rejected dispatch')
  end('completed')
  expect(messages().every(message => message.ackedAt !== null)).toBe(true)
})

it('Send now force-ends hung readiness, retains the undelivered work batch, and dispatches it after the selected draft', async () => {
  vi.useFakeTimers()
  try {
    let entered!: () => void
    const ready = new Promise<void>(resolve => { entered = resolve })
    let first = true
    runtime.ensureReady = async () => {
      if (!first) return
      first = false
      entered()
      await new Promise<void>(() => {})
    }
    runtime.interruptTurn = () => new Promise<void>(() => {})
    add('First retained work'); add('Second retained work')
    await ready
    const selected = service.sendMessage({ requestId: id(), sessionId, text: 'Selected next', refs: [] })
    const sending = service.sendNow({ requestId: id(), sessionId, messageId: selected.messageId })
    await vi.advanceTimersByTimeAsync(30_000)
    await sending
    await service.idle()
    expect(dispatched.map(input => input.text)).toEqual(['Selected next'])
    expect(messages().every(message => message.deliveredAt === null && message.ackedAt === null && !message.redelivered)).toBe(true)
    end('completed')
    await service.idle()
    expect(dispatched).toHaveLength(2)
    expect(dispatched[1]!.text.indexOf('First retained work')).toBeLessThan(dispatched[1]!.text.indexOf('Second retained work'))
    end('completed')
    expect(messages().every(message => message.ackedAt !== null && !message.redelivered)).toBe(true)
  } finally { vi.useRealTimers() }
})
