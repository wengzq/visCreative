import type { LocalOperation } from '@vis/protocol'
import { describeError, useFormat, useLocale, useMessages } from '@vis/ui-kit'
import { useEffect, useRef, useState, type PointerEvent } from 'react'
import type { OperationPanel, OperationPanelProps } from './operations-ui'
import { clampCrop, fitCrop, resizeCrop, type CropBox, type ImageSize } from './imageSelection'
import { toolbarMessages } from './toolbar-messages'
import './node-toolbar.css'

const RATIOS = [
  ['free', undefined], ['square', 1], ['landscape', 4 / 3], ['wide', 16 / 9], ['portrait', 9 / 16],
] as const

function ImagePanel({ src, onSubmit, onCancel, grid }: OperationPanelProps & { grid: boolean }) {
  const m = useMessages(toolbarMessages)
  const format = useFormat()
  const { locale } = useLocale()
  const [size, setSize] = useState<ImageSize | null>(null)
  const [crop, setCrop] = useState<CropBox>({ x: 0, y: 0, w: 1, h: 1 })
  const [ratioIndex, setRatioIndex] = useState(0)
  const [count, setCount] = useState(2)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [loadError, setLoadError] = useState(false)
  const stage = useRef<HTMLDivElement>(null)
  const root = useRef<HTMLDivElement>(null)
  const control = useRef<HTMLSelectElement>(null)
  // The select stays disabled until the image size is known, so its autoFocus is a no-op; hold focus on the panel
  // meanwhile so Enter and Escape reach it instead of the toolbar button that opened it, then hand focus to the select
  useEffect(() => { if (!root.current?.contains(document.activeElement)) root.current?.focus() }, [])
  useEffect(() => { if (size && document.activeElement === root.current) control.current?.focus() }, [size])
  const surface = useRef<HTMLDivElement>(null)
  const [bounds, setBounds] = useState({ w: 0, h: 0 })
  const drag = useRef<{ pointer: number; x: number; y: number; box: CropBox; resize: boolean } | null>(null)
  const ratio = RATIOS[ratioIndex]?.[1]
  useEffect(() => {
    if (!stage.current) return
    const observer = new ResizeObserver(([entry]) => { if (entry) setBounds({ w: entry.contentRect.width, h: entry.contentRect.height }) })
    observer.observe(stage.current)
    return () => observer.disconnect()
  }, [])
  const submit = async () => {
    if (!size || busy) return
    setBusy(true)
    setError(null)
    try { await onSubmit(grid ? { rows: count, cols: count } : { ...clampCrop(crop, size) }) }
    catch (cause) { setError(cause) }
    finally { setBusy(false) }
  }
  const start = (event: PointerEvent<HTMLDivElement | HTMLButtonElement>, resize: boolean) => {
    if (!size || busy) return
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, box: crop, resize }
  }
  const move = (event: PointerEvent) => {
    const active = drag.current
    const rect = surface.current?.getBoundingClientRect()
    if (!active || active.pointer !== event.pointerId || !size || !rect?.width || !rect.height) return
    const dx = (event.clientX - active.x) * size.w / rect.width
    const dy = (event.clientY - active.y) * size.h / rect.height
    setCrop(active.resize ? resizeCrop(active.box, dx, dy, size, ratio) : clampCrop({ ...active.box, x: active.box.x + dx, y: active.box.y + dy }, size))
  }
  const scale = size ? Math.min(bounds.w / size.w, bounds.h / size.h) : 0
  return <div ref={root} tabIndex={-1} className="vis-image-panel nodrag nopan nowheel" role="group" aria-label={grid ? m.gridPanel : m.cropPanel}
    onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}
    onKeyDown={event => {
      event.stopPropagation()
      if (event.key === 'Escape' && !busy) { event.preventDefault(); onCancel() }
      if (event.key === 'Enter' && !(event.target instanceof HTMLButtonElement)) { event.preventDefault(); void submit() }
    }}>
    <div ref={stage} className="vis-image-stage">
      <div ref={surface} className="vis-image-surface" style={size ? { width: size.w * scale, height: size.h * scale } : { width: '100%', height: '100%' }}>
        <img src={src} alt="" draggable={false} onError={() => setLoadError(true)}
          onLoad={event => {
            const image = event.currentTarget
            const next = { w: image.naturalWidth, h: image.naturalHeight }
            if (!next.w || !next.h) return
            setSize(next)
            setCrop(fitCrop(next, ratio))
          }} />
        {size && grid ? <div className="vis-image-grid" aria-hidden="true">
          {Array.from({ length: count - 1 }, (_, index) => <div key={index}>
            <i style={{ left: `${(index + 1) * 100 / count}%` }} /><b style={{ top: `${(index + 1) * 100 / count}%` }} />
          </div>)}
        </div> : size ? <div className="vis-crop-selection" role="group" aria-label={m.cropSelection} tabIndex={0}
          style={{ left: `${crop.x * 100 / size.w}%`, top: `${crop.y * 100 / size.h}%`, width: `${crop.w * 100 / size.w}%`, height: `${crop.h * 100 / size.h}%` }}
          onPointerDown={event => start(event, false)} onPointerMove={move}
          onPointerUp={() => { drag.current = null }} onPointerCancel={() => { drag.current = null }}
          onKeyDown={event => {
            const offsets: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }
            const delta = offsets[event.key]
            if (delta) { event.preventDefault(); setCrop(clampCrop({ ...crop, x: crop.x + delta[0] * (event.shiftKey ? 10 : 1), y: crop.y + delta[1] * (event.shiftKey ? 10 : 1) }, size)) }
          }}>
          <button type="button" className="vis-crop-handle" aria-label={m.resizeCrop} disabled={busy}
            onPointerDown={event => start(event, true)} onPointerMove={move} onPointerUp={() => { drag.current = null }}
            onPointerCancel={() => { drag.current = null }}
            onKeyDown={event => {
              if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); void submit(); return }
              if (!size) return
              const offsets: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }
              const delta = offsets[event.key]
              if (delta) { event.stopPropagation(); event.preventDefault(); setCrop(resizeCrop(crop, delta[0], delta[1], size, ratio)) }
            }} />
        </div> : null}
      </div>
    </div>
    <div className="vis-image-panel-controls">
      {grid ? <select ref={control} autoFocus aria-label={m.gridSize} disabled={busy} value={count} onChange={event => setCount(Number(event.target.value))}><option value={2}>{m.grid2}</option><option value={3}>{m.grid3}</option></select>
        : <select ref={control} autoFocus aria-label={m.ratio} disabled={busy || !size} value={ratioIndex} onChange={event => {
          const index = Number(event.target.value)
          setRatioIndex(index)
          if (size) setCrop(fitCrop(size, RATIOS[index]?.[1]))
        }}>{RATIOS.map(([label], index) => <option key={label} value={index}>{m[label]}</option>)}</select>}
      {size && !grid ? <span>{m.dimensions(format.number(crop.w), format.number(crop.h))}</span> : null}
      <button type="button" aria-label={m.confirm} disabled={busy || !size || loadError} onClick={() => void submit()}>{m.confirm}</button>
      <button type="button" aria-label={m.cancel} disabled={busy} onClick={onCancel}>{m.cancel}</button>
    </div>
    {loadError ? <span role="alert">{m.loadFailed}</span> : error ? <span role="alert">{describeError(error, locale)}</span> : null}
  </div>
}

export const IMAGE_PANELS: Partial<Record<LocalOperation, OperationPanel>> = {
  'image.crop': props => <ImagePanel {...props} grid={false} />,
  'image.gridSplit': props => <ImagePanel {...props} grid />,
}
