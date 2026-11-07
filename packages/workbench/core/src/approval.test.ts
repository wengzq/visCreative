import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { ApprovalPayload } from '@vis/protocol'
import { eq, openSpaceDb, readEventsAfter, spaceSchema as s, type SpaceDb } from '@vis/storage'
import type { AgentRuntimePort, ApprovalRequest } from './runtime-port'
import { createSessionService, type SessionService } from './session-service'

let db: SpaceDb
let sessions: SessionService
let clock: number
let interrupt: Mock<AgentRuntimePort['interruptTurn']>
let sequence = 0
const requestId = () => `approval_test_${++sequence}`

beforeEach(() => {
  db = openSpaceDb(':memory:')
  clock = 1_800_000_000_000
  interrupt = vi.fn(async () => {})
  sessions = createSessionService({ db, now: () => clock, runtime: { ensureReady: async () => {}, dispatchTurn: async () => {}, terminateTurn: async () => {}, interruptTurn: interrupt } })
})

afterEach(() => {
  sessions.dispose()
  vi.useRealTimers()
  db.$client.close()
})

async function startTurn(sessionId = sessions.create({ requestId: requestId(), title: '审批测试' }).sessionId): Promise<ApprovalRequest> {
  sessions.sendMessage({ requestId: requestId(), sessionId, text: '执行任务', refs: [] })
  await sessions.idle()
  const turnId = sessions.list({}).sessions.find(s => s.sessionId === sessionId)!.activeTurnId!
  return { sessionId, turnId, kind: 'command', summary: '创建导出目录', detail: 'mkdir -p exports', cwd: '/workspace' }
}

function approvals(sessionId: string) {
  return sessions.getTranscript({ sessionId }).items.filter(item => item.kind === 'approval')
}

function respond(approvalId: string, decision: 'allow_once' | 'allow_session' | 'deny') {
  return sessions.respondApproval({ requestId: requestId(), approvalId, decision })
}

