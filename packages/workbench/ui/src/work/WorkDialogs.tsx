import { describeError, useFormat, useLocale, useMessages } from '@vis/ui-kit'
import { workMessages } from '../messages'
import { AgentChoices, useAgents } from '../agents'
import { DEFAULT_AGENT_KIND } from '@vis/protocol'
import type { AgentKind, MethodResult, WorkItemView } from '@vis/protocol'
import { useEffect, useRef, useState } from 'react'
import { WorkDialog } from './WorkDialog'



export interface DeleteWorkDialogProps {
  title: string
  plan: MethodResult<'work.deletePlan'> | null
  loading?: boolean
  busy?: boolean
  error?: string
  onClose(): void
  onDelete(): void
}

export function DeleteWorkDialog({ title, plan, loading = false, busy = false, error, onClose, onDelete }: DeleteWorkDialogProps) {
  const { locale } = useLocale()
  const t = useMessages(workMessages)
  const format = useFormat()
  const cancel = useRef<HTMLButtonElement>(null)
  useEffect(() => { cancel.current?.focus() }, [])
  const warnings = plan ? [
    ...(plan.runningTurns ? [t.deleteRunningWarning] : []),
    ...(plan.unfinishedJobs ? [t.deleteJobsWarning(format.number(plan.unfinishedJobs))] : []),
    ...(plan.childrenTotal ? [t.deleteChildrenWarning(format.number(plan.childrenTotal), plan.childrenInProgress ? format.number(plan.childrenInProgress) : undefined)] : []),
    ...(plan.unresolvedMessages ? [t.deleteQuestionsWarning(format.number(plan.unresolvedMessages))] : []),
    ...(plan.hasUnreviewedReport ? [t.deleteReportWarning] : []),
    ...(plan.queued ? [t.deleteQueuedWarning] : []),
  ] : []
  return <WorkDialog hasUnsavedInput={busy} title={t.deleteTitle(title)} onClose={onClose}>
    <form className="vis-work-form" onSubmit={event => { event.preventDefault(); if (plan && !loading && !busy) onDelete() }}>
      {loading ? <p role="status" className="vis-work-muted">{t.readingDeletePlan}</p> : null}
      {plan ? <>
        {warnings.length ? <ul className="vis-work-delete-warnings">{warnings.map(warning => <li key={warning}>⚠ {warning}</li>)}</ul> : null}
        <p>{t.deleteKeepsCanvas}</p>
        <p className="vis-work-delete-directory">{t.directoryRetained}<span>{plan.workDir}</span></p>
      </> : null}
      {error ? <p className="vis-work-error" role="alert">{describeError(error, locale)}</p> : null}
      <div className="vis-work-form-actions"><button ref={cancel} type="button" autoFocus onClick={onClose}>{t.cancel}</button><button className="is-danger" type="submit" disabled={!plan || loading || busy}>{busy ? t.deleting : plan && (plan.runningTurns || plan.unfinishedJobs) ? t.stopAndDelete : t.deleted}</button></div>
    </form>
  </WorkDialog>
}

/** With parentId, dispatch with activate:false; otherwise create a root todo item. */
export interface NewTodoInput {
  title: string
  brief: string
  parentId?: string
  agentKind: AgentKind
}

/** parents contains only root work items in the current project; callback rejection preserves input and displays the error. */
export interface NewTodoDialogProps {
  parents: readonly Pick<WorkItemView, 'workItemId' | 'title'>[]
  onClose(): void
  onCreate(input: NewTodoInput): Promise<void>
}

