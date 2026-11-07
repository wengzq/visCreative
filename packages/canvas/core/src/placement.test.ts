import { describe, expect, it } from 'vitest'
import { defaultNodeSize, placeNewNode } from './placement'

describe('placement', () => {
  it('Scale media nodes proportionally into a 320 box; unknown dimensions use a square', () => {
    expect(defaultNodeSize('image', { width: 900, height: 1600 })).toEqual({ w: 180, h: 320 })
    expect(defaultNodeSize('video')).toEqual({ w: 320, h: 180 })
    expect(defaultNodeSize('text')).toEqual({ w: 320, h: 200 })
    expect(defaultNodeSize('audio')).toEqual({ w: 360, h: 140 })
    expect(defaultNodeSize('audio', { width: 900, height: 1600 })).toEqual({ w: 360, h: 140 })
  })

  it('Videos use a uniform width and proportional height in either orientation; invalid dimensions fall back to 16:9', () => {
    expect(defaultNodeSize('video', { width: 1920, height: 1080 })).toEqual({ w: 320, h: 180 })
    expect(defaultNodeSize('video', { width: 1080, height: 1920 })).toEqual({ w: 320, h: 569 })
    expect(defaultNodeSize('video', { width: 0, height: 1920 })).toEqual({ w: 320, h: 180 })
  })

  it('Extreme media ratios keep the short side at least 80; video height is at most four times its width', () => {
    expect(defaultNodeSize('image', { width: 1, height: 100 })).toEqual({ w: 80, h: 320 })
    expect(defaultNodeSize('image', { width: 100, height: 1 })).toEqual({ w: 320, h: 80 })
    expect(defaultNodeSize('video', { width: 4000, height: 10 })).toEqual({ w: 320, h: 80 })
    expect(defaultNodeSize('video', { width: 10, height: 4000 })).toEqual({ w: 320, h: 1280 })
  })

  it('Place directly below when the space to the right of the reference node is occupied', () => {
    const near = { x: 0, y: 0, w: 100, h: 100 }
    const blocker = { x: 140, y: 0, w: 100, h: 100 }
    expect(placeNewNode({ w: 100, h: 100 }, [near, blocker], near)).toEqual({ x: 0, y: 140 })
  })

  it('The first ring tries right, down, left, then up, maintaining spacing from all nodes', () => {
    const near = { x: 0, y: 0, w: 100, h: 100 }
    const size = { w: 100, h: 100 }
    const existing = [near]
    for (const point of [{ x: 140, y: 0 }, { x: 0, y: 140 }, { x: -140, y: 0 }, { x: 0, y: -140 }]) {
      const placed = placeNewNode(size, existing, near)
      expect(placed).toEqual(point)
      expect(existing.every(r => placed.x >= r.x + r.w + 40 || placed.x + size.w + 40 <= r.x || placed.y >= r.y + r.h + 40 || placed.y + size.h + 40 <= r.y)).toBe(true)
      existing.push({ ...placed, ...size })
    }
    expect(placeNewNode(size, existing, near)).toEqual({ x: 300, y: 0 })
  })

  it('Fall back to the right of existing content after exhausting the bounded search', () => {
    const near = { x: 0, y: 0, w: 100, h: 100 }
    const blocker = { x: -5000, y: -5000, w: 10000, h: 10000 }
    expect(placeNewNode({ w: 100, h: 100 }, [near, blocker], near)).toEqual({ x: 5080, y: -5000 })
  })

  it('Place at the origin on an empty canvas', () => {
    expect(placeNewNode({ w: 100, h: 100 }, [])).toEqual({ x: 0, y: 0 })
  })
})
