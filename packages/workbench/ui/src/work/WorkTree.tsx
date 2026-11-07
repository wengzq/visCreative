import { useFormat, useLocale, useMessages } from '@vis/ui-kit'
import { workMessages } from '../messages'
import type { WorkItemView, WorkSessionView, WorkStatus } from '@vis/protocol'
import { useEffect, useRef, useState, type PointerEvent } from 'react'
import { canReparentWorkItem, getWorkActivity, reparentTargets, sortWorkItems, statusLabels } from './model'
import type { WorkCardAction } from './WorkCard'
import { SlimWorkCard } from './SlimWorkCard'
import { SessionIcon } from '../SessionIcon'
import { childPreview, shortStatus } from './sessionPanelModel'
import type { WorkTreeDrag } from './WorkStatusDropBar'

export type WorkTreeProps = {
  items: readonly WorkItemView[]
  openSessionId?: string | null
  onSelect: (item: WorkItemView) => void
  onSession: (item: WorkItemView, session: WorkSessionView) => void
  onAction?: (item: WorkItemView, action: WorkCardAction) => void
  onMove?: (item: WorkItemView, status: WorkStatus) => void
  onReparent?: (item: WorkItemView, parentId: string | null) => void
  onDragChange?: (drag: WorkTreeDrag | null) => void
  queuePositions?: Record<string, number>
  onCreate?: () => void
  loading?: boolean
  /** Collapse and search state stored by the parent; when omitted, the component stores its own */
  view?: WorkTreeView
  onViewChange?: (view: WorkTreeView) => void
}

export type WorkTreeView = { query: string; doneOpen: boolean; expandedChildren: ReadonlySet<string> }
export const EMPTY_TREE_VIEW: WorkTreeView = { query: '', doneOpen: false, expandedChildren: new Set() }

type Drag = { item: WorkItemView; pointerId: number; x: number; y: number; active: boolean; capture: HTMLElement }
type DropTarget = { kind: 'status'; status: WorkStatus } | { kind: 'parent'; item: WorkItemView }

