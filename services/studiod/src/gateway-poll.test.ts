import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { MediaTools } from '@vis/assets'
import { createMockProvider } from '@vis/generation'
import { PROTOCOL_VERSION } from '@vis/protocol'
import { appSchema, eq, openAppDb, openSpaceDb, spaceSchema as s } from '@vis/storage'
import { createGateway, type Gateway } from './gateway'
import { createSpaceRegistry, type SpaceHost, type SpaceRegistry } from './space-host'

let dir: string
let db: ReturnType<typeof openAppDb>
let spaces: SpaceRegistry
let host: SpaceHost
let gateway: Gateway
let clock: number | undefined
const now = () => clock ?? Date.now()
let request = 0
const rid = () => `poll-${++request}`

beforeEach(async () => {
  clock = undefined
  dir = mkdtempSync(join(tmpdir(), 'vis-gateway-poll-'))
  vi.stubEnv('VIS_PROJECTS_DIR', join(dir, 'projects'))
  db = openAppDb(join(dir, 'app.db'))
  spaces = createSpaceRegistry({ appDb: db, dataDir: dir, now, host: {
    now,
    providers: [createMockProvider()], runtimes: { codex: () => ({ async ensureReady() {}, async dispatchTurn() {}, async terminateTurn() {}, async interruptTurn() {} }) }, suspended: true,
    defaults: { image: { provider: 'mock' }, video: { provider: 'mock' }, audio: { provider: 'mock' } },
  } })
  host = spaces.get(spaces.create('Polling').spaceId)!
  vi.useFakeTimers()
  gateway = createGateway({ appDb: db, spaces, now, media: {} as MediaTools, uiToken: 'test', studiodVersion: 'test', runtimeEpoch: 'test', onShutdown() {} })
  await vi.advanceTimersByTimeAsync(200)
})

