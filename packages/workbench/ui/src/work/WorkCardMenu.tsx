import { useLocale, useMessages } from '@vis/ui-kit'
import { workMessages } from '../messages'
import type { WorkItemView, WorkStatus } from '@vis/protocol'
import { type KeyboardEvent, type Ref, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import type { WorkCardAction } from './WorkCard'
import { statusLabels, STATUS_ORDER } from './model'
import './work.css'

export type WorkCardMenuHandle = {
  open(x: number, y: number, focus: HTMLElement | null): void
  openFromContextMenu(event: { clientX: number; clientY: number; buttons: number }, focus: HTMLElement | null): void
}
export type WorkCardMenuProps = {
  item: WorkItemView
  onAction?: ((item: WorkItemView, action: WorkCardAction) => void) | undefined
  onMove?: ((item: WorkItemView, status: WorkStatus) => void) | undefined
  moveTargets?: readonly WorkStatus[] | undefined
  parentTargets?: readonly WorkItemView[] | undefined
  onReparent?: ((item: WorkItemView, parentId: string | null) => void) | undefined
  ref?: Ref<WorkCardMenuHandle>
}

export function WorkCardMenu(p: WorkCardMenuProps) {
  const { item } = p
  const { locale } = useLocale()
  const t = useMessages(workMessages)
  const statuses = statusLabels(locale)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [movesOpen, setMovesOpen] = useState(false)
  const [parentsOpen, setParentsOpen] = useState(false)
  const dialog = useRef<HTMLDialogElement>(null)
  const returnFocus = useRef<HTMLElement | null>(null)
  const targets = p.moveTargets ?? STATUS_ORDER.filter(status => status !== item.status)
  const open = (x: number, y: number, focus: HTMLElement | null) => {
    returnFocus.current = focus
    setMovesOpen(false)
    setParentsOpen(false)
    setMenu({ x, y })
  }
  // macOS fires contextmenu while the button is still down; opening then lets the release outside the popover light-dismiss it.
  const openFromContextMenu: WorkCardMenuHandle['openFromContextMenu'] = (event, focus) => {
    const { clientX, clientY } = event
    if (!event.buttons) return open(clientX, clientY, focus)
    window.addEventListener('pointerup', () => setTimeout(() => open(clientX, clientY, focus)), { once: true, capture: true })
  }
  useImperativeHandle(p.ref, () => ({ open, openFromContextMenu }))
  useLayoutEffect(() => {
    if (!menu) return
    const element = dialog.current!
    element.showPopover()
    const bounds = element.getBoundingClientRect()
    element.style.left = `${Math.max(8, Math.min(menu.x, window.innerWidth - bounds.width - 8))}px`
    const top = Math.max(8, Math.min(menu.y, window.innerHeight - bounds.height - 8))
    element.style.top = `${top}px`
    element.style.maxHeight = `${window.innerHeight - top - 8}px`
    element.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    return () => {
      element.hidePopover()
      if (returnFocus.current?.isConnected && (document.activeElement === document.body || element.contains(document.activeElement))) returnFocus.current.focus()
    }
  }, [menu])
  useEffect(() => { setMenu(null) }, [item.workItemId])
  const closeMenu = () => setMenu(null)
  const menuAction = (value: WorkCardAction) => { closeMenu(); p.onAction?.(item, value) }
  const menuButton = (value: WorkCardAction, label: string, disabled = false) => <button key={value} type="button" role="menuitem" title={value === 'directory' ? item.workDir : undefined} disabled={disabled || !p.onAction} onClick={() => menuAction(value)}>{label}</button>
  const queued = item.waitingSlotSince !== null
  const statusActions: Array<[WorkCardAction, string]> = item.status === 'todo'
    ? [[queued ? 'recall' : 'activate', queued ? t.cancelQueue : t.activate]]
    : item.status === 'in_progress' ? [['submitReview', t.submitReview], ['recall', t.recall]]
      : item.status === 'in_review' ? [['approve', t.approve], ['reject', t.reject], ['recall', t.recall]]
        : [['reopen', t.reopen]]
  const menuKeys = (event: KeyboardEvent<HTMLDialogElement>) => {
    event.stopPropagation()
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
    event.preventDefault()
    buttons[next]?.focus()
  }
  return <>
    <button type="button" className="vis-work-menu-trigger" aria-label={t.moreActions(item.title)} aria-haspopup="menu" aria-expanded={menu !== null} onPointerDown={event => event.stopPropagation()} onClick={event => {
      event.stopPropagation()
      const bounds = event.currentTarget.getBoundingClientRect()
      open(bounds.right - 210, bounds.bottom + 4, event.currentTarget)
    }}><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></svg></button>
    {menu ? <dialog ref={dialog} className="vis-popover vis-work-card-menu" popover="auto" onToggle={event => { if (event.newState === 'closed') closeMenu() }} aria-label={t.itemActions(item.title)} onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); if (event.target === event.currentTarget) { const bounds = event.currentTarget.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) closeMenu() } }} onKeyDown={menuKeys} onCancel={event => { event.preventDefault(); closeMenu() }}>
      <div role="menu">
        {item.changeCount > 0 ? menuButton('locate', t.locate) : null}
        {menuButton('board', t.viewBoard)}
        <hr />
        {statusActions.map(([value, label]) => menuButton(value, label))}
        {p.onMove || p.onReparent ? <><button type="button" role="menuitem" aria-expanded={movesOpen} onClick={() => setMovesOpen(!movesOpen)}>{t.moveTo}</button>{movesOpen ? <div className="vis-work-move-options" role="group" aria-label={t.moveWorkspace}>
          {p.onMove ? targets.map(status => <button key={status} type="button" role="menuitem" onClick={() => { closeMenu(); p.onMove?.(item, status) }}>{statuses[status]}</button>) : null}
          {p.onReparent ? <><button type="button" role="menuitem" aria-expanded={parentsOpen} disabled={!p.parentTargets?.length} title={item.childIds.length ? t.hasChildren : !p.parentTargets?.length ? t.noRootTargets : undefined} onClick={() => setParentsOpen(!parentsOpen)}>{t.moveAsChild}</button>{parentsOpen ? <div className="vis-work-move-options" role="group" aria-label={t.targetRoot}>{p.parentTargets?.map(parent => <button key={parent.workItemId} type="button" role="menuitem" onClick={() => { closeMenu(); p.onReparent?.(item, parent.workItemId) }}>{parent.title}</button>)}</div> : null}</> : null}
        </div> : null}</> : null}
        {p.onReparent && item.parentId ? <button type="button" role="menuitem" disabled={item.childIds.length > 0} onClick={() => { closeMenu(); p.onReparent?.(item, null) }}>{t.moveToRoot}</button> : null}
        <hr />
        {menuButton('pin', item.pinned ? t.unpin : t.pin)}
        {menuButton('rename', t.rename)}
        {item.parentId ? <div className="vis-work-review-by"><span>{t.reviewer}</span><button type="button" role="menuitemradio" aria-checked={item.reviewBy === 'user'} disabled={!p.onAction} onClick={() => menuAction('reviewByUser')}>{t.me}{item.reviewBy === 'user' ? ' ✓' : ''}</button><button type="button" role="menuitemradio" aria-checked={item.reviewBy === 'parent'} disabled={!p.onAction} onClick={() => menuAction('reviewByParent')}>{t.parentReview}{item.reviewBy === 'parent' ? ' ✓' : ''}</button></div> : null}
        <hr />
        {menuButton('directory', t.openDirectory)}
        {menuButton('copyDirectory', t.copyDirectory)}
        <hr />
        <button type="button" role="menuitem" className="is-danger" disabled={!p.onAction} onClick={() => menuAction('delete')}>{t.deleteMore}</button>
      </div>
    </dialog> : null}
  </>
}