export function NewTodoDialog({ parents, onClose, onCreate }: NewTodoDialogProps) {
  const { locale } = useLocale()
  const t = useMessages(workMessages)
  const [title, setTitle] = useState('')
  const [brief, setBrief] = useState('')
  const [parentId, setParentId] = useState('')
  const agents = useAgents()
  const [agentKind, setAgentKind] = useState<AgentKind>(DEFAULT_AGENT_KIND)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const create = async () => {
    if (busy || !title.trim() || (parentId && (!brief.trim() || !agents.some(agent => agent.kind === agentKind && agent.available)))) return
    setBusy(true)
    setError(null)
    try {
      await onCreate({ title: title.trim(), brief, agentKind, ...(parentId ? { parentId } : {}) })
      onClose()
    } catch (error) { setError(error) }
    finally { setBusy(false) }
  }
  return <WorkDialog hasUnsavedInput={Boolean(busy || title || brief || parentId || agentKind !== DEFAULT_AGENT_KIND)} title={t.newTodo} onClose={onClose}><form className="vis-work-form" onSubmit={event => { event.preventDefault(); void create() }}>
    <label>{t.title}<input autoFocus required maxLength={60} value={title} onChange={event => setTitle(event.target.value)} /></label>
    <label>{t.markdownBrief}<textarea required={!!parentId} maxLength={20_000} rows={6} value={brief} onChange={event => setBrief(event.target.value)} /></label>
    <label>{t.parentItem}<select value={parentId} onChange={event => setParentId(event.target.value)}><option value="">{t.rootItem}</option>{parents.map(parent => <option key={parent.workItemId} value={parent.workItemId}>{parent.title}</option>)}</select></label>
    {parentId ? <fieldset><legend>{t.agent}</legend><div className="vis-agent-segment"><AgentChoices value={agentKind} onChange={setAgentKind} /></div></fieldset> : null}
    {error !== null ? <p className="vis-work-error" role="alert">{describeError(error, locale)}</p> : null}
    <div className="vis-work-form-actions"><button type="button" onClick={onClose}>{t.cancel}</button><button className="is-primary" type="submit" disabled={busy || !title.trim() || (!!parentId && (!brief.trim() || !agents.some(agent => agent.kind === agentKind && agent.available)))}>{busy ? t.creating : t.createTodo}</button></div>
  </form></WorkDialog>
}

/** Rejection feedback is optional: without it, only return the item to in-progress without notifying the Agent. Preserve input on callback rejection. */
export interface RejectDialogProps {
  title: string
  onClose(): void
  onReject(feedback?: string): Promise<void>
}

export function RejectDialog({ title, onClose, onReject }: RejectDialogProps) {
  const { locale } = useLocale()
  const t = useMessages(workMessages)
  const [feedback, setFeedback] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const reject = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try { await onReject(feedback.trim() || undefined); onClose() }
    catch (error) { setError(error) }
    finally { setBusy(false) }
  }
  return <WorkDialog hasUnsavedInput={busy || Boolean(feedback)} title={t.rejectTitle(title)} onClose={onClose}><form className="vis-work-form" onSubmit={event => { event.preventDefault(); void reject() }}>
    <label>{t.feedbackOptional}<textarea autoFocus maxLength={20_000} rows={5} value={feedback} onChange={event => setFeedback(event.target.value)} /></label>
    {error !== null ? <p className="vis-work-error" role="alert">{describeError(error, locale)}</p> : null}
    <div className="vis-work-form-actions"><button type="button" onClick={onClose}>{t.cancel}</button><button type="submit" disabled={busy}>{busy ? t.processingMore : feedback.trim() ? t.rejectWithFeedback : t.reject}</button></div>
  </form></WorkDialog>
}

/** Select a registered Agent before first activation of a work item without sessions. */
export interface AgentChoiceDialogProps {
  title?: string
  isRoot?: boolean
  onClose(): void
  onChoose(agentKind: AgentKind): Promise<void>
}

export function AgentChoiceDialog({ title, isRoot = false, onClose, onChoose }: AgentChoiceDialogProps) {
  const { locale } = useLocale()
  const t = useMessages(workMessages)
  const agents = useAgents()
  const [agentKind, setAgentKind] = useState<AgentKind>(DEFAULT_AGENT_KIND)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const choose = async () => {
    if (busy || !agents.some(agent => agent.kind === agentKind && agent.available)) return
    setBusy(true)
    setError(null)
    try { await onChoose(agentKind); onClose() }
    catch (error) { setError(error) }
    finally { setBusy(false) }
  }
  return <WorkDialog hasUnsavedInput={busy || agentKind !== DEFAULT_AGENT_KIND} title={title ?? t.chooseAgent} onClose={onClose}><form className="vis-work-form" onSubmit={event => { event.preventDefault(); void choose() }}>
    <p>{isRoot ? t.rootAgentHint : t.childAgentHint}</p>
    <fieldset><legend>{t.intelligentAgent}</legend><div className="vis-agent-segment"><AgentChoices value={agentKind} onChange={setAgentKind} /></div></fieldset>
    {error !== null ? <p className="vis-work-error" role="alert">{describeError(error, locale)}</p> : null}
    <div className="vis-work-form-actions"><button type="button" onClick={onClose}>{t.cancel}</button><button type="submit" disabled={busy || !agents.some(agent => agent.kind === agentKind && agent.available)}>{busy ? t.activating : t.activate}</button></div>
  </form></WorkDialog>
}
