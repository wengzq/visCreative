import { agentLabel, useAgents, useAgentsLoaded } from './agents'
import { CloseIcon, IconButton, describeError, useFormat, useLocale, useMessages } from '@vis/ui-kit'
import type { AgentModelOption, AssetVersionView, ApprovalMode, AgentKind, ApprovalDecision, ApprovalPayload, DeliveryState, JobView, SessionSummary, TranscriptItem, WorkItemView, WorkSessionView } from '@vis/protocol'
import { type KeyboardEvent, type RefObject, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { AgentMarkdown } from './AgentMarkdown'
import { NodePreview, RefThumbs, type RefPreview } from './RefThumb'
import { ApprovalCard } from './ApprovalCard'
import type { BatchApprovalActions } from './BatchApprovalCard'
import { workTranscript } from './workBlocks'
import { WorkBlock } from './WorkBlock'
import { SkillDraftCard, type SkillDraftHost } from './SkillDraftCard'
import { GenerationResult } from './GenerationResult'
import { type ProjectOption, type SkillOption, WorkspaceDialog, type WorkspaceInput, type DirectoryPicker } from './WorkspaceDialog'
import { mentionQuery, slashSkillQuery, plainTextSummary, workMessageText } from './workspaceUtils'
import { EMPTY_TREE_VIEW, WorkTree, type WorkTreeView, type WorkTreeProps } from './work/WorkTree'
import { WorkCardMenu } from './work/WorkCardMenu'
import { agentTabLabels, isRunning, mainSession } from './work/sessionPanelModel'
import { statusLabels, reparentTargets } from './work/model'
import { AgentIcon } from './AgentIcon'
import { ProjectSwitcher } from './ProjectSwitcher'
import { AgentConfigPicker } from './AgentConfigPicker'
import { Attachments } from './Attachments'
import { ATTACHMENT_ACCEPT, type AttachmentDraft } from './attachmentState'
import { ApprovalModePicker } from './ApprovalModePicker'
import { anchoredScrollTop } from './history'
import { pendingAgentConfigTurns } from './agentConfig'
import { skillCopyMessages, sessionMessages } from './messages'
import { transcriptNotice } from './activity'
import './session.css'

export type RefChip = { nodeId: string }
export type { RefPreview } from './RefThumb'

export type SessionPanelProps = {
  skillDraftHost?: SkillDraftHost

  scriptBatches?: ReadonlyMap<string, import('@vis/protocol').BatchView>
  onGetBatch?: BatchApprovalActions['onGetBatch']
  onRespondBatch?: BatchApprovalActions['onRespondBatch']
  resolveBatchShots?: BatchApprovalActions['resolveBatchShots']
  showProjectSwitcher?: boolean
  workTree?: WorkTreeProps
  projectAttention?: ReadonlySet<string>
  projects: ProjectOption[]
  projectsDir: string
  projectId: string | null
  onSelectProject(spaceId: string): Promise<void>
  onCreateProject(name: string, rootPath: string | undefined, agentKind: AgentKind | null): Promise<void>
  onDeleteProject?(spaceId: string): void
  onPickDirectory: DirectoryPicker
  onValidateDirectory(path: string): Promise<{ valid: boolean; error?: string }>
  onListSkills(input: { spaceId: string }): Promise<SkillOption[]>
  onRevealProject(): void
  resolveRef(nodeId: string): RefPreview
  onLocateRef(nodeId: string): void
  sessions: SessionSummary[]
  openSessionId: string | null
  collapsed: boolean
  onCollapsedChange(value: boolean | ((previous: boolean) => boolean)): void
  onSelect(sessionId: string | null): void
  onLocate(workItemId: string): void
  onCreate(input: WorkspaceInput): Promise<void>
  /** Current session entries in ascending createdSeq order; null means not yet loaded */
  transcript: TranscriptItem[] | null
  generationJobs?: ReadonlyMap<string, JobView>
  hasMore: boolean
  onLoadMore(): Promise<void>
  onSetApprovalMode(sessionId: string, mode: ApprovalMode): Promise<void>
  onResumeQueue(sessionId: string): Promise<void>
  onClearQueue(sessionId: string): Promise<void>
  onReopenQueue(sessionId: string): Promise<void>
  /** Streaming replies and thinking: entry id -> draft; the caller removes drafts when final entries arrive */
  composerDraft?: { sessionId: string; text: string; seq: number } | undefined
  drafts: ReadonlyMap<string, TranscriptItem>
  messageStates: ReadonlyMap<string, DeliveryState>
  refs: RefChip[]
  attachments: readonly AttachmentDraft[]
  onImportFiles(files: Iterable<File>): void
  onRemoveAttachment(id: string): void
  resolveAsset(assetVersionId: string): Promise<AssetVersionView>
  assetUrl(assetVersionId: string): string
  posterUrl(assetVersionId: string): string
  onAddAssetRef(asset: AssetVersionView): void
  /** Canvas nodes available for @ references; selected canvas nodes come first */
  mentionNodes: MentionNode[]
  onAddRef(nodeId: string): void
  onRemoveRef(nodeId: string): void
  skills: SkillOption[]
  onRefreshSkills?(): void
  onManageSkills?(importOpen: boolean): void
  selectedSkills: SkillOption[]
  onAddSkill(skill: SkillOption): void
  onRemoveSkill(path: string): void
  onAgentOptions(sessionId: string): Promise<AgentModelOption[]>
  onSetAgentConfig(sessionId: string, config: SessionSummary['agentConfig']): Promise<void>
  onSend(text: string): Promise<void>
  onStop(sessionId: string): void
  onSendNow(sessionId: string, messageId: string): Promise<void>
  stopCancelsWork?: ReadonlySet<string>
  onRespondApproval(approvalId: string, decision: ApprovalDecision): Promise<void>
}

export type MentionNode = { nodeId: string; label: string; detail: string; selected: boolean }

function readPreference(key: string): string | null {
  try { return localStorage.getItem(key) } catch { return null }
}

type ComposerDraft = { pendingAgentConfig: boolean; text: string; onTextChange(text: string | ((previous: string) => string)): void; sending: boolean; onSendingChange(sending: boolean): void }

export function SessionPanel(p: SessionPanelProps) {
  const panel = useRef<HTMLElement>(null)
  const sm = useMessages(skillCopyMessages)
  const agents = useAgents()
  const agentsLoaded = useAgentsLoaded()
  const m = useMessages(sessionMessages)
  const { locale } = useLocale()
  // The list unmounts in session view; keep collapse and search state here to preserve it on return
  const [treeView, setTreeView] = useState<WorkTreeView>(EMPTY_TREE_VIEW)
  const previousSessions = useRef(p.sessions)
  const [pendingConfig, setPendingConfig] = useState<ReadonlyMap<string, string>>(new Map())
  useEffect(() => {
    const previous = previousSessions.current
    setPendingConfig(current => pendingAgentConfigTurns(previous, p.sessions, current))
    previousSessions.current = p.sessions
  }, [p.sessions])
  const [texts, setTexts] = useState<Record<string, string>>({})
  const [sendingIds, setSendingIds] = useState<ReadonlySet<string>>(() => new Set())
  const draftId = p.openSessionId ?? ''
  const text = texts[draftId] ?? ''
  const sending = sendingIds.has(draftId)
  const setText = (value: string | ((previous: string) => string)) => setTexts(current => ({ ...current, [draftId]: typeof value === 'function' ? value(current[draftId] ?? '') : value }))
  const setSending = (value: boolean) => setSendingIds(current => { const next = new Set(current); if (value) next.add(draftId); else next.delete(draftId); return next })
  useEffect(() => { setTexts({}); setSendingIds(new Set()) }, [p.projectId])
  useEffect(() => {
    const draft = p.composerDraft
    if (!draft || draft.sessionId !== p.openSessionId) return
    setTexts(current => ({ ...current, [draft.sessionId]: [current[draft.sessionId], draft.text].filter(Boolean).join('\n\n') }))
  }, [p.composerDraft?.seq])
  const createTooltipId = useId()
  const [dialog, setDialog] = useState<'workspace' | null>(null)
  const { collapsed, onCollapsedChange: setCollapsed } = p
  const [width, setWidth] = useState(() => {
    const saved = Number(readPreference('vis.session.width'))
    return Number.isFinite(saved) && saved >= 300 ? saved : 400
  })
  const [resizing, setResizing] = useState(false)
  const drag = useRef<{ x: number; width: number } | null>(null)
  const toggle = useRef<HTMLButtonElement>(null)
  const focusToggle = useRef(false)
  useLayoutEffect(() => {
    if (focusToggle.current) { toggle.current?.focus(); focusToggle.current = false }
  }, [collapsed])
  const clampWidth = (value: number) => Math.max(300, Math.min(value, window.innerWidth / 2))
  useEffect(() => {
    // Allow operations within the current page even when browser storage is disabled
    try {
      localStorage.setItem('vis.session.collapsed', String(collapsed))
      localStorage.setItem('vis.session.width', String(width))
    } catch { /* Ignore unavailable preference storage */ }
  }, [collapsed, width])
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === '\\' && !event.altKey && !event.shiftKey) {
        event.preventDefault()
        if (!event.repeat) {
          focusToggle.current = true
          setCollapsed(value => !value)
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
  const sessions = [...p.sessions].sort((a, b) => a.createdAt - b.createdAt)
  const project = p.projects.find(project => project.spaceId === p.projectId)
  const openWorkSession = (item: WorkItemView, session: WorkSessionView) => { if (p.workTree) p.workTree.onSession(item, session); else p.onSelect(session.sessionId) }
  const expandedWork = p.workTree?.items.find(item => item.sessions.some(session => session.sessionId === p.openSessionId))
  const activeSession = sessions.find(session => session.sessionId === p.openSessionId)
  const workSessions = expandedWork?.sessions ?? []
  const labels = agentTabLabels(workSessions, locale, agents)
  const toggleButton = <button ref={toggle} className="vis-session-toggle" aria-label={collapsed ? m.expandPanel : m.collapsePanel} aria-expanded={!collapsed} onClick={() => setCollapsed(value => !value)}><span aria-hidden="true">{collapsed ? '‹' : '›'}</span></button>
  return (
    <aside ref={panel} className={`vis-session-panel${collapsed ? ' is-collapsed' : ''}${resizing ? ' is-resizing' : ''}`} style={{ width: collapsed ? 44 : width }}>
      {!collapsed ? (
        <div
          className="vis-session-resize"
          role="separator"
          aria-label={m.resizePanel}
          aria-orientation="vertical"
          aria-valuemin={300}
          aria-valuemax={Math.max(300, window.innerWidth / 2)}
          aria-valuenow={clampWidth(width)}
          tabIndex={0}
          onPointerDown={event => {
            if (event.button !== 0) return
            event.preventDefault()
            event.currentTarget.setPointerCapture(event.pointerId)
            drag.current = { x: event.clientX, width: event.currentTarget.parentElement!.getBoundingClientRect().width }
            setResizing(true)
          }}
          onPointerMove={event => {
            if (drag.current) setWidth(clampWidth(drag.current.width + drag.current.x - event.clientX))
          }}
          onPointerUp={event => event.currentTarget.releasePointerCapture(event.pointerId)}
          onLostPointerCapture={() => { drag.current = null; setResizing(false) }}
          onKeyDown={event => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
            event.preventDefault()
            setWidth(clampWidth(clampWidth(width) + (event.key === 'ArrowLeft' ? 20 : -20)))
          }}
        />
      ) : null}
      {collapsed ? <div className="vis-session-rail-toggle">{toggleButton}</div> : null}
      {collapsed ? (
        <div className="vis-session-rail">
          {(p.workTree?.items ?? []).filter(item => isRunning(item) || item.waitingOn).map(item => {
            const session = mainSession(item.sessions)
            return session ? <button key={item.workItemId} className={`vis-session-icon${session.sessionId === p.openSessionId ? ' is-active' : ''}`} aria-label={m.expandSession(item.title)} title={item.title} onClick={() => { openWorkSession(item, session); setCollapsed(false) }}><AgentIcon kind={session.agentKind} /><span className={`vis-work-activity is-${item.waitingOn ? 'waiting' : 'active'}`} aria-hidden="true" /></button> : null
          })}
        </div>
      ) : null}
      <div className="vis-session-content" hidden={collapsed}>
        {!p.openSessionId ? <div className="vis-session-project">
          <div className="vis-project-row">
            {p.showProjectSwitcher !== false ? <ProjectSwitcher {...p} /> : <strong className="vis-project-name">{m.sessions}</strong>}
            <div className="vis-workspace-create"><button className="vis-workspace-new" disabled={!project} aria-label={m.startCreating} aria-describedby={createTooltipId} onClick={() => setDialog('workspace')}>+</button><span id={createTooltipId} role="tooltip" className="vis-create-tooltip">{m.startCreating}</span></div>
            {!collapsed ? toggleButton : null}
          </div>
        </div> : <header className="vis-session-heading">
          <div className="vis-session-heading-row"><button aria-label={m.backToList} onClick={() => p.onSelect(null)}>←</button><strong>{expandedWork?.title ?? activeSession?.title ?? m.session}</strong>{activeSession && !workSessions.some(session => session.sessionId === activeSession.sessionId && session.archived) ? <button type="button" className="vis-session-save-skill" onClick={() => { setText(current => [current, sm.request].filter(Boolean).join('\n\n')); requestAnimationFrame(() => panel.current?.querySelector<HTMLTextAreaElement>('.vis-composer textarea')?.focus()) }}>{sm.saveAs}</button> : null}{expandedWork ? <div className="vis-slim-menu"><WorkCardMenu item={expandedWork} onAction={p.workTree?.onAction} onMove={p.workTree?.onMove} onReparent={p.workTree?.onReparent} parentTargets={reparentTargets(expandedWork, p.workTree?.items ?? [])} /></div> : null}{!collapsed ? toggleButton : null}</div>
          <div className="vis-session-heading-row"><span className="vis-slim-status">{expandedWork ? statusLabels(locale)[expandedWork.status] : ''}</span>{workSessions.length > 1 ? <div role="tablist" aria-label={m.agent} className="vis-agent-tabs" onKeyDown={event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
            event.preventDefault()
            const index = workSessions.findIndex(session => session.sessionId === p.openSessionId)
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? workSessions.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + workSessions.length) % workSessions.length
            event.currentTarget.querySelectorAll<HTMLButtonElement>('button')[next]?.focus()
            openWorkSession(expandedWork!, workSessions[next]!)
          }}>{workSessions.map((session, index) => <button key={session.sessionId} role="tab" tabIndex={session.sessionId === p.openSessionId ? 0 : -1} aria-selected={session.sessionId === p.openSessionId} onClick={() => openWorkSession(expandedWork!, session)}><AgentIcon kind={session.agentKind} />{labels[index]}{session.archived ? m.archivedSuffix : ''}</button>)}</div> : <span>{activeSession ? <><AgentIcon kind={activeSession.agentKind} />{agentLabel(agents, activeSession.agentKind)}</> : ''}{workSessions[0]?.archived ? m.archivedSuffix : ''}</span>}</div>
          {expandedWork ? <div className="vis-session-heading-actions">{expandedWork.changeCount ? <button onClick={() => p.onLocate(expandedWork.workItemId)}>{m.locateCanvas}</button> : null}{expandedWork.status === 'in_review' ? <button onClick={() => p.workTree?.onAction?.(expandedWork, 'review')}>{m.review}</button> : null}</div> : null}
          {activeSession ? <QueueStatus key={activeSession.sessionId} session={activeSession} blocked={!!expandedWork && (expandedWork.status !== 'in_progress' && expandedWork.waitingSlotSince === null || workSessions.some(session => session.sessionId === activeSession.sessionId && session.archived))} onReopen={p.onReopenQueue} archived={agentsLoaded && !agents.some(agent => agent.kind === activeSession.agentKind) || workSessions.some(session => session.sessionId === activeSession.sessionId && session.archived)} onResume={p.onResumeQueue} onClear={p.onClearQueue} /> : null}
        </header>}
        <div className="vis-session-stack">
          {!p.openSessionId && p.workTree ? <WorkTree {...p.workTree} openSessionId={p.openSessionId} view={treeView} onViewChange={setTreeView} /> : null}
          {p.openSessionId ? activeSession ? <section key={activeSession.sessionId} className={`vis-session-card is-${activeSession.agentKind} is-expanded`}><div className="vis-conversation"><Conversation {...p} pendingAgentConfig={pendingConfig.has(activeSession.sessionId)} session={activeSession} text={text} onTextChange={setText} sending={sending} onSendingChange={setSending} /></div></section> : <div className="vis-session-empty">{m.loading}</div> : null}
        </div>
      </div>
      {dialog === 'workspace' && p.projectId ? <WorkspaceDialog projects={p.projects} projectId={p.projectId} onClose={() => setDialog(null)} onCreate={p.onCreate} onPickDirectory={p.onPickDirectory} onValidateDirectory={p.onValidateDirectory} onListSkills={p.onListSkills} /> : null}
    </aside>
  )
}

