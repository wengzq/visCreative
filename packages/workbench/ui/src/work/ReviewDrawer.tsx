import { workFailureText, workMessageLabel } from './model'
import { describeError, useFormat, useLocale, useMessages } from '@vis/ui-kit'
import { workMessages } from '../messages'
import type { WorkChange, WorkItemView, WorkMessageView } from '@vis/protocol'
import { useEffect, useRef, useState } from 'react'
import { AgentMarkdown } from '../AgentMarkdown'
import type { RefPreview } from '../RefThumb'
import { ScriptSummary } from '../RefThumb'
import { SessionIcon } from '../SessionIcon'
import { relativeTime } from './model'
import { WorkDialog } from './WorkDialog'

/** The host supplements work.changes with titles and before/after revision previews from slot.history. */
export interface ReviewChangePreview extends WorkChange {
  title: string
  before?: RefPreview | null
  after?: RefPreview | null
}

/** The caller handles data loading and RPC; messages includes all loaded pages. */
export interface ReviewDrawerProps {
  item: WorkItemView
  spaceName?: string
  messages: readonly WorkMessageView[]
  /** This round's completion report; pass null for manual user review submission without a report, never substitute a historical report. */
  completionReport: WorkMessageView | null
  changes: readonly ReviewChangePreview[]
  hasMore: boolean
  loading?: boolean
  error?: string
  warning?: string
  loadingMore?: boolean
  incompleteChildren?: readonly Pick<WorkItemView, 'workItemId' | 'title'>[]
  onClose(): void
  onLoadMore(): void | Promise<void>
  onLocateNode(input: { spaceId: string; nodeId: string }): void
  onApprove(): Promise<void>
  onReject(feedback?: string): Promise<void>
}