describe('Operation approvals', () => {
  it('Wait for UI approval, persist entries, update the original entry and session count; responses are idempotent', async () => {
    const request = await startTurn()
    const resolved = vi.fn()
    const outcome = sessions.requestApproval(request).then(resolved)
    await Promise.resolve()
    expect(resolved).not.toHaveBeenCalled()
    const item = approvals(request.sessionId)[0]!
    expect(ApprovalPayload.parse(item.payload)).toMatchObject({ status: 'pending', detail: request.detail })
    expect(sessions.list({}).sessions[0]).toMatchObject({ pendingApprovals: 1 })
    expect(db.select().from(s.turns).where(eq(s.turns.id, request.turnId)).get()?.status).toBe('waiting_user')
    const params = { requestId: requestId(), approvalId: item.itemId, decision: 'allow_once' as const }
    expect(sessions.respondApproval(params)).toEqual({ status: 'approved' })
    expect(sessions.respondApproval(params)).toEqual({ status: 'approved' })
    expect(() => sessions.respondApproval({ ...params, decision: 'deny' })).toThrow(expect.objectContaining({ code: 'idempotency_conflict' }))
    await outcome
    expect(resolved).toHaveBeenCalledExactlyOnceWith('allow_once')
    expect(approvals(request.sessionId)).toEqual([expect.objectContaining({ itemId: item.itemId, createdSeq: item.createdSeq, revision: 2, payload: expect.objectContaining({ status: 'approved', decision: 'allow_once' }) })])
    expect(sessions.list({}).sessions[0]).toMatchObject({ pendingApprovals: 0 })
    expect(readEventsAfter(db, 0).filter(e => e.type === 'transcript.itemUpserted' && e.entityId === request.sessionId).map(e => e.payload)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'approval', revision: 1 }), expect.objectContaining({ kind: 'approval', revision: 2 }),
    ]))
    expect(respond(item.itemId, 'deny')).toEqual({ status: 'approved' })
    const next = sessions.requestApproval(request)
    expect(approvals(request.sessionId)).toHaveLength(2)
    respond(approvals(request.sessionId)[1]!.itemId, 'deny')
    await expect(next).resolves.toBe('deny')
  })

  it('Session grants persist and are reused only for the same session, type, exact operation, and directory', async () => {
    const request = await startTurn()
    const outcome = sessions.requestApproval(request)
    respond(approvals(request.sessionId)[0]!.itemId, 'allow_session')
    await expect(outcome).resolves.toBe('allow_session')
    sessions.handleAgentEvent({ type: 'turn_ended', sessionId: request.sessionId, turnId: request.turnId, status: 'completed' })
    await sessions.idle()
    sessions.dispose()
    sessions = createSessionService({ db, now: () => clock, runtime: { ensureReady: async () => {}, dispatchTurn: async () => {}, terminateTurn: async () => {}, interruptTurn: interrupt } })
    sessions.recover()
    const next = await startTurn(request.sessionId)
    await expect(sessions.requestApproval({ ...next, summary: '同一命令的新摘要' })).resolves.toBe('allow_session')
    expect(approvals(request.sessionId)).toHaveLength(1)
    const otherSession = await startTurn()
    for (const changed of [
      { ...next, detail: `${request.detail} && rm -rf /workspace` },
      { ...next, kind: 'file_write' as const },
      { ...next, cwd: '/other' },
      otherSession,
    ]) {
      const pending = sessions.requestApproval(changed)
      const item = approvals(changed.sessionId).at(-1)!
      expect(ApprovalPayload.parse(item.payload).status).toBe('pending')
      respond(item.itemId, 'deny')
      await expect(pending).resolves.toBe('deny')
    }
  })

  it('vis MCP session grants are reused by server and tool name, allowing changed arguments; other tools or servers still need approval', async () => {
    const turn = await startTurn()
    const request: ApprovalRequest = { ...turn, kind: 'other', summary: 'vis 工具调用', detail: 'MCP: vis\ntool: generation_get\n{"jobId":"first"}', mcpTool: { serverName: 'vis', toolName: 'generation_get' } }
    const outcome = sessions.requestApproval(request)
    respond(approvals(turn.sessionId)[0]!.itemId, 'allow_session')
    await expect(outcome).resolves.toBe('allow_session')
    expect(ApprovalPayload.parse(approvals(turn.sessionId)[0]!.payload).mcpTool).toEqual(request.mcpTool)
    await expect(sessions.requestApproval({ ...request, detail: 'MCP: vis\ntool: generation_get\n{"jobId":"second"}' })).resolves.toBe('allow_session')
    expect(approvals(turn.sessionId)).toHaveLength(1)
    const { mcpTool: _, ...unscoped } = request
    const otherTurn = await startTurn()
    for (const changed of [
      { ...request, mcpTool: { serverName: 'vis' as const, toolName: 'canvas_apply' } },
      { ...unscoped, summary: '其他 MCP 服务调用', detail: 'MCP: other\ntool: generation_get\n{"jobId":"first"}' },
      unscoped,
      { ...request, sessionId: otherTurn.sessionId, turnId: otherTurn.turnId },
    ]) {
      const pending = sessions.requestApproval(changed)
      const item = approvals(changed.sessionId).at(-1)!
      expect(ApprovalPayload.parse(item.payload).status).toBe('pending')
      respond(item.itemId, 'deny')
      await expect(pending).resolves.toBe('deny')
    }
  })

  it('Expire and deny automatically after ten minutes; late allows cannot take effect even before the timer fires', async () => {
    vi.useFakeTimers()
    const request = await startTurn()
    const outcome = sessions.requestApproval(request)
    const approvalId = approvals(request.sessionId)[0]!.itemId
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
    await expect(outcome).resolves.toBe('deny')
    expect(approvals(request.sessionId)[0]).toMatchObject({ revision: 2, payload: { status: 'expired' } })
    expect(respond(approvalId, 'allow_session')).toEqual({ status: 'expired' })
    const late = sessions.requestApproval(request)
    clock += 10 * 60 * 1000
    expect(respond(approvals(request.sessionId)[1]!.itemId, 'allow_once')).toEqual({ status: 'expired' })
    await expect(late).resolves.toBe('deny')
    expect(sessions.list({}).sessions[0]?.pendingApprovals).toBe(0)
  })

  it('Resume running only after all concurrent approvals finish, preserving the runtime\'s own waiting state', async () => {
    const request = await startTurn()
    const outcomes = [sessions.requestApproval(request), sessions.requestApproval({ ...request, detail: 'touch output.txt' })]
    const items = approvals(request.sessionId)
    sessions.handleAgentEvent({ type: 'turn_waiting', sessionId: request.sessionId, turnId: request.turnId, waiting: false })
    respond(items[0]!.itemId, 'allow_once')
    expect(db.select().from(s.turns).where(eq(s.turns.id, request.turnId)).get()?.status).toBe('waiting_user')
    sessions.handleAgentEvent({ type: 'turn_waiting', sessionId: request.sessionId, turnId: request.turnId, waiting: true })
    respond(items[1]!.itemId, 'deny')
    await expect(Promise.all(outcomes)).resolves.toEqual(['allow_once', 'deny'])
    expect(db.select().from(s.turns).where(eq(s.turns.id, request.turnId)).get()?.status).toBe('waiting_user')
    sessions.handleAgentEvent({ type: 'turn_waiting', sessionId: request.sessionId, turnId: request.turnId, waiting: false })
    expect(db.select().from(s.turns).where(eq(s.turns.id, request.turnId)).get()?.status).toBe('running')
  })

  it('Stopping expires all pending approvals before interrupting the runtime; late requests cannot resume waiting', async () => {
    const request = await startTurn()
    const first = sessions.requestApproval(request)
    const second = sessions.requestApproval({ ...request, detail: 'touch output.txt' })
    expect(sessions.list({}).sessions[0]?.pendingApprovals).toBe(2)
    interrupt.mockImplementation(async () => {
      expect(approvals(request.sessionId).every(item => ApprovalPayload.parse(item.payload).status === 'expired')).toBe(true)
    })
    await sessions.stop({ requestId: requestId(), sessionId: request.sessionId, turnId: request.turnId })
    await expect(first).resolves.toBe('deny')
    await expect(second).resolves.toBe('deny')
    await expect(sessions.requestApproval(request)).resolves.toBe('deny')
    expect(interrupt).toHaveBeenCalledExactlyOnceWith({ sessionId: request.sessionId, turnId: request.turnId })
    expect(sessions.list({}).sessions[0]).toMatchObject({ queuePaused: true, pendingApprovals: 0 })
  })

  it('Turn completion, space closure, and crash recovery expire pending approvals', async () => {
    const request = await startTurn()
    const outcome = sessions.requestApproval(request)
    sessions.handleAgentEvent({ type: 'turn_ended', sessionId: request.sessionId, turnId: request.turnId, status: 'failed' })
    await expect(outcome).resolves.toBe('deny')
    await expect(sessions.requestApproval(request)).resolves.toBe('deny')
    await sessions.idle()
    const next = await startTurn(request.sessionId)
    const pending = sessions.requestApproval(next)
    const previous = sessions
    sessions = createSessionService({ db, now: () => clock, runtime: { ensureReady: async () => {}, dispatchTurn: async () => {}, terminateTurn: async () => {}, interruptTurn: interrupt } })
    sessions.recover()
    expect(approvals(request.sessionId).every(item => ApprovalPayload.parse(item.payload).status === 'expired')).toBe(true)
    expect(sessions.list({}).sessions[0]).toMatchObject({ pendingApprovals: 0, activeTurnId: null, queuePaused: true })
    previous.dispose()
    await expect(pending).resolves.toBe('deny')
    sessions.resumeQueue({ requestId: requestId(), sessionId: request.sessionId })
    await sessions.idle()
    const last = await startTurn(request.sessionId)
    const closing = sessions.requestApproval(last)
    sessions.dispose()
    await expect(closing).resolves.toBe('deny')
    await expect(sessions.requestApproval(last)).resolves.toBe('deny')
  })
})