afterEach(async () => {
  gateway.close()
  vi.restoreAllMocks()
  vi.useRealTimers()
  await spaces.closeAll()
  db.$client.close()
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

async function client(afterSeq?: number, project = host, onSend?: (message: any) => void) {
  const messages: any[] = []
  const connection = gateway.accept({ send(message) { onSend?.(message); messages.push(message) }, close() {} })
  const call = async (method: string, params: object) => {
    const id = rid()
    connection.receive(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    await vi.advanceTimersByTimeAsync(0)
    const response = messages.find(message => message.id === id)
    expect(response?.error).toBeUndefined()
    return response.result
  }
  await call('runtime.hello', { protocolVersion: PROTOCOL_VERSION, credential: { kind: 'ui', token: 'test' } })
  await call('events.subscribe', { spaceId: project.spaceId, ...(afterSeq === undefined ? {} : { afterSeq }) })
  const initialEvents = messages.filter(message => message.method === 'events.event')
  messages.length = 0
  return { messages, connection, call, initialEvents }
}

it('skips inbox, slot drain/view and card rebuilding on unchanged ticks, but still flushes direct requests', async () => {
  const c = await client()
  await vi.advanceTimersByTimeAsync(200)
  const inbox = vi.spyOn(host.work, 'inbox')
  const cards = vi.spyOn(host.work, 'list')
  const slots = vi.spyOn(spaces.workSlots, 'view')
  const drain = vi.spyOn(spaces.workSlots, 'drain')
  await vi.advanceTimersByTimeAsync(2000)
  expect(inbox).not.toHaveBeenCalled()
  expect(cards).not.toHaveBeenCalled()
  expect(slots).not.toHaveBeenCalled()
  expect(drain).not.toHaveBeenCalled()
  await c.call('runtime.activity', {})
  expect(inbox).toHaveBeenCalledTimes(1)
  expect(drain).toHaveBeenCalledTimes(1)
})

it.each(['drain', 'inbox', 'cards'] as const)('contains and logs a failed %s flush and retries on the next tick without another write', async stage => {
  const c = await client()
  await vi.advanceTimersByTimeAsync(200)
  const failure = new Error('Temporary slot reservation failure')
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const cards = stage === 'cards' ? vi.spyOn(host.work, 'list') : undefined
  const target = stage === 'drain' ? vi.spyOn(spaces.workSlots, 'drain')
    : stage === 'inbox' ? vi.spyOn(host.work, 'inbox') : cards!
  target.mockImplementationOnce(() => { throw failure })
  db.insert(appSchema.settings).values({ key: 'work.slotLimit', value: 3 }).run()
  await expect(vi.advanceTimersByTimeAsync(100)).resolves.toBe(vi)
  expect(log).toHaveBeenCalledWith('[gateway] Event flush failed', failure)
  await vi.advanceTimersByTimeAsync(100)
  // One call per flush: the slot queue must not read full work item views.
  expect(target).toHaveBeenCalledTimes(2)
  expect(c.messages).toContainEqual(expect.objectContaining({ method: 'events.workSlotsChanged', params: expect.objectContaining({ limit: 3 }) }))
})

it('contains RPC completion flush failures and retries without another change', async () => {
  const c = await client()
  await vi.advanceTimersByTimeAsync(200)
  const failure = new Error('RPC completion flush failure')
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const drain = vi.spyOn(spaces.workSlots, 'drain').mockImplementationOnce(() => { throw failure })
  await c.call('runtime.activity', {})
  expect(log).toHaveBeenCalledWith('[gateway] Event flush failed', failure)
  await vi.advanceTimersByTimeAsync(100)
  expect(drain).toHaveBeenCalledTimes(2)
})

it('backs off repeated failures to one second, logs distinct failures once and resets after recovery', async () => {
  const c = await client()
  await vi.advanceTimersByTimeAsync(200)
  const failure = new Error('Persistent flush failure')
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const drain = vi.spyOn(spaces.workSlots, 'drain').mockImplementation(() => { throw new Error(failure.message) })
  db.insert(appSchema.settings).values({ key: 'work.slotLimit', value: 3 }).run()
  await vi.advanceTimersByTimeAsync(100)
  expect(drain).toHaveBeenCalledTimes(1)
  for (const [index, delay] of [100, 200, 400, 800, 1000, 1000].entries()) {
    await vi.advanceTimersByTimeAsync(delay - 100)
    expect(drain).toHaveBeenCalledTimes(index + 1)
    await vi.advanceTimersByTimeAsync(100)
    expect(drain).toHaveBeenCalledTimes(index + 2)
  }
  expect(log).toHaveBeenCalledTimes(1)
  const other = new Error('Different flush failure')
  drain.mockImplementationOnce(() => { throw other })
  await vi.advanceTimersByTimeAsync(1000)
  expect(log).toHaveBeenCalledTimes(2)
  expect(log).toHaveBeenLastCalledWith('[gateway] Event flush failed', other)
  drain.mockRestore()
  await vi.advanceTimersByTimeAsync(1000)
  expect(c.messages).toContainEqual(expect.objectContaining({ method: 'events.workSlotsChanged', params: expect.objectContaining({ limit: 3 }) }))
  const retry = vi.spyOn(spaces.workSlots, 'drain').mockImplementationOnce(() => { throw failure })
  await c.call('runtime.activity', {})
  expect(log).toHaveBeenCalledTimes(3)
  await vi.advanceTimersByTimeAsync(100)
  expect(retry).toHaveBeenCalledTimes(2)
})

it.each(['frozen', 'backwards'] as const)('retries failures with a %s injected wall clock', async movement => {
  const c = await client()
  await vi.advanceTimersByTimeAsync(200)
  clock = Date.now()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const drain = vi.spyOn(spaces.workSlots, 'drain').mockImplementationOnce(() => { throw new Error('Retry with an injected clock') })
  db.insert(appSchema.settings).values({ key: 'work.slotLimit', value: 3 }).run()
  await vi.advanceTimersByTimeAsync(100)
  expect(drain).toHaveBeenCalledTimes(1)
  if (movement === 'backwards') clock -= 60_000
  await vi.advanceTimersByTimeAsync(100)
  expect(drain).toHaveBeenCalledTimes(2)
  expect(c.messages).toContainEqual(expect.objectContaining({ method: 'events.workSlotsChanged', params: expect.objectContaining({ limit: 3 }) }))
})

it('defers forced RPC flushes during backoff and runs the owed flush after recovery', async () => {
  const c = await client()
  await vi.advanceTimersByTimeAsync(200)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const drain = vi.spyOn(spaces.workSlots, 'drain').mockImplementation(() => { throw new Error('Repeated drain failure') })
  // No database write: only the forced request and retry state can trigger recovery.
  await c.call('runtime.activity', {})
  await vi.advanceTimersByTimeAsync(100)
  expect(drain).toHaveBeenCalledTimes(2)
  for (let i = 0; i < 20; i++) await c.call('runtime.activity', {})
  expect(drain).toHaveBeenCalledTimes(2)
  drain.mockImplementation(() => {})
  await vi.advanceTimersByTimeAsync(199)
  expect(drain).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(1)
  expect(drain).toHaveBeenCalledTimes(3)
  await vi.advanceTimersByTimeAsync(1000)
  expect(drain).toHaveBeenCalledTimes(3)
})

it.each(['timer', 'RPC'] as const)('contains throwing error bookkeeping and logging from a %s flush', async source => {
  const c = await client()
  await vi.advanceTimersByTimeAsync(200)
  const failure = new Error('Unreadable failure')
  Object.defineProperty(failure, 'message', { get() { throw new Error('Error key bookkeeping failed') } })
  const log = vi.spyOn(console, 'error').mockImplementation(() => { throw new Error('Logging unavailable') })
  const drain = vi.spyOn(spaces.workSlots, 'drain').mockImplementationOnce(() => { throw failure })
  if (source === 'RPC') await c.call('runtime.activity', {})
  else {
    db.insert(appSchema.settings).values({ key: 'work.slotLimit', value: 3 }).run()
    await expect(vi.advanceTimersByTimeAsync(100)).resolves.toBe(vi)
  }
  expect(drain).toHaveBeenCalledTimes(1)
  expect(log).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(100)
  expect(drain).toHaveBeenCalledTimes(2)
})

it('contains an unavailable project and backs off the entire flush until recovery', async () => {
  const c = await client()
  await vi.advanceTimersByTimeAsync(200)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const get = vi.spyOn(spaces, 'get').mockReturnValue(undefined)
  const drain = vi.spyOn(spaces.workSlots, 'drain')
  db.insert(appSchema.settings).values({ key: 'work.slotLimit', value: 3 }).run()
  await expect(vi.advanceTimersByTimeAsync(200)).resolves.toBe(vi)
  expect(drain).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(100)
  expect(drain).toHaveBeenCalledTimes(2)
  get.mockRestore()
  await vi.advanceTimersByTimeAsync(100)
  expect(drain).toHaveBeenCalledTimes(3)
  expect(c.messages).toContainEqual(expect.objectContaining({ method: 'events.workSlotsChanged', params: expect.objectContaining({ limit: 3 }) }))
})

it('deduplicates only the last flush error and forgets older error keys', async () => {
  await client()
  await vi.advanceTimersByTimeAsync(200)
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  let message = 'First failure'
  vi.spyOn(spaces.workSlots, 'drain').mockImplementation(() => { throw new Error(message) })
  db.insert(appSchema.settings).values({ key: 'work.slotLimit', value: 3 }).run()
  await vi.advanceTimersByTimeAsync(1000)
  expect(log).toHaveBeenCalledTimes(1)
  message = 'Second failure'
  await vi.advanceTimersByTimeAsync(1000)
  expect(log).toHaveBeenCalledTimes(2)
  message = 'First failure'
  await vi.advanceTimersByTimeAsync(1000)
  expect(log).toHaveBeenCalledTimes(3)
})

it('pushes new project events in seq order once and replays a new subscription while otherwise idle', async () => {
  const c = await client()
  host.canvas.apply({ kind: 'user' }, { requestId: rid(), ops: [{ op: 'node.create', tempId: 'text', kind: 'text' }] })
  await vi.advanceTimersByTimeAsync(100)
  const events = c.messages.filter(message => message.method === 'events.event')
  expect(events.some(message => message.params.type === 'node.created')).toBe(true)
  const seqs = events.map(message => message.params.seq)
  expect(seqs).toEqual([...new Set(seqs)].sort((a, b) => a - b))
  c.messages.length = 0
  await vi.advanceTimersByTimeAsync(200)
  expect(c.messages).toEqual([])
  const replay = await client(0)
  expect(replay.initialEvents.map(message => message.params.seq)).toEqual(seqs)
  await replay.call('events.subscribe', { spaceId: host.spaceId, afterSeq: 0 })
  expect(replay.messages.filter(message => message.method === 'events.event').map(message => message.params.seq)).toEqual(seqs)
})

it.each(['same', 'other'] as const)('observes app writes from the %s connection and notifies ready clients', async writer => {
  const c = await client()
  const other = writer === 'other' ? openAppDb(join(dir, 'app.db')) : undefined
  try {
    const target = other ?? db
    target.insert(appSchema.settings).values({ key: 'work.slotLimit', value: 3 }).run()
    await vi.advanceTimersByTimeAsync(100)
    expect(c.messages).toContainEqual(expect.objectContaining({ method: 'events.workSlotsChanged', params: expect.objectContaining({ limit: 3 }) }))
  } finally { other?.$client.close() }
})

it('observes project writes made by another connection without an event', async () => {
  const c = await client()
  const item = host.work.create({ requestId: rid(), title: 'Original' }).item
  await vi.advanceTimersByTimeAsync(200)
  c.messages.length = 0
  const other = openSpaceDb(join(dir, 'spaces', host.spaceId, 'space.db'))
  try {
    other.update(s.workItems).set({ title: 'External edit' }).where(eq(s.workItems.id, item.workItemId)).run()
    await vi.advanceTimersByTimeAsync(100)
    expect(c.messages).toContainEqual(expect.objectContaining({ method: 'events.event', params: expect.objectContaining({
      type: 'work.itemChanged', payload: expect.objectContaining({ title: 'External edit' }),
    }) }))
  } finally { other.$client.close() }
})

it('rechecks accepted and closed connections and flushes readiness without requiring a subscription', async () => {
  const inbox = vi.spyOn(host.work, 'inbox')
  const messages: any[] = []
  const connection = gateway.accept({ send: message => messages.push(message), close() {} })
  await vi.advanceTimersByTimeAsync(100)
  expect(inbox).toHaveBeenCalledTimes(1)
  inbox.mockClear()
  connection.receive(JSON.stringify({ jsonrpc: '2.0', id: rid(), method: 'runtime.hello', params: {
    protocolVersion: PROTOCOL_VERSION, credential: { kind: 'ui', token: 'test' },
  } }))
  await vi.advanceTimersByTimeAsync(0)
  expect(inbox).toHaveBeenCalledTimes(1)
  db.insert(appSchema.settings).values({ key: 'work.slotLimit', value: 2 }).run()
  await vi.advanceTimersByTimeAsync(100)
  expect(messages).toContainEqual(expect.objectContaining({ method: 'events.workSlotsChanged', params: expect.objectContaining({ limit: 2 }) }))
  inbox.mockClear()
  connection.closed()
  await vi.advanceTimersByTimeAsync(100)
  expect(inbox).toHaveBeenCalledTimes(1)
})

it('observes inbox and slot queue writes without project events, and project topology changes', async () => {
  const c = await client()
  const item = host.work.create({ requestId: rid(), title: 'Waiting' }).item
  await vi.advanceTimersByTimeAsync(200)
  c.messages.length = 0
  spaces.workSlots.setLimit({ limit: 0 })
  host.db.update(s.workItems).set({ waitingSlotSince: Date.now() }).where(eq(s.workItems.id, item.workItemId)).run()
  host.db.insert(s.workMessages).values({ id: 'message_poll', workItemId: item.workItemId, kind: 'question', from: { kind: 'system' }, to: 'user', body: 'Question', refs: {}, createdAt: Date.now() }).run()
  await vi.advanceTimersByTimeAsync(100)
  expect(c.messages).toContainEqual(expect.objectContaining({ method: 'events.workInboxChanged', params: expect.objectContaining({ unread: 1, unresolved: 1 }) }))
  expect(c.messages).toContainEqual(expect.objectContaining({ method: 'events.workSlotsChanged', params: expect.objectContaining({ queue: [expect.objectContaining({ workItemId: item.workItemId })] }) }))
  const created = spaces.create('Another project')
  await vi.advanceTimersByTimeAsync(100)
  expect(c.messages).toContainEqual(expect.objectContaining({ method: 'events.workSlotsChanged', params: expect.objectContaining({ bySpace: expect.arrayContaining([expect.objectContaining({ spaceId: created.spaceId })]) }) }))
})

it('refreshes daily card fields at midnight without a database write', async () => {
  vi.setSystemTime(new Date(2026, 10, 1, 23, 59, 59, 500))
  await vi.advanceTimersByTimeAsync(100)
  const cards = vi.spyOn(host.work, 'list')
  await vi.advanceTimersByTimeAsync(300)
  expect(cards).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(200)
  expect(cards).toHaveBeenCalled()
})

it('pushes daily generation counts when only the injected work clock crosses midnight', async () => {
  clock = new Date(2026, 10, 1, 23, 59, 59, 500).getTime()
  const session = host.sessions.create({ requestId: rid() })
  host.db.insert(s.generationJobs).values({
    id: 'job_midnight', sessionId: session.sessionId, kind: 'image', provider: 'mock', model: 'mock-image-1',
    params: '{}', status: 'failed', createdAt: clock, updatedAt: clock,
  }).run()
  const c = await client()
  await vi.advanceTimersByTimeAsync(200)
  expect(host.work.get({ workItemId: session.workItemId! }).item.todayGenerations).toBe(1)
  c.messages.length = 0
  clock += 1000
  await vi.advanceTimersByTimeAsync(100)
  expect(c.messages).toContainEqual(expect.objectContaining({ method: 'events.event', params: expect.objectContaining({
    type: 'work.itemChanged', payload: expect.objectContaining({ workItemId: session.workItemId, todayGenerations: 0 }),
  }) }))
})

it.each([false, true])('throttles and delivers deferred activity using only the injected clock, with a card failure: %s', async fail => {
  clock = new Date(2020, 0, 1, 12).getTime()
  const session = host.sessions.create({ requestId: rid() })
  const c = await client()
  await vi.advanceTimersByTimeAsync(200)
  const activity = (at: number) => {
    host.db.insert(s.generationJobs).values({
      id: 'job_activity', sessionId: session.sessionId, kind: 'image', provider: 'mock', model: 'mock-image-1',
      params: '{}', status: 'failed', createdAt: clock!, updatedAt: at,
    }).onConflictDoUpdate({ target: s.generationJobs.id, set: { updatedAt: at } }).run()
  }
  const cardEvents = () => c.messages.filter(message => message.method === 'events.event' && message.params.type === 'work.itemChanged')
  activity(clock)
  await vi.advanceTimersByTimeAsync(100)
  clock += 100
  activity(clock)
  await vi.advanceTimersByTimeAsync(100)
  c.messages.length = 0
  clock += 100
  activity(clock)
  await vi.advanceTimersByTimeAsync(100)
  expect(cardEvents()).toHaveLength(0)
  clock += 899
  await vi.advanceTimersByTimeAsync(100)
  expect(cardEvents()).toHaveLength(0)
  clock += 1
  const cards = fail ? vi.spyOn(host.work, 'list').mockImplementationOnce(() => { throw new Error('Deferred card query failed') }) : undefined
  if (fail) vi.spyOn(console, 'error').mockImplementation(() => {})
  await vi.advanceTimersByTimeAsync(100)
  if (cards) {
    expect(cardEvents()).toHaveLength(0)
    cards.mockRestore()
    await vi.advanceTimersByTimeAsync(100)
  }
  expect(cardEvents()).toHaveLength(1)
  expect(cardEvents()[0].params.payload.sessions[0].lastActivityAt).toBe(clock - 900)
})
