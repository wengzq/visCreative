import { NodeToolbar, useViewport } from '@xyflow/react'
import { type ComponentProps, useLayoutEffect, useRef } from 'react'

/** Keep node actions reachable when their anchor is panned behind fixed canvas controls. */
export function FloatingNodeToolbar({ children, ...props }: ComponentProps<typeof NodeToolbar>) {
  const content = useRef<HTMLDivElement>(null)
  const { x, y, zoom } = useViewport()
  useLayoutEffect(() => {
    const element = content.current
    if (!element) return
    const canvas = element.closest('.react-flow')
    if (!canvas) return
    const host = canvas.closest('[data-canvas-surface]') ?? canvas.parentElement
    const update = () => {
      element.style.translate = '0px 0px'
      const bounds = element.getBoundingClientRect()
      const area = canvas.getBoundingClientRect()
      let dx = Math.max(area.left + 8 - bounds.left, Math.min(0, area.right - 8 - bounds.right))
      let dy = Math.max(area.top + 8 - bounds.top, Math.min(0, area.bottom - 8 - bounds.bottom))
      for (const obstacle of host?.querySelectorAll('[data-canvas-obstacle]') ?? []) {
        const fixed = obstacle.getBoundingClientRect()
        if (bounds.left + dx >= fixed.right || bounds.right + dx <= fixed.left || bounds.top + dy >= fixed.bottom || bounds.bottom + dy <= fixed.top) continue
        if (obstacle.getAttribute('data-canvas-obstacle') === 'top') {
          const beside = [fixed.left - 8 - bounds.right, fixed.right + 8 - bounds.left]
            .filter(move => bounds.left + move >= area.left + 8 && bounds.right + move <= area.right - 8)
            .sort((a, b) => Math.abs(a) - Math.abs(b))[0]
          // Moving sideways preserves access to the node title and its media controls.
          if (beside !== undefined) dx = beside
          else dy = fixed.bottom + 8 - bounds.top
        } else dy = fixed.top - 8 - bounds.bottom
      }
      element.style.translate = `${dx}px ${dy}px`
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    observer.observe(canvas)
    for (const obstacle of host?.querySelectorAll('[data-canvas-obstacle]') ?? []) observer.observe(obstacle)
    return () => observer.disconnect()
  }, [x, y, zoom, children])
  return <NodeToolbar {...props}><div ref={content}>{children}</div></NodeToolbar>
}
