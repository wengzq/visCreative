import { CloseIcon, IconButton, useMessages } from '@vis/ui-kit'
import { isBackdropClick } from '../dialogBackdrop'
import { workMessages } from '../messages'
import { type ReactNode, useEffect, useId, useRef } from 'react'
import './work.css'

/** Mount on opening; the native modal constrains focus, and unmounting restores focus to the trigger. */
export interface WorkDialogProps {
  title: string
  onClose(): void
  children: ReactNode
  className?: string
  subtitle?: ReactNode
  footer?: ReactNode
  popover?: boolean
  hasUnsavedInput?: boolean
}

export function WorkDialog({ title, subtitle, onClose, children, footer, className = '', popover = false, hasUnsavedInput = false }: WorkDialogProps) {
  const t = useMessages(workMessages)
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  useEffect(() => {
    const element = ref.current!
    const previous = document.activeElement
    if (popover) element.showPopover()
    else element.showModal()
    return () => {
      if (popover) element.hidePopover()
      else element.close()
      if (previous instanceof HTMLElement && previous.isConnected && (!popover || document.activeElement === document.body || element.contains(document.activeElement))) previous.focus()
    }
  }, [popover])
  return <dialog ref={ref} className={`${popover ? 'vis-popover' : 'vis-dialog'} vis-work-dialog ${className}`} role="dialog" popover={popover ? 'auto' : undefined} onToggle={event => { if (popover && event.newState === 'closed') onClose() }} onClick={event => { if (!hasUnsavedInput && isBackdropClick(event)) onClose() }} aria-labelledby={titleId} onCancel={event => { event.preventDefault(); event.stopPropagation(); onClose() }} onKeyDown={event => event.stopPropagation()}>
    <header className="vis-dialog-header vis-work-dialog-header"><div><h2 id={titleId}>{title}</h2>{subtitle ? <div className="vis-work-muted">{subtitle}</div> : null}</div><IconButton type="button" label={t.closeTitle(title)} onClick={onClose}><CloseIcon /></IconButton></header>
    <div className="vis-dialog-body vis-work-dialog-body">{children}</div>
    {footer ? <footer className="vis-dialog-footer vis-work-dialog-footer">{footer}</footer> : null}
  </dialog>
}
