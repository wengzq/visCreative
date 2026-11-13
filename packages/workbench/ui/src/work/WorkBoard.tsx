import { CloseIcon, IconButton, RunningIcon, useFormat, useLocale, useMessages } from '@vis/ui-kit'
import { workMessages } from '../messages'
import { useEffect, useRef, useState, type PointerEvent } from 'react'
import type { WorkItemView, WorkSlotsView, WorkStatus } from '@vis/protocol'
import { WorkCard, type WorkCardProps } from './WorkCard'
import { BOARD_STATUSES, statusLabels, boardChildGroups, getDropAction, groupBoardItems, getWorkActivity, queuePosition, type DropResult } from './model'
import './work.css'

export type WorkBoardProps = {
  items: readonly WorkItemView[]
  spaceId: string
  selectedId?: string
  spaceName: string
  projects: readonly { spaceId: string; name: string }[]
  slots: WorkSlotsView
  onAction: NonNullable<WorkCardProps['onAction']>
  onSelect: WorkCardProps['onSelect']
  onSession?: WorkCardProps['onSession']
  onTransition(item: WorkItemView, result: DropResult): void
  onCreate(): void
  onSlots(): void
  onScopeChange?(scope: 'space' | 'all'): void
  cardDetails?(item: WorkItemView): Pick<WorkCardProps, 'thumbnails' | 'reportChangeCount' | 'hasCompletionReport'>
}

type Drag = { item: WorkItemView; pointerId: number; x: number; y: number; dx: number; dy: number; active: boolean; element: HTMLElement; capture: HTMLElement }