function QueueStatus({ session, archived, blocked, onReopen, onResume, onClear }: { session: SessionSummary; archived: boolean; blocked: boolean; onReopen(sessionId: string): Promise<void>; onResume(sessionId: string): Promise<void>; onClear(sessionId: string): Promise<void> }) {
  const m = useMessages(sessionMessages)
  const { locale } = useLocale()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const format = useFormat()
  const count = session.queuedMessageCount ?? 0
  if ((!session.queuePaused && !blocked) || count === 0) return null
  const act = async (clear: boolean) => {
    if (clear && !window.confirm(m.withdrawQueueConfirm)) return
    setPending(true)
    setError(null)
    try { await (clear ? onClear : blocked ? onReopen : onResume)(session.sessionId) }
    catch (error) { setError(error) }
    finally { setPending(false) }
  }
  return <div className="vis-queue-status">
    <span role="status">{blocked ? m.queueEnded(format.number(count)) : m.queueCount(format.number(count))}</span>
    <button disabled={pending || (archived && !blocked)} onClick={() => void act(false)}>{blocked ? m.reopenAndSend : m.continue}</button>
    <button disabled={pending} title={m.clearQueueTitle} onClick={() => void act(true)}>{m.clearQueue}</button>
    {error ? <span role="alert">{describeError(error, locale)}</span> : null}
  </div>
}

