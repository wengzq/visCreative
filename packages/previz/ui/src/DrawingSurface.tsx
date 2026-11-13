import { useEffect, useRef, useState } from 'react'
import type { PrevizPanel } from '@vis/protocol'
import { useMessages } from '@vis/ui-kit'
import { backdrop, fitImage, loadImage, panelSize, png } from './assets'
import { previzMessages } from './messages'

export function DrawingSurface({ panel, ratio, url, tool, colour, size, disabled, sameSketch, onDraw, onError, onBusy }: {
  panel: PrevizPanel; ratio: string; url(id: string): string; tool: 'pen' | 'eraser'; colour: string; size: number; disabled: boolean
  sameSketch(a: string, b: string): boolean
  onDraw(sketch: Blob, adopt: (id: string) => void): void | Promise<void>; onError(error: unknown): void; onBusy(busy: boolean): void
}) {
  const m = useMessages(previzMessages)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [loading, setLoading] = useState(false)
  const stroke = useRef<{ id: number; x: number; y: number; pressure: number } | null>(null)
  const drawn = useRef<string | null>(null)
  const saves = useRef({ pending: 0, queue: Promise.resolve() })
  const { width, height } = panelSize(ratio)
  const under = backdrop(panel)
  useEffect(() => {
    // The canvas already shows its own strokes. Reloading them, or their uploaded version, would wipe newer ink.
    if (panel.sketch && drawn.current && sameSketch(drawn.current, panel.sketch)) { drawn.current = panel.sketch; return }
    drawn.current = null
    let live = true
    setLoading(true)
    const ctx = canvas.current!.getContext('2d')!
    ctx.clearRect(0, 0, width, height)
    void (async () => {
      if (panel.sketch) {
        const image = await loadImage(url(panel.sketch))
        if (live) fitImage(ctx, image, width, height)
      }
    })().catch(error => { if (live) onError(error) }).finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [panel.id, panel.sketch, ratio])
  const point = (event: { clientX: number; clientY: number; pressure: number; pointerType: string }) => {
    const box = canvas.current!.getBoundingClientRect()
    return { x: (event.clientX - box.left) / box.width * width, y: (event.clientY - box.top) / box.height * height, pressure: event.pointerType === 'pen' ? Math.max(0.05, event.pressure) : 0.5 }
  }
  const segment = (x: number, y: number, pressure: number) => {
    const previous = stroke.current!
    const ctx = canvas.current!.getContext('2d')!
    ctx.globalCompositeOperation = tool === 'eraser' ? 'destination-out' : 'source-over'
    ctx.strokeStyle = colour
    ctx.fillStyle = colour
    ctx.lineWidth = size * (pressure + previous.pressure)
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.beginPath()
    ctx.moveTo(previous.x, previous.y)
    ctx.lineTo(x, y)
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(x, y, ctx.lineWidth / 2, 0, Math.PI * 2)
    ctx.fill()
    stroke.current = { id: previous.id, x, y, pressure }
  }
  const finish = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (stroke.current?.id !== event.pointerId) return
    stroke.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    // Snapshot before another stroke can mutate the drawing surface; saves keep stroke order.
    const snapshot = png(event.currentTarget)
    const state = saves.current
    state.pending++
    state.queue = state.queue.then(() => snapshot).then(blob => onDraw(blob, id => { drawn.current = id })).catch(onError).finally(() => {
      state.pending--
      if (!state.pending && !stroke.current) onBusy(false)
    })
  }
  return <div className="vis-pv-paper" style={{ aspectRatio: ratio.replace(':', ' / ') }}>
    {under ? <img src={url(under)} alt="" draggable={false} /> : null}
    <canvas ref={canvas} width={width} height={height} role="img" aria-label={m.surface} aria-disabled={disabled || loading} tabIndex={0}
      onPointerDown={event => {
        // Control-click is a right click on macOS.
        if (disabled || loading || event.button !== 0 || event.ctrlKey || stroke.current) return
        event.preventDefault()
        event.currentTarget.setPointerCapture(event.pointerId)
        const p = point(event)
        stroke.current = { id: event.pointerId, ...p }
        onBusy(true)
        segment(p.x, p.y, p.pressure)
      }} onPointerMove={event => {
        if (stroke.current?.id !== event.pointerId) return
        const points = event.nativeEvent.getCoalescedEvents?.() ?? []
        for (const sample of points.length ? points : [event.nativeEvent]) {
          const p = point(sample)
          segment(p.x, p.y, p.pressure)
        }
      }} onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={event => { if (stroke.current?.id === event.pointerId) finish(event) }} />
    {loading ? <span className="vis-pv-loading" role="status">{m.loading}</span> : null}
  </div>
}
