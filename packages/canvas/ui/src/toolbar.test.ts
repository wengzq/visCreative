import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LocaleProvider } from '@vis/ui-kit'
import type { NodeView } from '@vis/protocol'
import { toolbarEntries, toolbarFocusIndex, toolbarOffset } from './toolbar'
import { clampCrop, fitCrop, resizeCrop } from './imageSelection'
import { NodeTitle } from './NodeTitle'
import { IMAGE_PANELS } from './imagePanels'

describe('Node operation toolbar catalog', () => {
  it('keeps local edits without providers, hides foreign and unknown operations, and deduplicates provider entries', () => {
    expect(toolbarEntries('image')).toEqual({ common: [{ operation: 'image.crop' }, { operation: 'image.gridSplit' }], more: [] })
    expect(toolbarEntries('image', ['generate', 'image.upscale', 'image.upscale', 'video.upscale', 'image.outpaint'])).toEqual({
      common: [{ operation: 'image.crop' }, { operation: 'image.gridSplit' }, { operation: 'image.upscale' }],
      more: [{ operation: 'image.outpaint' }],
    })
    expect(toolbarEntries('video').more).toEqual([{ operation: 'video.extractAudio' }])
    expect(toolbarEntries('audio').common).toContainEqual({ operation: 'audio.split', variant: 'smart' })
    expect(toolbarEntries('audio').common).toContainEqual({ operation: 'audio.split', variant: 'custom' })
    expect(toolbarEntries('audio').more).toEqual([{ operation: 'audio.speed' }])
  })

  it('wraps keyboard focus and supports Home and End, ignoring unrelated keys and empty toolbars', () => {
    expect(toolbarFocusIndex('ArrowRight', 3, 4)).toBe(0)
    expect(toolbarFocusIndex('ArrowLeft', 0, 4)).toBe(3)
    expect(toolbarFocusIndex('ArrowDown', 0, 4)).toBe(1)
    expect(toolbarFocusIndex('ArrowUp', 1, 4)).toBe(0)
    expect(toolbarFocusIndex('Home', 3, 4)).toBe(0)
    expect(toolbarFocusIndex('End', 0, 4)).toBe(3)
    expect(toolbarFocusIndex('Enter', 0, 4)).toBeUndefined()
    expect(toolbarFocusIndex('ArrowRight', 0, 0)).toBeUndefined()
  })
  it('places the toolbar above overlapping neighbors, including chains, and clears its own title when zoomed in', () => {
    const node = (nodeId: string, x: number, y: number): NodeView => ({ nodeId, kind: 'image', x, y, w: 320, h: 200, z: 0, layoutRevision: 0, slots: [] })
    const selected = node('selected', 340, 200)
    expect(toolbarOffset('selected', [selected], 1, { w: 480, h: 44 })).toBe(42)
    expect(toolbarOffset('selected', [selected], 2, { w: 480, h: 44 })).toBe(62)
    const source = node('source', 0, 100)
    expect(toolbarOffset('selected', [selected, source], 1, { w: 480, h: 44 })).toBe(135)
    const above = node('above', 340, -120)
    expect(toolbarOffset('selected', [selected, source, above], 1, { w: 480, h: 44 })).toBe(355)
    expect(toolbarOffset('selected', [selected, { ...source, kind: 'frame' }], 1, { w: 480, h: 44 })).toBe(42)
  })
})

describe('Source-pixel crop selection', () => {
  const size = { w: 1600, h: 900 }
  it('fits centered presets in asset pixels, including portrait and tiny sources', () => {
    expect(fitCrop(size)).toEqual({ x: 0, y: 0, w: 1600, h: 900 })
    expect(fitCrop(size, 1)).toEqual({ x: 350, y: 0, w: 900, h: 900 })
    expect(fitCrop(size, 9 / 16)).toEqual({ x: 547, y: 0, w: 506, h: 899 })
    expect(fitCrop({ w: 1, h: 1 }, 16 / 9)).toEqual({ x: 0, y: 0, w: 1, h: 1 })
  })
  it('keeps moving and resized boxes inside the asset with positive integer dimensions', () => {
    expect(clampCrop({ x: 1500, y: -50, w: 400.4, h: 300.2 }, size)).toEqual({ x: 1200, y: 0, w: 400, h: 300 })
    expect(clampCrop({ x: -10, y: 1000, w: 2000, h: 0 }, size)).toEqual({ x: 0, y: 899, w: 1600, h: 1 })
    expect(resizeCrop({ x: 1000, y: 400, w: 100, h: 100 }, 1000, 1000, size, 1)).toEqual({ x: 1000, y: 400, w: 500, h: 500 })
  })
})

it('titles use per-kind sequence numbers and preserve user titles; image panels expose localized controls', () => {
  const view: NodeView = { nodeId: 'second', kind: 'image', x: 0, y: 0, w: 320, h: 180, z: 1, layoutRevision: 0, slots: [] }
  const nodes: NodeView[] = [{ ...view, nodeId: 'text', kind: 'text' }, { ...view, nodeId: 'first' }, view]
  const render = (children: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(LocaleProvider, { locale: 'en', setLocale() {}, children }))
  expect(render(createElement(NodeTitle, { view, nodes }))).toContain('Image 2')
  expect(render(createElement(NodeTitle, { view: { ...view, title: 'Hero' }, nodes }))).toContain('Hero')
  const panel = IMAGE_PANELS['image.crop']!
  const html = render(createElement(panel, { view, slot: { slotId: 'main', slotKey: 'main', contentType: 'image', revision: 1, content: { type: 'asset', assetVersionId: 'asset', mime: 'image/png' } }, assetVersionId: 'asset', src: '/image.png', onSubmit: async () => {}, onCancel() {} }))
  expect(html).toContain('Crop aspect ratio')
  expect(html).toContain('Confirm processing')
  expect(html).toContain('16:9')
  expect(html).not.toMatch(/[\u3400-\u9fff]/)
})
