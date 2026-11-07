import type { ProviderCatalog } from '@vis/canvas-ui'
import { LocaleProvider } from '@vis/ui-kit'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ProviderSettings } from './ProviderSettings'

const catalog: ProviderCatalog = { providerTypes: [{
  type: 'volcengine-ark', label: { zh: '火山方舟', en: 'Volcengine Ark' }, needsKey: true,
  kinds: ['image', 'video', 'audio'], regions: [], allowCustomBaseUrl: true, knownModels: [],
  help: { consoleUrl: 'https://example.invalid', key: { zh: '', en: '' } }, verified: true,
}],
  providers: [
    { id: 'mock', type: 'mock', label: 'Mock', needsKey: false, available: true, hasKey: false, models: [
      { id: 'mock-music-1', label: 'Mock 音乐', kind: 'audio', paramsSchema: {} },
      { id: 'mock-sfx-1', label: 'Mock 音效', kind: 'audio', paramsSchema: {} },
    ] },
    { id: 'ark', type: 'volcengine-ark', label: '方舟', needsKey: true, available: true, hasKey: false, models: [
      { id: 'ep-audio', label: '音频接入点', kind: 'audio', paramsSchema: {} },
    ] },
  ],
  defaults: { audio: { provider: 'mock', model: 'mock-sfx-1' } },
  limits: { maxConcurrent: 3, dailyImage: 50, dailyVideo: 10, dailyAudio: 20 },
}
const render = (value = catalog, initialSection?: 'guardrails') => renderToStaticMarkup(createElement(ProviderSettings, {
  catalog: value, localePreference: null, async onLocaleChange() {}, rpc: { call: vi.fn() }, onClose() {}, onUpdated() {}, ...(initialSection ? { initialSection } : {}),
}))

describe('Audio service settings and agent generation limits', () => {
  it('renders unavailable services read-only with a reason while keeping removal enabled', () => {
    const unavailable: ProviderCatalog = { ...catalog, providers: [{
      id: 'removed', type: 'community', label: 'Removed service', baseUrl: 'https://example.invalid',
      available: false, unavailableReason: 'provider.type_unavailable', needsKey: false, hasKey: false,
      models: [{ id: 'legacy', label: 'Legacy', kind: 'image', paramsSchema: {} }],
    }], defaults: { image: { provider: 'removed', model: 'legacy' } }, unavailableDefaults: ['image'] }
    const html = render(unavailable)
    expect(html).toContain('此服务不可用，仅可删除')
    expect(html).toContain('生成服务类型 community 未注册')
    expect(html).toContain('<fieldset class="provider-settings-fields" disabled="">')
    expect(html).toMatch(/<button type="button" class="provider-settings-danger">/)
    expect(html).toContain('默认生成服务不可用')
    expect(html).toContain('Legacy')
    expect(html).not.toMatch(/<button[^>]*>自定义模型 ID<\/button>/)
    expect(html).not.toContain('<legend>视频模型</legend>')
    expect(html).not.toContain('<legend>音频模型</legend>')
  })
  it('English settings show the general entry, service forms, and guardrails while preserving user model names', () => {
    const html = renderToStaticMarkup(createElement(LocaleProvider, { locale: 'en', setLocale() {}, children: createElement(ProviderSettings, {
      catalog, localePreference: null, async onLocaleChange() {}, rpc: { call: vi.fn() }, onClose() {}, onUpdated() {}, initialSection: 'guardrails',
    }) }))
    for (const text of ['General', 'Close settings', 'Safety and limits', 'Agent daily audio limit', 'Default audio model']) expect(html).toContain(text)
    expect(html).toContain('Mock music')
    expect(html).toContain('Mock sound effects')
    expect(html).not.toContain('Mock 音乐')
    expect(html).toContain('音频接入点')
    expect(html).not.toContain('默认音频模型')
    expect(html).not.toContain('Agent 每日音频上限')
  })

  it('lists built-in music and sound effects; default audio can use built-in or configured models', () => {
    const html = render()
    expect(html).toContain('Mock 音乐 <code>mock-music-1</code>')
    expect(html).toContain('Mock 音效 <code>mock-sfx-1</code>')
    expect(html).toContain('默认音频模型')
    expect(html).toContain('selected="">Mock 音效</option>')
    expect(html).toContain('音频接入点（未配置密钥）</option>')
    expect(html).toContain('使用内置默认模型（Mock）')
  })

  it('displays matching display names and model IDs only once; configuration saving uses the shared primary button', () => {
    const html = render({ ...catalog, providers: [{ ...catalog.providers[0]!, models: [{ id: 'mock-image-1', label: 'mock-image-1', kind: 'image', paramsSchema: {} }] }] })
    expect(html).toContain('<li>mock-image-1</li>')
    expect(html).not.toContain('<code>mock-image-1</code>')
    expect(html).toContain('type="submit" class="is-primary"')
  })

  it('existing audio models remain editable and support adding and removing', () => {
    const html = render({ ...catalog, providers: [...catalog.providers].reverse() })
    expect(html).toContain('<legend>音频模型</legend>')
    expect(html).toContain('value="ep-audio"')
    expect(html).toContain('value="音频接入点"')
    expect(html).toContain('自定义模型 ID')
    expect(html).toContain('aria-label="删除音频模型 音频接入点"')
  })

  it('three daily limits explicitly apply only to agents; maximum concurrency still applies to all paid generation', () => {
    const html = render(catalog, 'guardrails')
    for (const kind of ['图片', '视频', '音频']) expect(html).toContain(`Agent 每日${kind}上限`)
    expect(html).toContain('只限制 Agent 提交的付费生成；你在界面上的生成不受限制。0 表示不限')
    expect(html).toContain('最大并发任务数对所有付费生成生效。')
    expect(html).toMatch(/id="[^"]+-dailyAudio"[^>]+value="20"/)
  })
})
