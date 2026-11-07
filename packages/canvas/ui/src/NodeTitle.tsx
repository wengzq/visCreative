import { useEffect, useRef, useState } from 'react'
import type { CanvasOp, NodeView } from '@vis/protocol'
import { describeError, useFormat, useLocale, useMessages } from '@vis/ui-kit'
import { Icon } from './Icon'
import { toolbarMessages } from './toolbar-messages'
import { nodeTitleNumber } from './node-title'

export function NodeTitle({ view, nodes = [], ordinal, src, onApply }: {
  view: NodeView
  nodes?: NodeView[]
  ordinal?: number
  src?: string | undefined
  onApply?: ((ops: CanvasOp[], description?: string) => Promise<void>) | undefined
}) {
  const m = useMessages(toolbarMessages)
  const format = useFormat()
  const { locale } = useLocale()
  const [draft, setDraft] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const saving = useRef(false)
  const editing = useRef(false)
  const [error, setError] = useState<unknown>(null)
  const [metadata, setMetadata] = useState<{ w: number; h: number; duration: number } | null>(null)
  const title = view.title ?? m.fallback(m[view.kind], format.number(ordinal ?? nodeTitleNumber(view, nodes)))
  useEffect(() => {
    setMetadata(null)
    if (!src || view.kind === 'text' || view.kind === 'frame' || view.kind === 'script' || view.kind === 'timeline' || view.kind === 'previz' || view.kind === 'scene') return
    const media = view.kind === 'image' ? new Image() : document.createElement(view.kind)
    const event = view.kind === 'image' ? 'load' : 'loadedmetadata'
    let released = false
    // A detached media element keeps its decoder until its source is cleared, about 3 MiB per video
    // (RFC 0024e memory notes), so release it as soon as the metadata has been copied.
    const release = () => {
      if (released) return
      released = true
      media.removeEventListener(event, loaded)
      media.removeEventListener('error', release)
      media.removeAttribute('src')
      if (media instanceof HTMLMediaElement) media.load()
    }
    function loaded() {
      setMetadata(media instanceof HTMLImageElement
        ? { w: media.naturalWidth, h: media.naturalHeight, duration: 0 }
        : { w: media instanceof HTMLVideoElement ? media.videoWidth : 0, h: media instanceof HTMLVideoElement ? media.videoHeight : 0, duration: Number.isFinite(media.duration) ? media.duration : 0 })
      if (media instanceof HTMLMediaElement) release()
    }
    media.addEventListener(event, loaded)
    if (media instanceof HTMLMediaElement) {
      media.addEventListener('error', release)
      media.preload = 'metadata'
    }
    media.src = src
    return release
  }, [src, view.kind])
  const save = async () => {
    if (draft === null || saving.current || !editing.current || !onApply) return
    const value = draft.trim() || null
    if (value === (view.title ?? null)) { editing.current = false; setDraft(null); return }
    saving.current = true
    setBusy(true)
    try { await onApply([{ op: 'node.setMeta', nodeId: view.nodeId, title: value }], m.renameDescription); editing.current = false; setDraft(null); setError(null) }
    catch (cause) { setError(cause) }
    finally { saving.current = false; setBusy(false) }
  }
  return <>
    <span className="vis-node-title vis-node-kind" onKeyDown={event => event.stopPropagation()}>
      <Icon kind={view.kind} size={14} />
      {draft !== null ? <input autoFocus className="nodrag nopan" onPointerDown={event => event.stopPropagation()} aria-label={m.rename} maxLength={60} value={draft} disabled={busy}
        onChange={event => setDraft(event.target.value)} onBlur={() => void save()}
        onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); editing.current = false; setDraft(null); setError(null) } if (event.key === 'Enter') { event.preventDefault(); void save() } }} />
        : <span title={title} onDoubleClick={event => { if (!onApply) return; event.stopPropagation(); editing.current = true; setDraft(view.title ?? '') }}>{title}</span>}
      {error ? <span role="alert">{describeError(error, locale)}</span> : null}
    </span>
    {metadata ? <span className="vis-node-metadata">{view.kind === 'audio' ? m.duration(format.number(Math.round(metadata.duration * 10) / 10)) : m.dimensions(format.number(metadata.w), format.number(metadata.h))}</span> : null}
  </>
}
