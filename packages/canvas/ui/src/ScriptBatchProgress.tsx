import type { BatchView, JobView, NodeView } from '@vis/protocol'
import { batchMessages, describeError, useFormat, useLocale, useMessages } from '@vis/ui-kit'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ScriptActions } from './script-ui'
import { activeBatch, shotBatchSteps } from './script-batch'
import { VideoPoster } from './VideoPoster'

export function ScriptBatchSummary({ batches, actions, jobs }: { batches: readonly BatchView[]; actions: ScriptActions; jobs?: readonly JobView[] }) {
  const m = useMessages(batchMessages)
  const f = useFormat()
  const { locale } = useLocale()
  const [cancelling, setCancelling] = useState<BatchView | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const pending = useRef(false)
  const latest = batches.reduce<BatchView | undefined>((previous, batch) => !previous || previous.createdAt <= batch.createdAt ? batch : previous, undefined)
  const perform = async (batch: BatchView, action: 'cancel' | 'resume') => {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setError(null)
    try {
      const callback = action === 'cancel' ? actions.onCancelScriptBatch : actions.onResumeScriptBatch
      await callback?.({ batchId: batch.batchId, requestId: `web-${crypto.randomUUID()}` })
      setCancelling(null)
    } catch (cause) { setError(cause) }
    finally { pending.current = false; setBusy(false) }
  }
  return <div className="vis-script-batches" aria-live="polite">
    {batches.filter(activeBatch).map(batch => {
      const steps = batch.shots.flatMap(shot => shot.steps)
      return <div key={batch.batchId} className="vis-script-batch-summary" role="status">
        <span>{m[batch.media]} · {m[batch.status]} · {m.steps(f.number(steps.filter(step => step.status === 'succeeded').length), f.number(steps.length))}</span>
        {batch.status === 'pending_approval' && batch.sessionId ? <button onClick={() => actions.onOpenSession?.(batch.sessionId!)}>{m.openSession}</button> : null}
        {batch.status === 'paused' ? <><span>{m.quotaPause}</span><button disabled={busy || !actions.onResumeScriptBatch} onClick={() => void perform(batch, 'resume')}>{m.resume}</button></> : null}
        <button disabled={busy || !actions.onCancelScriptBatch} onClick={() => { setError(null); setCancelling(batch) }}>{m.cancelBatch}</button>
      </div>
    })}
    {latest?.status === 'cancelled' ? <div role="status"><p>{m.cancelNote}</p>{jobs?.filter(job => job.status === 'cancelled' && latest.shots.some(shot => shot.steps.some(step => step.jobId === job.jobId))).map(job =>
      <p key={job.jobId}>{job.providerCancelled === true ? m.providerCancelled : job.providerCancelled === false ? m.providerNotCancelled : m.providerCancellationUnknown}</p>)}</div> : null}
    {error && !cancelling ? <p role="alert">{describeError(error, locale)}</p> : null}
    {cancelling ? <CancelBatchDialog busy={busy} error={error} onClose={() => setCancelling(null)} onConfirm={() => void perform(cancelling, 'cancel')} /> : null}
  </div>
}

function CancelBatchDialog({ busy, error, onClose, onConfirm }: { busy: boolean; error: unknown; onClose(): void; onConfirm(): void }) {
  const m = useMessages(batchMessages)
  const { locale } = useLocale()
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const element = ref.current
    const previous = document.activeElement as HTMLElement | null
    element?.showModal()
    return () => { element?.close(); previous?.focus() }
  }, [])
  return createPortal(<dialog ref={ref} className="vis-dialog vis-script-batch-dialog nodrag nopan" aria-label={m.cancelTitle}
    onCancel={event => { event.preventDefault(); event.stopPropagation(); if (!busy) onClose() }} onKeyDown={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()}>
    <header className="vis-dialog-header"><h2>{m.cancelTitle}</h2></header><div className="vis-dialog-body"><p>{m.cancelNote}</p>{error ? <p role="alert">{describeError(error, locale)}</p> : null}</div>
    <footer className="vis-dialog-footer"><button disabled={busy} onClick={onClose}>{m.close}</button><button disabled={busy} onClick={onConfirm}>{m.cancelBatch}</button></footer>
  </dialog>, document.body)
}

export function ShotBatchProgress({ batches, shotId, nodes, assetUrl, posterUrl, onFocus }: {
  batches: readonly BatchView[]; shotId: string; nodes: readonly NodeView[]; assetUrl(id: string): string; posterUrl(id: string): string; onFocus(id: string): void
}) {
  const m = useMessages(batchMessages)
  const { locale } = useLocale()
  return <div className="vis-shot-batch-steps">{shotBatchSteps(batches, shotId).map(({ batch, step }) => {
    const content = nodes.find(node => node.nodeId === step.nodeId)?.slots.find(slot => slot.slotKey === 'main')?.content
    return <div key={step.role} className={`vis-shot-batch-step is-${step.status}`}>
      <span>{m[step.role]}: {m[step.status]}</span>
      {step.blockedBy ? <small>{step.blockedBy === 'quota' ? m.quotaPause : m.waiting_previous}</small> : batch.status === 'paused' && step.status === 'waiting' ? <small>{m.quotaPause}</small> : null}
      {step.source === 'extract' ? <small>{m.extract}</small> : null}
      {step.error ? <small role="alert">{describeError(step.error, locale)}</small> : null}
      {step.status === 'succeeded' && step.nodeId ? <button aria-label={`${m[step.role]}: ${m.output}`} onClick={() => onFocus(step.nodeId!)}>
        {content?.type === 'asset' ? step.role === 'video' ? <VideoPoster src={assetUrl(content.assetVersionId)} posterSrc={posterUrl(content.assetVersionId)} /> : <img src={assetUrl(content.assetVersionId)} alt="" /> : m.output}
      </button> : null}
    </div>
  })}</div>
}
