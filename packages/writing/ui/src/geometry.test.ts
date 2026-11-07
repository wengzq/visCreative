import { expect, it } from 'vitest'
import { selectionPanelPosition, type SelectionGeometry } from './geometry'

const geometry: SelectionGeometry = {
  rects: [{ left: 600, right: 900, top: 125, bottom: 165 }],
  protected: [{ left: 600, right: 900, top: 125, bottom: 165 }, { left: 500, right: 1100, top: 108, bottom: 185 }],
  viewport: { left: 240, right: 1600, top: 56, bottom: 960 },
  column: { left: 500, right: 1290, top: 56, bottom: 960 },
}

it('places the selection toolbar above the whole styled heading, including its padding', () => {
  const position = selectionPanelPosition({ width: 300, height: 30 }, geometry)
  expect(position.side).toBe('above')
  expect(position.top + 30).toBeLessThanOrEqual(108)
  expect(position.top).toBeGreaterThanOrEqual(geometry.viewport.top + 8)
})

it('places the toolbar below a heading when scrolling leaves insufficient space above it', () => {
  const shifted = { ...geometry, rects: geometry.rects.map(rect => ({ ...rect, top: rect.top - 45, bottom: rect.bottom - 45 })),
    protected: geometry.protected.map(rect => ({ ...rect, top: rect.top - 45, bottom: rect.bottom - 45 })) }
  const position = selectionPanelPosition({ width: 300, height: 30 }, shifted)
  expect(position.side).toBe('below')
  expect(position.top).toBeGreaterThanOrEqual(140)
  expect(position.top + 30).toBeLessThanOrEqual(geometry.viewport.bottom - 8)
})
