import { describe, expect, it } from 'vitest'
import { overlayRect } from '@vis/protocol'
import { boundedPlacement, movePlacement, presetPlacement, resizePlacement } from './placement'

const output = { width: 1920, height: 1080 }
const placement = { x: 0.5, y: 0.5, width: 0.25, opacity: 0.7 }

describe('Overlay placement controls', () => {
  it('positions presets inside four percent margins using the source aspect', () => {
    for (const aspect of [0.5, 1, 2]) {
      const topRight = presetPlacement(placement, 'topRight', aspect, output)
      const rect = overlayRect(topRight, aspect, output)
      expect(Math.abs((rect.x + rect.width) / output.width - 0.96)).toBeLessThan(0.001)
      expect(Math.abs(rect.y / output.height - 0.04)).toBeLessThan(0.001)
      const bottomLeft = overlayRect(presetPlacement(placement, 'bottomLeft', aspect, output), aspect, output)
      expect(Math.abs(bottomLeft.x / output.width - 0.04)).toBeLessThan(0.001)
      expect(Math.abs((bottomLeft.y + bottomLeft.height) / output.height - 0.96)).toBeLessThan(0.001)
    }
    expect(presetPlacement(placement, 'centre', 2, output)).toEqual(placement)
    expect(presetPlacement(placement, 'fullWidth', 2, output)).toEqual({ ...placement, width: 1 })
  })
  it('snaps a move to centre and safe margins, and bypasses with no tolerance', () => {
    const tolerance = { x: 0.01, y: 0.01 }
    expect(movePlacement(placement, 0.005, -0.005, 2, output, tolerance)).toEqual(placement)
    expect(movePlacement(placement, 0.005, -0.005, 2, output)).toEqual({ ...placement, x: 0.505, y: 0.495 })
    expect(movePlacement(placement, 0.334, -0.345, 2, output, tolerance)).toEqual({ ...placement, x: 0.835, y: 0.151 })
  })
  it('resizes around the opposite corner with a locked aspect and bounded width', () => {
    const next = resizePlacement(placement, 'se', 0.1, 0, 2, output)
    expect(next.width).toBe(0.35)
    expect(next.x - next.width / 2).toBeCloseTo(placement.x - placement.width / 2, 3)
    expect(next.y - next.width * output.width / output.height / 2 / 2).toBeCloseTo(placement.y - placement.width * output.width / output.height / 2 / 2, 3)
    expect(resizePlacement(placement, 'nw', 1, 1, 2, output).width).toBe(0.02)
    expect(resizePlacement(placement, 'se', 2, 2, 2, output).width).toBe(1)
  })
  it('rounds to contract precision and keeps opacity within its range', () => {
    expect(boundedPlacement({ x: -1, y: 2, width: 0.12345, opacity: 0.456 })).toEqual({ x: 0, y: 1, width: 0.123, opacity: 0.46 })
  })
})
