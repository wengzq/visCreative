import type { Viewport } from '@xyflow/react'

export function zoomedViewport(viewport: Viewport, width: number, height: number, zoom: number): Viewport {
  const ratio = zoom / viewport.zoom
  return { x: width / 2 - (width / 2 - viewport.x) * ratio, y: height / 2 - (height / 2 - viewport.y) * ratio, zoom }
}
