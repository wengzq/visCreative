import { newId, VisError } from '@vis/domain'
import { ApprovalPayload, DEFAULT_AGENT_KIND, type ApprovalDecision, type MethodParams, type MethodResult, type SessionSummary, type SkillView, type WorkFailure } from '@vis/protocol'
import { accessSync, constants, existsSync, mkdirSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import {
  ackWorkMessages, claimWorkMessages, markWorkMessagesDelivered, readWorkMessageBatch, type WorkMessageRow,
  and, appendEvent, asc, desc, eq, inArray, isNotNull, isNull, max, runIdempotent, spaceSchema as s, sql, type SpaceDb, type SpaceTx,
} from '@vis/storage'
import { type AgentEvent, type AgentRuntimePort, type ApprovalRequest, DispatchError, type RequestApproval } from './runtime-port'
import { resolveSnapshot } from './snapshot'
import { readAgentOptions, validateAgentConfig } from './agent-config'
import { canAutoApprove } from './auto-approval'
import { appendNotice, readTranscript, upsertItem } from './transcript'

const ACTIVE_TURN = ['running', 'waiting_user'] as const
const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000
const SILENT_IDLE_MS = 10 * 60 * 1000
const SILENT_TOOL_MS = 30 * 60 * 1000
const WATCHDOG_INTERVAL_MS = 30_000
const STOP_GRACE_MS = 30_000

// Other services read the ephemeral notice inside their own transactions. The active turn ID
// fences old notices; globally unique session IDs and disposal keep projects isolated.
const silentTurns = new Map<string, { turnId: string; since: number }>()

export type TurnWatchdogOptions = { idleMs?: number; toolMs?: number; intervalMs?: number; stopGraceMs?: number }

type PendingApproval = {
  request: ApprovalRequest
  payload: ApprovalPayload
  expiresAt: number
  resolve: (decision: ApprovalDecision) => void
  timer: ReturnType<typeof setTimeout>
}

export interface SessionService {
  create(params: MethodParams<'session.create'>): MethodResult<'session.create'>
  list(params: MethodParams<'session.list'>): MethodResult<'session.list'>
  agentOptions(params: MethodParams<'session.agentOptions'>): Promise<MethodResult<'session.agentOptions'>>
  setAgentConfig(params: MethodParams<'session.setAgentConfig'>): Promise<MethodResult<'session.setAgentConfig'>>
  setApprovalMode(params: MethodParams<'session.setApprovalMode'>): MethodResult<'session.setApprovalMode'>
  rename(params: MethodParams<'session.rename'>): MethodResult<'session.rename'>
  resetTitle(params: MethodParams<'session.resetTitle'>): MethodResult<'session.resetTitle'>
  setTitle(sessionId: string, params: MethodParams<'session.setTitle'>): MethodResult<'session.setTitle'>
  sendMessage(params: MethodParams<'session.sendMessage'>): MethodResult<'session.sendMessage'>
  stop(params: MethodParams<'session.stop'>): Promise<MethodResult<'session.stop'>>
  sendNow(params: MethodParams<'session.sendNow'>): Promise<MethodResult<'session.sendNow'>>
  isTurnStopping(turnId: string): boolean
  respondApproval(params: MethodParams<'session.respondApproval'>): MethodResult<'session.respondApproval'>
  requestApproval: RequestApproval
  resumeQueue(params: MethodParams<'session.resumeQueue'>): MethodResult<'session.resumeQueue'>
  clearQueue(params: MethodParams<'session.clearQueue'>): MethodResult<'session.clearQueue'>
  retryMessage(params: MethodParams<'session.retryMessage'>): MethodResult<'session.retryMessage'>
  getTranscript(params: MethodParams<'session.getTranscript'>): MethodResult<'session.getTranscript'>
  /** Runtime events reported by AgentRuntime */
  handleAgentEvent(event: AgentEvent): void
  recordActivity(sessionId: string, turnId?: string): void
  checkWatchdog(): void
  /** Called on studiod startup to finalize state left by the previous process (0002 "Crash Recovery (MVP)") */
  recover(): void
  /** Stop dequeuing and reject pending approvals before closing the space; after runtime exit, wait for idle before closing the database */
  dispose(): void
  /** Wait until dequeuing and delivery settle for all sessions; used by tests */
  idle(): Promise<void>
  /** Resume delivery of queued session messages after work-item activation. */
  notifyWorkActivated(sessionId: string): void
}

export function readSessionSummary(t: SpaceTx, sessionId: string): SessionSummary {
  const row = t.select().from(s.sessions).where(eq(s.sessions.id, sessionId)).get()
  if (!row) throw VisError.of('not_found', 'session.not_found', { sessionId }, `Session ${sessionId} does not exist`)
  const active = t.select().from(s.turns).where(and(eq(s.turns.sessionId, sessionId), inArray(s.turns.status, [...ACTIVE_TURN]))).get()
  const pending = t.select({ count: sql<number>`count(*)` }).from(s.transcriptEntries)
    .where(and(eq(s.transcriptEntries.sessionId, sessionId), eq(s.transcriptEntries.kind, 'approval'), sql`json_extract(${s.transcriptEntries.payload}, '$.status') = 'pending'`)).get()!.count
  const queued = t.select({ count: sql<number>`count(*)` }).from(s.messages)
    .where(and(eq(s.messages.sessionId, sessionId), eq(s.messages.deliveryState, 'draft'))).get()!.count
  return { silentSince: active && silentTurns.get(sessionId)?.turnId === active.id ? silentTurns.get(sessionId)!.since : null, approvalMode: row.approvalMode, queuedMessageCount: queued, agentConfig: { model: row.agentModel, effort: row.reasoningEffort, serviceTier: row.serviceTier }, sessionId: row.id, agentKind: row.agentKind, title: row.title, workDir: row.workDir, workItemId: row.workItemId, titleSource: row.titleSource, queuePaused: row.queuePaused, activeTurnId: active?.id ?? null, pendingApprovals: pending, createdAt: row.createdAt }
}

export function createSessionService(deps: {
  db: SpaceDb
  runtime: AgentRuntimePort
  agentLabel?: (kind: string) => string
  assertAgent?: (kind: string) => void
  rootPath?: string
  assetPath?: (assetVersionId: string) => string
  listSkills?: () => SkillView[]
  now?: () => number
  watchdog?: TurnWatchdogOptions
  acquireWorkSlot?: (workItemId: string) => boolean
  releaseWorkSlot?: (workItemId: string) => void
  onWorkFailure?: (t: SpaceTx, failure: WorkFailure, key: string) => void
  onStop?: (sessionId: string) => void | Promise<void>
}): SessionService {
  const { db, runtime } = deps
  const now = deps.now ?? Date.now
  /** One serial chain per session: dequeue, resolve snapshots, and deliver in order */
  const chains = new Map<string, Promise<void>>()
  const pendingApprovals = new Map<string, PendingApproval>()
  const stoppingTurns = new Set<string>()
  const runtimeWaitingTurns = new Set<string>()
  const sendNowTurns = new Set<string>()
  const sendingNow = new Map<string, Promise<MethodResult<'session.sendNow'>>>()
  const heldQueues = new Map<string, number>()
  const activity = new Map<string, number>()
  const activeBySession = new Map<string, string>()
  const notifiedSilentTurns = new Set<string>()
  const stopTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const turnEnds = new Map<string, { promise: Promise<void>; resolve(): void; forced: Promise<void>; force(): void }>()
  let disposed = false

  const tx = <T>(fn: (tx: SpaceTx) => T): T => db.transaction(fn, { behavior: 'immediate' })

  function activeTurn(t: SpaceTx, sessionId: string) {
    return t.select().from(s.turns).where(and(eq(s.turns.sessionId, sessionId), inArray(s.turns.status, [...ACTIVE_TURN]))).get()
  }

  function recordActivity(sessionId: string, turnId?: string) {
    if (disposed) return
    const activeId = activeBySession.get(sessionId)
    if (!activeId || turnId !== undefined && turnId !== activeId) return
    activity.set(activeId, now())
    if (silentTurns.delete(sessionId)) tx(t => emitSession(t, sessionId, now()))
  }

  function checkWatchdog() {
    if (disposed) return
    const at = now()
    for (const turn of db.select().from(s.turns).where(eq(s.turns.status, 'running')).all()) {
      if (stoppingTurns.has(turn.id) || runtimeWaitingTurns.has(turn.id)) continue
      const since = activity.get(turn.id)
      if (since === undefined || silentTurns.has(turn.sessionId)) continue
      if (at - since < Math.min(deps.watchdog?.idleMs ?? SILENT_IDLE_MS, deps.watchdog?.toolMs ?? SILENT_TOOL_MS)) continue
      const items = db.select({ kind: s.transcriptEntries.kind, payload: s.transcriptEntries.payload }).from(s.transcriptEntries).where(and(eq(s.transcriptEntries.sessionId, turn.sessionId), eq(s.transcriptEntries.turnId, turn.id), inArray(s.transcriptEntries.kind, ['tool_call', 'tool_result']))).all()
      const results = new Set(items.filter(item => item.kind === 'tool_result').map(item => (item.payload as { toolUseId?: string }).toolUseId))
      const toolOpen = items.some(item => item.kind === 'tool_call' && !results.has((item.payload as { toolUseId?: string }).toolUseId))
      if (at - since < (toolOpen ? deps.watchdog?.toolMs ?? SILENT_TOOL_MS : deps.watchdog?.idleMs ?? SILENT_IDLE_MS)) continue
      silentTurns.set(turn.sessionId, { turnId: turn.id, since })
      tx(t => {
        emitSession(t, turn.sessionId, at)
        if (!notifiedSilentTurns.has(turn.id)) {
          notifiedSilentTurns.add(turn.id)
          reportWorkFailure(t, turn.sessionId, turn.id, 'turn_silent', String(Math.floor((at - since) / 60_000)))
        }
      })
    }
  }

  function beginStopping(sessionId: string, turnId: string) {
    stoppingTurns.add(turnId)
    if (silentTurns.delete(sessionId)) tx(t => emitSession(t, sessionId, now()))
    if (stopTimers.has(turnId)) return
    const timer = setTimeout(() => {
      stopTimers.delete(turnId)
      if (disposed || activeTurn(db, sessionId)?.id !== turnId) return
      const completion = turnEnds.get(turnId)
      // Fence writes and run the normal terminal-event cleanup before an adapter can report a late ending.
      service.handleAgentEvent({ type: 'turn_ended', sessionId, turnId, status: 'interrupted' })
      completion?.force()
      void runtime.terminateTurn({ sessionId, turnId }).catch(error => console.error('[session] Force termination failed', error))
    }, deps.watchdog?.stopGraceMs ?? STOP_GRACE_MS)
    timer.unref()
    stopTimers.set(turnId, timer)
  }

  async function interruptTurn(sessionId: string, turnId: string) {
    const ended = turnEnds.get(turnId)?.promise
    const interrupted = runtime.interruptTurn({ sessionId, turnId })
    if (ended) await Promise.race([interrupted, ended])
    else void interrupted.catch(() => {})
  }

  const watchdog = setInterval(checkWatchdog, deps.watchdog?.intervalMs ?? WATCHDOG_INTERVAL_MS)
  watchdog.unref()

  function canRunSession(t: SpaceTx, session: typeof s.sessions.$inferSelect): boolean {
    if (session.archivedAt !== null) return false
    if (!session.workItemId) return true
    const deleting = t.select().from(s.idempotencyKeys).where(eq(s.idempotencyKeys.method, 'work.delete')).all()
      .some(key => { const plan = key.result as { workItemIds: string[]; finished: boolean }; return !plan.finished && plan.workItemIds.includes(session.workItemId!) })
    const work = t.select().from(s.workItems).where(eq(s.workItems.id, session.workItemId)).get()
    return !deleting && work?.archivedAt === null && work.status === 'in_progress'
  }

  function emitSession(t: SpaceTx, sessionId: string, at: number) {
    appendEvent(t, { type: 'session.updated', entityType: 'session', entityId: sessionId, payload: readSessionSummary(t, sessionId) }, at)
  }

  function setMessageState(t: SpaceTx, messageId: string, state: typeof s.messages.$inferSelect.deliveryState, at: number, extra: { submittedAt?: number } = {}) {
    const before = t.select({ sessionId: s.messages.sessionId, deliveryState: s.messages.deliveryState }).from(s.messages).where(eq(s.messages.id, messageId)).get()
    t.update(s.messages).set({ deliveryState: state, ...extra }).where(eq(s.messages.id, messageId)).run()
    appendEvent(t, { type: 'message.stateChanged', entityType: 'message', entityId: messageId, payload: { messageId, deliveryState: state } }, at)
    // Leaving queued state changes queuedMessageCount, so update the summary too
    if (before?.deliveryState === 'draft' && state !== 'draft') emitSession(t, before.sessionId, at)
  }

  function setTurnStatus(t: SpaceTx, turnId: string, status: typeof s.turns.$inferSelect.status, at: number) {
    const ended = status === 'completed' || status === 'failed' || status === 'interrupted'
    t.update(s.turns).set({ status, ...(ended ? { endedAt: at } : {}) }).where(eq(s.turns.id, turnId)).run()
    appendEvent(t, { type: 'turn.stateChanged', entityType: 'turn', entityId: turnId, payload: { turnId, status } }, at)
    if (ended) {
      activity.delete(turnId)
      const turn = t.select().from(s.turns).where(eq(s.turns.id, turnId)).get()
      if (turn && activeBySession.get(turn.sessionId) === turnId) activeBySession.delete(turn.sessionId)
      if (turn && silentTurns.get(turn.sessionId)?.turnId === turnId) silentTurns.delete(turn.sessionId)
      clearTimeout(stopTimers.get(turnId))
      stopTimers.delete(turnId)
      turnEnds.get(turnId)?.resolve()
      turnEnds.delete(turnId)
      notifiedSilentTurns.delete(turnId)
    }
  }

  function writeApprovalState(t: SpaceTx, pending: PendingApproval, status: 'approved' | 'denied' | 'expired', decision?: ApprovalDecision) {
    const { request, payload } = pending
    const at = now()
    upsertItem(t, { sessionId: request.sessionId, turnId: request.turnId, itemId: payload.approvalId, revision: 2, kind: 'approval', payload: { ...payload, status, ...(decision ? { decision } : {}) } }, at)
    const turn = activeTurn(t, request.sessionId)
    if (turn?.id === request.turnId && turn.status === 'waiting_user' && !stoppingTurns.has(turn.id) && !runtimeWaitingTurns.has(turn.id)
      && ![...pendingApprovals.values()].some(other => other !== pending && other.request.turnId === turn.id)) {
      setTurnStatus(t, turn.id, 'running', at)
      activity.set(turn.id, at)
    }
    emitSession(t, request.sessionId, at)
  }

  function releaseApproval(pending: PendingApproval, decision: ApprovalDecision) {
    pendingApprovals.delete(pending.payload.approvalId)
    clearTimeout(pending.timer)
    pending.resolve(decision)
  }

  function expireApproval(pending: PendingApproval) {
    tx(t => writeApprovalState(t, pending, 'expired'))
    releaseApproval(pending, 'deny')
  }

  function expireTurnApprovals(turnId: string) {
    for (const pending of pendingApprovals.values()) {
      if (pending.request.turnId === turnId) expireApproval(pending)
    }
  }

  function requestApproval(request: ApprovalRequest): Promise<ApprovalDecision> {
    if (disposed) return Promise.resolve('deny')
    recordActivity(request.sessionId, request.turnId)
    const turn = activeTurn(db, request.sessionId)
    if (stoppingTurns.has(request.turnId) || turn?.id !== request.turnId) return Promise.resolve('deny')
    const allowed = db.select({ payload: s.transcriptEntries.payload }).from(s.transcriptEntries)
      .where(and(eq(s.transcriptEntries.sessionId, request.sessionId), eq(s.transcriptEntries.kind, 'approval'))).all()
      .some(row => {
        const parsed = ApprovalPayload.safeParse(row.payload)
        if (!parsed.success) return false
        const rule = parsed.data
        if (rule.status !== 'approved' || rule.decision !== 'allow_session') return false
        if (rule.mcpTool || request.mcpTool) {
          return rule.mcpTool?.serverName === 'vis' && request.mcpTool?.serverName === 'vis' && rule.mcpTool.toolName === request.mcpTool.toolName
        }
        // shortcut: session grants reuse only the exact operation and directory; extend prefixes only after explicitly modeling argv/path boundaries.
        return rule.kind === request.kind && rule.detail === request.detail && rule.cwd === request.cwd
      })
    if (allowed) return Promise.resolve('allow_session')
    const session = readSessionSummary(db, request.sessionId)
    const auto = session.approvalMode === 'auto' && canAutoApprove(request, { workDir: session.workDir, rootPath: deps.rootPath ?? session.workDir })
    const at = now()
    const approvalId = newId('transcriptItem', at)
    const payload: ApprovalPayload = { approvalId, kind: request.kind, summary: request.summary, detail: request.detail, ...(request.cwd !== undefined ? { cwd: request.cwd } : {}), ...(request.mcpTool ? { mcpTool: request.mcpTool } : {}), status: auto ? 'approved' : 'pending', ...(auto ? { auto: true, decision: 'allow_once' as const } : {}) }
    tx(t => {
      upsertItem(t, { sessionId: request.sessionId, turnId: request.turnId, itemId: approvalId, revision: 1, kind: 'approval', payload }, at)
      if (!auto && turn.status !== 'waiting_user') setTurnStatus(t, turn.id, 'waiting_user', at)
      emitSession(t, request.sessionId, at)
    })
    if (auto) return Promise.resolve('allow_once')
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        const pending = pendingApprovals.get(approvalId)
        if (pending) expireApproval(pending)
      }, APPROVAL_TIMEOUT_MS)
      timer.unref()
      pendingApprovals.set(approvalId, { request, payload, expiresAt: at + APPROVAL_TIMEOUT_MS, resolve, timer })
    })
  }

  function enqueue(sessionId: string, work: () => Promise<void>): Promise<void> {
    const next = (chains.get(sessionId) ?? Promise.resolve()).then(work).catch(error => {
      console.error(`[session] ${sessionId} queue step failed`, error)
    })
    chains.set(sessionId, next)
    return next
  }

  function workText(t: SpaceTx, messages: WorkMessageRow[]) {
    return messages.map(message => {
      const title = t.select({ title: s.workItems.title }).from(s.workItems).where(eq(s.workItems.id, message.workItemId)).get()?.title ?? message.workItemId
      const source = message.from.kind === 'session' ? `工作区「${title}」` : message.from.kind === 'user' ? '用户' : '系统'
      const refs = [...(message.refs.nodeIds ?? []), ...(message.refs.assetVersionIds ?? [])]
      return `[工作消息${message.redelivered ? ' · 重新投递' : ''} · ${message.kind} · 来自 ${source} · ${message.id} · 批次 ${message.deliveryId}]\n${message.body}${refs.length ? `\n关联：${refs.join('，')}` : ''}${['question', 'blocked', 'escalation'].includes(message.kind) ? `\n回复请调用 work.reply（replyTo: ${message.id}）` : ''}`
    }).join('\n\n')
  }

  function insertWorkDraft(t: SpaceTx, sessionId: string, deliveryId: string, messages: WorkMessageRow[], at: number, order?: number) {
    // Display work references without snapshot requirements: deleted outputs must not block report delivery.
    const id = insertDraft(t, sessionId, workText(t, messages), [], at, order)
    t.update(s.messages).set({ workDeliveryId: deliveryId }).where(eq(s.messages.id, id)).run()
    upsertItem(t, { sessionId, itemId: `user_${id}`, revision: 2, turnId: null, kind: 'user', payload: { messageId: id, text: workText(t, messages), refs: workRefs(messages), workDeliveryId: deliveryId } }, at)
    return id
  }

  function workRefs(messages: WorkMessageRow[]) {
    return [...new Set(messages.flatMap(message => message.refs.nodeIds ?? []))].map(nodeId => ({ nodeId, versionPolicy: 'latest-at-execution' as const }))
  }

  function retainUndeliveredWork(t: SpaceTx, message: typeof s.messages.$inferSelect, at: number) {
    if (!message.workDeliveryId) return false
    const batch = readWorkMessageBatch(t, message.sessionId, message.workDeliveryId)
    if (!batch.length || batch.some(message => message.deliveredAt !== null)) return false
    // A message can own only one turn. Preserve the batch and its queue position in a fresh draft.
    setMessageState(t, message.id, 'withdrawn', at)
    insertWorkDraft(t, message.sessionId, message.workDeliveryId, batch, at, message.queueOrder ?? undefined)
    return true
  }

  function reportWorkFailure(t: SpaceTx, sessionId: string, turnId: string, reason: WorkFailure['reason'], detail?: string) {
    const turn = t.select().from(s.turns).where(eq(s.turns.id, turnId)).get()
    const message = turn && t.select().from(s.messages).where(eq(s.messages.id, turn.messageId)).get()
    const batch = message?.workDeliveryId ? readWorkMessageBatch(t, sessionId, message.workDeliveryId) : []
    // Failure notifications never produce another work notification, even if their recipient fails.
    if (batch.length && batch.every(message => message.kind === 'failure')) return
    const key = reason === 'turn_silent' ? `silent_${turnId}` : message?.workDeliveryId ?? turnId
    deps.onWorkFailure?.(t, { sessionId, turnId, reason, ...(detail ? { detail } : {}) }, key)
  }

  // The unreported check waits for live turns and queued work, so whatever clears them without a completed turn must run it again.
  function recheckUnreported(t: SpaceTx, sessionId: string) {
    const workItemId = t.select({ id: s.sessions.workItemId }).from(s.sessions).where(eq(s.sessions.id, sessionId)).get()?.id
    if (!workItemId) return
    const turn = t.select({ id: s.turns.id, sessionId: s.turns.sessionId }).from(s.turns).innerJoin(s.sessions, eq(s.sessions.id, s.turns.sessionId))
      .where(and(eq(s.sessions.workItemId, workItemId), isNotNull(s.turns.endedAt))).orderBy(desc(s.turns.endedAt), desc(sql`${s.turns}.rowid`)).get()
    if (turn) reportWorkFailure(t, turn.sessionId, turn.id, 'turn_unreported')
  }

  function retryWorkBatch(t: SpaceTx, sessionId: string, deliveryId: string, at: number) {
    const batch = readWorkMessageBatch(t, sessionId, deliveryId)
    if (!batch.length || batch.some(message => message.ackedAt !== null || message.redelivered)) return false
    // Automatically redeliver each batch at most once; another failure retains the unacknowledged record for user intervention.
    t.update(s.workMessages).set({ redelivered: true }).where(eq(s.workMessages.deliveryId, deliveryId)).run()
    insertWorkDraft(t, sessionId, deliveryId, readWorkMessageBatch(t, sessionId, deliveryId), at)
    return true
  }

  /** When a session is idle, unpaused, and has drafts, start the earliest draft */
  function pumpQueue(sessionId: string): void {
    if (disposed) return
    void enqueue(sessionId, async () => {
      if (disposed) return
      const started = tx(t => {
        const session = t.select().from(s.sessions).where(eq(s.sessions.id, sessionId)).get()
        if (!session || session.archivedAt !== null || session.queuePaused || heldQueues.has(sessionId) || !canRunSession(t, session) || activeTurn(t, sessionId)) return null
        let draft = t
          .select()
          .from(s.messages)
          .where(and(eq(s.messages.sessionId, sessionId), eq(s.messages.deliveryState, 'draft')))
          .orderBy(asc(s.messages.queueOrder))
          .get()
        if (!draft) {
          const deliveryId = `dlv_${newId('message', now()).slice(4)}`
          const batch = claimWorkMessages(t, sessionId, deliveryId)
          if (!batch.length) return null
          const id = insertWorkDraft(t, sessionId, deliveryId, batch, now())
          draft = t.select().from(s.messages).where(eq(s.messages.id, id)).get()!
        }
        const at = now()
        const turnId = newId('turn', at)
        t.insert(s.turns).values({ id: turnId, sessionId, messageId: draft.id, status: 'running' }).run()
        activity.set(turnId, at)
        activeBySession.set(sessionId, turnId)
        let resolve!: () => void
        let force!: () => void
        const promise = new Promise<void>(done => { resolve = done })
        const forced = new Promise<void>(done => { force = done })
        turnEnds.set(turnId, { promise, resolve, forced, force })
        setMessageState(t, draft.id, 'submitted', at, { submittedAt: at })
        appendEvent(t, { type: 'turn.stateChanged', entityType: 'turn', entityId: turnId, payload: { turnId, status: 'running' } }, at)
        emitSession(t, sessionId, at)
        return { turnId, message: draft, resumeId: session.agentResumeId, agentConfig: { model: session.agentModel, effort: session.reasoningEffort, serviceTier: session.serviceTier } }
      })
      if (!started) return
      const ended = turnEnds.get(started.turnId)!.forced
      await Promise.race([runTurn(sessionId, started.turnId, started.message, started.resumeId, started.agentConfig), ended])
    })
  }

  async function runTurn(sessionId: string, turnId: string, message: typeof s.messages.$inferSelect, resumeId: string | null, agentConfig: SessionSummary['agentConfig']) {
    // 1. Ready the Agent. Failure means the message has not reached it: mark rejected, pause the queue, and wait for user intervention
    try {
      await runtime.ensureReady(sessionId)
    } catch (error) {
      if (disposed || activeTurn(db, sessionId)?.id !== turnId) return
      failBeforeDispatch(sessionId, turnId, message.id, 'agent_start_failed', `Agent failed to start: ${errorMessage(error)}`, error)
      return
    }
    if (disposed || activeTurn(db, sessionId)?.id !== turnId) return
    const liveSession = db.select().from(s.sessions).where(eq(s.sessions.id, sessionId)).get()!
    if (stoppingTurns.has(turnId) || liveSession.archivedAt !== null || !canRunSession(db, liveSession)) {
      // Stopping during readiness precedes runtime instance creation, so no runtime termination event arrives; finalize the fence here.
      tx(t => {
        setTurnStatus(t, turnId, 'interrupted', now())
        setMessageState(t, message.id, 'rejected', now())
        if (sendNowTurns.has(turnId)) retainUndeliveredWork(t, message, now())
        recheckUnreported(t, sessionId)
        emitSession(t, sessionId, now())
      })
      stoppingTurns.delete(turnId)
      sendNowTurns.delete(turnId)
      pumpQueue(sessionId)
      return
    }

    // 2. Fix the input snapshot before first delivery to the Agent; persist before sending
    let snapshot
    try {
      snapshot = tx(t => {
        const at = now()
        if (message.workDeliveryId) {
          // Relationships may change while the Agent starts; send only batch content still belonging to the current session.
          const batch = readWorkMessageBatch(t, sessionId, message.workDeliveryId)
          if (!batch.length) {
            setMessageState(t, message.id, 'withdrawn', at)
            setTurnStatus(t, turnId, 'completed', at)
            emitSession(t, sessionId, at)
            return null
          }
          const text = workText(t, batch)
          if (text !== message.text) {
            message = { ...message, text }
            t.update(s.messages).set({ text }).where(eq(s.messages.id, message.id)).run()
            const entry = t.select().from(s.transcriptEntries).where(eq(s.transcriptEntries.itemId, `user_${message.id}`)).get()!
            upsertItem(t, { sessionId, itemId: entry.itemId, turnId: entry.turnId, revision: entry.revision + 1, kind: 'user', payload: { messageId: message.id, text, refs: workRefs(batch), workDeliveryId: message.workDeliveryId } }, at)
          }
        }
        const result = resolveSnapshot(t, turnId, message.id, at, deps.assetPath)
        t.update(s.turns).set({ startedAt: at }).where(eq(s.turns.id, turnId)).run()
        if (message.workDeliveryId) markWorkMessagesDelivered(t, sessionId, message.workDeliveryId, at)
        return result
      })
    } catch (error) {
      failBeforeDispatch(sessionId, turnId, message.id, 'ref_unresolvable', `Cannot resolve references: ${errorMessage(error)}`, error)
      return
    }

    if (!snapshot) {
      pumpQueue(sessionId)
      return
    }

    // 3. Deliver. A timeout does not mean nonreceipt: do not resend on unknown; pause the queue for the user to decide
    try {
      const session = readSessionSummary(db, sessionId)
      const work = session.workItemId ? db.select().from(s.workItems).where(eq(s.workItems.id, session.workItemId)).get() : undefined
      await runtime.dispatchTurn({
        sessionId, sessionTitle: session.title, titleSource: session.titleSource, turnId, text: message.text + snapshot.assetText,
        inputSnapshotId: snapshot.snapshotId, refs: snapshot.refs, resumeId, agentConfig,
        ...(work ? { workContext: {
          workItemId: work.id, parentId: work.parentId,
          hasChildren: !!db.select({ id: s.workItems.id }).from(s.workItems).where(and(eq(s.workItems.parentId, work.id), isNull(s.workItems.archivedAt))).get(),
        } } : {}),
        ...(message.skills.length ? { skills: message.skills } : {}),
        ...(deps.rootPath ? { projectContext: {
          rootPath: deps.rootPath, assetsPath: join(deps.rootPath, 'assets'), skillsPath: join(deps.rootPath, 'skills'),
          workDir: session.workDir, skills: deps.listSkills?.() ?? [],
        } } : {}),
      })
      if (activeTurn(db, sessionId)?.id !== turnId) return
      tx(t => {
        const current = t.select({ state: s.messages.deliveryState }).from(s.messages).where(eq(s.messages.id, message.id)).get()
        if (current?.state === 'submitted') setMessageState(t, message.id, 'delivered', now())
      })
      // Stop during delivery handshake: the runtime has not registered an instance yet, so interruption is ignored; resend it once after acceptance
      if (stoppingTurns.has(turnId) && !disposed) await runtime.interruptTurn({ sessionId, turnId })
    } catch (error) {
      if (activeTurn(db, sessionId)?.id !== turnId) return
      const kind = error instanceof DispatchError ? error.kind : 'unknown'
      const sendNow = sendNowTurns.has(turnId)
      tx(t => {
        const at = now()
        setMessageState(t, message.id, kind === 'rejected' ? 'rejected' : 'unknown', at)
        const turn = t.select({ status: s.turns.status }).from(s.turns).where(eq(s.turns.id, turnId)).get()
        if (turn && (ACTIVE_TURN as readonly string[]).includes(turn.status)) setTurnStatus(t, turnId, kind === 'rejected' ? 'failed' : 'interrupted', at)
        if (sendNow && kind === 'rejected' && message.workDeliveryId) {
          t.update(s.workMessages).set({ deliveredAt: null }).where(and(eq(s.workMessages.targetSessionId, sessionId), eq(s.workMessages.deliveryId, message.workDeliveryId), isNull(s.workMessages.ackedAt))).run()
          retainUndeliveredWork(t, message, at)
        }
        t.update(s.sessions).set({ queuePaused: !sendNow }).where(eq(s.sessions.id, sessionId)).run()
        appendNotice(t, sessionId, turnId, kind === 'rejected' ? 'dispatch_rejected' : sendNow ? 'send_now_dispatch_unknown' : 'dispatch_unknown',
          kind === 'rejected' ? `Could not deliver the message to the Agent: ${errorMessage(error)}` : sendNow ? 'The interrupted turn may have received its message; the selected queued message will be sent next' : `无法确认 Agent 是否收到消息，已暂停自动发送，可选择重试`, at,
          kind === 'rejected' ? { reason: 'session.dispatch_rejected', params: { detail: errorMessage(error) }, cause: noticeCause(error) } : undefined)
        emitSession(t, sessionId, at)
      })
      expireTurnApprovals(turnId)
      let retry = false
      if (kind === 'rejected' && message.workDeliveryId && !stoppingTurns.has(turnId)) {
        retry = tx(t => {
          const retried = retryWorkBatch(t, sessionId, message.workDeliveryId!, now())
          if (retried) t.update(s.sessions).set({ queuePaused: false }).where(eq(s.sessions.id, sessionId)).run()
          return retried
        })
        if (retry) pumpQueue(sessionId)
      }
      if (!retry && !disposed && !stoppingTurns.has(turnId)) tx(t => reportWorkFailure(t, sessionId, turnId, kind === 'rejected' ? 'dispatch_rejected' : 'dispatch_unknown', errorMessage(error)))
      if (!retry && !disposed) tx(t => recheckUnreported(t, sessionId))
      if (sendNow) {
        stoppingTurns.delete(turnId)
        sendNowTurns.delete(turnId)
        pumpQueue(sessionId)
      }
    }
  }

  function failBeforeDispatch(sessionId: string, turnId: string, messageId: string, code: string, text: string, error: unknown) {
    const wasStopping = stoppingTurns.has(turnId)
    tx(t => {
      const at = now()
      setTurnStatus(t, turnId, wasStopping ? 'interrupted' : 'failed', at)
      const message = t.select().from(s.messages).where(eq(s.messages.id, messageId)).get()
      setMessageState(t, messageId, 'rejected', at)
      if (sendNowTurns.has(turnId) && message) retainUndeliveredWork(t, message, at)
      t.update(s.sessions).set({ queuePaused: !sendNowTurns.has(turnId) }).where(eq(s.sessions.id, sessionId)).run()
      appendNotice(t, sessionId, turnId, code, text, at, {
        reason: code === 'agent_start_failed' ? 'session.agent_start_failed' : 'session.ref_unresolvable',
        params: { detail: errorMessage(error) },
        cause: noticeCause(error),
      })
      emitSession(t, sessionId, at)
    })
    stoppingTurns.delete(turnId)
    if (sendNowTurns.delete(turnId)) pumpQueue(sessionId)
    const message = db.select().from(s.messages).where(eq(s.messages.id, messageId)).get()
    let retry = false
    if (message?.workDeliveryId && !wasStopping) {
      retry = tx(t => {
        const retried = retryWorkBatch(t, sessionId, message.workDeliveryId!, now())
        if (retried) t.update(s.sessions).set({ queuePaused: false }).where(eq(s.sessions.id, sessionId)).run()
        return retried
      })
      if (retry) pumpQueue(sessionId)
    }
    if (!retry && !wasStopping && !disposed) tx(t => reportWorkFailure(t, sessionId, turnId, code === 'agent_start_failed' ? 'agent_start_failed' : 'ref_unresolvable', errorMessage(error)))
    if (!retry && !disposed) tx(t => recheckUnreported(t, sessionId))
  }

  function insertDraft(t: SpaceTx, sessionId: string, text: string, refs: MethodParams<'session.sendMessage'>['refs'], at: number, order?: number, skills: string[] = []) {
    const messageId = newId('message', at)
    const queueOrder = order ?? (t.select({ m: max(s.messages.queueOrder) }).from(s.messages).where(eq(s.messages.sessionId, sessionId)).get()?.m ?? 0) + 1
    t.insert(s.messages).values({ id: messageId, sessionId, text, skills, deliveryState: 'draft', queueOrder, createdAt: at }).run()
    for (const [ordinal, ref] of refs.entries()) {
      t.insert(s.messageRefs)
        .values('assetVersionId' in ref
          ? { messageId, ordinal, assetVersionId: ref.assetVersionId }
          : { messageId, ordinal, nodeId: ref.nodeId, slotId: ref.slotId ?? null, versionPolicy: ref.versionPolicy, pinnedRevision: ref.pinnedRevision ?? null })
        .run()
    }
    upsertItem(t, { sessionId, itemId: `user_${messageId}`, revision: 1, turnId: null, kind: 'user', payload: { messageId, text, refs, ...(skills.length ? { skills } : {}) } }, at)
    appendEvent(t, { type: 'message.stateChanged', entityType: 'message', entityId: messageId, payload: { messageId, deliveryState: 'draft' } }, at)
    emitSession(t, sessionId, at)
    return messageId
  }

  /** Draft position in the queue (0 means next); if the session is idle and unpaused, the next draft starts immediately */
  function queueState(t: SpaceTx, sessionId: string, messageId: string) {
    const drafts = t.select({ id: s.messages.id }).from(s.messages)
      .where(and(eq(s.messages.sessionId, sessionId), eq(s.messages.deliveryState, 'draft'))).orderBy(asc(s.messages.queueOrder)).all()
    const position = drafts.findIndex(d => d.id === messageId)
    const session = t.select().from(s.sessions).where(eq(s.sessions.id, sessionId)).get()!
    const startsNow = position === 0 && !session.queuePaused && canRunSession(t, session) && !activeTurn(t, sessionId)
    return { position, startsNow }
  }

  const service: SessionService = {
    requestApproval,
    recordActivity,
    checkWatchdog,
    isTurnStopping: turnId => stoppingTurns.has(turnId),
    create(params) {
      let reservedWorkItem: string | undefined
      let result: SessionSummary
      try {
        result = runIdempotent(db, { requestId: params.requestId, method: 'session.create', params }, t => {
          const at = now()
          const id = newId('session', at)
          const agentKind = params.agentKind ?? DEFAULT_AGENT_KIND
          deps.assertAgent?.(agentKind)
          const title = params.title?.trim() ?? ''
          let workDir = params.workDir ?? ''
          if (params.workDir) {
            let valid = false
            try {
              valid = isAbsolute(workDir) && statSync(workDir).isDirectory()
              if (valid) accessSync(workDir, constants.R_OK | constants.W_OK | constants.X_OK)
            } catch { valid = false }
            if (!valid) throw VisError.of('invalid_params', 'session.invalid_work_dir', {}, 'The working directory must be an existing absolute directory path')
          } else if (deps.rootPath) {
            const slug = title.toLowerCase().replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^[-.]+|[-.]+$/g, '') || `ws-${id.slice(-8)}`
            workDir = join(deps.rootPath, 'workspaces', slug)
            if (existsSync(workDir)) workDir = `${workDir}-${id.slice(-8)}`
            mkdirSync(workDir, { recursive: true })
          }
          const count = t.select({ id: s.sessions.id }).from(s.sessions).where(eq(s.sessions.agentKind, agentKind)).all().length
          const label = deps.agentLabel?.(agentKind) ?? agentKind
          const sessionTitle = title || `${label} ${count + 1}`
          const workItemId = newId('workItem', at)
          const active = deps.acquireWorkSlot?.(workItemId) ?? true
          if (active) reservedWorkItem = workItemId
          t.insert(s.workItems).values({ id: workItemId, title: sessionTitle, agentKind, workDir, status: active ? 'in_progress' : 'todo', waitingSlotSince: active ? null : at, createdBy: { kind: 'user' }, statusChangedAt: at, createdAt: at }).run()
          t.insert(s.sessions).values({ id, agentKind, workItemId, title: sessionTitle, titleSource: title ? 'user' : 'default', workDir, createdAt: at }).run()
          const view = readSessionSummary(t, id)
          const seq = appendEvent(t, { type: 'session.created', entityType: 'session', entityId: id, payload: view }, at)
          if (active) t.update(s.workItems).set({ activationSeq: seq }).where(eq(s.workItems.id, workItemId)).run()
          return view
        }, now)
      } catch (error) {
        if (reservedWorkItem) deps.releaseWorkSlot?.(reservedWorkItem)
        throw error
      }
      return result
    },

    list(params) {
      const rows = db.select({ id: s.sessions.id }).from(s.sessions)
        .where(params.includeArchived ? undefined : isNull(s.sessions.archivedAt)).orderBy(asc(s.sessions.createdAt)).all()
      return { sessions: rows.map(r => readSessionSummary(db, r.id)) }
    },

    async agentOptions(params) {
      const session = readSessionSummary(db, params.sessionId)
      return { models: await readAgentOptions(runtime, session.agentKind) }
    },

    async setAgentConfig(params) {
      const request = { requestId: params.requestId, method: 'session.setAgentConfig', params }
      // Completed requests do not depend on whether the Agent can start now; the shared idempotency entry point still validates parameter conflicts.
      if (db.select().from(s.idempotencyKeys).where(eq(s.idempotencyKeys.requestId, params.requestId)).get()) {
        return runIdempotent<SessionSummary>(db, request, () => { throw new Error('Idempotency record has disappeared') }, now)
      }
      const session = readSessionSummary(db, params.sessionId)
      await validateAgentConfig(runtime, session.agentKind, params)
      return runIdempotent(db, request, t => {
        const current = readSessionSummary(t, params.sessionId)
        if (current.agentConfig.model !== params.model || current.agentConfig.effort !== params.effort || current.agentConfig.serviceTier !== params.serviceTier) {
          t.update(s.sessions).set({ agentModel: params.model, reasoningEffort: params.effort, serviceTier: params.serviceTier }).where(eq(s.sessions.id, params.sessionId)).run()
          emitSession(t, params.sessionId, now())
        }
        return readSessionSummary(t, params.sessionId)
      }, now)
    },

    setApprovalMode(params) {
      return runIdempotent(db, { requestId: params.requestId, method: 'session.setApprovalMode', params }, t => {
        const current = readSessionSummary(t, params.sessionId)
        if (current.approvalMode !== params.mode) {
          t.update(s.sessions).set({ approvalMode: params.mode }).where(eq(s.sessions.id, params.sessionId)).run()
          emitSession(t, params.sessionId, now())
        }
        return readSessionSummary(t, params.sessionId)
      }, now)
    },

    rename(params) {
      return runIdempotent(db, { requestId: params.requestId, method: 'session.rename', params }, t => {
        const current = readSessionSummary(t, params.sessionId)
        if (current.title !== params.title || current.titleSource !== 'user') {
          t.update(s.sessions).set({ title: params.title, titleSource: 'user' }).where(eq(s.sessions.id, params.sessionId)).run()
          emitSession(t, params.sessionId, now())
        }
        return readSessionSummary(t, params.sessionId)
      }, now)
    },

    resetTitle(params) {
      return runIdempotent(db, { requestId: params.requestId, method: 'session.resetTitle', params }, t => {
        const current = readSessionSummary(t, params.sessionId)
        if (current.titleSource !== 'default') {
          t.update(s.sessions).set({ titleSource: 'default' }).where(eq(s.sessions.id, params.sessionId)).run()
          emitSession(t, params.sessionId, now())
        }
        return readSessionSummary(t, params.sessionId)
      }, now)
    },

    setTitle(sessionId, params) {
      return runIdempotent(db, { requestId: params.requestId, method: 'session.setTitle', params: { ...params, sessionId } }, t => {
        const current = readSessionSummary(t, sessionId)
        if (current.titleSource === 'user') return { applied: false as const, reason: 'user_named' as const, title: current.title }
        if (current.title !== params.title) {
          t.update(s.sessions).set({ title: params.title, titleSource: 'agent' }).where(eq(s.sessions.id, sessionId)).run()
          emitSession(t, sessionId, now())
        }
        return { applied: true as const, title: params.title }
      }, now)
    },

    sendMessage(params) {
      deps.assertAgent?.(readSessionSummary(db, params.sessionId).agentKind)
      if (disposed) throw VisError.of('unavailable', 'session.service_closed', {}, 'Session service is closed')
      const result = runIdempotent(db, { requestId: params.requestId, method: 'session.sendMessage', params }, t => {
        readSessionSummary(t, params.sessionId)
        for (const ref of params.refs) {
          if ('assetVersionId' in ref && !t.select({ id: s.assetVersions.id }).from(s.assetVersions).where(eq(s.assetVersions.id, ref.assetVersionId)).get()) {
            throw VisError.of('not_found', 'session.asset_version_not_found', { assetVersionId: ref.assetVersionId }, `Asset version ${ref.assetVersionId} does not belong to this project or does not exist`)
          }
        }
        const skills = [...new Set(params.skills ?? [])]
        const availableSkills = deps.listSkills?.()
        if (availableSkills && skills.some(name => !availableSkills.some(skill => skill.name === name))) throw VisError.of('invalid_params', 'session.skill_not_found', {}, 'The selected skill is not in the project skill directory')
        const messageId = insertDraft(t, params.sessionId, params.text, params.refs, now(), undefined, skills)
        const { position, startsNow } = queueState(t, params.sessionId, messageId)
        // When idle, this message dequeues immediately; report that honestly in the receipt instead of first claiming draft and then changing
        return startsNow ? { messageId, deliveryState: 'submitted' as const } : { messageId, deliveryState: 'draft' as const, queuePosition: position }
      }, now)
      pumpQueue(params.sessionId)
      return result
    },

    async stop(params) {
      // Verify the stop target: stop only the current turn so a late Stop cannot interrupt the next one
      tx(t => {
        const active = activeTurn(t, params.sessionId)
        if (!active || active.id !== params.turnId) throw VisError.of('busy', 'session.turn_not_current', {}, 'This turn has ended or is not the current turn')
        // Record stop intent first: pause the queue and retain drafts
        t.update(s.sessions).set({ queuePaused: true }).where(eq(s.sessions.id, params.sessionId)).run()
        emitSession(t, params.sessionId, now())
      })
      beginStopping(params.sessionId, params.turnId)
      await deps.onStop?.(params.sessionId)
      expireTurnApprovals(params.turnId)
      await interruptTurn(params.sessionId, params.turnId)
      return { accepted: true }
    },

    async sendNow(params) {
      if (disposed) throw VisError.of('unavailable', 'session.service_closed', {}, 'Session service is closed')
      let first = false
      const plan = runIdempotent(db, { requestId: params.requestId, method: 'session.sendNow', params }, t => {
        const session = t.select().from(s.sessions).where(eq(s.sessions.id, params.sessionId)).get()
        if (!session) throw VisError.of('not_found', 'session.not_found', {}, 'Session does not exist')
        deps.assertAgent?.(session.agentKind)
        if (!canRunSession(t, session)) throw VisError.of('busy', 'session.cannot_run', {}, 'This session cannot run; reopen its workspace first')
        const message = t.select().from(s.messages).where(eq(s.messages.id, params.messageId)).get()
        if (!message || message.sessionId !== params.sessionId || message.deliveryState !== 'draft' || message.workDeliveryId !== null) {
          throw VisError.of('busy', 'session.message_not_queued', {}, 'Only an unsent user message in this session can be sent now')
        }
        const head = t.select({ order: s.messages.queueOrder }).from(s.messages)
          .where(eq(s.messages.sessionId, params.sessionId)).orderBy(asc(s.messages.queueOrder)).get()!
        t.update(s.messages).set({ queueOrder: (head.order ?? 0) - 1 }).where(eq(s.messages.id, params.messageId)).run()
        t.update(s.sessions).set({ queuePaused: false }).where(eq(s.sessions.id, params.sessionId)).run()
        emitSession(t, params.sessionId, now())
        first = true
        return { turnId: activeTurn(t, params.sessionId)?.id ?? null }
      }, now)
      const pending = sendingNow.get(params.requestId)
      if (pending) return pending
      if (!first) return { accepted: true }
      heldQueues.set(params.sessionId, (heldQueues.get(params.sessionId) ?? 0) + 1)
      if (plan.turnId) { beginStopping(params.sessionId, plan.turnId); sendNowTurns.add(plan.turnId) }
      const action = Promise.resolve().then(async () => {
        try {
          if (plan.turnId) {
            await deps.onStop?.(params.sessionId)
            expireTurnApprovals(plan.turnId)
            await interruptTurn(params.sessionId, plan.turnId)
          }
          return { accepted: true as const }
        } finally {
          const remaining = (heldQueues.get(params.sessionId) ?? 1) - 1
          if (remaining) heldQueues.set(params.sessionId, remaining)
          else heldQueues.delete(params.sessionId)
          sendingNow.delete(params.requestId)
          pumpQueue(params.sessionId)
        }
      })
      sendingNow.set(params.requestId, action)
      return action
    },

    respondApproval(params) {
      let release: { pending: PendingApproval; decision: ApprovalDecision } | undefined
      const result = runIdempotent(db, { requestId: params.requestId, method: 'session.respondApproval', params }, t => {
        const row = t.select().from(s.transcriptEntries).where(and(eq(s.transcriptEntries.itemId, params.approvalId), eq(s.transcriptEntries.kind, 'approval'))).get()
        const parsed = ApprovalPayload.safeParse(row?.payload)
        if (!row || !parsed.success) throw VisError.of('not_found', 'session.approval_not_found', {}, 'Approval request does not exist')
        if (parsed.data.kind === 'generation_batch') throw VisError.of('invalid_params', 'script.batch_approval_method_required', {}, 'Generation batches must be answered through the batch approval methods')
        if (parsed.data.status !== 'pending') return { status: parsed.data.status }
        const pending = pendingApprovals.get(params.approvalId)
        if (!pending) throw VisError.of('busy', 'session.approval_expired', {}, 'Approval request has expired')
        const turn = activeTurn(t, row.sessionId)
        const expired = now() >= pending.expiresAt || turn?.id !== row.turnId || stoppingTurns.has(row.turnId!)
        const status = expired ? 'expired' as const : params.decision === 'deny' ? 'denied' as const : 'approved' as const
        writeApprovalState(t, pending, status, expired ? undefined : params.decision)
        release = { pending, decision: expired ? 'deny' : params.decision }
        return { status }
      }, now)
      if (release) releaseApproval(release.pending, release.decision)
      return result
    },

    resumeQueue(params) {
      deps.assertAgent?.(readSessionSummary(db, params.sessionId).agentKind)
      if (disposed) throw VisError.of('unavailable', 'session.service_closed', {}, 'Session service is closed')
      tx(t => {
        readSessionSummary(t, params.sessionId)
        t.update(s.sessions).set({ queuePaused: false }).where(eq(s.sessions.id, params.sessionId)).run()
        emitSession(t, params.sessionId, now())
      })
      pumpQueue(params.sessionId)
      return { queuePaused: false }
    },

    clearQueue(params) {
      if (disposed) throw VisError.of('unavailable', 'session.service_closed', {}, 'Session service is closed')
      return runIdempotent(db, { requestId: params.requestId, method: 'session.clearQueue', params }, t => {
        readSessionSummary(t, params.sessionId)
        const at = now()
        // Never withdraw work-item report batches: no one would redeliver them, so the reports would be lost
        const drafts = t.select({ id: s.messages.id }).from(s.messages)
          .where(and(eq(s.messages.sessionId, params.sessionId), eq(s.messages.deliveryState, 'draft'), isNull(s.messages.workDeliveryId))).all()
        for (const draft of drafts) setMessageState(t, draft.id, 'withdrawn', at)
        if (drafts.length) {
          recheckUnreported(t, params.sessionId)
          emitSession(t, params.sessionId, at)
        }
        return { withdrawnMessageIds: drafts.map(d => d.id) }
      }, now)
    },

    retryMessage(params) {
      if (disposed) throw VisError.of('unavailable', 'session.service_closed', {}, 'Session service is closed')
      const result = runIdempotent(db, { requestId: params.requestId, method: 'session.retryMessage', params }, t => {
        const original = t.select().from(s.messages).where(eq(s.messages.id, params.messageId)).get()
        if (!original) throw VisError.of('not_found', 'session.message_not_found', { messageId: params.messageId }, `Message ${params.messageId} does not exist`)
        deps.assertAgent?.(readSessionSummary(t, original.sessionId).agentKind)
        if (original.deliveryState !== 'unknown' && original.deliveryState !== 'rejected') {
          throw VisError.of('busy', 'session.message_not_retryable', { state: original.deliveryState }, `Message status is ${original.deliveryState}; only unacknowledged or rejected messages can be retried`)
        }
        const at = now()
        if (original.workDeliveryId) {
          const batch = readWorkMessageBatch(t, original.sessionId, original.workDeliveryId)
          const pending = t.select().from(s.messages).where(and(eq(s.messages.workDeliveryId, original.workDeliveryId), inArray(s.messages.deliveryState, ['draft', 'submitted']))).get()
          const running = activeTurn(t, original.sessionId)
          const runningMessage = running ? t.select().from(s.messages).where(eq(s.messages.id, running.messageId)).get() : undefined
          if (batch.some(message => message.ackedAt !== null) || pending || runningMessage?.workDeliveryId === original.workDeliveryId) throw VisError.of('busy', 'session.work_batch_not_retryable', {}, 'This work batch is already acknowledged or being delivered')
          t.update(s.workMessages).set({ redelivered: true }).where(eq(s.workMessages.deliveryId, original.workDeliveryId)).run()
        }
        const refs = t.select().from(s.messageRefs).where(eq(s.messageRefs.messageId, original.id)).orderBy(s.messageRefs.ordinal).all()
        setMessageState(t, original.id, 'withdrawn', at)
        // Place retries at the front of the queue; a user retry also unpauses the queue
        const first = t.select({ m: s.messages.queueOrder }).from(s.messages)
          .where(and(eq(s.messages.sessionId, original.sessionId), eq(s.messages.deliveryState, 'draft'))).orderBy(asc(s.messages.queueOrder)).get()
        const messageId = insertDraft(t, original.sessionId, original.workDeliveryId ? workText(t, readWorkMessageBatch(t, original.sessionId, original.workDeliveryId)) : original.text, refs.map(r => r.assetVersionId ? { assetVersionId: r.assetVersionId } : {
          nodeId: r.nodeId!, versionPolicy: r.versionPolicy!,
          ...(r.slotId ? { slotId: r.slotId } : {}), ...(r.pinnedRevision !== null ? { pinnedRevision: r.pinnedRevision } : {}),
        }), at, (first?.m ?? 1) - 1, original.skills)
        if (original.workDeliveryId) t.update(s.messages).set({ workDeliveryId: original.workDeliveryId }).where(eq(s.messages.id, messageId)).run()
        t.update(s.sessions).set({ queuePaused: false }).where(eq(s.sessions.id, original.sessionId)).run()
        emitSession(t, original.sessionId, at)
        const { startsNow } = queueState(t, original.sessionId, messageId)
        return { messageId, withdrawnMessageId: original.id, deliveryState: startsNow ? ('submitted' as const) : ('draft' as const), sessionId: original.sessionId }
      }, now)
      pumpQueue(result.sessionId)
      const { sessionId: _, ...rest } = result
      return rest
    },

    getTranscript(params) {
      readSessionSummary(db, params.sessionId)
      return readTranscript(db, params.sessionId, params.beforeSeq, params.limit ?? 100)
    },

    handleAgentEvent(event) {
      if (disposed && event.type !== 'turn_ended') return
      if ('turnId' in event && event.turnId && activeTurn(db, event.sessionId)?.id !== event.turnId) return
      recordActivity(event.sessionId, 'turnId' in event ? event.turnId ?? undefined : undefined)
      const at = now()
      switch (event.type) {
        case 'resume_id':
          db.update(s.sessions).set({ agentResumeId: event.resumeId }).where(eq(s.sessions.id, event.sessionId)).run()
          return
        case 'leaf':
          db.update(s.sessions).set({ providerLeafUuid: event.leafUuid }).where(eq(s.sessions.id, event.sessionId)).run()
          return
        case 'item':
          tx(t => upsertItem(t, { sessionId: event.sessionId, itemId: event.itemId, revision: event.revision, turnId: event.turnId, kind: event.kind, payload: event.payload }, at))
          return
        case 'context_compacted':
          tx(t => appendNotice(t, event.sessionId, null, 'context_compacted', '上下文已压缩：Agent 不再记得完整的早期细节，必要时请重新说明关键设定', at))
          return
        case 'turn_waiting':
          tx(t => {
            const turn = t.select().from(s.turns).where(eq(s.turns.id, event.turnId)).get()
            if (!turn || !(ACTIVE_TURN as readonly string[]).includes(turn.status)) return
            if (event.waiting) runtimeWaitingTurns.add(event.turnId)
            else runtimeWaitingTurns.delete(event.turnId)
            const waiting = event.waiting || [...pendingApprovals.values()].some(p => p.request.turnId === event.turnId)
            setTurnStatus(t, event.turnId, waiting ? 'waiting_user' : 'running', at)
          })
          return
        case 'turn_ended': {
          const ended = tx(t => {
            const turn = t.select().from(s.turns).where(eq(s.turns.id, event.turnId)).get()
            if (!turn || !(ACTIVE_TURN as readonly string[]).includes(turn.status)) return false
            setTurnStatus(t, event.turnId, event.status, at)
            // Turn completion proves the Agent received the message
            const msg = t.select().from(s.messages).where(eq(s.messages.id, turn.messageId)).get()
            let retried = false
            let retained = false
            if (msg?.workDeliveryId) {
              retained = sendNowTurns.has(event.turnId) && retainUndeliveredWork(t, msg, at)
              if (!retained && event.status === 'completed') ackWorkMessages(t, event.sessionId, msg.workDeliveryId, at)
              else if (!retained && !disposed && !stoppingTurns.has(event.turnId)) retried = retryWorkBatch(t, event.sessionId, msg.workDeliveryId, at)
            }
            if (!retried && event.status !== 'completed' && !disposed && !stoppingTurns.has(event.turnId)) reportWorkFailure(t, event.sessionId, event.turnId, event.status === 'failed' ? 'turn_failed' : 'runtime_exited')
            if (!retained && (msg?.deliveryState === 'submitted' || msg?.deliveryState === 'unknown')) setMessageState(t, turn.messageId, 'delivered', at)
            if (event.status === 'completed' ? !stoppingTurns.has(event.turnId) : !disposed) recheckUnreported(t, event.sessionId)
            emitSession(t, event.sessionId, at)
            return true
          })
          expireTurnApprovals(event.turnId)
          stoppingTurns.delete(event.turnId)
          sendNowTurns.delete(event.turnId)
          runtimeWaitingTurns.delete(event.turnId)
          if (ended) pumpQueue(event.sessionId)
          return
        }
      }
    },

    recover() {
      const resume = new Set<string>()
      const pausedBeforeRestart = new Set(db.select().from(s.sessions).where(eq(s.sessions.queuePaused, true)).all().map(session => session.id))
      tx(t => {
        const at = now()
        t.update(s.agentInstances).set({ status: 'exited', exitedAt: at, exitReason: 'studiod_restart' })
          .where(inArray(s.agentInstances.status, ['starting', 'ready'])).run()
        const interrupted = t.select().from(s.turns).where(inArray(s.turns.status, [...ACTIVE_TURN])).all()
        const sessionIds = new Set<string>()
        for (const row of t.select().from(s.transcriptEntries).where(eq(s.transcriptEntries.kind, 'approval')).all()) {
          const parsed = ApprovalPayload.safeParse(row.payload)
          if (!parsed.success || parsed.data.status !== 'pending' || parsed.data.kind === 'generation_batch' || parsed.data.kind === 'work_delete') continue
          upsertItem(t, { sessionId: row.sessionId, itemId: row.itemId, turnId: row.turnId, revision: row.revision + 1, kind: 'approval', payload: { ...parsed.data, status: 'expired' } }, at)
          sessionIds.add(row.sessionId)
        }
        for (const turn of interrupted) {
          setTurnStatus(t, turn.id, 'interrupted', at)
          sessionIds.add(turn.sessionId)
        }
        // Submitted messages without confirmed delivery have unknown outcomes; never resend automatically
        for (const m of t.select().from(s.messages).where(eq(s.messages.deliveryState, 'submitted')).all()) {
          setMessageState(t, m.id, 'unknown', at)
          sessionIds.add(m.sessionId)
        }
        for (const sessionId of sessionIds) {
          t.update(s.sessions).set({ queuePaused: true }).where(eq(s.sessions.id, sessionId)).run()
          appendNotice(t, sessionId, null, 'runtime_restarted', '后台已重启，进行中的回合已中断；工作消息按批次恢复，普通消息保持暂停', at)
          emitSession(t, sessionId, at)
        }
        for (const session of t.select().from(s.sessions).all()) {
          const queuedMessages = t.select().from(s.messages).where(eq(s.messages.sessionId, session.id)).all()
          const batches = new Set(queuedMessages.map(message => message.workDeliveryId).filter((id): id is string => id !== null))
          let recovered = false
          for (const deliveryId of batches) {
            if (queuedMessages.some(message => message.workDeliveryId === deliveryId && message.deliveryState === 'draft')) recovered = true
            else if (retryWorkBatch(t, session.id, deliveryId, at)) recovered = true
          }
          const pending = t.select().from(s.workMessages).where(and(eq(s.workMessages.targetSessionId, session.id), isNull(s.workMessages.deliveryId), isNull(s.workMessages.ackedAt))).get()
          if (!recovered) for (const turn of interrupted.filter(turn => turn.sessionId === session.id)) reportWorkFailure(t, session.id, turn.id, 'runtime_restarted')
          if ((recovered || pending) && session.archivedAt === null && canRunSession(t, session)) {
            const ordinaryInterrupted = interrupted.some(turn => turn.sessionId === session.id && !t.select().from(s.messages).where(eq(s.messages.id, turn.messageId)).get()?.workDeliveryId)
            if (!ordinaryInterrupted && !pausedBeforeRestart.has(session.id)) {
              t.update(s.sessions).set({ queuePaused: false }).where(eq(s.sessions.id, session.id)).run()
              emitSession(t, session.id, at)
              resume.add(session.id)
            }
          }
        }
        for (const turn of interrupted) recheckUnreported(t, turn.sessionId)
      })
      for (const sessionId of resume) pumpQueue(sessionId)
    },

    dispose() {
      disposed = true
      clearInterval(watchdog)
      for (const timer of stopTimers.values()) clearTimeout(timer)
      stopTimers.clear()
      for (const session of db.select({ id: s.sessions.id }).from(s.sessions).all()) silentTurns.delete(session.id)
      for (const pending of pendingApprovals.values()) expireApproval(pending)
    },

    async idle() {
      for (;;) {
        const pending = [...chains.values()]
        await Promise.all(pending)
        if ([...chains.values()].every((c, i) => c === pending[i]) && chains.size === pending.length) return
      }
    },

    notifyWorkActivated(sessionId) {
      pumpQueue(sessionId)
    },
  }
  return service
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function noticeCause(error: unknown) {
  return { message: errorMessage(error), ...(error instanceof VisError ? { code: error.code, data: error.details } : {}) }
}
