import { CloseIcon, IconButton, useFormat, useMessages } from '@vis/ui-kit'
import type { NodeView } from '@vis/protocol'
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { isEditing, mediaTime, VideoPlayer } from './VideoPlayer'
import './lightbox.css'
import { createPortal } from 'react-dom'
import { AudioPlayer } from './AudioPlayer'
import { Icon } from './Icon'
import { mediaMessages } from './messages'
import type { PreviewLoader } from './peaks'

/** Callable by external menus; the current canvas validates whether the node can be previewed. */
export function openPreview(nodeId: string) {
  window.dispatchEvent(new CustomEvent('vis:preview', { detail: nodeId }))
}

export function mediaSlot(node: NodeView) {
  return node.kind !== 'text' ? node.slots.find(s => s.slotKey === 'main' && s.content.type === 'asset') : undefined
}

export function readingOrder(nodes: NodeView[]) {
  const sorted = nodes.filter(n => mediaSlot(n)).sort((a, b) => a.y - b.y || a.x - b.x)
  const result: NodeView[] = []
  while (sorted.length) {
    const y = sorted[0]!.y
    const row = sorted.filter(n => n.y - y <= 80).sort((a, b) => a.x - b.x || a.y - b.y)
    result.push(...row)
    sorted.splice(0, row.length)
  }
  return result
}
export function Lightbox({ nodes, nodeId, assetUrl, onSelect, onClose, origin, footer, details, onPreview }: {
  nodes: NodeView[]; nodeId: string; assetUrl(id: string): string
  onSelect(id: string): void; onClose(): void; origin?: DOMRect | undefined
  footer?: ReactNode; details?: ReactNode
  onPreview?: PreviewLoader | undefined
}) {
  const m = useMessages(mediaMessages)
  const format = useFormat()
  const label = (node: NodeView) => `${node.kind === 'audio' ? m.audio : node.kind === 'video' ? m.video : node.kind === 'image' ? m.image : m.text} ${node.nodeId.slice(-8)}`
  const ordered = useMemo(() => readingOrder(nodes), [nodes])
  const index = ordered.findIndex(n => n.nodeId === nodeId)
  const node = ordered[index]
  const slot = node && mediaSlot(node)
  const assetId = slot?.content.type === 'asset' ? slot.content.assetVersionId : ''
  const [showDetails, setShowDetails] = useState(() => { try { return localStorage.getItem('vis.preview.details') === 'true' } catch { return false } })
  const [size, setSize] = useState({ width: 0, height: 0, duration: 0 })
  const [area, setArea] = useState({ width: 1, height: 1 })
  const [scale, setScale] = useState<number | null>(null)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [showZoom, setShowZoom] = useState(true)
  const stage = useRef<HTMLDivElement>(null)
  const media = useRef<HTMLDivElement>(null)
  const dialog = useRef<HTMLDivElement>(null)
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null)
  const animated = useRef(false)
  const fit = size.width ? Math.min(node?.kind === 'image' ? 1 : 8, (area.width - 48) / size.width, (area.height - 48) / size.height) : 1
  const zoom = scale ?? fit
  const reset = () => { setScale(null); setOffset({ x: 0, y: 0 }) }
  const changeZoom = (next: number, x = 0, y = 0) => {
    const value = Math.max(.1, Math.min(8, next))
    setOffset(p => ({ x: x - (x - p.x) * value / zoom, y: y - (y - p.y) * value / zoom }))
    setScale(value)
  }
  const switchNode = (delta: number) => { if (ordered.length) onSelect(ordered[(index + delta + ordered.length) % ordered.length]!.nodeId) }
  useEffect(() => { dialog.current?.focus() }, [])
  useLayoutEffect(() => { reset(); setSize({ width: 0, height: 0, duration: 0 }) }, [assetId])
  useEffect(() => {
    setShowZoom(true)
    const timer = setTimeout(() => setShowZoom(false), 2000)
    return () => clearTimeout(timer)
  }, [zoom, offset])
  useLayoutEffect(() => {
    const el = stage.current
    if (!el) return
    const observer = new ResizeObserver(() => setArea({ width: el.clientWidth, height: el.clientHeight }))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  useLayoutEffect(() => {
    if (!size.width || !media.current || animated.current) return
    animated.current = true
    if (origin && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const target = media.current.getBoundingClientRect()
      media.current.animate([
        { transform: `translate(${origin.x + origin.width / 2 - target.x - target.width / 2}px, ${origin.y + origin.height / 2 - target.y - target.height / 2}px) scale(${origin.width / target.width}, ${origin.height / target.height})` },
        { transform: 'translate(0,0) scale(1)' },
      ], { duration: 180, easing: 'ease-out' })
    }
  }, [size, origin])
  useEffect(() => {
    const el = stage.current
    if (!el || node?.kind !== 'image') return
    const wheel = (event: WheelEvent) => {
      event.preventDefault()
      const rect = el.getBoundingClientRect()
      changeZoom(zoom * Math.exp(-event.deltaY * .002), event.clientX - rect.x - rect.width / 2, event.clientY - rect.y - rect.height / 2)
    }
    el.addEventListener('wheel', wheel, { passive: false })
    return () => el.removeEventListener('wheel', wheel)
  })
  useEffect(() => {
    if (!node) { onClose(); return }
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Tab') {
        const items = [...(dialog.current?.querySelectorAll<HTMLElement>('button, a, input') ?? [])].filter(el => el.getClientRects().length && !el.hasAttribute('disabled'))
        if (event.shiftKey && (document.activeElement === items[0] || document.activeElement === dialog.current)) { items.at(-1)?.focus(); event.preventDefault() }
        else if (!event.shiftKey && document.activeElement === items.at(-1)) { items[0]?.focus(); event.preventDefault() }
        return
      }
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); return }
      if (isEditing(event.target)) return
      if (event.key === ' ' && event.target instanceof HTMLElement && event.target.closest('button, a')) return
      switch (event.key) {
        case 'Escape': onClose(); break
        case 'ArrowLeft': switchNode(-1); break
        case 'ArrowRight': switchNode(1); break
        case ' ': if (node.kind !== 'image') return; onClose(); break
        case '0': reset(); break
        case '1': setScale(1); setOffset({ x: 0, y: 0 }); break
        case '+': case '=': changeZoom(zoom * 1.2); break
        case '-': changeZoom(zoom / 1.2); break
        default: return
      }
      event.preventDefault()
      event.stopPropagation()
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  })
  if (!node || !assetId) return null
  // Pixel dimensions and zoom ratios are technical values and use no digit grouping.
  const dimensions = node.kind === 'audio' ? mediaTime(size.duration) : size.width ? m.dimensions(size.width, size.height, node.kind === 'video' ? mediaTime(size.duration) : undefined) : m.loading
  return createPortal(<div ref={dialog} className="vis-lightbox" role="dialog" aria-modal="true" aria-label={m.mediaPreview} tabIndex={-1} onKeyDown={e => e.stopPropagation()}>
    <header className="vis-preview-header">
      <span><Icon kind={node.kind} size={16} /> {label(node)} <span className="vis-preview-dimensions">{dimensions}</span></span>
      <span className="vis-preview-count">{format.number(index + 1)} / {format.number(ordered.length)}</span>
      <div className="vis-canvas-toolbar"><button aria-label={m.details} title={m.details} aria-pressed={showDetails} onClick={() => { setShowDetails(!showDetails); try { localStorage.setItem('vis.preview.details', String(!showDetails)) } catch {} }}>ⓘ</button><a aria-label={m.download} title={m.download} href={assetUrl(assetId)} download>↓</a><IconButton label={m.closePreview} title={m.closePreviewHint} onClick={onClose}><CloseIcon /></IconButton></div>
    </header>
    <div className="vis-preview-body">
      <div className="vis-preview-main">
        <div ref={stage} className="vis-preview-stage" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
          <div ref={media} className="vis-preview-media" style={{ width: size.width ? size.width * (node.kind === 'image' ? zoom : fit) : '80%', height: size.height ? size.height * (node.kind === 'image' ? zoom : fit) : '80%', transform: `translate(${offset.x}px, ${offset.y}px)` }}>
            {node.kind === 'audio' ? <AudioPlayer key={assetId} assetId={assetId} src={assetUrl(assetId)} selected onPreview={onPreview} onMetadata={duration => setSize({ width: 0, height: 0, duration })} /> : node.kind === 'image' ? <img key={assetId} src={assetUrl(assetId)} alt={label(node)} draggable={false} onLoad={e => setSize({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight, duration: 0 })} onDoubleClick={() => { setScale(scale === 1 ? null : 1); setOffset({ x: 0, y: 0 }) }} onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); drag.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y } }} onPointerMove={e => { const d = drag.current; if (d) setOffset({ x: d.ox + e.clientX - d.x, y: d.oy + e.clientY - d.y }) }} onPointerUp={() => { drag.current = null }} onPointerCancel={() => { drag.current = null }} />
              : <VideoPlayer hasAlpha={slot?.content.type === 'asset' && slot.content.hasAlpha} key={assetId} src={assetUrl(assetId)} source={slot?.source} onMetadata={(width, height, duration) => setSize({ width, height, duration })} />}
          </div>
          {ordered.length > 1 ? <><button className="vis-preview-prev" aria-label={m.previousNode} title={m.previousNodeHint} onClick={() => switchNode(-1)}>‹</button><button className="vis-preview-next" aria-label={m.nextNode} title={m.nextNodeHint} onClick={() => switchNode(1)}>›</button></> : null}
          {node.kind === 'image' ? <output className={`vis-preview-zoom${showZoom ? ' is-visible' : ''}`}>{Math.round(zoom * 100)}%</output> : null}
        </div>
        {footer ? <div className="vis-preview-footer">{footer}</div> : null}
      </div>
      {showDetails ? <aside className="vis-preview-details">{details ?? <><h3>{label(node)}</h3><dl><dt>{m.type}</dt><dd>{node.kind === 'audio' ? m.audio : node.kind === 'image' ? m.image : m.video}</dd><dt>{m.dimensionsDuration}</dt><dd>{dimensions}</dd><dt>{m.asset}</dt><dd className="vis-preview-id" title={assetId}>{assetId.length > 28 ? `${assetId.slice(0, 14)}…${assetId.slice(-10)}` : assetId}</dd><dt>{m.currentContentSource}</dt><dd>{slot?.source ? <>{m.generationJob(slot.source.jobId.slice(-8))}<ul>{slot.source.inputNodeIds.map(id => <li key={id}>{nodes.find(n => n.nodeId === id) ? label(nodes.find(n => n.nodeId === id)!) : m.deletedNode(id.slice(-8))}</li>)}</ul></> : m.uploadManual}</dd></dl></>}</aside> : null}
    </div>
  </div>, document.body)
}
