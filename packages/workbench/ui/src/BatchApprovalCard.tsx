import type { ApprovalPayload, BatchView } from '@vis/protocol'
import { BatchEstimateDetails, batchMessages, describeError, useFormat, useLocale, useMessages } from '@vis/ui-kit'
import { useEffect, useRef, useState } from 'react'

export type BatchApprovalActions = {
  batch?: BatchView | undefined
  onGetBatch?(batchId: string): Promise<BatchView>
  onRespondBatch?(batchId: string, decision: 'approve' | 'reject', requestId: string): Promise<BatchView>
  resolveBatchShots?(scriptNodeId: string): readonly { id: string; description: string }[]
}

export function BatchApprovalCard({ approval, batch, onGetBatch, onRespondBatch, onLocateNode, resolveBatchShots }: BatchApprovalActions & {
  approval: ApprovalPayload
  onLocateNode?: ((nodeId: string) => void) | undefined
}) {
  const m = useMessages(batchMessages)
  const f = useFormat()
  const { locale } = useLocale()
  const [loaded, setLoaded] = useState<BatchView | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [sending, setSending] = useState(false)
  const pending = useRef(false)
  const requestIds = useRef<Partial<Record<'approve' | 'reject', string>>>({})
  const getter = useRef(onGetBatch)
  getter.current = onGetBatch
  const terminal = (value: BatchView) => !['pending_approval', 'running', 'paused'].includes(value.status)
  const current = loaded && terminal(loaded) && (!batch || !terminal(batch)) ? loaded
    : batch && batch.status !== 'pending_approval' ? batch : loaded ?? batch
  useEffect(() => {
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const read = async () => {
      if (!approval.batchId || !getter.current) return
      try {
        const result = await getter.current(approval.batchId)
        if (!live) return
        setLoaded(previous => previous && terminal(previous) && !terminal(result) ? previous : result)
        setError(null)
        if (result.status === 'pending_approval') timer = setTimeout(() => void read(), 2000)
      } catch (cause) { if (live) { setError(cause); timer = setTimeout(() => void read(), 5000) } }
    }
    void read()
    return () => { live = false; clearTimeout(timer) }
  }, [approval.batchId])
  const respond = async (decision: 'approve' | 'reject') => {
    if (!approval.batchId || !onRespondBatch || pending.current) return
    pending.current = true
    setSending(true)
    setError(null)
    const requestId = requestIds.current[decision] ??= `web-${crypto.randomUUID()}`
    try { setLoaded(await onRespondBatch(approval.batchId, decision, requestId)) }
    catch (cause) { setError(cause) }
    finally { pending.current = false; setSending(false) }
  }
  const status = current?.status ?? (approval.status === 'denied' ? 'rejected' : approval.status === 'expired' ? 'expired' : approval.status === 'approved' ? 'running' : 'pending_approval')
  const shotLabels = new Map((current ? resolveBatchShots?.(current.scriptNodeId) ?? [] : []).map((shot, index) => [shot.id, `${m.shot(f.number(index + 1))}: ${shot.description}`]))
  return <section className={`vis-approval vis-batch-approval is-${status}`} aria-label={m.approval} aria-busy={sending}>
    <div className="vis-approval-title">{m.approval} · {m[status]}</div>
    {current ? <><BatchEstimateDetails batch={current} shotLabels={shotLabels} /><button onClick={() => onLocateNode?.(current.scriptNodeId)}>{m.locate}</button></> : <p role="status">{m.loading}</p>}
    {error ? <p role="alert">{describeError(error, locale)}</p> : null}
    {status === 'pending_approval' ? <div className="vis-approval-actions">
      <button className="is-primary" disabled={sending || !current || !onRespondBatch} onClick={() => void respond('approve')}>{m.approve}</button>
      <button disabled={sending || !onRespondBatch} onClick={() => void respond('reject')}>{m.reject}</button>
    </div> : <p role="status">{m[status]}</p>}
  </section>
}
