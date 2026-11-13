import { createElement, type ComponentProps, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { LocaleProvider } from '@vis/ui-kit'
import type { NodeView } from '@vis/protocol'
import { placeFloatingToolbar, toolbarEntries, toolbarFocusIndex, toolbarOffset } from './toolbar'
import { clampCrop, fitCrop, resizeCrop } from './imageSelection'
import { NodeTitle } from './NodeTitle'
import { IMAGE_PANELS } from './imagePanels'
import { NodeOperationsToolbar } from './NodeOperationsToolbar'

vi.mock('@xyflow/react', async importOriginal => ({
  ...await importOriginal<typeof import('@xyflow/react')>(),
  useViewport: () => ({ x: 0, y: 0, zoom: 1 }),
}))
vi.mock('./FloatingNodeToolbar', () => ({ FloatingNodeToolbar: ({ children }: { children: ReactNode }) => children }))

describe('Node operation toolbar catalog', () => {
  it.each(['image', 'video', 'audio'] as const)('shows %s regeneration only with displayed job provenance and no active generation', kind => {
    const props = { nodeId: 'node', nodes: [], kind, disabled: false, onOperation() {}, onDownload() {}, onFullscreen() {}, onRegenerate: async () => {} }
    const render = (extra: Partial<ComponentProps<typeof NodeOperationsToolbar>>) => renderToStaticMarkup(createElement(LocaleProvider, {
      locale: 'en', setLocale() {}, children: createElement(NodeOperationsToolbar, { ...props, ...extra }),
    }))
    const label = 'Regenerate with the same prompt and settings (new version)'
    expect(render({})).not.toContain(label)
    expect(render({ sourceJobId: 'job' })).toContain(`aria-label="${label}"`)
    expect(render({ sourceJobId: 'job', running: true })).not.toContain(label)
    expect(render({ sourceJobId: 'job', onRegenerate: undefined })).not.toContain(label)
    expect(render({ sourceJobId: 'job', disabled: true })).toContain(`title="${label}" disabled=""`)
  })

  it('uses the approved regeneration label and tooltip in both languages', () => {
    for (const [locale, label, hint] of [
      ['en', 'Regenerate', 'Regenerate with the same prompt and settings (new version)'],
      ['zh-CN', '重新生成', '用相同的提示词和设置重新生成（新版本）'],
    ] as const) {
      const html = renderToStaticMarkup(createElement(LocaleProvider, {
        locale, setLocale() {}, children: createElement(NodeOperationsToolbar, {
          nodeId: 'node', nodes: [], kind: 'image', sourceJobId: 'job', disabled: false,
          onRegenerate: async () => {}, onOperation() {}, onDownload() {}, onFullscreen() {},
        }),
      }))
      expect(html).toContain(`aria-label="${hint}" title="${hint}"`)
      expect(html).toContain(`<span>${label}</span>`)
    }
  })

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

  it('keeps a wide clamped toolbar clear of its card, title, version strip and fixed header', () => {
    const bounds = { left: 190, top: -15, right: 790, bottom: 29 }
    const area = { left: 0, top: 0, right: 960, bottom: 600 }
    const obstacles = [
      { left: 400, top: 10, right: 560, bottom: 50 },
      { left: 390, top: 80, right: 570, bottom: 220 },
      { left: 390, top: 60, right: 570, bottom: 80 },
      { left: 360, top: 230, right: 600, bottom: 280 },
    ]
    expect(placeFloatingToolbar(bounds, area, obstacles)).toEqual({ x: 0, y: 303 })
    expect(placeFloatingToolbar({ left: 190, top: 300, right: 790, bottom: 344 }, area, obstacles)).toEqual({ x: 0, y: 0 })
  })

  it('uses space beside the card when the bottom of the canvas has no room', () => {
    expect(placeFloatingToolbar(
      { left: 0, top: 0, right: 300, bottom: 44 },
      { left: 0, top: 0, right: 1000, bottom: 400 },
      [{ left: 0, top: 0, right: 1000, bottom: 60 }, { left: 10, top: 80, right: 210, bottom: 390 }],
    )).toEqual({ x: 218, y: 68 })
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