describe('Session permission modes', () => {
  it('Default to ask; persist modes, ensure requestId idempotency, and emit only one update', () => {
    const created = sessions.create({ requestId: requestId() })
    expect(created.approvalMode).toBe('ask')
    const params = { requestId: requestId(), sessionId: created.sessionId, mode: 'auto' as const }
    const before = readEventsAfter(db, 0).length
    const changed = sessions.setApprovalMode(params)
    expect(changed.approvalMode).toBe('auto')
    expect(sessions.setApprovalMode(params)).toEqual(changed)
    expect(readEventsAfter(db, 0).slice(before)).toEqual([expect.objectContaining({ type: 'session.updated', payload: expect.objectContaining({ approvalMode: 'auto' }) })])
    expect(db.select().from(s.sessions).where(eq(s.sessions.id, created.sessionId)).get()?.approvalMode).toBe('auto')
    expect(() => sessions.setApprovalMode({ ...params, mode: 'ask' })).toThrow(expect.objectContaining({ code: 'idempotency_conflict' }))
  })

  it('Switching affects only the next request; automatic approvals are recorded; switching back to ask resumes prompting', async () => {
    const request = await startTurn()
    db.update(s.sessions).set({ workDir: process.cwd() }).where(eq(s.sessions.id, request.sessionId)).run()
    const local = { ...request, cwd: process.cwd() }
    const pending = sessions.requestApproval(local)
    sessions.setApprovalMode({ requestId: requestId(), sessionId: request.sessionId, mode: 'auto' })
    expect(ApprovalPayload.parse(approvals(request.sessionId)[0]!.payload).status).toBe('pending')
    respond(approvals(request.sessionId)[0]!.itemId, 'deny')
    await expect(pending).resolves.toBe('deny')
    await expect(sessions.requestApproval(local)).resolves.toBe('allow_once')
    expect(ApprovalPayload.parse(approvals(request.sessionId)[1]!.payload)).toMatchObject({ status: 'approved', decision: 'allow_once', auto: true, detail: request.detail })
    expect(sessions.list({}).sessions[0]!.pendingApprovals).toBe(0)
    sessions.setApprovalMode({ requestId: requestId(), sessionId: request.sessionId, mode: 'ask' })
    const next = sessions.requestApproval(local)
    expect(ApprovalPayload.parse(approvals(request.sessionId)[2]!.payload).status).toBe('pending')
    respond(approvals(request.sessionId)[2]!.itemId, 'deny')
    await expect(next).resolves.toBe('deny')
  })
})
