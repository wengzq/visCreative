import { expect, it } from 'vitest'
import { zoomedViewport } from './viewport'

it('keeps the canvas center fixed while consecutive zooms accumulate from their target', () => {
  const fitted = { x: 100, y: 200, zoom: 0.6 }
  const first = zoomedViewport(fitted, 1200, 960, fitted.zoom / 1.2)
  const second = zoomedViewport(first, 1200, 960, first.zoom / 1.2)
  expect(second.zoom).toBeCloseTo(0.6 / 1.2 ** 2)
  expect((600 - second.x) / second.zoom).toBeCloseTo((600 - fitted.x) / fitted.zoom)
  expect((480 - second.y) / second.zoom).toBeCloseTo((480 - fitted.y) / fitted.zoom)
})
