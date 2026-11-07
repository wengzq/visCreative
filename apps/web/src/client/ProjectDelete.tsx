import type { MethodResult } from '@vis/protocol'
import { describeError, useFormat, useLocale, useMessages } from '@vis/ui-kit'
import { WorkDialog } from '@vis/workbench-ui'
import { useEffect, useRef } from 'react'
import { settingsMessages } from './messages'

export function ProjectDeleteDialog({ name, plan, loading = false, busy = false, error, onClose, onDelete }: {
  name: string
  plan: MethodResult<'space.deletePlan'> | null
  loading?: boolean
  busy?: boolean
  error?: string
  onClose(): void
  onDelete(): void
}) {
  const m = useMessages(settingsMessages)
  const { locale } = useLocale()
  const format = useFormat()
  const cancel = useRef<HTMLButtonElement>(null)
  useEffect(() => { cancel.current?.focus() }, [])
  const warnings = plan ? [
    ...(plan.runningTurns ? [m.projectDeleteTurns(format.number(plan.runningTurns))] : []),
    ...(plan.unfinishedJobs ? [m.projectDeleteJobs(format.number(plan.unfinishedJobs))] : []),
    ...(plan.workInProgress ? [m.projectDeleteWork(format.number(plan.workInProgress))] : []),
    ...(plan.unresolvedMessages ? [m.projectDeleteMessages(format.number(plan.unresolvedMessages))] : []),
  ] : []
  return <WorkDialog title={m.projectDeleteTitle(name)} onClose={onClose} hasUnsavedInput={busy}>
    <form className="vis-work-form" onSubmit={event => { event.preventDefault(); if (plan && !loading && !busy) onDelete() }}>
      {loading ? <p className="vis-work-muted" role="status">{m.projectDeleteLoading}</p> : null}
      {plan ? <>
        {warnings.length ? <ul className="vis-work-delete-warnings">{warnings.map(warning => <li key={warning}>⚠ {warning}</li>)}</ul> : null}
        <p>{m.projectDeleteHint}</p>
        <p className="vis-work-delete-directory"><span>{plan.rootPath}</span></p>
      </> : null}
      {error ? <p className="vis-work-error" role="alert">{describeError(error, locale)}</p> : null}
      <div className="vis-work-form-actions"><button ref={cancel} type="button" autoFocus onClick={onClose}>{m.cancel}</button><button type="submit" className="is-danger" disabled={!plan || loading || busy}>{busy ? m.deleting : plan && (plan.runningTurns || plan.unfinishedJobs) ? m.projectStopAndDelete : m.delete}</button></div>
    </form>
  </WorkDialog>
}
