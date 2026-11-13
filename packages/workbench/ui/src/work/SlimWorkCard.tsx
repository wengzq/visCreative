import { agentLabel, useAgents } from '../agents'
import { useFormat, useLocale, useMessages } from '@vis/ui-kit'
import { workMessages } from '../messages'
import { AgentIcon } from '../AgentIcon'
import type { WorkItemView, WorkStatus } from '@vis/protocol'
import { useEffect, useRef } from 'react'
import { getWorkActivity, statusLabels, sessionDoing, workFailureText } from './model'
import type { WorkCardAction } from './WorkCard'
import { WorkCardMenu, type WorkCardMenuHandle } from './WorkCardMenu'
import './work.css'

export type SlimWorkCardProps = {
  item: WorkItemView
  selected?: boolean
  parentTitle?: string | undefined
  queuePosition?: number | undefined
  grabbed?: boolean | undefined
  parentTargets?: readonly WorkItemView[] | undefined
  onSelect: (item: WorkItemView) => void
  onAction?: ((item: WorkItemView, action: WorkCardAction) => void) | undefined
  onMove?: ((item: WorkItemView, status: WorkStatus) => void) | undefined
  onReparent?: ((item: WorkItemView, parentId: string | null) => void) | undefined
}

export function SlimWorkCard(p: SlimWorkCardProps) {
  const { item } = p
  const { locale } = useLocale()
  const agents = useAgents()
  const t = useMessages(workMessages)
  const format = useFormat()
  const statuses = statusLabels(locale)
  const menu = useRef<WorkCardMenuHandle>(null)
  const card = useRef<HTMLElement>(null)
  useEffect(() => {
    if (p.selected) card.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [p.selected])
  const queued = item.waitingSlotSince !== null
  const waiting = item.waitingOn ? t.waitingReplyExcerpt(item.waitingOn.excerpt) : queued ? t.queuePosition(p.queuePosition === undefined ? '…' : format.number(p.queuePosition)) : ''
  const unreported = item.failure?.reason === 'turn_unreported'
  const activity = (unreported ? t.unreportedWarning : item.failure ? workFailureText(item.failure, locale) : '') || waiting || item.sessions.filter(session => !session.archived && session.activeTurnId).map(session => `${agentLabel(agents, session.agentKind)} ${sessionDoing(session.doing, locale) || t.working}`).join(' · ') || t.idle
  return <article ref={card} role="listitem" tabIndex={0} aria-grabbed={p.grabbed} className={`vis-work-card vis-slim-card${p.selected ? ' is-selected' : ''}`} aria-label={t.cardLabel(item.title, statuses[item.status], waiting)} onClick={() => p.onSelect(item)} onKeyDown={event => {
    if (event.target !== event.currentTarget) return
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); p.onSelect(item) }
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault()
      const bounds = event.currentTarget.getBoundingClientRect()
      menu.current?.open(bounds.right - 210, bounds.top + 28, event.currentTarget)
    }
  }} onContextMenu={event => { event.preventDefault(); event.stopPropagation(); menu.current?.openFromContextMenu(event, card.current) }}>
    <div className="vis-work-card-heading">
      {getWorkActivity(item) !== 'idle' ? <span className={`vis-work-activity is-${getWorkActivity(item)}`} aria-hidden="true" /> : null}
      <span className="vis-work-card-title" title={item.title}>{item.title}</span>
      <span className="vis-slim-status">{statuses[item.status]}</span>
      {item.unreadCount > 0 ? <span className="vis-work-unread" aria-label={t.unread(format.number(item.unreadCount))}>{format.number(item.unreadCount)}</span> : null}
      <WorkCardMenu ref={menu} item={item} onAction={p.onAction} onMove={p.onMove} onReparent={p.onReparent} parentTargets={p.parentTargets} />
    </div>
    {p.parentTitle ? <div className="vis-work-parent">↳ {p.parentTitle}</div> : null}
    <div className={`vis-slim-activity${unreported ? ' vis-work-silent' : ''}`} role={unreported ? 'status' : undefined}>{[...new Set(item.sessions.map(session => session.agentKind))].map(kind => <AgentIcon key={kind} kind={kind} />)}{activity}</div>
  </article>
}
