import { stopExecution } from './stop-execution'
import { accessSync, constants, existsSync, mkdirSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { newId, VisError } from '@vis/domain'
import { readNodes } from '@vis/canvas-core'
import type { GenerationService } from '@vis/generation'
import { METHODS } from '@vis/protocol'
import type { CanvasNodeKind, MethodParams, MethodResult, NodeView, SessionSummary, WorkChange, WorkItemView, WorkMessageFrom, WorkMessageView, WorkFailure } from '@vis/protocol'
import { and, appendEvent, asc, currentSeq, desc, eq, gt, inArray, isLegacyWorkspaceRequest, isNotNull, isNull, lt, ne, runIdempotent, spaceSchema as s, sql, type SpaceDb, type SpaceTx } from '@vis/storage'
import { readAgentOptions, readSessionSummary, validateAgentConfig, type AgentRuntimePort, type SessionService } from '@vis/workbench-core'

export type WorkServiceActor = { sessionId: string; workItemId: string }
type WorkActorSource = () => WorkServiceActor | undefined
export type WorkSlots = { reserve(spaceId: string, workItemId: string): boolean; release(spaceId: string, workItemId: string): void }
type WorkMethod = 'list' | 'get' | 'create' | 'reparent' | 'activate' | 'move' | 'reopen' | 'submitReview' | 'report' | 'reply' | 'review' | 'update' | 'markRead' | 'changes' | 'deletePlan'
export type WorkService = {
  [M in WorkMethod]: (params: MethodParams<`work.${M}`>, actor?: WorkServiceActor) => MethodResult<`work.${M}`>
} & {
  dispatch(params: MethodParams<'work.dispatch'>, getActor: WorkActorSource): Promise<MethodResult<'work.dispatch'>>
  agentOptions(params: MethodParams<'work.agentOptions'>): Promise<MethodResult<'work.agentOptions'>>
  setAgentConfig(params: MethodParams<'work.setAgentConfig'>, getActor: WorkActorSource): Promise<MethodResult<'work.setAgentConfig'>>
  delete(params: MethodParams<'work.delete'>, actor?: WorkServiceActor): Promise<MethodResult<'work.delete'>>
  /** Stage approved deletions in the approval transaction before any asynchronous stops. */
  prepareDelete(params: MethodParams<'work.delete'>): void
  isDeleting(workItemId: string): boolean
  recall(params: MethodParams<'work.recall'>, actor?: WorkServiceActor): Promise<MethodResult<'work.recall'>>
  inbox(spaceName?: string): MethodResult<'work.inbox'>
  activateQueued(workItemId: string): MethodResult<'work.activate'> | null
  queued(): { workItemId: string; title: string; waitingSince: number }[]
  notifySessionFailure(t: SpaceTx, failure: WorkFailure, key: string): void
  recoverRecalls(): Promise<void>
}

type WorkRow = typeof s.workItems.$inferSelect
type MessageRow = typeof s.workMessages.$inferSelect
type RecallPlan = MethodResult<'work.recall'> & { stops: { sessionId: string; turnId: string }[]; releasedIds: string[]; finished: boolean }
type DeletePlan = MethodResult<'work.delete'> & { stops: RecallPlan['stops']; finished: boolean; suppressParentDelivery?: boolean }
const NEEDS_REPLY = ['question', 'blocked', 'escalation'] as const
const ACTIVE_TURNS = ['running', 'waiting_user'] as const
const CANVAS_EVENTS = ['node.created', 'node.updated', 'node.deleted', 'slot.revised']
const TERMINAL_JOBS = ['succeeded', 'failed', 'cancelled', 'unknown']
const FAILURE_REASONS: Record<WorkFailure['reason'], string> = {
  agent_start_failed: 'Agent failed to start', ref_unresolvable: 'Message references could not be resolved',
  dispatch_rejected: 'Message delivery failed; retries stopped', dispatch_unknown: 'Agent receipt is unknown; queue paused',
  turn_failed: 'Agent turn failed', runtime_exited: 'Agent exited unexpectedly', runtime_restarted: 'Background restarted; turn interrupted',
  turn_silent: 'Agent may be stuck; it has not been stopped. Recall it or keep waiting',
  turn_unreported: 'The child ended its turn without reporting. Nothing was stopped. Reply to the child, recall it, or keep waiting.',
}

function isChildReport(message: MessageRow) {
  return message.from.kind === 'session' && ((NEEDS_REPLY as readonly string[]).includes(message.kind) || message.kind === 'done')
}

/** Card waiting summaries are plain text: strip Markdown markers and fold into one line. */
export function plainExcerpt(body: string, max = 80) {
  return body
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/(\*\*|__|~~)(.+?)\1/g, '$2')
    .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?=[^\w*]|$)/g, '$1$2')
    .replace(/`+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

/** Display names of related inbox nodes follow the review drawer title rules. */
export function nodeLabel(node: NodeView | undefined) {
  if (!node) return '已删除的节点'
  const text = (key: string) => { const content = node.slots.find(slot => slot.slotKey === key)?.content; return content?.type === 'text' ? content.body.split(/\r?\n/)[0]!.trim().slice(0, 40) : '' }
  if (node.kind === 'frame') return node.frame?.title || '框'
  if (node.kind === 'text') return text('main') || '空文本'
  const kind = node.kind === 'video' ? '视频' : node.kind === 'image' ? '图片' : '音频'
  return text('prompt') ? `${kind} · ${text('prompt')}` : kind
}

export function createWorkService(deps: {
  db: SpaceDb; spaceId: string; rootPath: string
  sessions: Pick<SessionService, 'stop'> & Partial<Pick<SessionService, 'notifyWorkActivated'>>; generation: Pick<GenerationService, 'cancel'>; slots: WorkSlots; now?: () => number
  assertAgent?: (kind: string) => void
  runtime?: Pick<AgentRuntimePort, 'agentOptions'>
  cancelSessionMedia?: (sessionId: string) => void | Promise<void>
}): WorkService {
  const { db, spaceId, rootPath, sessions, generation, slots } = deps
  const now = deps.now ?? Date.now
  const deleteRuns = new Map<string, Promise<void>>()
  const recallRuns = new Map<string, Promise<void>>()
  const changeCache = new Map<string, { seq: number; baselineSeq: number; sessionIds: string; result: MethodResult<'work.changes'> }>()

  function row(t: SpaceTx, id: string, includeArchived = false): WorkRow {
    const item = t.select().from(s.workItems).where(eq(s.workItems.id, id)).get()
    if (!item || (!includeArchived && item.archivedAt !== null)) throw VisError.of('not_found', 'work.not_found', { workItemId: id }, `Work item ${id} does not exist`)
    return item
  }

  function checkActor(actor?: WorkServiceActor, userOnly = false) {
    if (!actor) return
    if (userOnly) throw VisError.of('forbidden', 'work.user_only', {}, 'This operation is only available to users')
    const session = db.select().from(s.sessions).where(eq(s.sessions.id, actor.sessionId)).get()
    if (!session || session.archivedAt !== null || session.workItemId !== actor.workItemId) throw VisError.of('forbidden', 'work.invalid_session', {}, 'Invalid session identity')
  }

  function ownChild(item: WorkRow, actor?: WorkServiceActor) {
    if (actor && item.parentId !== actor.workItemId) throw VisError.of('forbidden', 'work.direct_child_required', {}, 'Only your own direct child work items can be operated on')
  }

  function recalling(t: SpaceTx, id: string) {
    const pending = t.select().from(s.idempotencyKeys).where(eq(s.idempotencyKeys.method, 'work.recall')).all()
      .some(key => { const plan = key.result as RecallPlan; return !plan.finished && plan.items.some(item => item.workItemId === id) })
    if (pending || isDeleting(id, t)) throw VisError.of('busy', 'work.recall_or_delete_in_progress', {}, 'This work item is being recalled or deleted; try again later')
  }

  function isDeleting(id: string, t: SpaceTx = db) {
    return t.select().from(s.idempotencyKeys).where(eq(s.idempotencyKeys.method, 'work.delete')).all()
      .some(key => { const plan = key.result as DeletePlan; return !plan.finished && plan.workItemIds.includes(id) })
  }

  function affected(t: SpaceTx, item: WorkRow) {
    return [item, ...t.select().from(s.workItems).where(and(eq(s.workItems.parentId, item.id), isNull(s.workItems.archivedAt))).all()]
  }

  function canRead(item: WorkRow, actor?: WorkServiceActor) {
    return !actor || item.id === actor.workItemId || item.parentId === actor.workItemId
  }

  function revision(item: WorkRow, expected?: number) {
    if (expected !== undefined && expected !== item.revision) throw VisError.of('revision_conflict', 'work.revision_conflict', {}, 'Work item has been modified; read it again', undefined, undefined, { expectedRevision: expected, currentRevision: item.revision })
  }

  function transition(item: WorkRow, allowed: WorkRow['status'][]) {
    if (!allowed.includes(item.status)) throw VisError.of('invalid_transition', 'work.invalid_transition', { status: item.status }, `Work item is currently ${item.status}`, undefined, undefined, { status: item.status })
  }

  function childrenDone(t: SpaceTx, item: WorkRow) {
    const incompleteChildren = t.select().from(s.workItems).where(and(eq(s.workItems.parentId, item.id), isNull(s.workItems.archivedAt))).all().filter(child => child.status !== 'done').map(child => child.id)
    if (incompleteChildren.length) throw VisError.of('invalid_transition', 'work.children_incomplete', {}, 'Not all child work items are complete', undefined, undefined, { status: item.status, incompleteChildren })
  }

  function messages(t: SpaceTx, workItemId: string) {
    return t.select().from(s.workMessages).where(eq(s.workMessages.workItemId, workItemId)).orderBy(asc(s.workMessages.createdAt), asc(s.workMessages.id)).all()
  }

  function messageView(message: MessageRow): WorkMessageView {
    const { id, targetSessionId: _, ...rest } = message
    return { messageId: id, ...rest }
  }

  function userMessage(message: MessageRow) {
    return message.kind === 'failure' || message.kind === 'done' || message.to === 'user' || (NEEDS_REPLY as readonly string[]).includes(message.kind)
  }

  function messageSeq(t: SpaceTx, id: string) {
    return t.select({ seq: s.events.seq }).from(s.events).where(and(eq(s.events.type, 'work.messageAdded'), eq(s.events.entityId, id))).get()?.seq ?? 0
  }

  function messageSeqs(t: SpaceTx, ids: string[], after: number) {
    if (!ids.length) return new Map<string, number>()
    return new Map(t.select({ id: s.events.entityId, seq: s.events.seq }).from(s.events)
      .where(and(gt(s.events.seq, after), eq(s.events.type, 'work.messageAdded'), inArray(s.events.entityId, ids))).all().map(event => [event.id, event.seq]))
  }

  function messageOrder(t: SpaceTx, id: string) {
    return t.select({ order: sql<number>`${s.workMessages}.rowid` }).from(s.workMessages).where(eq(s.workMessages.id, id)).get()?.order ?? 0
  }

  // Views resolve timestamp ties through primary-key lookups, never event-table scans.
  function unreportedWarning(t: SpaceTx, item: WorkRow, history: MessageRow[], sessionIds: string[]) {
    if (item.status !== 'in_progress' || !sessionIds.length) return null
    const notice = history.filter(message => message.from.kind === 'system' && message.from.failure?.reason === 'turn_unreported')
      .sort((a, b) => b.createdAt - a.createdAt || messageOrder(t, b.id) - messageOrder(t, a.id))[0]
    const failure = notice?.from.kind === 'system' ? notice.from.failure : undefined
    if (!notice || !failure || notice.createdAt < item.statusChangedAt) return null
    if (failure.detail && (JSON.parse(failure.detail) as { warningCleared?: boolean }).warningCleared) return null
    const reports = history.filter(message => isChildReport(message) && message.createdAt >= notice.createdAt)
    if (reports.some(report => report.createdAt > notice.createdAt || messageOrder(t, report.id) > messageOrder(t, notice.id))) return null
    const turnOrder = t.select({ order: sql<number>`${s.turns}.rowid` }).from(s.turns).where(eq(s.turns.id, failure.turnId)).get()?.order ?? 0
    const resumed = t.select({ id: s.turns.id }).from(s.turns).where(and(inArray(s.turns.sessionId, sessionIds), ne(s.turns.id, failure.turnId),
      sql`(${s.turns.startedAt} > ${notice.createdAt} or (${s.turns.startedAt} = ${notice.createdAt} and ${s.turns}.rowid > ${turnOrder}))`)).get()
    return resumed ? null : failure
  }

  function view(t: SpaceTx, id: string): WorkItemView {
    const item = row(t, id, true)
    const history = messages(t, id)
    const unresolved = history.filter(message => (NEEDS_REPLY as readonly string[]).includes(message.kind) && message.resolvedBy === null)
    const linked = t.select().from(s.sessions).where(eq(s.sessions.workItemId, id)).orderBy(asc(s.sessions.createdAt), asc(s.sessions.id)).all()
    const dayStart = new Date(now()); dayStart.setHours(0, 0, 0, 0)
    const sessionViews = linked.map(session => {
      const turns = t.select().from(s.turns).where(eq(s.turns.sessionId, session.id)).orderBy(desc(s.turns.startedAt)).all()
      const active = turns.find(turn => (ACTIVE_TURNS as readonly string[]).includes(turn.status))
      const jobs = t.select().from(s.generationJobs).where(eq(s.generationJobs.sessionId, session.id)).orderBy(desc(s.generationJobs.createdAt)).all()
      const job = jobs.find(job => !TERMINAL_JOBS.includes(job.status))
      const activity = t.select().from(s.transcriptEntries).where(eq(s.transcriptEntries.sessionId, session.id)).orderBy(desc(s.transcriptEntries.updatedAt)).get()
      const lastActivityAt = Math.max(session.createdAt, activity?.updatedAt ?? 0, ...turns.map(turn => turn.endedAt ?? turn.startedAt ?? 0), ...jobs.map(job => job.updatedAt))
      const tool = active ? t.select().from(s.transcriptEntries).where(and(eq(s.transcriptEntries.sessionId, session.id), eq(s.transcriptEntries.turnId, active.id), eq(s.transcriptEntries.kind, 'tool_call'))).orderBy(desc(s.transcriptEntries.updatedAt)).get()?.payload as { name?: unknown } | undefined : undefined
      const doing = job ? `正在生成${{ image: '图片', video: '视频', audio: '音频' }[job.kind]}` : unresolved.length ? '等待回复' : active ? active.status === 'waiting_user' ? '等待审批' : typeof tool?.name === 'string' ? `正在调用 ${tool.name}` : '正在处理' : null
      const summary = readSessionSummary(t, session.id)
      return { silentSince: summary.silentSince, agentConfig: summary.agentConfig, sessionId: session.id, agentKind: session.agentKind, title: session.title, activeTurnId: active?.id ?? null, doing, lastActivityAt, archived: session.archivedAt !== null }
    })
    const latestTurns = linked.map(session => t.select({ id: s.turns.id, status: s.turns.status, deliveryId: s.messages.workDeliveryId }).from(s.turns)
      .innerJoin(s.messages, eq(s.messages.id, s.turns.messageId)).where(eq(s.turns.sessionId, session.id))
      .orderBy(desc(s.messages.queueOrder), desc(s.turns.endedAt)).get())
    const failure = [...history].reverse().flatMap(message => {
      const failure = message.kind === 'failure' && message.from.kind === 'system' ? message.from.failure : undefined
      return failure && failure.reason !== 'turn_silent' && failure.reason !== 'turn_unreported' && latestTurns.some(turn => turn && (turn.id === failure.turnId || turn.deliveryId && message.id === `wmsg_failure_${item.id}_${turn.deliveryId}`) && (turn.status === 'failed' || turn.status === 'interrupted')) ? [failure] : []
    })[0] ?? null
    const failed = !!failure || latestTurns.some(turn => turn?.status === 'failed')
    const todayGenerations = linked.length ? t.select().from(s.generationJobs).where(and(inArray(s.generationJobs.sessionId, linked.map(session => session.id)), gt(s.generationJobs.createdAt, dayStart.getTime() - 1))).all().length : 0
    const changes = readChanges(t, item).changes
    return {
      workItemId: id, spaceId, parentId: item.parentId, childIds: t.select({ id: s.workItems.id }).from(s.workItems).where(and(eq(s.workItems.parentId, id), isNull(s.workItems.archivedAt))).all().map(child => child.id),
      title: item.title, brief: item.brief, status: item.status, pinned: item.pinned, reviewBy: item.reviewBy, workDir: item.workDir,
      createdBy: item.createdBy, revision: item.revision, activationSeq: item.activationSeq, waitingSlotSince: item.waitingSlotSince, pendingFeedback: item.pendingFeedback, reviewReportId: item.reviewReportId,
      failure: failure ?? unreportedWarning(t, item, history, linked.map(session => session.id)),
      activity: failure ? 'error' : item.status === 'todo' || item.status === 'done' ? 'idle' : unresolved.length ? 'waiting' : sessionViews.some(session => session.activeTurnId) ? 'active' : failed ? 'error' : 'idle', sessions: sessionViews,
      unreadCount: history.filter(message => userMessage(message) && message.readAt === null).length, unresolvedCount: unresolved.length,
      waitingOn: unresolved[0] ? { messageId: unresolved[0].id, kind: unresolved[0].kind as 'question' | 'blocked' | 'escalation', excerpt: plainExcerpt(unresolved[0].body) } : null,
      todayGenerations, changeCount: new Set(changes.map(change => change.nodeId)).size, lastChangeSeq: changes[0]?.lastSeq ?? null, statusChangedAt: item.statusChangedAt, createdAt: item.createdAt, archivedAt: item.archivedAt,
    }
  }

  function readChanges(t: SpaceTx, item: WorkRow): MethodResult<'work.changes'> {
    const baselineSeq = item.activationSeq
    if (baselineSeq === null) return { baselineSeq, changes: [] }
    const sessionIds = new Set(t.select({ id: s.sessions.id }).from(s.sessions).where(eq(s.sessions.workItemId, item.id)).all().map(session => session.id))
    const cacheable = t === db && !db.$client.inTransaction
    const seq = cacheable ? t.select({ seq: s.events.seq }).from(s.events).where(inArray(s.events.type, [...CANVAS_EVENTS, 'binding.stateChanged'])).orderBy(desc(s.events.seq)).get()?.seq ?? 0 : 0
    const linked = [...sessionIds].sort().join(',')
    const cached = changeCache.get(item.id)
    if (cacheable && cached?.seq === seq && cached.baselineSeq === baselineSeq && cached.sessionIds === linked) return cached.result
    const operations = new Map(t.select().from(s.operations).where(inArray(s.operations.actorSessionId, [...sessionIds])).all().map(operation => [operation.id, operation]))
    const generated = new Map(t.select({ operationId: s.deliveryBindings.deliveredOperationId, sessionId: s.generationJobs.sessionId }).from(s.deliveryBindings).innerJoin(s.generationJobs, eq(s.generationJobs.id, s.deliveryBindings.jobId)).where(inArray(s.generationJobs.sessionId, [...sessionIds])).all().map(binding => [binding.operationId, binding.sessionId]))
    type NodeState = { kind: CanvasNodeKind; layoutRevision: number; slots: Map<string, number> }
    const baseline = new Map<string, NodeState>(), latest = new Map<string, NodeState>()
    const touched = new Map<string, { node: boolean; slots: Set<string>; sessionId: string; lastSeq: number }>()
    function apply(state: Map<string, NodeState>, type: string, nodeId: string, payload: Record<string, unknown>) {
      if (type === 'node.deleted') state.delete(nodeId)
      else if (type === 'node.created' || type === 'node.updated') {
        const slots = (payload.slots ?? []) as { slotId: string; revision: number }[]
        state.set(nodeId, { kind: payload.kind as CanvasNodeKind, layoutRevision: Number(payload.layoutRevision), slots: new Map(slots.map(slot => [slot.slotId, slot.revision])) })
      } else if (type === 'slot.revised') state.get(nodeId)?.slots.set(String(payload.slotId), Number(payload.revision))
    }
    const events = t.select().from(s.events).where(inArray(s.events.type, CANVAS_EVENTS)).orderBy(asc(s.events.seq)).all()
    for (const event of events) {
      const payload = event.payload as Record<string, unknown>
      const nodeId = event.type === 'slot.revised' ? String(payload.nodeId) : event.entityId
      apply(latest, event.type, nodeId, payload)
      if (event.seq <= baselineSeq) { apply(baseline, event.type, nodeId, payload); continue }
      const operation = event.operationId ? operations.get(event.operationId) : undefined
      const sessionId = operation?.actorSessionId ?? (event.operationId ? generated.get(event.operationId) : undefined)
      if (!sessionId || !sessionIds.has(sessionId)) continue
      const target = touched.get(nodeId) ?? { node: false, slots: new Set<string>(), sessionId, lastSeq: event.seq }
      if (event.type === 'slot.revised') target.slots.add(event.entityId)
      else target.node = true
      target.sessionId = sessionId
      target.lastSeq = event.seq
      touched.set(nodeId, target)
    }
    const changes: WorkChange[] = []
    for (const [nodeId, touch] of touched) {
      const before = baseline.get(nodeId), after = latest.get(nodeId)
      if (!before && !after) continue
      const nodeKind = (after ?? before)!.kind
      const change = !before ? 'created' : !after ? 'deleted' : 'updated'
      const slotIds = !before ? [...after!.slots.keys()] : !after ? [...before.slots.keys()] : [...touch.slots]
      for (const slotId of slotIds) {
        const fromRevision = before?.slots.get(slotId) ?? null, toRevision = after?.slots.get(slotId) ?? null
        if (fromRevision !== toRevision) changes.push({ nodeId, nodeKind, slotId, change, fromRevision, toRevision, sessionId: touch.sessionId, lastSeq: touch.lastSeq })
      }
      if (touch.node && (change !== 'updated' ? slotIds.length === 0 : before!.layoutRevision !== after!.layoutRevision)) {
        changes.push({ nodeId, nodeKind, slotId: null, change, fromRevision: before?.layoutRevision ?? null, toRevision: after?.layoutRevision ?? null, sessionId: touch.sessionId, lastSeq: touch.lastSeq })
      }
    }
    const result = { baselineSeq, changes: changes.sort((a, b) => b.lastSeq - a.lastSeq) }
    if (cacheable) changeCache.set(item.id, { seq, baselineSeq, sessionIds: linked, result })
    return result
  }

  function emit(t: SpaceTx, id: string) {
    const stored = row(t, id, true)
    if (stored.status !== 'in_progress') {
      // Persist dismissal when leaving and re-entering progress share a millisecond.
      for (const notice of messages(t, id)) {
        if (notice.createdAt < stored.statusChangedAt || notice.from.kind !== 'system' || notice.from.failure?.reason !== 'turn_unreported') continue
        const detail = JSON.parse(notice.from.failure.detail!) as { warningCleared?: boolean }
        if (detail.warningCleared) continue
        t.update(s.workMessages).set({ from: { ...notice.from, failure: { ...notice.from.failure, detail: JSON.stringify({ ...detail, warningCleared: true }) } } }).where(eq(s.workMessages.id, notice.id)).run()
      }
    }
    const item = view(t, id)
    appendEvent(t, { type: 'work.itemChanged', entityType: 'work', entityId: id, payload: item }, now())
    return item
  }

  function addMessage(t: SpaceTx, input: Pick<MessageRow, 'workItemId' | 'kind' | 'from' | 'to' | 'body'> & Partial<Pick<MessageRow, 'refs' | 'replyTo' | 'targetSessionId'>>) {
    const message = t.insert(s.workMessages).values({ id: newId('workMessage', now()), ...input, createdAt: now() }).returning().get()
    appendEvent(t, { type: 'work.messageAdded', entityType: 'workMessage', entityId: message.id, payload: messageView(message) }, now())
    return message
  }

  function from(actor?: WorkServiceActor): WorkMessageFrom {
    return actor ? { kind: 'session', sessionId: actor.sessionId } : { kind: 'user' }
  }

  function replay<T>(method: string, params: { requestId: string }, actor: WorkServiceActor | undefined): { result: T } | null {
    if (!db.select().from(s.idempotencyKeys).where(eq(s.idempotencyKeys.requestId, params.requestId)).get()) return null
    return { result: runIdempotent<T>(db, { requestId: params.requestId, method: `work.${method}`, params: { ...params, actor } }, () => { throw new Error('Idempotency record has disappeared') }, now) }
  }

  function mutate<P extends { requestId: string }, T>(method: string, params: P, actor: WorkServiceActor | undefined, fn: (t: SpaceTx, reserved: string[], released: string[], actor: WorkServiceActor | undefined) => T, getActor: WorkActorSource = () => actor): T {
    const reserved: string[] = [], released: string[] = []
    let result: T
    try {
      result = runIdempotent(db, { requestId: params.requestId, method: `work.${method}`, params: { ...params, actor } }, t => {
        const currentActor = getActor()
        checkActor(currentActor)
        const ids = params as P & { workItemId?: string; parentId?: string }
        for (const id of new Set([ids.workItemId, ids.parentId, currentActor?.workItemId].filter((id): id is string => !!id))) recalling(t, id)
        return fn(t, reserved, released, currentActor)
      }, now)
    } catch (error) {
      for (const id of reserved) slots.release(spaceId, id)
      throw error
    }
    for (const id of released) slots.release(spaceId, id)
    for (const id of reserved) resumeChats(id)
    if (method !== 'delete') for (const message of db.select({ sessionId: s.workMessages.targetSessionId }).from(s.workMessages).where(and(isNull(s.workMessages.ackedAt), isNull(s.workMessages.deliveryId))).all()) {
      if (message.sessionId) sessions.notifyWorkActivated?.(message.sessionId)
    }
    return result
  }

  function resumeChats(workItemId: string) {
    const item = row(db, workItemId)
    if (item.status !== 'in_progress') return
    for (const session of db.select().from(s.sessions).where(and(eq(s.sessions.workItemId, workItemId), isNull(s.sessions.archivedAt))).all()) sessions.notifyWorkActivated?.(session.id)
  }

  function workDirectory(id: string, title: string, parent?: WorkRow, explicit?: string) {
    if (explicit !== undefined) {
      let valid = false
      try { valid = isAbsolute(explicit) && statSync(explicit).isDirectory(); if (valid) accessSync(explicit, constants.R_OK | constants.W_OK | constants.X_OK) } catch { valid = false }
      if (!valid) throw VisError.of('invalid_params', 'work.directory_invalid', {}, 'Working directory must be an existing absolute directory path')
      return explicit
    }
    const slug = title.toLowerCase().replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^[-.]+|[-.]+$/g, '') || id
    let path = join(parent?.workDir || rootPath, 'workspaces', slug)
    if (existsSync(path)) path += `-${id.slice(-8)}`
    return path
  }

  function mainSession(t: SpaceTx, workItemId: string) {
    return t.select().from(s.sessions).where(and(eq(s.sessions.workItemId, workItemId), isNull(s.sessions.archivedAt))).orderBy(asc(s.sessions.createdAt), asc(s.sessions.id)).get()
  }

  // Agents can recall and activate each other, so only the author's own actions restart the parent wake count.
  function resetUnreportedWakes(t: SpaceTx, workItemId: string) {
    t.update(s.workItems).set({ unreportedBaselineSeq: currentSeq(t) }).where(eq(s.workItems.id, workItemId)).run()
  }

  function unreportedTurn(t: SpaceTx, item: WorkRow) {
    if (!item.parentId || item.status !== 'in_progress' || item.archivedAt !== null || isDeleting(item.id, t)) return null
    const linked = t.select({ id: s.sessions.id, archivedAt: s.sessions.archivedAt }).from(s.sessions).where(eq(s.sessions.workItemId, item.id)).all()
    const sessionIds = linked.map(session => session.id)
    const live = linked.filter(session => session.archivedAt === null).map(session => session.id)
    if (t.select({ id: s.turns.id }).from(s.turns).where(and(inArray(s.turns.sessionId, live), inArray(s.turns.status, [...ACTIVE_TURNS]))).get()) return null
    const history = messages(t, item.id)
    const turns = t.select({
      id: s.turns.id, sessionId: s.turns.sessionId, status: s.turns.status, endedAt: s.turns.endedAt,
      deliveryId: s.messages.workDeliveryId, messageCreatedAt: s.messages.createdAt,
    }).from(s.turns).innerJoin(s.messages, eq(s.messages.id, s.turns.messageId))
      .where(inArray(s.turns.sessionId, sessionIds))
      .orderBy(asc(sql`coalesce(${s.turns.startedAt}, ${s.messages.submittedAt})`), asc(sql`${s.turns}.rowid`)).all()
    const rejectedTurns = new Set(history.flatMap(message => message.from.kind === 'system' && message.from.failure?.reason === 'dispatch_rejected' ? [message.from.failure.turnId] : []))
    const rejected = new Map<string, typeof turns[number]>()
    for (const turn of turns) {
      if (!turn.deliveryId) continue
      if (rejectedTurns.has(turn.id)) rejected.set(turn.deliveryId, turn)
      else rejected.delete(turn.deliveryId)
    }
    const drafts = t.select().from(s.messages).where(and(inArray(s.messages.sessionId, live), eq(s.messages.deliveryState, 'draft'))).all()
    if (drafts.some(draft => {
      const stopped = draft.workDeliveryId ? rejected.get(draft.workDeliveryId) : undefined
      if (!stopped) return true
      if (draft.createdAt !== stopped.endedAt) return draft.createdAt > (stopped.endedAt ?? 0)
      const entry = t.select({ seq: s.transcriptEntries.createdSeq }).from(s.transcriptEntries)
        .where(and(eq(s.transcriptEntries.sessionId, draft.sessionId), eq(s.transcriptEntries.itemId, `user_${draft.id}`))).get()
      const rejection = t.select({ seq: s.transcriptEntries.createdSeq }).from(s.transcriptEntries)
        .where(and(eq(s.transcriptEntries.sessionId, stopped.sessionId), eq(s.transcriptEntries.turnId, stopped.id), eq(s.transcriptEntries.kind, 'notice'),
          sql`json_extract(${s.transcriptEntries.payload}, '$.code') = 'dispatch_rejected'`)).get()
      return !!entry && !!rejection && entry.seq > rejection.seq
    })) return null
    const pending = (message: MessageRow) => message.deliveredAt === null && message.ackedAt === null && (!message.deliveryId || !rejected.has(message.deliveryId))
    if (history.some(message => message.to === 'child' && (message.targetSessionId === null || live.includes(message.targetSessionId)) && pending(message))) return null
    const inbound = t.select().from(s.workMessages).where(inArray(s.workMessages.targetSessionId, sessionIds)).all()
    if (inbound.some(message => live.includes(message.targetSessionId!) && pending(message))) return null
    const delivered = inbound.filter(message => message.deliveryId !== null && message.deliveredAt !== null)
      .sort((a, b) => b.deliveredAt! - a.deliveredAt! || (a.deliveryId === b.deliveryId ? 0 : messageSeq(t, b.id) - messageSeq(t, a.id)))
    const batch = delivered[0]
    if (!batch?.deliveryId || !delivered.some(message => message.deliveryId === batch.deliveryId && ['brief', 'reply', 'review_feedback'].includes(message.kind))) return null
    const batchIndex = turns.findLastIndex(turn => turn.deliveryId === batch.deliveryId)
    const batchTurn = turns[batchIndex]
    if (!batchTurn || batchTurn.status !== 'completed' || batchTurn.endedAt === null) return null
    const run = turns.slice(batchIndex)
    let endedAt = batchTurn.endedAt
    for (const turn of run.slice(1)) {
      if (turn.messageCreatedAt > endedAt) return null
      endedAt = Math.max(endedAt, turn.endedAt ?? 0)
    }
    const key = `unreported_${batch.deliveryId}`
    if (history.some(message => message.id === `wmsg_failure_${item.id}_${key}`)) return null
    const reports = history.filter(isChildReport)
    if (reports.some(report => report.createdAt > batch.deliveredAt!)) return null
    const tiedReports = reports.filter(report => report.createdAt === batch.deliveredAt)
    if (tiedReports.length) {
      // Only a real report tie needs the first running event, which precedes delivery.
      const deliveryStart = t.select({ seq: s.events.seq }).from(s.events)
        .innerJoin(s.turns, eq(s.turns.id, s.events.entityId)).innerJoin(s.messages, eq(s.messages.id, s.turns.messageId))
        .where(and(eq(s.events.type, 'turn.stateChanged'), eq(s.messages.workDeliveryId, batch.deliveryId), sql`json_extract(${s.events.payload}, '$.status') = 'running'`))
        .orderBy(asc(s.events.seq)).get()?.seq ?? 0
      if (tiedReports.some(report => messageSeq(t, report.id) > deliveryStart)) return null
    }
    // Only notices that reached a session count: the cap bounds parent wakes.
    const earlier = history.filter(message => message.from.kind === 'system' && message.from.failure?.reason === 'turn_unreported' && message.targetSessionId !== null)
    const baseline = item.unreportedBaselineSeq ?? 0
    const seqs = messageSeqs(t, [...reports, ...earlier].map(message => message.id), baseline)
    const resetSeq = Math.max(baseline, ...reports.map(report => seqs.get(report.id) ?? 0))
    const notices = earlier.filter(message => (seqs.get(message.id) ?? 0) > resetSeq).length
    const unfinishedJobs = t.select({ status: s.generationJobs.status }).from(s.generationJobs).where(inArray(s.generationJobs.sessionId, sessionIds)).all().filter(job => !TERMINAL_JOBS.includes(job.status)).length
    let reply = ''
    for (const turn of [...run].reverse()) {
      const assistant = t.select({ payload: s.transcriptEntries.payload }).from(s.transcriptEntries)
        .where(and(eq(s.transcriptEntries.sessionId, turn.sessionId), eq(s.transcriptEntries.turnId, turn.id), eq(s.transcriptEntries.kind, 'assistant_text')))
        .orderBy(desc(s.transcriptEntries.createdSeq)).all().map(entry => entry.payload as { text?: unknown })
        .find(payload => typeof payload.text === 'string' && payload.text.trim())
      if (typeof assistant?.text === 'string') {
        reply = Array.from(assistant.text).slice(-500).join('')
        break
      }
    }
    return { key, wakeParent: notices < 2, detail: JSON.stringify({ unfinishedJobs, reply }), unfinishedJobs, reply }
  }

  function linkedSession(t: SpaceTx, item: WorkRow, agentKind?: WorkRow['agentKind'], agentConfig: SessionSummary['agentConfig'] = { model: null, effort: null, serviceTier: null }) {
    let session = mainSession(t, item.id) ?? t.select().from(s.sessions).where(eq(s.sessions.workItemId, item.id)).orderBy(asc(s.sessions.createdAt), asc(s.sessions.id)).get()
    if (session) {
      deps.assertAgent?.(session.agentKind)
      t.update(s.sessions).set({ archivedAt: null, queuePaused: false }).where(eq(s.sessions.id, session.id)).run()
      return session.id
    }
    const kind = agentKind ?? item.agentKind
    if (!kind) throw VisError.of('invalid_params', 'work.agent_kind_required', {}, 'Agent kind is required for initial activation')
    deps.assertAgent?.(kind)
    session = t.insert(s.sessions).values({ id: newId('session', now()), workItemId: item.id, agentKind: kind, title: item.title, titleSource: 'user', workDir: item.workDir, agentModel: agentConfig.model, reasoningEffort: agentConfig.effort, serviceTier: agentConfig.serviceTier, createdAt: now() }).returning().get()
    appendEvent(t, { type: 'session.created', entityType: 'session', entityId: session.id, payload: readSessionSummary(t, session.id) }, now())
    return session.id
  }

  function start(t: SpaceTx, item: WorkRow, reserved: string[], agentKind?: WorkRow['agentKind'], keepBaseline = false) {
    const sessionId = linkedSession(t, item, agentKind)
    t.update(s.workMessages).set({ targetSessionId: sessionId }).where(and(
      inArray(s.workMessages.workItemId, t.select({ id: s.workItems.id }).from(s.workItems).where(and(eq(s.workItems.parentId, item.id), isNull(s.workItems.archivedAt)))),
      eq(s.workMessages.to, 'parent'), inArray(s.workMessages.kind, ['done', 'failure', ...NEEDS_REPLY]), isNull(s.workMessages.targetSessionId), isNull(s.workMessages.ackedAt),
    )).run()
    const acquired = slots.reserve(spaceId, item.id)
    if (acquired && !reserved.includes(item.id)) reserved.push(item.id)
    t.update(s.workItems).set({
      status: acquired ? 'in_progress' : 'todo', waitingSlotSince: acquired ? null : item.waitingSlotSince ?? now(),
      activationSeq: acquired && !keepBaseline ? currentSeq(t) : item.activationSeq,
      pendingFeedback: acquired ? false : item.pendingFeedback, reviewReportId: null, agentKind: agentKind ?? item.agentKind, revision: item.revision + 1,
      statusChangedAt: item.status === (acquired ? 'in_progress' : 'todo') ? item.statusChangedAt : now(), archivedAt: null,
    }).where(eq(s.workItems.id, item.id)).run()
    if (acquired) {
      if (!keepBaseline && item.brief) addMessage(t, { workItemId: item.id, kind: 'brief', from: { kind: 'system' }, to: 'child', targetSessionId: sessionId, body: item.brief })
      t.update(s.workMessages).set({ targetSessionId: sessionId }).where(and(eq(s.workMessages.workItemId, item.id), eq(s.workMessages.to, 'child'), isNull(s.workMessages.targetSessionId))).run()
    }
    return { item: emit(t, item.id), queued: !acquired }
  }

  function createItem(t: SpaceTx, params: MethodParams<'work.create'> | MethodParams<'work.dispatch'>, actor?: WorkServiceActor, parent?: WorkRow) {
    const id = newId('workItem', now()), at = now()
    const workDir = workDirectory(id, params.title, parent, 'workDir' in params ? params.workDir : undefined)
    t.insert(s.workItems).values({ id, parentId: parent?.id ?? null, title: params.title, brief: params.brief ?? '', workDir, createdBy: actor ? { kind: 'agent', sessionId: actor.sessionId } : { kind: 'user' }, agentKind: 'agentKind' in params ? params.agentKind : params.chat?.agentKind ?? null, reviewBy: 'reviewBy' in params ? params.reviewBy ?? 'user' : 'user', createdAt: at, statusChangedAt: at }).run()
    mkdirSync(workDir, { recursive: true })
    return row(t, id)
  }

  /** Users change status directly: bypass Agent reports and clear queuing and the current activation report. */
  function setStatus(t: SpaceTx, item: WorkRow, status: WorkRow['status']) {
    t.update(s.workItems).set({ status, waitingSlotSince: null, pendingFeedback: false, reviewReportId: null, revision: item.revision + 1, statusChangedAt: now() }).where(eq(s.workItems.id, item.id)).run()
    if (status === 'done') t.update(s.sessions).set({ archivedAt: now(), queuePaused: true }).where(and(eq(s.sessions.workItemId, item.id), isNull(s.sessions.archivedAt))).run()
    return emit(t, item.id)
  }

  function finishRecall(requestId: string, plan: RecallPlan): Promise<void> {
    const running = recallRuns.get(requestId)
    if (running) return running
    const run = completeRecall(requestId, plan).finally(() => recallRuns.delete(requestId))
    recallRuns.set(requestId, run)
    return run
  }

  async function completeRecall(requestId: string, plan: RecallPlan) {
    if (plan.finished) return
    for (const item of plan.items) {
      for (const session of db.select({ id: s.sessions.id }).from(s.sessions).where(eq(s.sessions.workItemId, item.workItemId)).all()) await deps.cancelSessionMedia?.(session.id)
    }
    for (const stop of plan.stops) {
      const active = db.select().from(s.turns).where(and(eq(s.turns.id, stop.turnId), inArray(s.turns.status, [...ACTIVE_TURNS]))).get()
      if (active) await sessions.stop({ requestId: `${requestId}:${stop.turnId}`, ...stop })
    }
    for (const cancelled of plan.cancelledJobs) {
      const job = db.select().from(s.generationJobs).where(eq(s.generationJobs.id, cancelled.jobId)).get()
      if (!job) continue
      if (!TERMINAL_JOBS.includes(job.status)) {
        const result = await generation.cancel({ sessionId: null, turnId: null, inputSnapshotId: null }, { requestId: `${requestId}:${job.id}`, jobId: job.id })
        cancelled.providerCancelled = result.providerCancelled ?? false
      } else cancelled.providerCancelled = job.providerCancelled ?? false
    }
    plan.finished = true
    db.update(s.idempotencyKeys).set({ result: plan }).where(eq(s.idempotencyKeys.requestId, requestId)).run()
    for (const id of plan.releasedIds) slots.release(spaceId, id)
  }

  function finishDelete(requestId: string, plan: DeletePlan): Promise<void> {
    const running = deleteRuns.get(requestId)
    if (running) return running
    const run = completeDelete(requestId, plan).finally(() => deleteRuns.delete(requestId))
    deleteRuns.set(requestId, run)
    return run
  }

  async function completeDelete(requestId: string, plan: DeletePlan) {
    if (plan.finished) {
      for (const id of plan.workItemIds) slots.release(spaceId, id)
      return
    }
    await stopExecution(db, sessions, generation, requestId, plan)
    const notifySessionId = db.transaction(t => {
      let notifySessionId: string | undefined
      const targets = plan.workItemIds.map(id => row(t, id))
      for (const target of targets) {
        const deleted = addMessage(t, { workItemId: target.id, kind: 'deleted', from: { kind: 'user' }, to: 'child', body: '工作项已删除；会话已归档，工作目录保留。' })
        t.update(s.workMessages).set({ resolvedBy: deleted.id }).where(and(eq(s.workMessages.workItemId, target.id), inArray(s.workMessages.kind, [...NEEDS_REPLY]), isNull(s.workMessages.resolvedBy))).run()
        t.update(s.sessions).set({ archivedAt: now(), queuePaused: true }).where(eq(s.sessions.workItemId, target.id)).run()
        t.update(s.workItems).set({ archivedAt: now(), waitingSlotSince: null, pendingFeedback: false, reviewReportId: null, revision: target.revision + 1 }).where(eq(s.workItems.id, target.id)).run()
      }
      for (const target of targets) emit(t, target.id)
      const parentId = targets[0]!.parentId
      if (parentId && !plan.workItemIds.includes(parentId)) {
        const parent = row(t, parentId)
        const parentSession = mainSession(t, parentId)
        if (parentSession) {
          addMessage(t, { workItemId: parentId, kind: 'deleted', from: { kind: 'user' }, to: 'parent', targetSessionId: plan.suppressParentDelivery ? null : parentSession.id, body: `用户删除了子工作项「${targets[0]!.title}」，不要再跟进。` })
          if (!plan.suppressParentDelivery) notifySessionId = parentSession.id
        }
        t.update(s.workItems).set({ revision: parent.revision + 1 }).where(eq(s.workItems.id, parentId)).run()
        emit(t, parentId)
      }
      plan.finished = true
      t.update(s.idempotencyKeys).set({ result: plan }).where(eq(s.idempotencyKeys.requestId, requestId)).run()
      return notifySessionId
    }, { behavior: 'immediate' })
    for (const id of plan.workItemIds) slots.release(spaceId, id)
    if (notifySessionId) sessions.notifyWorkActivated?.(notifySessionId)
  }

  function prepareDelete(params: MethodParams<'work.delete'>, actor?: WorkServiceActor, suppressParentDelivery = false, pending?: typeof s.idempotencyKeys.$inferSelect) {
    return mutate('delete', params, actor, (t): DeletePlan => {
      if (pending && pending.requestId !== params.requestId) return t.select().from(s.idempotencyKeys).where(eq(s.idempotencyKeys.requestId, pending.requestId)).get()!.result as DeletePlan
      const item = row(t, params.workItemId), targets = affected(t, item)
      if (item.parentId) recalling(t, item.parentId)
      const stops: DeletePlan['stops'] = [], cancelledJobs: DeletePlan['cancelledJobs'] = []
      for (const target of targets) {
        recalling(t, target.id)
        if (target.waitingSlotSince !== null) {
          t.update(s.workItems).set({ waitingSlotSince: null, revision: target.revision + 1 }).where(eq(s.workItems.id, target.id)).run()
          emit(t, target.id)
        }
        const linked = t.select().from(s.sessions).where(eq(s.sessions.workItemId, target.id)).all()
        for (const session of linked) {
          t.update(s.sessions).set({ queuePaused: true }).where(eq(s.sessions.id, session.id)).run()
          stops.push(...t.select().from(s.turns).where(and(eq(s.turns.sessionId, session.id), inArray(s.turns.status, [...ACTIVE_TURNS]))).all().map(turn => ({ sessionId: session.id, turnId: turn.id })))
          cancelledJobs.push(...t.select().from(s.generationJobs).where(eq(s.generationJobs.sessionId, session.id)).all().filter(job => !TERMINAL_JOBS.includes(job.status)).map(job => ({ jobId: job.id, providerCancelled: false })))
        }
      }
      return { workItemIds: targets.map(target => target.id), cancelledJobs, stops, finished: false, ...(suppressParentDelivery ? { suppressParentDelivery: true } : {}) }
    })
  }

  return {
    prepareDelete(params) { prepareDelete(params, undefined, true) },
    notifySessionFailure(t, failure, key) {
      const session = t.select().from(s.sessions).where(eq(s.sessions.id, failure.sessionId)).get()
      if (!session?.workItemId) return
      const item = row(t, session.workItemId, true)
      const unreported = failure.reason === 'turn_unreported' ? unreportedTurn(t, item) : null
      if (failure.reason === 'turn_unreported') {
        if (!unreported) return
        key = unreported.key
        failure = { ...failure, detail: unreported.detail }
      }
      if (failure.reason === 'turn_silent' && !item.parentId) return
      const id = `wmsg_failure_${item.id}_${key}`
      if (t.select().from(s.workMessages).where(eq(s.workMessages.id, id)).get()) return
      const parent = item.parentId ? t.select().from(s.workItems).where(eq(s.workItems.id, item.parentId)).get() : null
      const target = parent?.archivedAt === null && (!unreported || unreported.wakeParent) ? mainSession(t, parent.id) : null
      const message = t.insert(s.workMessages).values({ id, workItemId: item.id, kind: 'failure', from: { kind: 'system', failure },
        // start() retargets 'parent' messages without a session, which would deliver a stale notice long after the fact.
        to: parent && (!unreported || target) ? 'parent' : 'user', targetSessionId: target?.id ?? null,
        body: unreported
          ? `Work item “${item.title}”: ${FAILURE_REASONS.turn_unreported}${unreported.unfinishedJobs ? ` Unfinished generation jobs: ${unreported.unfinishedJobs}.` : ''}${unreported.reply ? `\nChild's last reply:\n${unreported.reply}` : ''}`
          : failure.reason === 'turn_silent'
          ? `Work item “${item.title}” has had no activity for ${failure.detail ?? '10'} minutes. ${FAILURE_REASONS.turn_silent}`
          : `Work item “${item.title}” failed: ${FAILURE_REASONS[failure.reason]}${failure.detail ? ` — ${failure.detail}` : ''}`, createdAt: now(),
      }).returning().get()
      appendEvent(t, { type: 'work.messageAdded', entityType: 'workMessage', entityId: id, payload: messageView(message) }, now())
      t.update(s.workItems).set({ revision: item.revision + 1 }).where(eq(s.workItems.id, item.id)).run()
      emit(t, item.id)
      if (target) queueMicrotask(() => sessions.notifyWorkActivated?.(target.id))
    },
    isDeleting,
    deletePlan(params, actor) {
      checkActor(actor, true)
      const item = row(db, params.workItemId), targets = affected(db, item)
      const ids = targets.map(target => target.id)
      const linked = db.select().from(s.sessions).where(inArray(s.sessions.workItemId, ids)).all().map(session => session.id)
      return {
        runningTurns: linked.length ? db.select().from(s.turns).where(and(inArray(s.turns.sessionId, linked), inArray(s.turns.status, [...ACTIVE_TURNS]))).all().length : 0,
        unfinishedJobs: linked.length ? db.select().from(s.generationJobs).where(inArray(s.generationJobs.sessionId, linked)).all().filter(job => !TERMINAL_JOBS.includes(job.status)).length : 0,
        childrenTotal: targets.length - 1, childrenInProgress: targets.slice(1).filter(target => target.status === 'in_progress').length,
        unresolvedMessages: db.select().from(s.workMessages).where(and(inArray(s.workMessages.workItemId, ids), inArray(s.workMessages.kind, [...NEEDS_REPLY]), isNull(s.workMessages.resolvedBy))).all().length,
        hasUnreviewedReport: targets.some(target => target.status === 'in_review' && target.reviewReportId !== null), queued: targets.some(target => target.waitingSlotSince !== null),
        workDir: item.workDir,
      }
    },
    async delete(params, actor) {
      checkActor(actor, true)
      const knownRequest = db.select().from(s.idempotencyKeys).where(eq(s.idempotencyKeys.requestId, params.requestId)).get()
      const pending = knownRequest ? undefined : db.select().from(s.idempotencyKeys).where(eq(s.idempotencyKeys.method, 'work.delete')).all().find(key => {
        const plan = key.result as DeletePlan
        return !plan.finished && plan.workItemIds[0] === params.workItemId
      })
      if (pending && pending.requestId !== params.requestId) await finishDelete(pending.requestId, pending.result as DeletePlan)
      const plan = prepareDelete(params, actor, false, pending)
      await finishDelete(params.requestId, plan)
      const completed = db.select().from(s.idempotencyKeys).where(eq(s.idempotencyKeys.requestId, params.requestId)).get()!.result as DeletePlan
      return { workItemIds: completed.workItemIds, cancelledJobs: completed.cancelledJobs }
    },
    list(params, actor) {
      checkActor(actor)
      if (actor && (params.spaceId !== undefined || params.scope === 'all')) throw VisError.of('forbidden', 'work.other_project_forbidden', {}, 'Agents cannot access other projects')
      if (params.parentId) row(db, params.parentId)
      const items = db.select().from(s.workItems).where(and(params.status ? eq(s.workItems.status, params.status) : undefined, params.parentId ? eq(s.workItems.parentId, params.parentId) : undefined, isNull(s.workItems.archivedAt))).orderBy(asc(s.workItems.createdAt)).all()
      return { items: items.filter(item => canRead(item, actor)).map(item => view(db, item.id)) }
    },
    get(params, actor) {
      checkActor(actor)
      const id = params.workItemId ?? actor?.workItemId
      if (!id) throw VisError.of('invalid_params', 'work.id_required', {}, 'Missing work item ID')
      if (!canRead(row(db, id), actor)) throw VisError.of('forbidden', 'work.read_forbidden', {}, 'Only your own work item and direct children can be read')
      if (actor && params.spaceId !== undefined) throw VisError.of('forbidden', 'work.other_project_forbidden', {}, 'Agents cannot access other projects')
      const item = view(db, id), limit = params.limit ?? 100
      const history = db.select().from(s.workMessages).where(and(eq(s.workMessages.workItemId, id), params.beforeCreatedAt !== undefined ? lt(s.workMessages.createdAt, params.beforeCreatedAt) : undefined)).orderBy(desc(s.workMessages.createdAt), desc(s.workMessages.id)).limit(limit + 1).all()
      const boundary = history[Math.min(limit, history.length) - 1]?.createdAt
      let page = history.slice(0, limit), hasMore = history.length > limit
      if (boundary !== undefined && history[limit]?.createdAt === boundary) {
        // Time cursors cannot distinguish messages in the same millisecond; limit is a soft target and the entire boundary-time group must be returned.
        const ties = db.select().from(s.workMessages).where(and(eq(s.workMessages.workItemId, id), eq(s.workMessages.createdAt, boundary))).orderBy(desc(s.workMessages.id)).all()
        page = [...history.filter(message => message.createdAt > boundary), ...ties]
        hasMore = !!db.select({ id: s.workMessages.id }).from(s.workMessages).where(and(eq(s.workMessages.workItemId, id), lt(s.workMessages.createdAt, boundary))).limit(1).get()
      }
      return { item, messages: page.reverse().map(messageView), hasMore }
    },
    create(params, actor) {
      checkActor(actor, true)
      return mutate('create', params, actor, (t, reserved) => {
        const item = createItem(t, params)
        return params.chat ? start(t, item, reserved, params.chat.agentKind) : { item: emit(t, item.id), queued: false }
      })
    },
    async agentOptions(params) {
      return { models: await readAgentOptions(deps.runtime ?? {}, params.agentKind) }
    },
    async setAgentConfig(params, getActor) {
      const actor = getActor()
      const previous = replay<MethodResult<'work.setAgentConfig'>>('setAgentConfig', params, actor)
      if (previous) return previous.result
      if (!actor) throw VisError.of('forbidden', 'work.agent_required', {}, 'Only a parent Agent can configure a child session')
      checkActor(actor)
      const target = (t: SpaceTx, caller: WorkServiceActor | undefined) => {
        if (!caller) throw VisError.of('forbidden', 'work.agent_required', {}, 'Only a parent Agent can configure a child session')
        checkActor(caller)
        ownChild(row(t, params.workItemId), caller)
        const session = mainSession(t, params.workItemId)
        if (!session) throw VisError.of('not_found', 'work.main_session_missing', {}, 'The work item has no unarchived session')
        return session
      }
      const session = target(db, actor)
      await validateAgentConfig(deps.runtime ?? {}, session.agentKind, params)
      return mutate('setAgentConfig', params, actor, (t, _reserved, _released, currentActor) => {
        if (target(t, currentActor).id !== session.id) throw VisError.of('busy', 'work.main_session_changed', {}, 'The main session changed; retry the request')
        const current = readSessionSummary(t, session.id)
        if (current.agentConfig.model !== params.model || current.agentConfig.effort !== params.effort || current.agentConfig.serviceTier !== params.serviceTier) {
          t.update(s.sessions).set({ agentModel: params.model, reasoningEffort: params.effort, serviceTier: params.serviceTier }).where(eq(s.sessions.id, session.id)).run()
          appendEvent(t, { type: 'session.updated', entityType: 'session', entityId: session.id, payload: readSessionSummary(t, session.id) }, now())
          t.update(s.workItems).set({ revision: row(t, params.workItemId).revision + 1 }).where(eq(s.workItems.id, params.workItemId)).run()
          emit(t, params.workItemId)
        }
        return readSessionSummary(t, session.id)
      }, getActor)
    },
    async dispatch(params, getActor) {
      params = { ...params, agentConfig: METHODS['work.dispatch'].params.shape.agentConfig.parse(params.agentConfig) }
      const actor = getActor()
      const previous = replay<MethodResult<'work.dispatch'>>('dispatch', params, actor)
      if (previous) return previous.result
      checkActor(actor)
      const dispatchParent = (t: SpaceTx, caller: WorkServiceActor | undefined) => {
        checkActor(caller)
        const parentId = caller?.workItemId ?? params.parentId
        if (!parentId || (caller && params.parentId !== undefined && params.parentId !== parentId)) throw VisError.of('forbidden', 'work.dispatch_parent_required', {}, 'Dispatch must be under the current work item')
        const parent = row(t, parentId)
        if (parent.parentId !== null) throw VisError.of('forbidden', 'work.dispatch_root_required', {}, 'Child workspaces cannot dispatch again; report to the parent')
        if (parent.status === 'done' || parent.status === 'in_review') transition(parent, ['todo', 'in_progress'])
        return parent
      }
      dispatchParent(db, actor)
      if (params.agentConfig) await validateAgentConfig(deps.runtime ?? {}, params.agentKind, params.agentConfig)
      return mutate('dispatch', params, actor, (t, reserved, _released, currentActor) => {
        const parent = dispatchParent(t, currentActor)
        const item = createItem(t, params, currentActor, parent)
        linkedSession(t, item, params.agentKind, params.agentConfig)
        t.update(s.workItems).set({ revision: parent.revision + 1 }).where(eq(s.workItems.id, parent.id)).run()
        emit(t, parent.id)
        const result = params.activate === false ? { item: emit(t, item.id), queued: false } : start(t, item, reserved, params.agentKind)
        return result
      }, getActor)
    },
    reparent(params, actor) {
      checkActor(actor, true)
      return mutate('reparent', params, actor, t => {
        const item = row(t, params.workItemId)
        if (params.parentId === item.id) throw VisError.of('invalid_params', 'work.reparent_self', {}, 'Cannot move a work item under itself')
        if (t.select({ id: s.workItems.id }).from(s.workItems).where(eq(s.workItems.parentId, item.id)).get()) throw VisError.of('invalid_params', 'work.reparent_has_children', {}, 'It still has children')
        if (params.parentId !== null) {
          const parent = t.select().from(s.workItems).where(eq(s.workItems.id, params.parentId)).get()
          if (!parent || parent.archivedAt !== null) throw VisError.of('invalid_params', 'work.reparent_invalid_parent', {}, 'Parent work item must be an unarchived root work item in the same project')
          if (parent.parentId !== null) throw VisError.of('invalid_params', 'work.reparent_root_required', {}, 'Can only move under a root work item')
        }
        const oldParentId = item.parentId
        if (oldParentId === params.parentId) return { item: view(t, item.id), oldParentId }
        t.update(s.workItems).set({ parentId: params.parentId, revision: item.revision + 1 }).where(eq(s.workItems.id, item.id)).run()
        const pending = and(eq(s.workMessages.workItemId, item.id), eq(s.workMessages.to, 'parent'), inArray(s.workMessages.kind, ['done', 'failure', ...NEEDS_REPLY]), isNull(s.workMessages.ackedAt))
        const batches = new Set(t.select({ deliveryId: s.workMessages.deliveryId }).from(s.workMessages).where(pending).all().flatMap(message => message.deliveryId ? [message.deliveryId] : []))
        // Preserve records already shown in the old session; clear unacknowledged batches so the new parent can claim them again.
        t.update(s.workMessages).set({ targetSessionId: params.parentId ? mainSession(t, params.parentId)?.id ?? null : null, deliveryId: null, deliveredAt: null, redelivered: false }).where(pending).run()
        for (const deliveryId of batches) {
          const draft = t.select({ id: s.messages.id }).from(s.messages).where(and(eq(s.messages.workDeliveryId, deliveryId), eq(s.messages.deliveryState, 'draft'))).get()
          // Retry draft bodies are frozen; withdraw the entire draft and requeue other reports in the same batch.
          if (draft) t.update(s.workMessages).set({ deliveryId: null, deliveredAt: null, redelivered: false }).where(and(eq(s.workMessages.deliveryId, deliveryId), isNull(s.workMessages.ackedAt))).run()
          const remaining = t.select({ id: s.workMessages.id }).from(s.workMessages).where(eq(s.workMessages.deliveryId, deliveryId)).get()
          const stale = t.select({ id: s.messages.id }).from(s.messages).where(and(eq(s.messages.workDeliveryId, deliveryId), inArray(s.messages.deliveryState, draft || !remaining ? ['draft', 'unknown', 'rejected'] : ['draft']))).all()
          for (const message of stale) {
            t.update(s.messages).set({ deliveryState: 'withdrawn' }).where(eq(s.messages.id, message.id)).run()
            appendEvent(t, { type: 'message.stateChanged', entityType: 'message', entityId: message.id, payload: { messageId: message.id, deliveryState: 'withdrawn' } }, now())
          }
        }
        for (const parentId of [oldParentId, params.parentId]) {
          if (!parentId) continue
          const parent = row(t, parentId)
          t.update(s.workItems).set({ revision: parent.revision + 1 }).where(eq(s.workItems.id, parentId)).run()
          emit(t, parentId)
        }
        return { item: emit(t, item.id), oldParentId }
      })
    },
    activate(params, actor) {
      checkActor(actor)
      return mutate('activate', params, actor, (t, reserved) => {
        const item = row(t, params.workItemId); ownChild(item, actor); revision(item, params.expectedRevision); transition(item, ['todo'])
        if (!actor) resetUnreportedWakes(t, item.id)
        return start(t, item, reserved, params.agentKind, item.pendingFeedback)
      })
    },
    // Runs on every event flush, so it must not build full views: that blocked the event loop for hundreds of milliseconds.
    queued() {
      return db.select({ workItemId: s.workItems.id, title: s.workItems.title, waitingSince: s.workItems.waitingSlotSince }).from(s.workItems)
        .where(and(isNotNull(s.workItems.waitingSlotSince), isNull(s.workItems.archivedAt))).all()
        .map(item => ({ ...item, waitingSince: item.waitingSince! }))
    },
    activateQueued(id) {
      const result = db.transaction(t => {
        const item = row(t, id)
        if (item.status !== 'todo' || item.waitingSlotSince === null) return null
        recalling(t, id)
        if (!slots.reserve(spaceId, id)) return { item: view(t, id), queued: true }
        const reserved: string[] = [id]
        try { return start(t, item, reserved, undefined, item.pendingFeedback) } catch (error) { for (const id of reserved) slots.release(spaceId, id); throw error }
      }, { behavior: 'immediate' })
      if (result && !result.queued) resumeChats(id)
      return result
    },
    async recall(params, actor) {
      checkActor(actor)
      const plan = mutate('recall', params, actor, (t): RecallPlan => {
        const item = row(t, params.workItemId); ownChild(item, actor); revision(item, params.expectedRevision)
        if (item.status === 'todo' && item.waitingSlotSince !== null) {
          t.update(s.workItems).set({ waitingSlotSince: null, revision: item.revision + 1 }).where(eq(s.workItems.id, item.id)).run()
          return { items: [emit(t, item.id)], cancelledJobs: [], stops: [], releasedIds: [], finished: true }
        }
        transition(item, ['in_progress', 'in_review'])
        const targets = affected(t, item).filter(target => target.status !== 'done')
        const stops: RecallPlan['stops'] = [], cancelledJobs: RecallPlan['cancelledJobs'] = [], releasedIds: string[] = []
        for (const target of targets) {
          recalling(t, target.id)
          if (!actor) resetUnreportedWakes(t, target.id)
          const linked = t.select().from(s.sessions).where(eq(s.sessions.workItemId, target.id)).all()
          for (const session of linked) {
            t.update(s.sessions).set({ queuePaused: true }).where(eq(s.sessions.id, session.id)).run()
            const active = t.select().from(s.turns).where(and(eq(s.turns.sessionId, session.id), inArray(s.turns.status, [...ACTIVE_TURNS]))).get()
            if (active) stops.push({ sessionId: session.id, turnId: active.id })
            const jobs = t.select().from(s.generationJobs).where(eq(s.generationJobs.sessionId, session.id)).all().filter(job => !TERMINAL_JOBS.includes(job.status))
            cancelledJobs.push(...jobs.map(job => ({ jobId: job.id, providerCancelled: false })))
          }
          const recall = addMessage(t, { workItemId: target.id, kind: 'recall', from: from(actor), to: 'child', targetSessionId: mainSession(t, target.id)?.id ?? null, body: '工作项已回收；产物和历史保留。' })
          t.update(s.workMessages).set({ resolvedBy: recall.id }).where(and(eq(s.workMessages.workItemId, target.id), inArray(s.workMessages.kind, [...NEEDS_REPLY]), isNull(s.workMessages.resolvedBy))).run()
          t.update(s.workItems).set({ status: 'todo', waitingSlotSince: null, pendingFeedback: false, reviewReportId: null, revision: target.revision + 1, statusChangedAt: target.status === 'todo' ? target.statusChangedAt : now() }).where(eq(s.workItems.id, target.id)).run()
          if (target.status === 'in_progress') releasedIds.push(target.id)
        }
        return { items: targets.map(target => emit(t, target.id)), cancelledJobs, stops, releasedIds, finished: false }
      })
      await finishRecall(params.requestId, plan)
      const completed = db.select().from(s.idempotencyKeys).where(eq(s.idempotencyKeys.requestId, params.requestId)).get()!.result as RecallPlan
      return { items: isLegacyWorkspaceRequest(db, params.requestId) ? completed.items.map(item => view(db, item.workItemId)) : completed.items, cancelledJobs: completed.cancelledJobs }
    },
    async recoverRecalls() {
      for (const key of db.select().from(s.idempotencyKeys).where(eq(s.idempotencyKeys.method, 'work.recall')).all()) await finishRecall(key.requestId, key.result as RecallPlan)
      for (const key of db.select().from(s.idempotencyKeys).where(eq(s.idempotencyKeys.method, 'work.delete')).all()) {
        const plan = key.result as DeletePlan
        // Approval recovery starts its targets independently and reports individual failures in the session.
        if (!plan.suppressParentDelivery) await finishDelete(key.requestId, plan)
      }
    },
    // Board dragging changes status only: it neither interrupts active turns or generation nor cascades to children; the UI warns that work is still running.
    move(params) {
      return mutate('move', params, undefined, (t, reserved, released) => {
        const item = row(t, params.workItemId); revision(item, params.expectedRevision)
        const to = params.status, fromStatus = item.status
        if (to === fromStatus) return { item: view(t, item.id), queued: false }
        if (to === 'in_progress') {
          resetUnreportedWakes(t, item.id)
          const linked = mainSession(t, item.id) ?? t.select().from(s.sessions).where(eq(s.sessions.workItemId, item.id)).get()
          const kind = linked?.agentKind ?? params.agentKind ?? item.agentKind
          try { if (kind) deps.assertAgent?.(kind) }
          catch (error) {
            if (!(error instanceof VisError) || error.details?.reason !== 'session.agent_unconfigured') throw error
            t.update(s.sessions).set({ queuePaused: true }).where(eq(s.sessions.workItemId, item.id)).run()
            return { item: setStatus(t, item, to), queued: false }
          }
          // Treat todo as activation; moving back from review preserves the review baseline and sends no message, so the Agent waits for the user; treat done as reopening.
          // Cards that have never had a session (e.g. dragged straight from todo to done) require agentKind when entering from any column.
          return fromStatus === 'todo' ? start(t, item, reserved, params.agentKind, item.pendingFeedback)
            : fromStatus === 'in_review' ? start(t, { ...item, pendingFeedback: true }, reserved, params.agentKind, true)
              : start(t, { ...item, pendingFeedback: false, activationSeq: currentSeq(t) }, reserved, params.agentKind)
        }
        if (fromStatus === 'in_progress') {
          // Leaving in_progress releases slots: pause all session queues, finish the current turn without starting another, and resume on reactivation.
          released.push(item.id)
          t.update(s.sessions).set({ queuePaused: true }).where(and(eq(s.sessions.workItemId, item.id), isNull(s.sessions.archivedAt))).run()
        }
        return { item: setStatus(t, item, to), queued: false }
      })
    },
    reopen(params, actor) {
      checkActor(actor, true)
      return mutate('reopen', params, actor, (t, reserved) => {
        const item = row(t, params.workItemId); revision(item, params.expectedRevision)
        resetUnreportedWakes(t, item.id)
        if (params.resumeSessionId) {
          const session = t.select().from(s.sessions).where(and(eq(s.sessions.id, params.resumeSessionId), eq(s.sessions.workItemId, item.id))).get()
          const draft = session && t.select().from(s.messages).where(and(eq(s.messages.sessionId, session.id), eq(s.messages.deliveryState, 'draft'), isNull(s.messages.workDeliveryId))).get()
          if (!session || !draft) throw VisError.of('invalid_params', 'work.queued_message_required', {}, 'The session must belong to this work item and have an unsent user message')
          t.update(s.sessions).set({ archivedAt: null, queuePaused: false }).where(eq(s.sessions.id, session.id)).run()
        } else transition(item, ['done'])
        if (params.note) addMessage(t, { workItemId: item.id, kind: 'review_feedback', from: from(actor), to: 'child', targetSessionId: mainSession(t, item.id)?.id ?? null, body: params.note })
        const result = start(t, { ...item, pendingFeedback: !!params.note, activationSeq: currentSeq(t) }, reserved, undefined, item.status === 'in_progress')
        return result
      })
    },
    submitReview(params, actor) {
      checkActor(actor, true)
      return mutate('submitReview', params, actor, (t, _, released) => {
        // Users judge completion themselves; child work items need not finish first.
        const item = row(t, params.workItemId); revision(item, params.expectedRevision); transition(item, ['in_progress'])
        t.update(s.workItems).set({ status: 'in_review', reviewReportId: null, revision: item.revision + 1, statusChangedAt: now() }).where(eq(s.workItems.id, item.id)).run()
        released.push(item.id)
        return emit(t, item.id)
      })
    },
    report(params, actor) {
      checkActor(actor)
      if (!actor) throw VisError.of('forbidden', 'work.report_session_required', {}, 'Only workspace sessions can report work')
      return mutate('report', params, actor, (t, _, released) => {
        const item = row(t, actor.workItemId)
        if (!item.parentId) throw VisError.of('forbidden', 'work.root_report_forbidden', {}, 'Root workspaces should reply directly to the user')
        transition(item, ['in_progress'])
        if (params.kind === 'done') childrenDone(t, item)
        const parentSession = mainSession(t, item.parentId)
        const working = readChanges(t, item).changes.flatMap(change => {
          const node = t.select({ kind: s.nodes.kind, purpose: s.nodes.purpose, deletedAt: s.nodes.deletedAt }).from(s.nodes).where(eq(s.nodes.id, change.nodeId)).get()
          return node?.kind === 'text' && node.purpose === 'working' && node.deletedAt === null ? [change.nodeId] : []
        })
        const refs = working.length ? { ...params.refs, nodeIds: [...new Set([...(params.refs?.nodeIds ?? []), ...working])] } : params.refs ?? {}
        const message = addMessage(t, { workItemId: item.id, kind: params.kind, from: from(actor), to: 'parent', targetSessionId: parentSession?.id ?? null, body: params.body, refs })
        t.update(s.workItems).set({ revision: item.revision + 1, ...(params.kind === 'done' ? { status: 'in_review', reviewReportId: message.id, statusChangedAt: now() } : {}) }).where(eq(s.workItems.id, item.id)).run()
        if (params.kind === 'done') released.push(item.id)
        return { messageId: message.id, item: emit(t, item.id) }
      })
    },
    reply(params, actor) {
      checkActor(actor)
      return mutate('reply', params, actor, t => {
        const item = row(t, params.workItemId, true); ownChild(item, actor)
        const original = params.replyTo ? t.select().from(s.workMessages).where(and(eq(s.workMessages.id, params.replyTo), eq(s.workMessages.workItemId, item.id))).get() : undefined
        if (params.replyTo && !original) throw VisError.of('not_found', 'work.reply_not_found', {}, 'Message to reply to does not exist')
        if (original && !(NEEDS_REPLY as readonly string[]).includes(original.kind)) throw VisError.of('invalid_params', 'work.reply_kind_invalid', {}, 'Only question, blocked or escalation messages can be replied to')
        if (original?.resolvedBy) {
          const resolution = t.select().from(s.workMessages).where(eq(s.workMessages.id, original.resolvedBy)).get()!
          throw VisError.of('already_resolved', 'work.message_resolved', {}, 'This message has been resolved', undefined, undefined, { resolution: messageView(resolution) })
        }
        row(t, item.id)
        const childSession = mainSession(t, item.id)
        const message = addMessage(t, { workItemId: item.id, kind: 'reply', from: from(actor), to: 'child', targetSessionId: childSession?.id ?? null, body: params.body, refs: params.refs ?? {}, replyTo: original?.id ?? null })
        if (original) t.update(s.workMessages).set({ resolvedBy: message.id }).where(eq(s.workMessages.id, original.id)).run()
        t.update(s.workItems).set({ revision: item.revision + 1 }).where(eq(s.workItems.id, item.id)).run()
        emit(t, item.id)
        return { messageId: message.id }
      })
    },
    review(params, actor) {
      checkActor(actor)
      return mutate('review', params, actor, (t, reserved) => {
        const item = row(t, params.workItemId); ownChild(item, actor); revision(item, params.expectedRevision); transition(item, ['in_review'])
        if (actor && item.reviewBy !== 'parent') throw VisError.of('forbidden', 'work.user_review_required', {}, 'This work item is reviewed by the user')
        if (params.decision === 'approve') {
          if (actor) childrenDone(t, item)
          return { item: setStatus(t, item, 'done'), queued: false }
        }
        if (actor && !params.feedback) throw VisError.of('invalid_params', 'work.feedback_required', {}, 'Rejection requires feedback')
        if (!actor) resetUnreportedWakes(t, item.id)
        // Without user feedback, only change status and do not notify the Agent.
        if (params.feedback) addMessage(t, { workItemId: item.id, kind: 'review_feedback', from: from(actor), to: 'child', targetSessionId: mainSession(t, item.id)?.id ?? null, body: params.feedback })
        return start(t, { ...item, pendingFeedback: true }, reserved, params.agentKind, true)
      })
    },
    update(params, actor) {
      checkActor(actor, true)
      return mutate('update', params, actor, t => {
        const item = row(t, params.workItemId); revision(item, params.expectedRevision)
        t.update(s.workItems).set({ title: params.title ?? item.title, brief: params.brief ?? item.brief, pinned: params.pinned ?? item.pinned, reviewBy: params.reviewBy ?? item.reviewBy, waitingSlotSince: null, revision: item.revision + 1 }).where(eq(s.workItems.id, item.id)).run()
        return emit(t, item.id)
      })
    },
    markRead(params, actor) {
      checkActor(actor, true)
      return db.transaction(t => {
        row(t, params.workItemId)
        recalling(t, params.workItemId)
        const unread = messages(t, params.workItemId).filter(message => userMessage(message) && message.readAt === null)
        if (unread.length) {
          t.update(s.workMessages).set({ readAt: now() }).where(inArray(s.workMessages.id, unread.map(message => message.id))).run()
          t.update(s.workItems).set({ revision: row(t, params.workItemId).revision + 1 }).where(eq(s.workItems.id, params.workItemId)).run()
          emit(t, params.workItemId)
        }
        return { marked: unread.length }
      }, { behavior: 'immediate' })
    },
    changes(params, actor) {
      checkActor(actor, true)
      return readChanges(db, row(db, params.workItemId))
    },
    inbox(spaceName = '') {
      const items = db.select().from(s.workItems).where(isNull(s.workItems.archivedAt)).orderBy(asc(s.workItems.createdAt)).all().flatMap(item => {
        const history = messages(db, item.id).filter(message => userMessage(message) && (message.readAt === null || ((NEEDS_REPLY as readonly string[]).includes(message.kind) && message.resolvedBy === null)))
        if (!history.length) return []
        const ids = [...new Set(history.flatMap(message => message.refs.nodeIds ?? []))]
        const nodes = new Map(ids.length ? readNodes(db, ids).map(node => [node.nodeId, node]) : [])
        return [{ workItemId: item.id, title: item.title, status: item.status, parentTitle: item.parentId ? row(db, item.parentId, true).title : null, messages: history.map(messageView), nodeLabels: Object.fromEntries(ids.map(id => [id, nodeLabel(nodes.get(id))])) }]
      })
      const history = items.flatMap(item => item.messages), unread = history.filter(message => message.readAt === null).length, unresolved = history.filter(message => (NEEDS_REPLY as readonly string[]).includes(message.kind) && message.resolvedBy === null).length
      return { groups: items.length ? [{ spaceId, spaceName, items }] : [], counts: { unread, unresolved, bySpace: [{ spaceId, unread, unresolved }] } }
    },
  }
}