function Conversation(p: SessionPanelProps & ComposerDraft & { session: SessionSummary }) {
  const agents = useAgents()
  const agentsLoaded = useAgentsLoaded()
  const m = useMessages(sessionMessages)
  const { locale } = useLocale()
  const scroller = useRef<HTMLDivElement>(null)
  const composerInput = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (p.composerDraft?.sessionId !== p.session.sessionId) return
    const frame = requestAnimationFrame(() => composerInput.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [p.composerDraft?.seq])
  const [visitedHistory, setVisitedHistory] = useState(false)
  const stick = useRef(true)
  const [loadingHistory, setLoadingHistory] = useState(false)
  const [historyError, setHistoryError] = useState<unknown>(null)
  const historyPending = useRef(false)
  const touchStart = useRef<{ y: number; atTop: boolean } | null>(null)
  const historyPosition = useRef<Array<{ element: HTMLElement; offset: number; itemIds?: string }> | null>(null)
  const captureHistoryPosition = () => {
    const el = scroller.current
    if (!el) return
    const top = el.getBoundingClientRect().top
    historyPosition.current = [...el.children].filter((child): child is HTMLElement => child instanceof HTMLElement && !child.matches('.vis-load-more,.vis-history-start') && child.getBoundingClientRect().bottom > top).map(element => ({ element, offset: element.getBoundingClientRect().top - top, ...(element.dataset.historyItems ? { itemIds: element.dataset.historyItems } : {}) }))
  }
  const loadHistory = async () => {
    setVisitedHistory(true)
    const el = scroller.current
    if (!el || !p.hasMore || historyPending.current) return
    historyPending.current = true
    stick.current = false
    captureHistoryPosition()
    setLoadingHistory(true)
    setHistoryError(null)
    try { await p.onLoadMore() }
    catch (error) { setHistoryError(error) }
    finally { historyPending.current = false; setLoadingHistory(false) }
  }
  const persisted = p.transcript ?? []
  const streaming = new Set<string>()
  const items = persisted.map(item => {
    const draft = p.drafts.get(item.itemId)
    if (!draft || draft.revision <= item.revision) return item
    streaming.add(item.itemId)
    return { ...draft, createdAt: item.createdAt, createdSeq: item.createdSeq }
  })
  for (const draft of p.drafts.values()) {
    if (persisted.some(item => item.itemId === draft.itemId)) continue
    streaming.add(draft.itemId)
    const item = draft.turnId ? draft : { ...draft, turnId: p.session.activeTurnId }
    const next = items.findIndex(existing => existing.createdAt > item.createdAt)
    items.splice(next < 0 ? items.length : next, 0, item)
  }
  const queued = p.workTree?.items.some(item => item.waitingSlotSince !== null && item.sessions.some(session => session.sessionId === p.session.sessionId))
  const archived = p.workTree?.items.some(item => item.sessions.some(session => session.sessionId === p.session.sessionId && session.archived)) ?? false
  const owner = p.workTree?.items.find(item => item.workItemId === p.session.workItemId)
  const blocked = archived || !!owner && owner.status !== 'in_progress' && owner.waitingSlotSince === null
  const groups = workTranscript(items, p.generationJobs, queued ? null : p.session.activeTurnId, item => {
    const payload = item.payload as { messageId?: string; deliveryState?: DeliveryState }
    return ((payload.messageId ? p.messageStates.get(payload.messageId) : undefined) ?? payload.deliveryState) === 'draft'
  })

  // When at the bottom, stay pinned there as new content arrives
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && historyPosition.current && !loadingHistory) {
      const anchor = historyPosition.current.find(candidate => candidate.element.isConnected) ?? historyPosition.current.flatMap(candidate => {
        if (!candidate.itemIds) return []
        const ids = JSON.parse(candidate.itemIds) as string[]
        const element = [...el.querySelectorAll<HTMLElement>('[data-history-items]')].find(element => (JSON.parse(element.dataset.historyItems!) as string[]).some(id => ids.includes(id)))
        return element ? [{ ...candidate, element }] : []
      })[0]
      if (anchor) el.scrollTop = anchoredScrollTop(el.scrollTop, anchor.offset, anchor.element.getBoundingClientRect().top - el.getBoundingClientRect().top)
      historyPosition.current = null
    } else if (el && stick.current) el.scrollTop = el.scrollHeight
  })
  useEffect(() => { stick.current = true }, [p.session.sessionId])
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    // Child cards resolve media and expand independently of the transcript render.
    const observer = new ResizeObserver(() => { if (stick.current) el.scrollTop = el.scrollHeight })
    for (const child of el.children) observer.observe(child)
    return () => observer.disconnect()
  })

  return (
    <>
      <div
        className="vis-transcript"
        ref={scroller}
        onTouchStart={event => { const touch = event.touches[0]; touchStart.current = touch ? { y: touch.clientY, atTop: event.currentTarget.scrollTop <= 1 } : null }}
        onTouchEnd={event => { const touch = event.changedTouches[0]; if (touchStart.current?.atTop && touch && touch.clientY - touchStart.current.y > 20) void loadHistory(); touchStart.current = null }}
        onWheel={event => {
          // Respond only to a new upward scroll after reaching the top; opening a session must not paginate automatically.
          if (event.deltaY < 0 && event.currentTarget.scrollTop <= 1) void loadHistory()
        }}
        onScroll={e => {
          const el = e.currentTarget
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
          if (historyPending.current) captureHistoryPosition()
        }}
      >
        {p.transcript === null ? <div className="vis-session-empty">{m.loading}</div> : null}
        {p.hasMore ? <button className="vis-load-more" disabled={loadingHistory} onClick={() => void loadHistory()}>{loadingHistory ? m.loadingHistory : m.loadHistory}</button> : visitedHistory && items.length > 0 ? <span className="vis-history-start">{m.historyStart}</span> : null}
        {p.transcript !== null && items.length === 0 ? <div className="vis-session-welcome">
          <AgentIcon kind={p.session.agentKind} />
          <p>{m.emptySession}</p>
          {[m.exampleStoryboard, m.exampleVariants, m.exampleOrganize].map(example => <button type="button" key={example} onClick={() => { p.onTextChange(example); composerInput.current?.focus() }}>{example}</button>)}
        </div> : null}
        {historyError ? <span role="alert">{describeError(historyError, locale)}</span> : null}
        {groups.map(group => group.kind === 'work'
          ? <WorkBlock key={group.itemId} block={group} onStop={() => p.onStop(p.session.sessionId)} silentSince={group.active ? p.session.silentSince : null} items={items} jobs={p.generationJobs} onToggle={() => { const el = scroller.current; if (el && stick.current) el.scrollTop = el.scrollHeight }} />
          : group.kind === 'result'
            ? <GenerationResult key={group.job.jobId} job={group.job} archived={archived} resolveAsset={p.resolveAsset} assetUrl={p.assetUrl} posterUrl={p.posterUrl} onLocateRef={p.onLocateRef} onAddRef={p.onAddRef} onAddAssetRef={p.onAddAssetRef} />
            : group.kind === 'skillDraft'
            ? <SkillDraftCard key={group.draft.draftId} draft={group.draft} host={p.skillDraftHost} />
            : group.item.kind === 'approval'
            ? <ApprovalCard key={group.item.itemId} approval={group.item.payload as ApprovalPayload} onRespond={p.onRespondApproval} onLocateNode={p.onLocateRef}
              batch={p.scriptBatches?.get((group.item.payload as ApprovalPayload).batchId ?? '')} {...(p.onGetBatch ? { onGetBatch: p.onGetBatch } : {})} {...(p.onRespondBatch ? { onRespondBatch: p.onRespondBatch } : {})} {...(p.resolveBatchShots ? { resolveBatchShots: p.resolveBatchShots } : {})} />
            : <Item canSendNow={!blocked && !queued && (!agentsLoaded || agents.some(agent => agent.kind === p.session.agentKind))} onSendNow={messageId => p.onSendNow(p.session.sessionId, messageId)} stopCancelsWork={p.stopCancelsWork?.has(p.session.sessionId) ?? false} blocked={blocked} agentKind={p.session.agentKind} key={group.item.itemId} item={group.item} streaming={streaming.has(group.item.itemId)} states={p.messageStates} resolveAsset={p.resolveAsset} assetUrl={p.assetUrl} posterUrl={p.posterUrl} resolveRef={p.resolveRef} onLocateRef={p.onLocateRef} />)}
      </div>
      <Composer {...p} inputRef={composerInput} />
    </>
  )
}

