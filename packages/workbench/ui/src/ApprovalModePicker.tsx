import { CloseIcon, IconButton, describeError, useLocale, useMessages } from '@vis/ui-kit'
import { isBackdropClick } from './dialogBackdrop'
import type { ApprovalMode } from '@vis/protocol'
import { useEffect, useRef, useState } from 'react'
import { sessionMessages } from './messages'

export function ApprovalModePicker({ mode, onSave }: { mode: ApprovalMode; onSave(mode: ApprovalMode): Promise<void> }) {
  const m = useMessages(sessionMessages)
  const { locale } = useLocale()
  const dialog = useRef<HTMLDialogElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<unknown>(null)
  useEffect(() => {
    if (!confirming) return
    const element = dialog.current
    element?.showModal()
    return () => { element?.close(); trigger.current?.focus() }
  }, [confirming])
  const save = async (next: ApprovalMode) => {
    setBusy(true)
    setError(null)
    try {
      await onSave(next)
      if (next === 'auto') {
        try { localStorage.setItem('vis.approval.auto.confirmed', 'true') } catch { /* With storage disabled, confirm again next time */ }
      }
      setConfirming(false)
    } catch (error) { setError(error) }
    finally { setBusy(false) }
  }
  return <>
    <button ref={trigger} type="button" className="vis-ref-add" title={m.switchApprovalMode} aria-label={m.approvalMode(mode === 'auto' ? m.autoApproval : m.askApproval)} disabled={busy} onClick={() => {
      if (mode === 'auto') { void save('ask'); return }
      let confirmed = false
      try { confirmed = localStorage.getItem('vis.approval.auto.confirmed') === 'true' } catch { /* Use this confirmation */ }
      if (confirmed) void save('auto')
      else setConfirming(true)
    }}><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true"><path d="M8 1 14 4v4c0 3-6 7-6 7S2 11 2 8V4Z" /></svg>{mode === 'auto' ? m.autoApproval : m.askApproval}</button>
    {confirming ? <dialog ref={dialog} onCancel={event => { event.preventDefault(); if (!busy) setConfirming(false) }} aria-label={m.enableAuto} className="vis-dialog vis-approval-confirm" onClick={event => { if (!busy && isBackdropClick(event)) setConfirming(false) }} onKeyDown={event => { if (event.key === 'Escape' && !busy) setConfirming(false) }}>
      <header className="vis-dialog-header"><h2>{m.enableAuto}</h2><IconButton label={m.close} disabled={busy} onClick={() => setConfirming(false)}><CloseIcon /></IconButton></header>
      <div className="vis-dialog-body"><ul><li>{m.autoScope}</li><li>{m.autoOutside}</li><li>{m.autoLimits}</li></ul></div>
      <footer className="vis-dialog-footer">
      <button type="button" autoFocus disabled={busy} onClick={() => setConfirming(false)}>{m.cancel}</button>
      <button className="is-primary" type="button" disabled={busy} onClick={() => void save('auto')}>{m.confirmEnable}</button></footer>
    </dialog> : null}
    {error ? <span role="alert">{describeError(error, locale)}</span> : null}
  </>
}