export function WorkTree(p: WorkTreeProps) {
  const { locale } = useLocale()
  const t = useMessages(workMessages)
  const format = useFormat()
  const statuses = statusLabels(locale)
  const [ownView, setOwnView] = useState(EMPTY_TREE_VIEW)
  const [dragging, setDragging] = useState<WorkItemView | null>(null)
  const [target, setTarget] = useState<DropTarget | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const drag = useRef<Drag | null>(null)
  const tree = useRef<HTMLElement>(null)
  const suppressClick = useRef(false)
  const dragChanged = useRef(p.onDragChange)
  dragChanged.current = p.onDragChange
  const clearDrag = () => {
    const current = drag.current
    drag.current = null
    setDragging(null)
    setTarget(null)
    dragChanged.current?.(null)
    if (current?.capture.hasPointerCapture(current.pointerId)) current.capture.releasePointerCapture(current.pointerId)
  }
  useEffect(() => {
    const cancel = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !drag.current) return
      event.preventDefault()
      suppressClick.current = drag.current.active
      clearDrag()
      setAnnouncement(t.dragCancelled)
    }
    window.addEventListener('keydown', cancel)
    return () => { window.removeEventListener('keydown', cancel); clearDrag() }
  }, [p.items[0]?.spaceId, locale])
  const destinationAt = (item: WorkItemView, x: number, y: number): DropTarget | null => {
    const element = document.elementFromPoint(x, y)
    const status = element?.closest<HTMLElement>('[data-work-status-drop]')?.dataset.workStatusDrop as WorkStatus | undefined
    if (status && p.onMove) return { kind: 'status', status }
    const parentElement = element?.closest<HTMLElement>('[data-work-parent-drop]')
    const parent = p.items.find(candidate => candidate.workItemId === parentElement?.dataset.workParentDrop)
    return parent && tree.current?.contains(parentElement!) && p.onReparent && canReparentWorkItem(item, parent) ? { kind: 'parent', item: parent } : null
  }
  const finishDrag = (event: PointerEvent, cancelled = false) => {
    const current = drag.current
    if (!current || current.pointerId !== event.pointerId) return
    const destination = !cancelled && current.active ? destinationAt(current.item, event.clientX, event.clientY) : null
    if (current.active) {
      suppressClick.current = true
      if (destination?.kind === 'status') p.onMove?.(current.item, destination.status)
      if (destination?.kind === 'parent') p.onReparent?.(current.item, destination.item.workItemId)
      setAnnouncement(destination ? t.dropped(current.item.title) : t.dragCancelled)
    }
    clearDrag()
  }
  const view = p.view ?? ownView
  const setView = (patch: Partial<WorkTreeView>) => (p.onViewChange ?? setOwnView)({ ...view, ...patch })
  const { query, doneOpen, expandedChildren } = view
  const setQuery = (value: string) => setView({ query: value })
  const setDoneOpen = (value: boolean) => setView({ doneOpen: value })
  const searching = query.trim().length > 0
  const matches = (item: WorkItemView) => item.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
  const sorted = sortWorkItems(p.items)
  const done = sorted.filter(item => item.status === 'done' && matches(item))
  const toggleChildren = (id: string) => {
    const next = new Set(expandedChildren)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setView({ expandedChildren: next })
  }
  const card = (item: WorkItemView, parentTitle?: string) => {
    const moving = dragging?.workItemId === item.workItemId
    const allowed = !!dragging && !!p.onReparent && canReparentWorkItem(dragging, item)
    return <div key={item.workItemId} data-work-parent-drop={item.workItemId} className={`vis-work-tree-drag${moving ? ' is-dragging' : ''}${allowed ? ' is-reparent-allowed' : ''}${target?.kind === 'parent' && target.item.workItemId === item.workItemId ? ' is-reparent-over' : ''}`} style={moving ? { pointerEvents: 'none' } : undefined}
      onClickCapture={event => { if (suppressClick.current) { event.preventDefault(); event.stopPropagation(); suppressClick.current = false } }}
      onPointerDown={event => {
        suppressClick.current = false
        if ((!p.onMove && !p.onReparent) || event.button !== 0 || (event.target as HTMLElement).closest('button,input,textarea,select,a,[role="menu"]')) return
        const capture = event.currentTarget.querySelector<HTMLElement>('.vis-work-card')!
        drag.current = { item, pointerId: event.pointerId, x: event.clientX, y: event.clientY, active: false, capture }
        capture.setPointerCapture(event.pointerId)
      }}
      onPointerMove={event => {
        const current = drag.current
        if (!current || current.pointerId !== event.pointerId) return
        current.active ||= Math.hypot(event.clientX - current.x, event.clientY - current.y) > 5
        if (!current.active) return
        event.preventDefault()
        const destination = destinationAt(current.item, event.clientX, event.clientY)
        setDragging(current.item)
        setTarget(destination)
        dragChanged.current?.({ item: current.item, status: destination?.kind === 'status' ? destination.status : null })
        setAnnouncement(destination?.kind === 'status' ? t.dropStatus(statuses[destination.status]) : destination?.kind === 'parent' ? t.asChild(destination.item.title) : t.dragging(current.item.title))
      }} onPointerUp={event => finishDrag(event)} onPointerCancel={event => finishDrag(event, true)} onLostPointerCapture={event => { if (drag.current) finishDrag(event, true) }}>
      <SlimWorkCard item={item} parentTitle={parentTitle} selected={item.sessions.some(session => session.sessionId === p.openSessionId)} grabbed={!!moving} onSelect={p.onSelect} onAction={p.onAction} onMove={p.onMove} onReparent={p.onReparent} parentTargets={reparentTargets(item, sorted)} queuePosition={p.queuePositions?.[item.workItemId]} />
    </div>
  }
  const roots = sorted.filter(item => item.status !== 'done' && (!item.parentId || !p.items.some(parent => parent.workItemId === item.parentId && parent.status !== 'done')))
  return <section ref={tree} className="vis-work-tree" aria-label={t.workspace}>
    <span className="vis-work-drag-announcement" role="status" aria-live="polite" aria-atomic="true">{announcement}</span>
    <div className="vis-work-tree-toolbar"><input type="search" aria-label={t.searchItems} placeholder={t.searchTitle} value={query} onChange={event => setQuery(event.target.value)} /></div>
    <div role="list" aria-label={t.workItems} className="vis-work-tree-list" aria-busy={p.loading || undefined}>
      {roots.map(item => {
        const all = sorted.filter(child => child.parentId === item.workItemId)
        const children = all.filter(child => child.status !== 'done' && matches(child))
        if (!matches(item) && !children.length) return null
        const finished = all.filter(child => child.status === 'done').length
        const expanded = searching || children.length <= 3 || expandedChildren.has(item.workItemId)
        return <div key={item.workItemId} className="vis-work-tree-node">
          {card(item)}
          {children.length > 3 && !searching ? <button type="button" className="vis-work-fold vis-work-children-fold" aria-expanded={expanded} onClick={() => toggleChildren(item.workItemId)}>{t.childItems(format.number(all.length), finished ? format.number(finished) : undefined)} <span aria-hidden="true" className={expanded ? 'is-open' : undefined}><SessionIcon kind="chevron" /></span></button> : null}
          {children.length ? <div role="list" aria-label={t.childItemsLabel(item.title)} className="vis-work-tree-children">{expanded ? <>{children.map(child => card(child))}{children.length > 3 && !searching ? <button type="button" className="vis-work-fold vis-work-children-more" onClick={() => toggleChildren(item.workItemId)}>{t.collapse}</button> : null}</> : <>{childPreview(children).map(child => <button key={child.workItemId} type="button" className="vis-child-preview" aria-label={t.childPreviewLabel(child.title, shortStatus(child, p.queuePositions?.[child.workItemId], locale))} onClick={() => p.onSelect(child)}>{getWorkActivity(child) !== 'idle' ? <span className={`vis-work-activity is-${getWorkActivity(child)}`} aria-hidden="true" /> : null}<span className="vis-work-card-title">{child.title}</span><span>{shortStatus(child, p.queuePositions?.[child.workItemId], locale)}</span>{child.unreadCount ? <span className="vis-work-unread" aria-label={t.unread(format.number(child.unreadCount))}>{format.number(child.unreadCount)}</span> : null}</button>)}<button type="button" className="vis-work-fold vis-work-children-more" onClick={() => toggleChildren(item.workItemId)}>{t.moreChildren(format.number(children.length - 3))}</button></>}</div> : null}
        </div>
      })}
      {done.length ? <div className="vis-work-done-group"><button type="button" className="vis-work-fold" aria-expanded={doneOpen || searching} onClick={() => setDoneOpen(!doneOpen)}>{t.doneItemsCount(format.number(done.length))} <span aria-hidden="true" className={doneOpen || searching ? 'is-open' : undefined}><SessionIcon kind="chevron" /></span></button>{doneOpen || searching ? <div role="list" aria-label={t.doneItems}>{done.map(item => card(item, p.items.find(parent => parent.workItemId === item.parentId)?.title))}</div> : null}</div> : null}
      {!sorted.some(matches) ? <p className="vis-work-tree-empty">{p.loading ? t.loadingItems : searching ? t.noMatchingItems : t.noItems}</p> : null}
    </div>
  </section>
}