function SkillIcon() {
  return <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 3.5C6 2 3.5 2 1.5 2.5v10C4 12 6 12.5 8 14c2-1.5 4-2 6.5-1.5v-10C12.5 2 10 2 8 3.5Zm0 0V14" /></svg>
}

function Item({ canSendNow, onSendNow, stopCancelsWork, blocked, agentKind, item, streaming, states, resolveRef, onLocateRef, resolveAsset, assetUrl, posterUrl }: { canSendNow: boolean; onSendNow(messageId: string): Promise<void>; stopCancelsWork: boolean; blocked: boolean; agentKind: AgentKind; item: TranscriptItem; streaming: boolean; states: SessionPanelProps['messageStates'] } & Pick<SessionPanelProps, 'resolveRef' | 'onLocateRef' | 'resolveAsset' | 'assetUrl' | 'posterUrl'>) {
  const agents = useAgents()
  const m = useMessages(sessionMessages)
  const { locale } = useLocale()
  const format = useFormat()
  const stateLabels: Partial<Record<DeliveryState, string>> = { draft: m.deliveryDraft, submitted: m.deliverySubmitted, unknown: m.deliveryUnknown, rejected: m.deliveryRejected, withdrawn: m.deliveryWithdrawn }
  const payload = item.payload as any
  switch (item.kind) {
    case 'user': {
      const state: DeliveryState | undefined = states.get(payload?.messageId) ?? payload?.deliveryState
      const label = state === 'draft' && blocked ? m.deliveryEnded : state ? stateLabels[state] : undefined
      return (
        <div className="vis-item is-user">
          <div className="vis-user-heading">{m.you} <time dateTime={new Date(item.createdAt).toISOString()}>· {format.time(item.createdAt)}</time></div>
          {payload?.refs?.length ? <div className="vis-refs"><RefThumbs refs={payload.refs} resolveAsset={resolveAsset} assetUrl={assetUrl} posterUrl={posterUrl} resolveRef={resolveRef} onLocateRef={onLocateRef} /></div> : null}
          {payload?.skills?.length ? <div className="vis-skill-chips">{payload.skills.map((name: string) => <span className="vis-skill-chip" key={name} title={name}><SkillIcon />/{name}</span>)}</div> : null}
          <div className="vis-user-text">{payload?.workDeliveryId ? workMessageText(payload.text) : payload?.text ?? ''}</div>
          {label ? <div className="vis-item-meta"><span>{label}</span>{state === 'draft' && canSendNow && !payload?.workDeliveryId ? <SendNow messageId={payload.messageId} onSend={onSendNow} cancelsWork={stopCancelsWork} /> : null}</div> : null}
        </div>
      )
    }
    case 'assistant_text':
      // react-markdown does not render raw HTML, so tags in Agent output never execute
      return <div className={`vis-item is-assistant is-markdown${streaming ? ' is-streaming' : ''}`}><div className="vis-agent-heading"><AgentIcon kind={agentKind} />{agentLabel(agents, agentKind)}</div><div className="vis-message-markdown"><AgentMarkdown>{payload?.text ?? ''}</AgentMarkdown></div></div>
    case 'notice':
      return <div className="vis-item is-notice">{transcriptNotice(payload, locale)}</div>
    default:
      return null
  }
}

