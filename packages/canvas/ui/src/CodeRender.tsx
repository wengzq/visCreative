import { useEffect, useRef, useState } from 'react'
import { describeError, useLocale, useMessages } from '@vis/ui-kit'
import type { CanvasActions } from './CanvasView'
import { controlMessages } from './messages'

export function CodeRender({ nodeId, revision, edited, actions, commit }: {
  nodeId: string; revision: number; edited: boolean; actions: CanvasActions; commit(): Promise<boolean>
}) {
  const m = useMessages(controlMessages)
  const { locale } = useLocale()
  const [renderedRevision, setRenderedRevision] = useState<number | null>(() => {
    try { const saved = localStorage.getItem(`vis.canvas.rendered.${nodeId}`); return saved === null ? null : Number(saved) }
    catch { return null }
  })
  const [job, setJob] = useState<{ jobId: string; revision: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ kind: 'delivery' | 'incomplete' } | { kind: 'poll' | 'render'; cause: unknown } | null>(null)
  const errorText = error?.kind === 'delivery' ? m.renderUndelivered : error?.kind === 'incomplete' ? m.renderIncomplete
    : error?.kind === 'poll' ? m.renderStatusFailed(describeError(error.cause, locale)) : error?.kind === 'render' ? describeError(error.cause, locale) : ''
  const requestId = useRef<string | null>(null)
  const poll = actions.onGetRenderJob
  useEffect(() => {
    if (!job || !poll) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const read = async () => {
      try {
        const state = await poll(job.jobId)
        if (cancelled) return
        if (state.status === 'succeeded') {
          const delivered = state.outputs.some(output => output.delivery.status === 'delivered')
          if (delivered) {
            setRenderedRevision(job.revision)
            setError(null)
            try { localStorage.setItem(`vis.canvas.rendered.${nodeId}`, String(job.revision)) } catch {}
          }
          else setError({ kind: 'delivery' })
          setJob(null)
          requestId.current = null
        } else if (['failed', 'cancelled', 'unknown'].includes(state.status)) {
          setError(state.error ? { kind: 'render', cause: state.error } : { kind: 'incomplete' })
          setJob(null)
          requestId.current = null
        } else timer = setTimeout(read, 800)
      } catch (error) {
        if (cancelled) return
        setError({ kind: 'poll', cause: error })
        timer = setTimeout(read, 2000)
      }
    }
    void read()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [job, poll, nodeId])

  const render = async () => {
    if (busy || job || !actions.onRenderCode) return
    setBusy(true)
    setError(null)
    try {
      if (!await commit()) return
      requestId.current ??= `web-render-${crypto.randomUUID()}`
      setJob(await actions.onRenderCode(nodeId, requestId.current))
    } catch (error) {
      setError({ kind: 'render', cause: error })
    } finally { setBusy(false) }
  }
  return <div className="vis-code-tools nodrag nopan" onPointerDown={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
    <span>html</span>
    <button disabled={busy || Boolean(job) || !actions.onRenderCode} onClick={() => void render()}>{busy || job ? m.rendering : error ? m.retryRender : m.render}</button>
    {edited || renderedRevision !== revision ? <small>{m.codeUnrendered}</small> : null}
    {errorText ? <small role="alert">{errorText}</small> : null}
  </div>
}
