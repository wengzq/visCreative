import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { CloseIcon, IconButton, useMessages } from '@vis/ui-kit'
import { settingsMessages } from './messages'
import './settings.css'

export function SettingsDialog({ title, onClose, children, footer }: { title: string; onClose(): void; children: ReactNode; footer?: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
  const m = useMessages(settingsMessages)
  useEffect(() => {
    const element = ref.current!
    const previous = document.activeElement as HTMLElement | null
    element.showModal()
    return () => { element.close(); if (previous?.isConnected) previous.focus() }
  }, [])
  return createPortal(<dialog ref={ref} className="vis-dialog library-settings-dialog" aria-label={title}
    onCancel={event => { event.preventDefault(); onClose() }} onPointerDown={event => event.stopPropagation()}
    onKeyDown={event => event.stopPropagation()}>
    <header className="vis-dialog-header"><h2>{title}</h2><IconButton label={m.close} onClick={onClose}><CloseIcon /></IconButton></header>
    <div className="vis-dialog-body">{children}</div>
    {footer ? <footer className="vis-dialog-footer">{footer}</footer> : null}
  </dialog>, document.body)
}