function SendNow({ messageId, onSend, cancelsWork }: { messageId: string; onSend(messageId: string): Promise<void>; cancelsWork: boolean }) {
  const m = useMessages(sessionMessages)
  const { locale } = useLocale()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const send = async () => {
    if (pending || cancelsWork && !window.confirm(m.sendNowConfirm)) return
    setPending(true)
    setError(null)
    try { await onSend(messageId) }
    catch (error) { setError(error) }
    finally { setPending(false) }
  }
  return <><button className="vis-send-now" disabled={pending} onClick={() => void send()}>{m.sendNow}</button>{error ? <span role="alert">{describeError(error, locale)}</span> : null}</>
}

function Composer(p: SessionPanelProps & ComposerDraft & { inputRef: RefObject<HTMLTextAreaElement | null> }) {
  const agents = useAgents()
  const agentsLoaded = useAgentsLoaded()
  const m = useMessages(sessionMessages)
  const { locale } = useLocale()
  const { text, onTextChange: setText, sending, onSendingChange: setSending } = p
  const [pickerOpen, setPickerOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  // One popover serves two purposes: / or the Skill button selects skills; @ selects canvas nodes
  const [mode, setMode] = useState<'skill' | 'node'>('skill')
  const [slash, setSlash] = useState<ReturnType<typeof slashSkillQuery>>(null)
  const textarea = p.inputRef
  const fileInput = useRef<HTMLInputElement>(null)
  const attachmentsBlocked = p.attachments.some(item => item.status !== 'ready')
  const search = useRef<HTMLInputElement>(null)
  const picker = useRef<HTMLDivElement>(null)
  const skillButton = useRef<HTMLButtonElement>(null)
  const pickerId = useId()
  const filtered = p.skills.filter(skill => `${skill.name} ${skill.description}`.toLowerCase().includes(query.toLowerCase()))
  const nodes = p.mentionNodes.map(node => {
    const preview = p.resolveRef(node.nodeId)
    if (preview.kind !== 'text') return node
    const summary = plainTextSummary(preview.text).replace(/\s+/g, ' ')
    return { ...node, label: summary ? summary.length > 18 ? `${summary.slice(0, 18)}…` : summary : node.label }
  }).filter(node => `${node.label} ${node.detail}`.toLowerCase().includes(query.toLowerCase()))
  const count = mode === 'skill' ? filtered.length : nodes.length
  useEffect(() => { if (pickerOpen && mode === 'skill') p.onRefreshSkills?.() }, [pickerOpen, mode, p.onRefreshSkills])
  useEffect(() => { setIndex(0) }, [query])
  useEffect(() => { picker.current?.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' }) }, [index, count])
  useEffect(() => {
    if (!pickerOpen) return
    const dismiss = (event: PointerEvent) => {
      if (!picker.current?.contains(event.target as Node) && !skillButton.current?.contains(event.target as Node) && event.target !== textarea.current) setPickerOpen(false)
    }
    document.addEventListener('pointerdown', dismiss)
    return () => document.removeEventListener('pointerdown', dismiss)
  }, [pickerOpen])
  const closePicker = () => {
    // After selection, remove the /word or @word that triggered the popover from the input
    if (slash) setText(text.slice(0, slash.start) + text.slice(slash.end))
    setPickerOpen(false)
    setSlash(null)
    textarea.current?.focus()
  }
  const choose = (skill: SkillOption) => { p.onAddSkill(skill); closePicker() }
  const chooseNode = (node: MentionNode) => { p.onAddRef(node.nodeId); closePicker() }
  const pickerKey = (event: KeyboardEvent) => {
    if (!pickerOpen || event.nativeEvent.isComposing) return false
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setPickerOpen(false); return true }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      setIndex(value => (value + (event.key === 'ArrowDown' ? 1 : -1) + Math.max(1, count)) % Math.max(1, count))
      return true
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      if (mode === 'skill') { const skill = filtered[Math.min(index, filtered.length - 1)]; if (skill) choose(skill) } else { const node = nodes[Math.min(index, nodes.length - 1)]; if (node) chooseNode(node) }
      return true
    }
    return false
  }

  const archived = p.workTree?.items.some(item => item.sessions.some(session => session.sessionId === p.openSessionId && session.archived)) ?? false
  const session = p.sessions.find(session => session.sessionId === p.openSessionId)
  const owner = p.workTree?.items.find(item => item.workItemId === session?.workItemId)
  const workEnded = !!owner && (owner.status !== 'in_progress' && owner.waitingSlotSince === null || owner.sessions.some(agent => agent.sessionId === session?.sessionId && agent.archived))
  const registered = !agentsLoaded || agents.some(agent => agent.kind === session?.agentKind)
  const running = Boolean(session?.activeTurnId)
  const stopping = running && !text.trim()
  const [resumeError, setResumeError] = useState<unknown>(null)
  const send = async () => {
    const body = text.trim()
    if (!body || sending || attachmentsBlocked || !registered) return
    setSending(true)
    setResumeError(null)
    try {
      if (session?.queuePaused) await p.onResumeQueue(session.sessionId)
      await p.onSend(body)
      setText(current => current === text ? '' : current)
    } catch (error) { setResumeError(error) /* Retain the draft for retry */
    } finally {
      setSending(false)
    }
  }
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (pickerKey(e)) return
    // Enter sends, Shift+Enter inserts a newline; do not send during IME composition
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void send()
    }
  }

  return (
    <fieldset className="vis-composer" disabled={archived || !registered}
      onDragOver={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.stopPropagation() } }}
      onDrop={event => { if (event.dataTransfer.files.length) { event.preventDefault(); event.stopPropagation(); if (!archived) p.onImportFiles(event.dataTransfer.files) } }}
      onPaste={event => { if (event.clipboardData.files.length) { event.preventDefault(); if (!archived) p.onImportFiles(event.clipboardData.files) } }}
    >
      {!registered ? <p className="vis-composer-hint">{m.agentUnregistered}</p> : null}
      {archived ? <p className="vis-composer-hint">{m.archivedHint}</p> : null}
      <div className="vis-composer-card">
        <div className="vis-refs">
          <Attachments attachments={p.attachments} onRemove={p.onRemoveAttachment} assetUrl={p.assetUrl} posterUrl={p.posterUrl} />
          <RefThumbs refs={p.refs} resolveRef={p.resolveRef} onLocateRef={p.onLocateRef} onRemoveRef={p.onRemoveRef} />
          {p.selectedSkills.map(skill => <span className="vis-skill-chip" key={skill.path} title={skill.path}><SkillIcon />/{skill.name}<IconButton label={m.removeSkill(skill.name)} onClick={() => p.onRemoveSkill(skill.path)}><CloseIcon /></IconButton></span>)}

        </div>
        {pickerOpen && mode === 'node' ? <div ref={picker} className="vis-popover vis-skill-picker vis-mention-picker">
          {nodes[index] ? <div className="vis-mention-preview"><NodePreview preview={p.resolveRef(nodes[index].nodeId)} large /></div> : null}
          <div id={pickerId} role="listbox" aria-label={m.canvasNodes} className="vis-skill-list">{nodes.map((node, itemIndex) => <button type="button" role="option" aria-selected={itemIndex === index} className={`vis-mention-option${itemIndex === index ? ' is-active' : ''}`} tabIndex={-1} key={node.nodeId} onPointerMove={() => setIndex(itemIndex)} onClick={() => chooseNode(node)}><NodePreview preview={p.resolveRef(node.nodeId)} /><span className="vis-mention-info"><strong>@{node.label}{p.refs.some(ref => ref.nodeId === node.nodeId) ? ' ✓' : ''}</strong>{node.detail || node.selected ? <span>{[node.detail, node.selected ? m.selectedOnCanvas : ''].filter(Boolean).join(' · ')}</span> : null}</span></button>)}{!nodes.length ? <div className="vis-skill-empty">{p.mentionNodes.length ? m.noMatchingNodes : m.noReferenceNodes}</div> : null}</div>
        </div> : null}
        {pickerOpen && mode === 'skill' ? <div ref={picker} className="vis-popover vis-skill-picker">
          <input ref={search} aria-label={m.searchSkill} placeholder={m.searchSkill} value={query} onChange={event => setQuery(event.target.value)} onKeyDown={pickerKey} />
          <div id={pickerId} role="listbox" aria-label={m.skill} className="vis-skill-list">{filtered.map((skill, itemIndex) => <button type="button" role="option" aria-selected={itemIndex === index} className={itemIndex === index ? 'is-active' : ''} tabIndex={-1} key={skill.path} title={skill.path} onPointerMove={() => setIndex(itemIndex)} onClick={() => choose(skill)}><strong>/{skill.name}{p.selectedSkills.some(selected => selected.path === skill.path) ? ' ✓' : ''}</strong><span>{skill.description}</span></button>)}{!filtered.length ? <div className="vis-skill-empty">{p.skills.length ? m.noMatchingSkills : m.noProjectSkills}</div> : null}</div>
          <div className="vis-popover vis-skill-picker-actions"><button type="button" onClick={() => { setPickerOpen(false); skillButton.current?.focus(); p.onManageSkills?.(true) }}>{m.importSkill}</button><button type="button" onClick={() => { setPickerOpen(false); skillButton.current?.focus(); p.onManageSkills?.(false) }}>{m.manage}</button></div>
        </div> : null}
        <textarea
          ref={textarea}
          value={text}
          aria-label={m.messageAgent}
          placeholder={m.messagePlaceholder}
          aria-controls={pickerOpen ? pickerId : undefined}
          onChange={e => {
            setText(e.target.value)
            const skill = slashSkillQuery(e.target.value, e.target.selectionStart)
            const node = skill ? null : mentionQuery(e.target.value, e.target.selectionStart)
            const match = skill ?? node
            setSlash(match)
            setMode(node ? 'node' : 'skill')
            setPickerOpen(Boolean(match))
            setQuery(match?.query ?? '')
          }}
          onKeyDown={onKeyDown}
          rows={3}
        />
        {/* Tool buttons always stay on one composer row: a long model label truncates, and they never move into a menu */}
        <div className="vis-composer-toolbar">
          <div className="vis-composer-tools">
            <input ref={fileInput} type="file" accept={ATTACHMENT_ACCEPT} multiple hidden aria-label={m.chooseAttachments} onChange={event => { p.onImportFiles(event.currentTarget.files ?? []); event.currentTarget.value = '' }} />
            <button type="button" className="vis-ref-add" aria-label={m.importAsset} title={m.importAssetTitle} onClick={() => fileInput.current?.click()}>{m.importAssetSymbol}</button>
            <button ref={skillButton} className="vis-ref-add" type="button" aria-label={m.skill} aria-expanded={pickerOpen && mode === 'skill'} onClick={() => { setMode('skill'); setPickerOpen(value => mode !== 'skill' || !value); setSlash(null); setQuery(''); queueMicrotask(() => search.current?.focus()) }}>{m.addSkill}</button>
            {session && agents.some(agent => agent.kind === session.agentKind && agent.capabilities.approvals) ? <ApprovalModePicker mode={session.approvalMode ?? 'ask'} onSave={mode => p.onSetApprovalMode(session.sessionId, mode)} /> : null}
            {session && agents.some(agent => agent.kind === session.agentKind && agent.capabilities.models) ? <AgentConfigPicker key={session.sessionId} session={session} pending={false} onOptions={p.onAgentOptions} onSave={p.onSetAgentConfig} /> : null}
          </div>
          <button type="button" className={`vis-send-button${stopping ? ' is-stop' : ''}`} aria-label={stopping ? m.stop : m.send} title={stopping ? m.stop : m.sendHint} disabled={!stopping && (!text.trim() || sending || attachmentsBlocked)} onClick={() => { if (stopping && p.openSessionId) p.onStop(p.openSessionId); else void send() }}>
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{stopping ? <rect x="4" y="4" width="8" height="8" rx="1" fill="currentColor" stroke="none" /> : <path d="M8 13V3m-4 4 4-4 4 4" />}</svg>
          </button>
        </div>
      </div>
      {p.pendingAgentConfig ? <span className="vis-composer-hint" role="status">{m.nextTurn}</span> : null}
      {running && !workEnded && (text.trim() || (session?.queuedMessageCount ?? 0) > 0) ? <span className="vis-composer-hint" role="status">{m.sendAfterTurn}</span> : null}
      {session?.queuePaused ? <span className="vis-composer-hint" role="status">{m.queuePaused}</span> : null}
      {resumeError ? <span role="alert">{describeError(resumeError, locale)}</span> : null}
    </fieldset>
  )
}
