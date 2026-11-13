import { NodeToolbar, useViewport } from '@xyflow/react'
import { type ComponentProps, useLayoutEffect, useRef } from 'react'
import { placeFloatingToolbar } from './toolbar'

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
      const nodeId = element.closest('.react-flow__node-toolbar')?.getAttribute('data-id')
      const anchor = [...canvas.querySelectorAll('.react-flow__node')].find(node => node.getAttribute('data-id') === nodeId)
      const obstacles = [
        ...(host?.querySelectorAll('[data-canvas-obstacle]') ?? []),
        ...(anchor ? [anchor, ...anchor.querySelectorAll('.vis-node-label')] : []),
        ...canvas.querySelectorAll('.vis-node-version-strip'),
      ].filter(target => !element.contains(target)).map(target => target.getBoundingClientRect())
      const { x: dx, y: dy } = placeFloatingToolbar(bounds, area, obstacles)
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
