import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq, openSpaceDb, readEventsAfter, spaceSchema as s, type SpaceDb } from '@vis/storage'
import { createSessionService, type SessionService } from './session-service'
import type { AgentEvent, AgentRuntimePort, DispatchInput } from './runtime-port'

let db: SpaceDb
let service: SessionService
let at: number
let input: DispatchInput
let runtime: AgentRuntimePort
const minute = 60_000
const rid = () => crypto.randomUUID()
const summary = () => service.list({}).sessions[0]!
const item = (kind: 'tool_call' | 'tool_result', toolUseId = 'tool') => service.handleAgentEvent({ type: 'item', sessionId: input.sessionId, turnId: input.turnId, itemId: `${kind}:${toolUseId}`, revision: 1, kind, payload: kind === 'tool_call' ? { toolUseId, name: 'build', input: {} } : { toolUseId, text: 'done', isError: false } })
const tick = (elapsed: number) => { at += elapsed; service.checkWatchdog() }

beforeEach(async () => {
  vi.useFakeTimers()
  at = 1_800_000_000_000
  db = openSpaceDb(':memory:')
  runtime = { ensureReady: async () => {}, dispatchTurn: vi.fn(async value => { input = value }), interruptTurn: vi.fn(async () => {}), terminateTurn: vi.fn(async () => {}) }
  service = createSessionService({ db, runtime, now: () => at })
  const session = service.create({ requestId: rid(), title: 'Watchdog' })
  service.sendMessage({ requestId: rid(), sessionId: session.sessionId, text: 'Work', refs: [] })
  await service.idle()
})
afterEach(() => { service.dispose(); db.$client.close(); vi.useRealTimers() })

describe('Silent turn notice', () => {
  it.each([false, true])('uses the full threshold with open tool = %s, without stopping or pausing', tool => {
    if (tool) item('tool_call')
    const threshold = (tool ? 30 : 10) * minute
    tick(threshold - 1)
    expect(summary().silentSince).toBeNull()
    tick(1)
    expect(summary()).toMatchObject({ silentSince: at - threshold, activeTurnId: input.turnId, queuePaused: false })
    expect(runtime.interruptTurn).not.toHaveBeenCalled()
    expect(runtime.terminateTurn).not.toHaveBeenCalled()
    expect(db.select().from(s.turns).get()?.status).toBe('running')
    const updates = () => readEventsAfter(db, 0).filter(event => event.type === 'session.updated' && (event.payload as { silentSince?: number }).silentSince != null)
    expect(updates()).toHaveLength(1)
    tick(minute)
    expect(updates()).toHaveLength(1)
  })

  it('counts every open tool, then returns to the idle threshold after their results', () => {
    item('tool_call', 'one'); item('tool_call', 'two'); item('tool_result', 'two')
    tick(10 * minute)
    expect(summary().silentSince).toBeNull()
    item('tool_result', 'one')
    tick(10 * minute)
    expect(summary().silentSince).toBe(at - 10 * minute)
  })

  it.each(['resume_id', 'leaf', 'item', 'context_compacted', 'turn_waiting', 'stream', 'gateway'] as const)('resets and clears immediately on %s activity', source => {
    tick(10 * minute)
    const events: Record<string, AgentEvent> = {
      resume_id: { type: 'resume_id', sessionId: input.sessionId, resumeId: 'resume' },
      leaf: { type: 'leaf', sessionId: input.sessionId, leafUuid: 'leaf' },
      item: { type: 'item', sessionId: input.sessionId, turnId: input.turnId, itemId: 'reasoning', revision: 1, kind: 'reasoning', payload: { text: 'Working' } },
      context_compacted: { type: 'context_compacted', sessionId: input.sessionId },
      turn_waiting: { type: 'turn_waiting', sessionId: input.sessionId, turnId: input.turnId, waiting: false },
    }
    if (source === 'stream' || source === 'gateway') service.recordActivity(input.sessionId, input.turnId)
    else service.handleAgentEvent(events[source]!)
    expect(summary().silentSince).toBeNull()
    tick(10 * minute - 1)
    expect(summary().silentSince).toBeNull()
    tick(1)
    expect(summary().silentSince).toBe(at - 10 * minute)
    const updates = readEventsAfter(db, 0).filter(event => event.type === 'session.updated')
    expect(updates.slice(-2).map(event => (event.payload as { silentSince: number | null }).silentSince)).toEqual([null, at - 10 * minute])
  })

  it('exempts runtime waiting and user approvals, starting a fresh clock when each resumes', async () => {
    service.handleAgentEvent({ type: 'turn_waiting', sessionId: input.sessionId, turnId: input.turnId, waiting: true })
    tick(40 * minute)
    expect(summary().silentSince).toBeNull()
    service.handleAgentEvent({ type: 'turn_waiting', sessionId: input.sessionId, turnId: input.turnId, waiting: false })
    const approval = service.requestApproval({ sessionId: input.sessionId, turnId: input.turnId, kind: 'command', summary: 'Build', detail: 'build' })
    tick(40 * minute)
    expect(summary().silentSince).toBeNull()
    const id = service.getTranscript({ sessionId: input.sessionId }).items.find(item => item.kind === 'approval')!.itemId
    service.respondApproval({ requestId: rid(), approvalId: id, decision: 'deny' })
    await approval
    service.checkWatchdog()
    expect(summary().silentSince).toBeNull()
  })
})

