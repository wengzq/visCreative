import { useAgents } from '../agents'
import { ChevronDownIcon, useFormat, useLocale, useMessages } from '@vis/ui-kit'
import { workMessages } from '../messages'
import { AgentIcon } from '../AgentIcon'
import { useClock } from '../AgentActivity'
import type { WorkItemView, WorkSessionView, WorkStatus } from '@vis/protocol'
import { useEffect, useRef, useState } from 'react'
import { actionLabels, getQuickActions, getWorkActivity, relativeTime, statusLabels, sessionDoing, workFailureText } from './model'
import { WorkCardMenu, type WorkCardMenuHandle } from './WorkCardMenu'
import { useAgentModels } from '../agentModels'
import { workSessionLabel, type AgentModels } from './sessionLabels'
import './work.css'

export type WorkCardAction = 'locate' | 'board' | 'activate' | 'recall' | 'submitReview' | 'approve' | 'reject' | 'reopen' | 'review' | 'pin' | 'rename' | 'reviewByUser' | 'reviewByParent' | 'directory' | 'copyDirectory' | 'session' | 'inbox' | 'delete'
export type WorkCardThumbnail = { src: string; kind: 'image' | 'video'; alt?: string }
export type WorkCardProps = {
  item: WorkItemView
  agentModels?: AgentModels
  variant?: 'tree' | 'board' | 'compact'
  selected?: boolean
  compact?: boolean
  parentTitle?: string | undefined
  thumbnails?: readonly WorkCardThumbnail[]
  queuePosition?: number | null
  reportChangeCount?: number
  hasCompletionReport?: boolean
  moveTargets?: readonly WorkStatus[]
  onSelect?: ((item: WorkItemView) => void) | undefined
  onSession?: ((item: WorkItemView, session: WorkSessionView) => void) | undefined
  onAction?: ((item: WorkItemView, action: WorkCardAction) => void) | undefined
  onMove?: ((item: WorkItemView, status: WorkStatus) => void) | undefined
}

const QUICK_ACTIONS: Record<string, WorkCardAction> = { activate: 'activate', cancelQueue: 'recall', openSession: 'session', locate: 'locate', recall: 'recall', review: 'review', reopen: 'reopen' }

