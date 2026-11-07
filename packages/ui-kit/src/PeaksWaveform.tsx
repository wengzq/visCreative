import { useEffect, useRef } from 'react'

export type PeaksWaveformProps = {
  peaks: readonly number[]
  binsPerSecond: number
  fromMs: number
  toMs: number
  color: string
  height: number
  className?: string
}

/** The previous bitmap stretches during zoom; drawing follows once the viewport settles. */
export function PeaksWaveform({ peaks, binsPerSecond, fromMs, toMs, color, height, className }: PeaksWaveformProps) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    let timer: ReturnType<typeof setTimeout>
    const draw = () => {
      const width = canvas.getBoundingClientRect().width
      const dpr = window.devicePixelRatio || 1
      canvas.width = Math.max(1, Math.round(width * dpr))
      canvas.height = Math.max(1, Math.round(height * dpr))
      const ctx = canvas.getContext('2d')
      if (!ctx || width <= 0 || toMs <= fromMs || binsPerSecond <= 0) return
      ctx.scale(dpr, dpr)
      ctx.clearRect(0, 0, width, height)
      ctx.fillStyle = color.startsWith('var(') ? getComputedStyle(canvas).getPropertyValue(color.slice(4, -1)).trim() : color
      const count = Math.ceil(width / 3)
      const first = Math.max(0, Math.floor(fromMs * binsPerSecond / 1000))
      const last = Math.min(peaks.length, Math.ceil(toMs * binsPerSecond / 1000))
      for (let bar = 0; bar < count; bar++) {
        const a = Math.max(first, Math.floor((fromMs + (toMs - fromMs) * bar / count) * binsPerSecond / 1000))
        const b = Math.min(last, Math.max(a + 1, Math.ceil((fromMs + (toMs - fromMs) * (bar + 1) / count) * binsPerSecond / 1000)))
        let peak = 0
        for (let i = a; i < b; i++) peak = Math.max(peak, Math.min(1, Math.max(0, peaks[i] ?? 0)))
        const barHeight = Math.max(1, peak * (height - 4))
        ctx.fillRect(bar * 3, (height - barHeight) / 2, 2, barHeight)
      }
    }
    const schedule = () => { clearTimeout(timer); timer = setTimeout(draw, 100) }
    schedule()
    const observer = new ResizeObserver(schedule)
    observer.observe(canvas)
    return () => { clearTimeout(timer); observer.disconnect() }
  }, [peaks, binsPerSecond, fromMs, toMs, color, height])
  return <canvas ref={ref} className={className} aria-hidden="true" style={{ width: '100%', height, display: 'block' }} />
}
