import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { LocaleProvider, type Locale } from '@vis/ui-kit'
import { expect, it } from 'vitest'
import type { useGenerationChoice } from './ModelPicker'
import { ModelParameters } from './ParamsSummary'

it('renders model-owned Wan audio/prompt extension labels and Ark descriptions in both languages', () => {
  const schema = { properties: {
    audio: { type: 'boolean', default: true, 'x-vis-label': { zh: '生成音频', en: 'Generate audio' } },
    prompt_extend: { type: 'boolean', default: true, 'x-vis-label': { zh: '扩展提示词', en: 'Extend prompt' } },
    size: {
      type: 'string', examples: ['1K', '2K'],
      'x-vis-label': { zh: '尺寸', en: 'Size' },
      'x-vis-description': { zh: '自定义宽*高', en: 'Custom width*height' },
    },
    imageMode: {
      type: 'string', enum: ['auto', 'reference'], default: 'auto',
      description: 'Agent-facing description',
      'x-vis-label': { zh: '参考图片模式', en: 'Reference image mode' },
      'x-vis-description': { zh: '选择参考图片的用途', en: 'Choose how reference images are used' },
      'x-vis-options': { auto: { zh: '自动选择', en: 'Automatic selection' }, reference: { zh: '参考图', en: 'Reference images' } },
    },
  } }
  const settings = {
    model: { id: 'schema-model', label: 'Schema model', kind: 'video', paramsSchema: schema },
    choice: { provider: 'schema-provider', model: 'schema-model', params: { audio: true, prompt_extend: true, imageMode: 'auto' } },
    select: async () => {},
  } as unknown as ReturnType<typeof useGenerationChoice>
  const render = (locale: Locale) => renderToStaticMarkup(createElement(LocaleProvider, {
    locale, setLocale() {}, children: createElement(ModelParameters, { settings }),
  }))
  const en = render('en')
  expect(en).toContain('aria-label="Generate audio"')
  expect(en).toContain('aria-label="Extend prompt"')
  expect(en).toContain('Automatic selection')
  expect(en).toContain('title="Choose how reference images are used"')
  expect(en).toMatch(/<input[^>]*title="Custom width\*height"/)
  expect(en).not.toMatch(/\p{Script=Han}/u)
  const zh = render('zh-CN')
  expect(zh).toContain('aria-label="生成音频"')
  expect(zh).toContain('aria-label="扩展提示词"')
  expect(zh).toContain('自动选择')
  expect(zh).toContain('title="选择参考图片的用途"')
})