export function WorkCard(p: WorkCardProps) {
  const { item } = p
  const { locale } = useLocale()
  const agents = useAgents()
  const catalogModels = useAgentModels(item.sessions)
  const models = p.agentModels ?? catalogModels
  const t = useMessages(workMessages)
  const format = useFormat()
  const statuses = statusLabels(locale)
  const actions = actionLabels(locale)
  const board = p.variant === 'board' || p.variant === 'compact'
  const compact = p.compact || p.variant === 'compact'
  const [sessionsOpen, setSessionsOpen] = useState(false)
  const menu = useRef<WorkCardMenuHandle>(null)
  const card = useRef<HTMLElement>(null)
  useEffect(() => {
    if (p.selected) card.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [p.selected])
  const silentSince = item.sessions.reduce<number | null>((since, session) => session.silentSince == null ? since : Math.min(since ?? session.silentSince, session.silentSince), null)
  const now = useClock(silentSince !== null)
  const queued = item.waitingSlotSince !== null
  const waiting = queued ? p.queuePosition ? t.waitingSlotPosition(format.number(p.queuePosition)) : t.waitingSlot : item.waitingOn ? t.waitingReplyExcerpt(item.waitingOn.excerpt) : ''
  const sessionLabel = (session: WorkSessionView) => workSessionLabel(session, item.sessions, agents, locale, models)
  const action = (value: WorkCardAction) => p.onAction?.(item, value)
  useEffect(() => { setSessionsOpen(false) }, [item.workItemId])
  return <article ref={card} role="listitem" tabIndex={0} className={`vis-work-card is-${board ? 'board' : 'tree'}${p.selected ? ' is-selected' : ''}${compact ? ' is-compact' : ''}`} aria-label={t.cardLabel(item.title, statuses[item.status], waiting)} onClick={() => p.onSelect?.(item)} onKeyDown={event => {
    if (event.target !== event.currentTarget) return
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); p.onSelect?.(item) }
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault()
      const bounds = event.currentTarget.getBoundingClientRect()
      menu.current?.open(bounds.right - 210, bounds.top + 28, event.currentTarget)
    }
  }} onContextMenu={event => { event.preventDefault(); event.stopPropagation(); menu.current?.openFromContextMenu(event, card.current) }}>
    <div className="vis-work-card-heading">
      {getWorkActivity(item) !== 'idle' ? <span className={`vis-work-activity is-${getWorkActivity(item)}`} aria-hidden="true" /> : null}
      <span className="vis-work-card-title" title={item.title}>{item.title}</span>
      {item.pinned ? <span className="vis-work-pinned" title={t.pinned} aria-label={t.pinned}>⌖</span> : null}
      {item.unreadCount > 0 ? <span className="vis-work-unread" aria-label={t.unread(format.number(item.unreadCount))}>{format.number(item.unreadCount)}</span> : null}
      <WorkCardMenu ref={menu} item={item} onAction={p.onAction} onMove={p.onMove} moveTargets={p.moveTargets} />
    </div>
    {board && compact && item.spaceName ? <span className="vis-work-project-tag">{item.spaceName}</span> : null}
    {board && !compact && p.parentTitle ? <div className="vis-work-parent" title={p.parentTitle}>↳ {p.parentTitle}</div> : null}
    {silentSince !== null ? <div className="vis-work-silent" role="status">{t.silentWarning(format.number(Math.max(0, Math.floor((now - silentSince) / 60_000))))}</div> : null}
    {item.failure ? item.failure.reason === 'turn_unreported'
      ? <div className="vis-work-silent" role="status">{t.unreportedWarning}</div>
      : <div className="vis-work-failure" role="status">{workFailureText(item.failure, locale)}</div> : null}
    {queued ? <div className="vis-work-waiting">{waiting}</div> : null}
    {item.sessions.length > 1 ? <button type="button" className="vis-work-fold" aria-expanded={sessionsOpen} onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); setSessionsOpen(!sessionsOpen) }}>{t.agents(format.number(item.sessions.length))} <span className={sessionsOpen ? 'is-open' : ''}><ChevronDownIcon /></span></button> : null}
    {item.sessions.length <= 1 || sessionsOpen ? <div className="vis-work-agents">{item.sessions.map(session => <button key={session.sessionId} type="button" className="vis-work-agent" aria-label={t.openAgentSession(sessionLabel(session).agentName)} onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); if (p.onSession) p.onSession(item, session); else action('session') }}>
      <AgentIcon kind={session.agentKind} /><span className="vis-work-agent-name">{sessionLabel(session).agentName}</span>{sessionLabel(session).configLabel ? <span className="vis-work-agent-model" title={sessionLabel(session).configLabel}>{t.agentModelSuffix(sessionLabel(session).configLabel)}</span> : null}<span className="vis-work-doing" title={sessionDoing(session.doing, locale) ?? undefined}>{sessionDoing(session.doing, locale) || (session.archived ? t.archived : t.idle)}</span><time dateTime={session.lastActivityAt === null ? undefined : new Date(session.lastActivityAt).toISOString()}>{relativeTime(session.lastActivityAt, undefined, locale)}</time>
    </button>)}</div> : null}
    {board && !compact && p.thumbnails?.length ? <div className="vis-work-thumbnails">{p.thumbnails.slice(0, 2).map((thumbnail, index) => thumbnail.kind === 'video' ? <video key={`${thumbnail.src}:${index}`} src={thumbnail.src} preload="metadata" muted playsInline aria-label={thumbnail.alt || t.videoArtifact} /> : <img key={`${thumbnail.src}:${index}`} src={thumbnail.src} alt={thumbnail.alt || t.imageArtifact} loading="lazy" />)}</div> : null}
    {board && item.waitingOn ? <button type="button" className="vis-work-waiting vis-work-waiting-link" onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); action('inbox') }}>{t.waitingReplyExcerpt(item.waitingOn.excerpt)}</button> : null}
    {board && item.status === 'in_review' ? <div className="vis-work-review-hint">{p.hasCompletionReport === false ? t.noCompletionReport : t.reportReady(p.reportChangeCount === undefined ? undefined : format.number(p.reportChangeCount))}</div> : null}
    {board && item.pendingFeedback ? <div className="vis-work-feedback">{t.pendingFeedback}</div> : null}
    {board ? <>
      {item.todayGenerations > 0 || item.changeCount > 0 ? <div className="vis-work-card-footer">{item.todayGenerations > 0 ? <span>{t.todayGenerations(format.number(item.todayGenerations))}</span> : null}{item.changeCount > 0 ? <span>{t.activationChanges(format.number(item.changeCount))}</span> : null}</div> : null}
      <div className="vis-work-quick-actions" onPointerDown={event => event.stopPropagation()}>{getQuickActions(item).slice(0, 3).map(quick => <button key={quick} type="button" onClick={event => { event.stopPropagation(); const value = QUICK_ACTIONS[quick]; if (value) action(value) }}>{actions[quick]}</button>)}</div>
    </> : null}
  </article>
}
