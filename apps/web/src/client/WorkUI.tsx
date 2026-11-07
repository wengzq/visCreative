import type { MethodResult, WorkChange, WorkInboxGroup, WorkItemView, WorkMessageView, WorkSessionView, WorkStatus } from '@vis/protocol'
import type { AgentKind } from '@vis/protocol'
import { AgentChoiceDialog, DeleteWorkDialog, InboxPopover, NewTodoDialog, RejectDialog, SlotsPopover, WorkBoard, WorkStatusDropBar, actionLabels, runningNotice, statusLabels, type DropResult, type WorkCardAction, type WorkTreeDrag, type WorkTreeProps } from '@vis/workbench-ui'
import { useEffect, useRef, useState } from 'react'
import { RunningIcon, describeError, useFormat, useLocale, useMessages } from '@vis/ui-kit'
import type { Notice } from './actions'
import { RpcError } from './rpc'
import { type SpaceConnection, type SpaceView } from './space'
import { changedThumbnails, WorkReview } from './WorkReview'
import { transitionWorkItem, updateWorkItem } from './work'
import { workMessages } from './messages'

const rid = () => `web-${crypto.randomUUID()}`
const target = (item: WorkItemView) => ({ spaceId: item.spaceId, workItemId: item.workItemId })

export function useWorkUI({ conn, view, notify, openSession, closeSession, focusNode, locateChanges, openSettings, activeSessionId }: {
  conn: SpaceConnection
  activeSessionId: string | null
  view: SpaceView
  notify(notice: Omit<Notice, 'id'>): void
  openSession(sessionId: string): void
  closeSession(): void
  focusNode(nodeId: string): void
  locateChanges(workItemId: string): Promise<void>
  openSettings(): void
}) {
  const { locale } = useLocale()
  const t = useMessages(workMessages)
  const format = useFormat()
  const labels: Record<string, string> = { ...actionLabels(locale), update: t.workUpdate, move: t.workMove }
  const statuses = statusLabels(locale)
  const navigation = useRef(0)
  const [mainView, setMainView] = useState<'canvas' | 'board'>(() => {
    try { return localStorage.getItem('vis.main.view') === 'board' ? 'board' : 'canvas' } catch { return 'canvas' }
  })
  const [scope, setScope] = useState<'space' | 'all'>('space')
  const [inboxFocus, setInboxFocus] = useState<string>()
  const [inboxOpen, setInboxOpen] = useState(false)
  const [inbox, setInbox] = useState<WorkInboxGroup[]>([])
  const [inboxLoading, setInboxLoading] = useState(false)
  const [slotsOpen, setSlotsOpen] = useState(false)
  // choose: select an agent before a card without prior sessions first enters in-progress (activation, dragging, or rejection)
  const [dialog, setDialog] = useState<{ action: 'reject'; item: WorkItemView } | { action: 'choose'; item: WorkItemView; run(agentKind: AgentKind): Promise<unknown> } | null>(null)
  const [newTodo, setNewTodo] = useState(false)
  const [deleting, setDeleting] = useState<WorkItemView | null>(null)
  const [treeDrag, setTreeDrag] = useState<WorkTreeDrag | null>(null)
  const pendingChanges = useRef(new Map<string, { revision: number; promise: Promise<WorkChange[]> }>())
  const [changes, setChanges] = useState<Record<string, { revision: number; changes: WorkChange[] }>>({})
  const [review, setReview] = useState<WorkItemView | null>(null)
  const items = [...view.work.items.values()].map(item => ({ ...item, spaceName: view.projects.find(project => project.spaceId === item.spaceId)?.name ?? item.spaceName ?? item.spaceId }))
  const currentItems = items.filter(item => item.spaceId === view.space?.spaceId)
  const selectedId = currentItems.find(item => item.sessions.some(session => session.sessionId === activeSessionId))?.workItemId
  const slots = view.work.slots
  const counts = view.work.inboxCounts
  const fail = (error: unknown) => notify({ kind: 'error', text: describeError(error, locale) })

  useEffect(() => {
    if (review && view.work.deletedIds.has(review.workItemId)) setReview(null)
    const activeWorkItemId = activeSessionId ? view.state.sessions.get(activeSessionId)?.workItemId : null
    if (activeWorkItemId && view.work.deletedIds.has(activeWorkItemId)) closeSession()
  }, [view.work.deletedIds, review, selectedId, activeSessionId, view.state.sessions])

  useEffect(() => {
    try { localStorage.setItem('vis.main.view', mainView) } catch { /* Preference storage unavailable */ }
  }, [mainView])
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'b') {
        event.preventDefault()
        setMainView(value => value === 'canvas' ? 'board' : 'canvas')
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [])
  useEffect(() => {
    if (!view.ready || view.status !== 'open' || (mainView !== 'board' && !inboxOpen)) return
    void conn.refreshWork(scope === 'all' || inboxOpen ? 'all' : 'space').catch(fail)
  }, [conn, view.ready, view.status, mainView, scope, inboxOpen, view.work.inboxVersion, view.work.slots])
  useEffect(() => {
    if (!inboxOpen) return
    let current = true
    setInboxLoading(true)
    void conn.rpc.call<{ groups: WorkInboxGroup[] }>('work.inbox', {}).then(result => {
      if (current) setInbox(result.groups)
    }, error => { if (current) fail(error) }).finally(() => { if (current) setInboxLoading(false) })
    return () => { current = false }
  }, [conn, inboxOpen, view.work.inboxVersion])

  useEffect(() => {
    if (mainView !== 'board' || scope !== 'space' || !view.ready) return
    let current = true
    for (const item of currentItems.filter(item => item.changeCount > 0 && changes[item.workItemId]?.revision !== item.revision)) {
      let pending = pendingChanges.current.get(item.workItemId)
      if (pending?.revision !== item.revision) {
        const promise = conn.rpc.call<MethodResult<'work.changes'>>('work.changes', target(item)).then(result => result.changes)
        pending = { revision: item.revision, promise }
        pendingChanges.current.set(item.workItemId, pending)
        void promise.catch(() => { if (pendingChanges.current.get(item.workItemId)?.promise === promise) pendingChanges.current.delete(item.workItemId) })
      }
      void pending.promise.then(changes => {
        if (current) setChanges(previous => ({ ...previous, [item.workItemId]: { revision: item.revision, changes } }))
      }, error => { if (current) fail(error) })
    }
    return () => { current = false }
  }, [conn, mainView, scope, view.ready, view.work.items])

  async function mutate(method: string, item: WorkItemView, extra: Record<string, unknown> = {}) {
    const latest = conn.getView().work.items.get(item.workItemId) ?? item
    try {
      const result = method === 'update'
        ? await updateWorkItem(conn.rpc, latest, extra, fresh => conn.mergeWorkItems([fresh]))
        : await transitionWorkItem(conn.rpc, latest, method, extra, fresh => conn.mergeWorkItems([fresh]))
      if (result.item) conn.mergeWorkItems([result.item])
      else if (result.items) conn.mergeWorkItems(result.items)
      else if (result.workItemId) conn.mergeWorkItems([result])
      if (result.queued) {
        const currentSlots = await conn.rpc.call('work.slots', {})
        const position = currentSlots.queue.findIndex((entry: { workItemId: string }) => entry.workItemId === item.workItemId) + 1
        notify({ kind: 'info', text: method === 'review' ? t.workReviewQueued : t.workQueued(position ? format.number(position) : '') })
      }
      const billed = result.cancelledJobs?.filter((job: { providerCancelled: boolean }) => !job.providerCancelled).length
      if (billed) notify({ kind: 'info', text: t.workBilledJobs(billed, format.number(billed)) })
      return result
    } catch (error) {
      if (error instanceof RpcError && error.code === 'revision_conflict') {
        const fresh = await conn.rpc.call<{ item: WorkItemView }>('work.get', target(latest))
        conn.mergeWorkItems([fresh.item])
        notify({ kind: 'info', text: t.workCardRefreshed })
      } else if (error instanceof RpcError && error.code === 'invalid_transition') {
        const data = error.data as { status?: WorkStatus } | undefined
        notify({ kind: 'error', text: t.workInvalidTransition(statuses[data?.status ?? latest.status], method === 'review' ? extra.decision === 'approve' ? labels.approve! : labels.reject! : labels[method] ?? method) })
      } else fail(error)
      throw error
    }
  }

  async function locate({ spaceId, nodeId }: { spaceId: string; nodeId: string }) {
    const request = ++navigation.current
    await conn.selectProject(spaceId)
    if (request !== navigation.current || !conn.getView().ready || conn.getView().space?.spaceId !== spaceId) return
    setMainView('canvas')
    focusNode(nodeId)
  }
  async function showReview(input: { spaceId: string; workItemId: string }) {
    const request = ++navigation.current
    setInboxOpen(false)
    await conn.selectProject(input.spaceId)
    if (request !== navigation.current || !conn.getView().ready || conn.getView().space?.spaceId !== input.spaceId) return
    const result = await conn.rpc.call<{ item: WorkItemView }>('work.get', input)
    if (request !== navigation.current || !conn.getView().ready || conn.getView().space?.spaceId !== input.spaceId) return
    conn.mergeWorkItems([result.item])
    setReview(result.item)
  }
  async function session(item: WorkItemView, selected?: WorkSessionView) {
    const request = ++navigation.current
    // Session jumps switch projects just like locating canvas changes and opening reviews.
    await conn.selectProject(item.spaceId)
    if (request !== navigation.current || !conn.getView().ready || conn.getView().space?.spaceId !== item.spaceId) return
    setMainView('canvas')
    const agent = selected ?? item.sessions.find(agent => !agent.archived) ?? item.sessions.at(-1)
    if (!agent && item.status === 'todo') {
      setDialog({ action: 'choose', item, run: async agentKind => { const result = await mutate('activate', item, { agentKind }); if (result.item?.sessions.length) await session(result.item); return result } })
      return
    }
    if (agent) {
      openSession(agent.sessionId)
      await conn.loadSession(agent.sessionId)
    }
  }
  // Do not block status changes or require reasons; only first activation selects an agent, while Reject in the menu offers optional feedback
  function transition(item: WorkItemView, action: string, pin = false, status?: DropResult['status']) {
    if (action === 'none') return
    if (action === 'pin') { void mutate('update', item, { pinned: pin || !item.pinned }).catch(() => {}); return }
    if (action === 'activate' && !item.sessions.length) { setDialog({ action: 'choose', item, run: agentKind => mutate('activate', item, { agentKind }) }); return }
    if (action === 'move' && status === 'in_progress' && !item.sessions.length) { setDialog({ action: 'choose', item, run: agentKind => mutate('move', item, { status, agentKind }) }); return }
    if (action === 'reject') { setDialog({ action, item }); return }
    if (action === 'move' && status) {
      const latest = conn.getView().work.items.get(item.workItemId) ?? item
      const notice = runningNotice(latest, status, locale)
      void mutate('move', item, { status }).then(() => { if (notice) notify({ kind: 'info', text: notice }) }).catch(() => {})
      return
    }
    void mutate(action === 'approve' ? 'review' : action, item, action === 'approve' ? { decision: 'approve' } : {}).catch(() => {})
  }
  async function reject(item: WorkItemView, feedback?: string) {
    const params = { decision: 'reject', ...(feedback ? { feedback } : {}) }
    if (item.sessions.length) { await mutate('review', item, params); return }
    setDialog({ action: 'choose', item, run: agentKind => mutate('review', item, { ...params, agentKind }) })
  }
  async function reparent(item: WorkItemView, parentId: string | null) {
    try {
      const result = await conn.rpc.call<MethodResult<'work.reparent'>>('work.reparent', { requestId: rid(), ...target(item), parentId })
      conn.mergeWorkItems([result.item])
      await conn.refreshWork('space')
      notify({ kind: 'info', text: parentId ? t.workBecameChild(item.title) : t.workBecameRoot(item.title) })
    } catch (error) { fail(error) }
  }
  function action(item: WorkItemView, action: WorkCardAction) {
    if (action === 'locate') { void locateChanges(item.workItemId).catch(fail); return }
    if (action === 'board') { setMainView('board'); return }
    if (action === 'session') { void session(item).catch(fail); return }
    if (action === 'review') { void showReview(target(item)).catch(fail); return }
    if (action === 'delete') { setDeleting(item); return }
    if (action === 'inbox') { setInbox([]); setInboxFocus(item.waitingOn?.messageId); setInboxOpen(true); return }
    if (action === 'copyDirectory') { void navigator.clipboard.writeText(item.workDir).catch(fail); return }
    if (action === 'directory') {
      void conn.rpc.call('fs.reveal', { workItemId: item.workItemId, spaceId: item.spaceId }).then(result => { if (!result.revealed) return navigator.clipboard.writeText(result.path) }).catch(fail)
      return
    }
    if (action === 'rename') {
      const title = window.prompt(t.workRename, item.title)?.trim()
      if (title) void mutate('update', item, { title }).catch(() => {})
      return
    }
    if (action === 'reviewByUser' || action === 'reviewByParent') { void mutate('update', item, { reviewBy: action === 'reviewByUser' ? 'user' : 'parent' }).catch(() => {}); return }
    transition(item, action)
  }
  const tree: WorkTreeProps = {
    items: currentItems, openSessionId: activeSessionId,
    queuePositions: Object.fromEntries((slots?.queue ?? []).map((entry, index) => [entry.workItemId, index + 1])),
    onSelect: item => { void session(item).catch(fail) },
    onSession: (item, agent) => { void session(item, agent).catch(fail) },
    onAction: action,
    onMove: (item, status) => { if (item.status !== status) transition(item, 'move', false, status) },
    onReparent: (item, parentId) => { void reparent(item, parentId) },
    onDragChange: setTreeDrag,
  }
  const latestReview = review ? view.work.items.get(review.workItemId) ?? review : null
  const closeDialog = () => setDialog(null)
  return {
    mainView, tree, selectedId,
    async reopenQueue(sessionId: string) {
      const item = currentItems.find(item => item.sessions.some(session => session.sessionId === sessionId))
      if (!item) throw new Error('Work item is unavailable')
      await mutate('reopen', item, { resumeSessionId: sessionId })
      await conn.rpc.call('session.resumeQueue', { requestId: rid(), sessionId })
    },
    statusDropBar: <WorkStatusDropBar drag={treeDrag} />,
    showCanvas() { setMainView('canvas') },
    locateRef(nodeId: string) { setMainView('canvas'); focusNode(nodeId) },
    tabs: <div role="tablist" aria-label={t.workMainView}>{(['canvas', 'board'] as const).map(value => <button key={value} role="tab" aria-selected={mainView === value} onClick={() => setMainView(value)}>{value === 'canvas' ? t.workCanvas : t.workBoard}</button>)}</div>,
    runningButton: <button className={`app-toolbar-button app-running${slots && slots.used >= slots.limit ? ' is-full' : ''}`} aria-label={t.workRunningCount(slots ? `${format.number(slots.used)}/${format.number(slots.limit)}` : '…')} title={slots ? `${t.workRunningCount(`${format.number(slots.used)}/${format.number(slots.limit)}`)} · ${t.workSlotsLimit(format.number(slots.limit))}` : undefined} onClick={() => setSlotsOpen(true)}><RunningIcon active={Boolean(slots?.used)} /></button>,
    inboxButton: <button className="app-toolbar-button" title={t.workInboxLabel(format.number(counts?.unread ?? 0), format.number(counts?.unresolved ?? 0))} aria-label={t.workInboxLabel(format.number(counts?.unread ?? 0), format.number(counts?.unresolved ?? 0))} onClick={() => { setInboxFocus(undefined); setInbox([]); setInboxOpen(true) }}><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" /></svg>{counts?.unread ? <span className="app-toolbar-badge">{format.number(counts.unread)}</span> : counts?.unresolved ? <span className="app-toolbar-badge vis-work-project-dot">●</span> : null}</button>,
    board: slots && view.space ? <WorkBoard {...(selectedId ? { selectedId } : {})} items={items} spaceId={view.space.spaceId} spaceName={view.space.name} projects={view.projects} slots={slots} onAction={action} onSelect={item => { if (item.status === 'in_review') void showReview(target(item)).catch(fail); else void session(item).catch(fail) }} onSession={(item, agent) => { void session(item, agent).catch(fail) }} onTransition={(item, result) => transition(item, result.action, result.action === 'pin', result.status)} onCreate={() => setNewTodo(true)} onSlots={() => setSlotsOpen(true)} onScopeChange={setScope} cardDetails={item => ({ reportChangeCount: item.changeCount, hasCompletionReport: !!item.reviewReportId, thumbnails: changes[item.workItemId]?.revision === item.revision ? changedThumbnails(changes[item.workItemId]!.changes, view.state.nodes, id => `/assets/${encodeURIComponent(item.spaceId)}/${encodeURIComponent(id)}?t=${encodeURIComponent(conn.token)}`) : [] })} /> : null,
    overlays: <>
      {deleting ? <WorkDelete key={`${deleting.spaceId}/${deleting.workItemId}`} conn={conn} item={deleting} onClose={() => setDeleting(null)} onDeleted={result => {
        const removed = items.filter(item => result.workItemIds.includes(item.workItemId))
        if (removed.some(item => item.sessions.some(session => session.sessionId === activeSessionId))) closeSession()
        if (review && result.workItemIds.includes(review.workItemId)) setReview(null)
        conn.removeWorkItems(result.workItemIds)
        setDeleting(current => current?.workItemId === deleting.workItemId && current.spaceId === deleting.spaceId ? null : current)
        notify({ kind: 'info', text: t.workDeleted(deleting.title) })
        const billed = result.cancelledJobs.filter(job => !job.providerCancelled).length
        if (billed) notify({ kind: 'info', text: t.workBilledJobs(billed, format.number(billed)) })
      }} /> : null}
      {newTodo ? <NewTodoDialog parents={currentItems.filter(item => !item.parentId)} onClose={() => setNewTodo(false)} onCreate={async input => { const { agentKind, ...data } = input; const result = await conn.rpc.call(input.parentId ? 'work.dispatch' : 'work.create', { requestId: rid(), spaceId: view.space?.spaceId, ...data, ...(input.parentId ? { agentKind, activate: false } : {}) }); conn.mergeWorkItems([result.item]) }} /> : null}
      {dialog?.action === 'choose' ? <AgentChoiceDialog isRoot={!dialog.item.parentId} onClose={closeDialog} onChoose={async agentKind => { await dialog.run(agentKind) }} /> : null}
      {dialog?.action === 'reject' ? <RejectDialog title={dialog.item.title} onClose={() => setDialog(current => current?.action === 'reject' ? null : current)} onReject={feedback => reject(dialog.item, feedback)} /> : null}
      {slotsOpen && slots ? <SlotsPopover slots={slots} spaceNames={new Map(view.projects.map(project => [project.spaceId, project.name]))} onClose={() => setSlotsOpen(false)} onAdjustLimit={() => { setSlotsOpen(false); openSettings() }} onCancelQueue={async input => { const result = await conn.rpc.call<{ item: WorkItemView }>('work.get', input); await mutate('recall', result.item) }} /> : null}
      {inboxOpen ? <InboxPopover {...(inboxFocus ? { focusMessageId: inboxFocus } : {})} groups={inbox} loading={inboxLoading} sessions={items.flatMap(item => item.sessions)} onClose={() => setInboxOpen(false)} onMarkRead={async input => { await conn.rpc.call('work.markRead', input) }} onReply={async input => {
        try { await conn.rpc.call('work.reply', { requestId: rid(), ...input }); return { status: 'sent' } }
        catch (error) { if (error instanceof RpcError && error.code === 'already_resolved') return { status: 'already_resolved', reply: (error.data as { resolution: WorkMessageView }).resolution }; throw error }
      }} onReview={input => { void showReview(input).catch(fail) }} onLocateNode={input => { setInboxOpen(false); void locate(input).catch(fail) }} /> : null}
      {latestReview ? <WorkReview conn={conn} item={latestReview} onClose={() => setReview(null)} onLocateNode={input => { setReview(null); void locate(input).catch(fail) }} onApprove={async () => { await mutate('review', latestReview, { decision: 'approve' }) }} onReject={feedback => reject(latestReview, feedback)} /> : null}
    </>,
  }
}

function WorkDelete({ conn, item, onClose, onDeleted }: {
  conn: SpaceConnection
  item: WorkItemView
  onClose(): void
  onDeleted(result: MethodResult<'work.delete'>): void
}) {
  const { locale } = useLocale()
  const requestId = useRef(rid())
  const [plan, setPlan] = useState<MethodResult<'work.deletePlan'> | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  useEffect(() => {
    let current = true
    void conn.rpc.call<MethodResult<'work.deletePlan'>>('work.deletePlan', target(item)).then(result => {
      if (current) setPlan(result)
    }, error => { if (current) setError(error) }).finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [conn, item.spaceId, item.workItemId])
  const remove = async () => {
    if (!plan || loading || busy) return
    setBusy(true)
    setError(null)
    try { onDeleted(await conn.rpc.call<MethodResult<'work.delete'>>('work.delete', { requestId: requestId.current, ...target(item) })) }
    catch (error) { setError(error) }
    finally { setBusy(false) }
  }
  return <DeleteWorkDialog title={item.title} plan={plan} loading={loading} busy={busy} error={error ? describeError(error, locale) : ''} onClose={onClose} onDelete={() => void remove()} />
}
