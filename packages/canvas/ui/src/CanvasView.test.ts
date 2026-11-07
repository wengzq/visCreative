import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LocaleProvider, type Locale } from '@vis/ui-kit'
import { CanvasView, type CanvasViewProps } from './CanvasView'
import { OrganizationPreview } from './OrganizationPreview'
import type { NodeView } from '@vis/protocol'

const render = (locale: Locale) => renderToStaticMarkup(createElement(LocaleProvider, {
  locale, setLocale() {}, children: createElement(CanvasView, { nodes: [], assetUrl: (id: string) => id } as unknown as CanvasViewProps),
}))

describe('Canvas UI language', () => {
  it('English toolbar, category suggestions, and empty-canvas hints contain no Chinese', () => {
    const html = render('en')
    expect(html).toContain('aria-label="Generate image"')
    expect(html).toContain('aria-label="Canvas shortcuts"')
    expect(html).toContain('value="Characters"')
    expect(html).not.toMatch(/[\u3400-\u9fff]/)
  })

  it('Chinese toolbar, category suggestions, and menu copy remain unchanged', () => {
    const html = render('zh-CN')
    expect(html).toContain('aria-label="生图"')
    expect(html).toContain('aria-label="画布快捷键"')
    expect(html).toContain('value="人物"')
    expect(html).toContain('整理全部产物；保留内容、连线和已有框大小，可一次撤销。')
  })
})


it('The English organization preview preserves original titles of reused frames', () => {
  const frame: NodeView = { nodeId: 'frame', kind: 'frame', x: 0, y: 0, w: 400, h: 400, z: 0, layoutRevision: 0, slots: [], frame: { title: '未分类', color: 'gray' } }
  const html = renderToStaticMarkup(createElement(LocaleProvider, {
    locale: 'en', setLocale() {}, children: createElement(OrganizationPreview, {
      nodes: [frame], ops: [], groups: [{ frameId: 'frame', category: 'Uncategorized', nodeIds: [], x: 0, y: 0, w: 400, h: 400 }],
    }),
  }))
  expect(html).toContain('>未分类</text>')
  expect(html).toContain('Uncategorized 0 nodes')
})
