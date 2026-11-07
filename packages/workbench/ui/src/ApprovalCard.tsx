import { CloseIcon, useFormat, useMessages } from '@vis/ui-kit'
import type { ApprovalDecision, ApprovalPayload } from '@vis/protocol'
import { useId, useState } from 'react'
import { sessionMessages } from './messages'
import { BatchApprovalCard, type BatchApprovalActions } from './BatchApprovalCard'

export function ApprovalCard({ approval, onRespond, onLocateNode, ...batchActions }: BatchApprovalActions & { approval: ApprovalPayload; onRespond(approvalId: string, decision: ApprovalDecision): Promise<void>; onLocateNode?(nodeId: string): void }) {
  if (approval.kind === 'generation_batch') return <BatchApprovalCard approval={approval} onLocateNode={onLocateNode} {...batchActions} />
  if (approval.kind === 'work_delete') return <WorkDeletionCard approval={approval} onRespond={onRespond} />
  return <CommandApprovalCard approval={approval} onRespond={onRespond} />
}

function CommandApprovalCard({ approval, onRespond }: { approval: ApprovalPayload; onRespond(approvalId: string, decision: ApprovalDecision): Promise<void> }) {
  const m = useMessages(sessionMessages)
  const title: Record<ApprovalPayload['kind'], string> = { command: m.approvalCommand, file_write: m.approvalFileWrite, network: m.approvalNetwork, other: m.approvalOther, generation_batch: m.approvalGenerationBatch, text_delete: m.approvalTextDelete, work_delete: m.approvalWorkDelete }
  const status = { approved: m.approvalApproved, denied: m.approvalDenied, expired: m.approvalExpired }
  const [expanded, setExpanded] = useState(false)
  const [sending, setSending] = useState(false)
  const detailId = useId()
  const respond = async (decision: ApprovalDecision) => {
    if (sending) return
    setSending(true)
    try { await onRespond(approval.approvalId, decision) }
    catch { /* The caller shows the error; keep the approval card so it can be retried */ }
    finally { setSending(false) }
  }

  if (approval.status !== 'pending') return <div className={`vis-approval-handled is-${approval.status}`} title={approval.summary}>
    <span aria-hidden="true">{approval.status === 'approved' ? '✓' : approval.status === 'denied' ? <CloseIcon /> : '–'}</span>
    <span>{approval.status === 'approved' && approval.auto ? m.approvalAuto : status[approval.status]} · {title[approval.kind]} · {approval.summary}</span>
  </div>

  return <section className="vis-approval" aria-label={m.pendingApproval(title[approval.kind])} aria-busy={sending}>
    <div className="vis-approval-title"><span aria-hidden="true">⚠ </span>{m.requestApproval(title[approval.kind])}</div>
    {/* Do not repeat the summary when it is just the start of the detail */}
    {approval.detail?.trim().startsWith(approval.summary.trim()) ? null : <div className="vis-approval-summary">{approval.summary}</div>}
    {approval.kind === 'text_delete' && <div className="vis-approval-summary">{m.approvalTextDeleteDetail(approval.textDelete?.title ?? approval.summary)}</div>}
    {approval.detail ? <>
      <pre id={detailId} className={`vis-approval-detail${expanded ? ' is-expanded' : ''}`}>{approval.detail}</pre>
      <button className="vis-approval-expand" aria-expanded={expanded} aria-controls={detailId} onClick={() => setExpanded(value => !value)}>{expanded ? m.collapseDetails : m.expandDetails}</button>
    </> : null}
    {approval.cwd ? <div className="vis-approval-cwd" title={approval.cwd}>{m.approvalDirectory(approval.cwd)}</div> : null}
    <div className="vis-approval-actions">
      <button className="is-primary" disabled={sending} onClick={() => void respond('allow_once')}>{approval.kind === 'text_delete' ? m.allowDeletion : m.allowOnce}</button>
      {approval.kind !== 'text_delete' && <button title={approval.mcpTool ? m.allowToolTitle : approval.kind === 'command' ? m.allowCommandTitle : approval.kind === 'file_write' ? m.allowFileTitle : m.allowRequestTitle} disabled={sending} onClick={() => void respond('allow_session')}>{m.allowSession}</button>}
      <button disabled={sending} onClick={() => void respond('deny')}>{m.deny}</button>
    </div>
  </section>
}

function WorkDeletionCard({ approval, onRespond }: { approval: ApprovalPayload; onRespond(approvalId: string, decision: ApprovalDecision): Promise<void> }) {
  const m = useMessages(sessionMessages)
  const format = useFormat()
  const [sending, setSending] = useState(false)
  const target = approval.workDelete
  const pending = approval.status === 'pending'
  const respond = async (decision: ApprovalDecision) => {
    if (sending) return
    setSending(true)
    try { await onRespond(approval.approvalId, decision) }
    catch { /* The caller shows the error and leaves this decision retryable. */ }
    finally { setSending(false) }
  }
  return <section className="vis-approval" aria-label={pending ? m.pendingApproval(m.approvalWorkDelete) : m.approvalWorkDelete} aria-busy={sending}>
    <div className="vis-approval-title">{pending ? m.requestApproval(m.approvalWorkDelete) : approval.status === 'approved' ? m.workDeletionApproved : approval.status === 'denied' ? m.workDeletionDenied : m.approvalExpired}</div>
    <ul className="vis-work-delete-items">{target?.items.map(item => <li key={item.workItemId}>{item.title}</li>)}</ul>
    {target && <div className="vis-work-delete-consequences">
      {target.runningTurns > 0 && <div>{m.workDeletionTurns(format.number(target.runningTurns))}</div>}
      {target.unfinishedJobs > 0 && <div>{m.workDeletionJobs(format.number(target.unfinishedJobs))}</div>}
      {target.childrenTotal > 0 && <div>{m.workDeletionChildren(format.number(target.childrenTotal))}</div>}
      {target.unresolvedMessages > 0 && <div>{m.workDeletionQuestions(format.number(target.unresolvedMessages))}</div>}
      {target.hasUnreviewedReport && <div>{m.workDeletionReports}</div>}
    </div>}
    <div className="vis-approval-summary">{m.workDeletionCanvasStays}</div>
    {approval.status === 'expired' && <div className="vis-approval-summary">{m.workDeletionExpired}</div>}
    {pending && <div className="vis-approval-actions">
      <button className="is-primary" disabled={sending} onClick={() => void respond('allow_once')}>{m.workDeletionDelete}</button>
      <button disabled={sending} onClick={() => void respond('deny')}>{m.workDeletionKeep}</button>
    </div>}
  </section>
}