export function WorkBoard(p: WorkBoardProps) {
  const { locale } = useLocale()
  const t = useMessages(workMessages)
  const format = useFormat()
  const statuses = statusLabels(locale)
  const [scope, setScope] = useState<'space' | 'all'>('all')
  useEffect(() => { p.onScopeChange?.(scope) }, [scope, p.onScopeChange])
  const [projects, setProjects] = useState<string[]>([])
  const [older, setOlder] = useState(false)
  const [expandedChildren, setExpandedChildren] = useState<ReadonlySet<string>>(() => new Set())
  const [dragging, setDragging] = useState<Drag | null>(null)
  const [target, setTarget] = useState<WorkStatus | 'pinned' | null>(null)
  const drag = useRef<Drag | null>(null)
  const suppressClick = useRef(false)
  const board = useRef<HTMLElement>(null)
  const visible = p.items.filter(item => scope === 'space' ? item.spaceId === p.spaceId : !projects.length || projects.includes(item.spaceId))
  const groups = groupBoardItems(visible)
  const move = (item: WorkItemView, destination: WorkStatus | 'pinned') => {
    const result = getDropAction(item, destination)
    if (result.action !== 'none') p.onTransition(item, result)
    return true
  }
  const destinationAt = (x: number, y: number) => {
    const element = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-work-drop]')
    return element && board.current?.contains(element) ? element.dataset.workDrop as WorkStatus | 'pinned' : null
  }
  const finish = (event: PointerEvent, cancelled = false) => {
    const current = drag.current
    if (!current || current.pointerId !== event.pointerId) return
    drag.current = null
    const destination = cancelled ? null : destinationAt(event.clientX, event.clientY)
    if (current.active) {
      suppressClick.current = true
      const accepted = destination !== null && move(current.item, destination)
      if (!accepted && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
        current.element.animate([{ transform: `translate(${current.dx}px, ${current.dy}px)`, opacity: .65 }, { transform: 'translate(0, 0)', opacity: 1 }], { duration: 200, easing: 'ease-out' })
      }
      window.setTimeout(() => { suppressClick.current = false }, 0)
    }
    setDragging(null)
    setTarget(null)
    if (current.capture.hasPointerCapture(event.pointerId)) current.capture.releasePointerCapture(event.pointerId)
  }
  return <section ref={board} className="vis-work-board" aria-label={t.board} onKeyDown={event => {
    if (event.key === 'Escape' && drag.current) {
      const current = drag.current
      drag.current = null
      if (current.capture.hasPointerCapture(current.pointerId)) current.capture.releasePointerCapture(current.pointerId)
      setDragging(null)
      setTarget(null)
    }
  }}>
    <header className="vis-work-board-heading">
      <h1>{t.board}</h1>
      <div role="tablist" aria-label={t.boardScope}>{(['all', 'space'] as const).map(value => <button key={value} role="tab" aria-selected={scope === value} onClick={() => setScope(value)}>{value === 'space' ? t.currentProject : t.allProjects}</button>)}</div>
      <button className={`vis-work-board-slots${p.slots.used >= p.slots.limit ? ' is-full' : ''}`} onClick={p.onSlots}><RunningIcon active={p.slots.used > 0} />{t.globalRunning(format.number(p.slots.used), format.number(p.slots.limit))}</button>
    </header>
    {scope === 'all' ? <div className="vis-work-project-filters" aria-label={t.projectFilter}><button aria-pressed={!projects.length} onClick={() => setProjects([])}>{t.all}</button>{p.projects.map(project => <button key={project.spaceId} aria-pressed={projects.includes(project.spaceId)} onClick={() => setProjects(current => current.includes(project.spaceId) ? current.filter(id => id !== project.spaceId) : [...current, project.spaceId])}>{project.name}</button>)}</div> : null}
    {groups.pinned.length || dragging?.active ? <div className={`vis-work-pins${!groups.pinned.length ? ' is-drop-target' : ''}${target === 'pinned' ? ' is-over' : ''}`} data-work-drop="pinned" aria-label={t.pinned}><span>{groups.pinned.length ? t.pinned : t.pinHint}</span>{groups.pinned.map(item => <div key={`${item.spaceId}:${item.workItemId}`} className="vis-work-pin"><button onClick={() => p.onSelect?.(item)}>{getWorkActivity(item) !== 'idle' ? <span className={`vis-work-activity is-${getWorkActivity(item)}`} /> : null}{item.title} <small>{statuses[item.status]}</small></button><IconButton label={t.unpinTitle(item.title)} onClick={() => p.onAction(item, 'pin')}><CloseIcon /></IconButton></div>)}</div> : null}
    {!visible.length ? <p className="vis-work-board-empty">{t.boardEmpty}</p> : null}
    <div className="vis-work-columns">{BOARD_STATUSES.map(status => {
      const cards = status === 'done' && older ? [...groups.done, ...groups.olderDone] : groups[status]
      return <section key={status} className={`vis-work-column${dragging?.active ? ' is-allowed' : ''}${target === status ? ' is-over' : ''}`} data-work-drop={status} aria-label={statuses[status]}>
        <header><span className={`vis-work-status-dot is-${status}`} /><h2>{statuses[status]}</h2><span>{format.number(cards.length)}</span>{status === 'todo' ? <button aria-label={t.newTodo} onClick={p.onCreate}>{t.newTodoSymbol}</button> : null}</header>
        <div className="vis-work-column-scroll"><div role="list" aria-label={t.statusItems(statuses[status])}>{boardChildGroups(cards, expandedChildren).map(group => <div key={group.key}>{group.items.map(item => {
          const moving = dragging?.active && dragging.item.workItemId === item.workItemId && dragging.item.spaceId === item.spaceId
          return <div key={`${item.spaceId}:${item.workItemId}`} className={`vis-work-drag${moving ? ' is-dragging' : ''}`} style={moving ? { pointerEvents: 'none' } : undefined}
            onClickCapture={event => { if (suppressClick.current) { event.preventDefault(); event.stopPropagation() } }}
            onPointerDown={event => {
              if (event.button !== 0 || (event.target as HTMLElement).closest('button,input,textarea,select,a,[role="menu"]')) return
              const capture = event.currentTarget.querySelector<HTMLElement>('.vis-work-card')!
              drag.current = { item, pointerId: event.pointerId, x: event.clientX, y: event.clientY, dx: 0, dy: 0, active: false, element: event.currentTarget, capture }
              capture.setPointerCapture(event.pointerId)
            }}
            onPointerMove={event => {
              const current = drag.current
              if (!current || current.pointerId !== event.pointerId) return
              current.dx = event.clientX - current.x
              current.dy = event.clientY - current.y
              current.active ||= Math.hypot(current.dx, current.dy) > 5
              if (current.active) { event.preventDefault(); setDragging({ ...current }); setTarget(destinationAt(event.clientX, event.clientY)) }
            }} onPointerUp={event => finish(event)} onPointerCancel={event => finish(event, true)} onLostPointerCapture={event => { if (drag.current) finish(event, true) }}>
            <WorkCard item={item} selected={p.selectedId === item.workItemId} variant={scope === 'all' ? 'compact' : 'board'} parentTitle={p.items.find(parent => parent.spaceId === item.spaceId && parent.workItemId === item.parentId)?.title} queuePosition={queuePosition(item, p.slots)} onAction={p.onAction} onSelect={p.onSelect} onSession={p.onSession} onMove={(card, destination) => { move(card, destination) }} {...p.cardDetails?.(item)} />
          </div>
        })}{group.collapsible ? <button className="vis-work-children-toggle" aria-expanded={expandedChildren.has(group.key)} aria-label={t.childrenToggleLabel(p.items.find(parent => parent.spaceId === group.items[0]!.spaceId && parent.workItemId === group.items[0]!.parentId)?.title ?? t.workspace, group.hidden ? t.moreItems(format.number(group.hidden)) : t.collapseChildren)} onClick={() => setExpandedChildren(current => { const next = new Set(current); if (next.has(group.key)) next.delete(group.key); else next.add(group.key); return next })}>{group.hidden ? t.moreItems(format.number(group.hidden)) : t.collapseChildren}</button> : null}</div>)}</div>
        {!cards.length ? <p className="vis-work-column-empty">{t.none}</p> : null}
        {status === 'done' && groups.olderDone.length ? <button className="vis-work-older" aria-expanded={older} onClick={() => setOlder(value => !value)}>{older ? t.collapseOlder : t.olderItems(format.number(groups.olderDone.length))}</button> : null}
        </div>
      </section>
    })}</div>
    {dragging?.active ? <div className="vis-work-drag-preview" aria-hidden="true" style={{ left: dragging.x + dragging.dx + 12, top: dragging.y + dragging.dy + 12 }}>{dragging.item.title}</div> : null}
  </section>
}