describe('Bounded interruption', () => {
  it('expires approvals, fences late events and leaves Stop drafts paused after forcing a hung request', async () => {
    runtime.interruptTurn = vi.fn(() => new Promise<void>(() => {}))
    const pending = service.requestApproval({ sessionId: input.sessionId, turnId: input.turnId, kind: 'command', summary: 'Build', detail: 'build' })
    const draft = service.sendMessage({ requestId: rid(), sessionId: input.sessionId, text: 'Next', refs: [] })
    const stopping = service.stop({ requestId: rid(), sessionId: input.sessionId, turnId: input.turnId })
    expect(await pending).toBe('deny')
    tick(40 * minute)
    expect(summary().silentSince).toBeNull()
    await vi.advanceTimersByTimeAsync(29_999)
    expect(summary().activeTurnId).toBe(input.turnId)
    await vi.advanceTimersByTimeAsync(1)
    await stopping
    expect(runtime.terminateTurn).toHaveBeenCalledExactlyOnceWith({ sessionId: input.sessionId, turnId: input.turnId })
    expect(summary()).toMatchObject({ activeTurnId: null, pendingApprovals: 0, queuePaused: true })
    const terminal = () => readEventsAfter(db, 0).filter(event => event.type === 'turn.stateChanged' && (event.payload as { status: string }).status === 'interrupted')
    expect(terminal()).toHaveLength(1)
    service.handleAgentEvent({ type: 'turn_ended', sessionId: input.sessionId, turnId: input.turnId, status: 'completed' })
    item('tool_result', 'late')
    expect(terminal()).toHaveLength(1)
    expect(service.getTranscript({ sessionId: input.sessionId }).items.some(item => item.itemId === 'tool_result:late')).toBe(false)
    service.resumeQueue({ requestId: rid(), sessionId: input.sessionId })
    await service.idle()
    expect(db.select().from(s.messages).where(eq(s.messages.id, draft.messageId)).get()?.deliveryState).toBe('delivered')
  })

  it('Send now promotes the selected message and continues FIFO after a forced end', async () => {
    runtime.interruptTurn = vi.fn(() => new Promise<void>(() => {}))
    const old = { ...input }
    service.sendMessage({ requestId: rid(), sessionId: input.sessionId, text: 'First queued', refs: [] })
    const selected = service.sendMessage({ requestId: rid(), sessionId: input.sessionId, text: 'Selected', refs: [] })
    const sending = service.sendNow({ requestId: rid(), sessionId: input.sessionId, messageId: selected.messageId })
    await vi.advanceTimersByTimeAsync(30_000)
    await sending
    await service.idle()
    expect(input.text).toBe('Selected')
    expect(db.select().from(s.turns).where(eq(s.turns.id, old.turnId)).get()?.status).toBe('interrupted')
    service.handleAgentEvent({ type: 'turn_ended', sessionId: input.sessionId, turnId: input.turnId, status: 'completed' })
    await service.idle()
    expect((runtime.dispatchTurn as ReturnType<typeof vi.fn>).mock.calls.map(([value]) => value.text)).toEqual(['Work', 'Selected', 'First queued'])
  })

  it.each(['ready', 'dispatch'] as const)('unblocks the queue when %s never settles, and a late handshake cannot change the ended turn', async phase => {
    service.handleAgentEvent({ type: 'turn_ended', sessionId: input.sessionId, turnId: input.turnId, status: 'completed' })
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    if (phase === 'ready') runtime.ensureReady = () => gate
    else runtime.dispatchTurn = () => gate
    const message = service.sendMessage({ requestId: rid(), sessionId: input.sessionId, text: 'Hung handshake', refs: [] })
    await Promise.resolve(); await Promise.resolve()
    const turnId = summary().activeTurnId!
    await service.stop({ requestId: rid(), sessionId: input.sessionId, turnId })
    await vi.advanceTimersByTimeAsync(30_000)
    await service.idle()
    expect(summary().activeTurnId).toBeNull()
    expect(db.select().from(s.turns).where(eq(s.turns.messageId, message.messageId)).get()?.status).toBe('interrupted')
    release()
    await Promise.resolve(); await Promise.resolve()
    expect(summary().activeTurnId).toBeNull()
  })
})
