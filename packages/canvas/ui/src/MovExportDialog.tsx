import type { AssetVersionView, MediaTaskView, NodeView, SlotView } from '@vis/protocol'
import { CloseIcon, IconButton, describeError, useFormat, useLocale, useMessages } from '@vis/ui-kit'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CanvasActions } from './CanvasView'
import { movExportMessages } from './messages'

export function MovExportDialog({ node, slot, assetVersionId, actions, task, onClose }: {
  node: NodeView; slot: SlotView; assetVersionId: string; actions: CanvasActions; task?: MediaTaskView | undefined; onClose(): void
}) {
  const m = useMessages(movExportMessages)
  const f = useFormat()
  const { locale } = useLocale()
  const dialog = useRef<HTMLDialogElement>(null)
  const mounted = useRef(true)
  const receipt = useRef<MediaTaskView | null>(null)
  const [asset, setAsset] = useState<AssetVersionView | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [result, setResult] = useState<MediaTaskView | null>(null)
  useEffect(() => {
    mounted.current = true
    const previous = document.activeElement
    dialog.current!.showModal()
    void actions.onResolveAsset!(assetVersionId).then(value => { if (mounted.current) setAsset(value) }, error => { if (mounted.current) setError(error) })
    return () => {
      mounted.current = false
      dialog.current?.close()
      if (receipt.current) void actions.onMediaDismiss!(receipt.current.taskId).catch(() => {})
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [])
  const close = async () => {
    if (busy && !receipt.current) return
    if (busy && receipt.current) {
      try { await actions.onMediaCancel!(receipt.current.taskId) } catch (error) { setError(error); return }
    }
    onClose()
  }
  const start = async () => {
    setBusy(true)
    setError(null)
    try {
      const done = await actions.onMediaProcess!({ operation: 'video.exportMov', nodeId: node.nodeId, slotId: slot.slotId, expectedRevision: slot.revision, params: {} }, task => {
        receipt.current = task
        if (!mounted.current) void actions.onMediaDismiss!(task.taskId).catch(() => {})
      })
      if (mounted.current) {
        setResult(done)
        actions.onMediaDownload!(done.taskId)
      }
    } catch (error) { if (mounted.current) setError(error) }
    finally {
      if (mounted.current) setBusy(false)
      else if (receipt.current) void actions.onMediaDismiss!(receipt.current.taskId).catch(() => {})
    }
  }
  // ProRes size depends on picture detail and alpha; a range is more honest than a precise byte count.
  const pixels = (asset?.width ?? 0) * (asset?.height ?? 0) * (asset?.fps ?? 30) * (asset?.durationMs ?? 0) / 1000
  const active = task?.taskId === receipt.current?.taskId ? task : undefined
  return createPortal(<dialog ref={dialog} className="vis-dialog vis-mov-export" aria-label={m.title} onCancel={event => { event.preventDefault(); void close() }} onKeyDown={event => event.stopPropagation()}>
    <div className="vis-dialog-header"><h2>{m.title}</h2><IconButton label={m.close} disabled={busy && !receipt.current} onClick={() => { void close() }}><CloseIcon /></IconButton></div>
    <div className="vis-dialog-body">
      <p>{m.delivery}</p>
      <p>{asset ? pixels ? m.estimate(f.bytes(pixels * 0.5), f.bytes(pixels * 2)) : m.unknownSize : m.loading}</p>
      {busy ? <progress aria-label={m.progress} max={1} value={active?.progress} /> : null}
      {result?.download ? <p>{m.ready(f.bytes(result.download.byteSize))}</p> : null}
      {error ? <p role="alert">{describeError(error, locale)}</p> : null}
    </div>
    <div className="vis-dialog-actions">
      <button type="button" disabled={busy && !receipt.current} onClick={() => { void close() }}>{busy ? m.cancel : result ? m.done : m.close}</button>
      {result ? <button type="button" onClick={() => actions.onMediaDownload!(result.taskId)}>{m.download}</button> : <button type="button" disabled={!asset || busy} onClick={() => { void start() }}>{m.start}</button>}
    </div>
  </dialog>, document.body)
}
