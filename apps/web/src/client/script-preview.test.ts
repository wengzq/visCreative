import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { LocaleProvider } from '@vis/ui-kit'
import { NodePreview, RefThumb, type RefPreview } from '../../../../packages/workbench/ui/src/RefThumb'

it('renders script reference and mention previews with the table glyph and localized counts', () => {
  const preview = { kind: 'script', label: 'Storyboard', shots: 3, assets: 2 } as unknown as RefPreview
  for (const locale of ['en', 'zh-CN'] as const) {
    for (const children of [
      createElement(NodePreview, { preview, large: true }),
      createElement(RefThumb, { nodeId: 'script', resolveRef: () => preview, onLocateRef() {} }),
    ]) {
      const html = renderToStaticMarkup(createElement(LocaleProvider, { locale, setLocale() {}, children }))
      expect(html).toContain('M3 9h18M3 14h18M9 9v11')
      expect(html).toContain(locale === 'en' ? '3 shots · 2 assets' : '3 个镜头 · 2 个资产')
    }
  }
})