export function ReviewDrawer(p: ReviewDrawerProps) {
  const { locale } = useLocale()
  const t = useMessages(workMessages)
  const format = useFormat()
  const changeLabels = { created: t.created, updated: t.updated, deleted: t.deleted }
  const [rejecting, setRejecting] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [busy, setBusy] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  const messages = [...p.messages].sort((a, b) => a.createdAt - b.createdAt || a.messageId.localeCompare(b.messageId))
  const latestDone = p.completionReport
  const incomplete = p.incompleteChildren ?? []
  // Unfinished child work items only trigger a notice; users can still approve directly
  const disabled = busy || !!p.loading || !!p.error || p.item.status !== 'in_review'
  const decide = async (decision: 'approve' | 'reject') => {
    if (disabled) return
    setBusy(true)
    setError(null)
    try {
      if (decision === 'approve') await p.onApprove()
      else await p.onReject(feedback.trim() || undefined)
      if (mounted.current) p.onClose()
    } catch (error) { if (mounted.current) setError(error) }
    finally { if (mounted.current) setBusy(false) }
  }
  const loadMore = async () => {
    if (loadingMore || p.loadingMore) return
    setLoadingMore(true)
    setError(null)
    try { await p.onLoadMore() }
    catch (error) { if (mounted.current) setError(error) }
    finally { if (mounted.current) setLoadingMore(false) }
  }
  return <WorkDialog hasUnsavedInput={busy || Boolean(feedback)} title={p.item.title} className="vis-work-review" onClose={p.onClose} subtitle={<>{p.spaceName ?? p.item.spaceName ?? p.item.spaceId} · {p.item.reviewBy === 'user' ? t.reviewerMe : t.parentReview}</>} footer={<div className="vis-work-review-actions">
    {incomplete.length ? <p className="vis-work-notice">{t.incompleteChildren(incomplete.map(child => child.title))}</p> : null}
    {p.error || error !== null ? <p className="vis-work-error" role="alert">{describeError(p.error || error, locale)}</p> : null}
    {rejecting ? <label>{t.rejectFeedbackOptional}<textarea autoFocus aria-label={t.rejectFeedback} maxLength={20_000} rows={4} disabled={busy} value={feedback} onChange={event => setFeedback(event.target.value)} /></label> : null}
    <div className="vis-work-form-actions">{rejecting ? <><button disabled={busy} onClick={() => setRejecting(false)}>{t.cancelReject}</button><button disabled={disabled} onClick={() => void decide('reject')}>{feedback.trim() ? t.rejectWithFeedback : t.reject}</button></> : <button disabled={disabled} onClick={() => setRejecting(true)}>{t.reject}</button>}<button className="is-primary" disabled={disabled} onClick={() => void decide('approve')}>{busy ? t.processingMore : t.approve}</button></div>
  </div>}>
    {p.loading ? <p className="vis-work-notice" role="status">{t.readingReview}</p> : null}
    {p.warning ? <p className="vis-work-notice" role="alert">{p.warning}</p> : null}
    <section><h3>{t.completionReport}</h3>{latestDone ? <div className="vis-work-markdown"><AgentMarkdown>{latestDone.body}</AgentMarkdown></div> : p.loading ? null : <p className="vis-work-notice">{t.noCompletionReport}</p>}</section>
    <section><h3>{t.artifactChanges}</h3>{p.changes.length ? p.changes.map((change, index) => <article className="vis-work-change" key={`${change.nodeId}/${change.slotId ?? ''}/${index}`}>
      <button className="vis-work-change-title" aria-label={t.locateNode(change.title)} onClick={() => p.onLocateNode({ spaceId: p.item.spaceId, nodeId: change.nodeId })}>{change.nodeKind === 'frame' ? <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 8h18" /></svg> : <SessionIcon kind={change.nodeKind} />}<strong>{change.title}</strong><span className="vis-work-badge">{changeLabels[change.change]}</span></button>
      {change.change === 'deleted' ? <div><h4>{t.beforeDeletion}{change.fromRevision !== null ? ` · r${format.number(change.fromRevision)}` : ''}</h4><ChangePreview preview={change.before} absent={t.noPreview} /></div> : <div className="vis-work-comparison"><div><h4>{t.beforeChange}{change.fromRevision !== null ? ` · r${format.number(change.fromRevision)}` : ''}</h4><ChangePreview preview={change.before} absent={change.change === 'created' ? t.notCreated : t.noPreview} /></div><div><h4>{t.afterChange}{change.toRevision !== null ? ` · r${format.number(change.toRevision)}` : ''}</h4><ChangePreview preview={change.after} absent={t.noPreview} /></div></div>}
    </article>) : <p className="vis-work-muted">{t.noChanges}</p>}</section>
    <details className="vis-work-history"><summary>{t.messageHistory(format.number(messages.length))}</summary>{p.hasMore ? <button disabled={p.loading || loadingMore || p.loadingMore} onClick={() => void loadMore()}>{loadingMore || p.loadingMore ? t.loading : t.loadOlderMessages}</button> : null}{messages.map(message => <article className="vis-work-message" key={message.messageId}><header><span>{message.kind === 'done' ? t.completionReport : workMessageLabel(message, locale)}</span><time dateTime={new Date(message.createdAt).toISOString()}>{relativeTime(message.createdAt, undefined, locale)}</time></header><div className="vis-work-markdown"><AgentMarkdown>{message.from.kind === 'system' && message.from.failure ? workFailureText(message.from.failure, locale) : message.body}</AgentMarkdown></div></article>)}</details>
  </WorkDialog>
}

function ChangePreview({ preview, absent }: { preview: RefPreview | null | undefined; absent: string }) {
  if (!preview || preview.kind === 'missing' || preview.kind === 'empty') return <p className="vis-work-muted">{preview?.kind === 'missing' ? preview.label : absent}</p>
  if (preview.kind === 'text') return <pre>{preview.text}</pre>
  if (preview.kind === 'script') return <div><strong>{preview.label}</strong><p><ScriptSummary preview={preview} /></p></div>
  if (preview.kind === 'image') return <img src={preview.src} alt={preview.label} loading="lazy" />
  if (preview.kind === 'audio') return <audio src={preview.src} aria-label={preview.label} preload="metadata" controls />
  return <video src={preview.src} aria-label={preview.label} preload="metadata" controls />
}
