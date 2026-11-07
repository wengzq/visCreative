import { formatter, LocaleProvider } from '@vis/ui-kit'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { GenerationUsage, type GenerationUsageData, UsageCount } from './GenerationUsage'

describe('Total paid usage and agent quotas', () => {
  it('English usage formats numbers; job issues and backend errors do not leak Chinese UI copy', () => {
    const usage: GenerationUsageData = {
      date: '2026-10-29', image: 1000, video: 0, audio: 0,
      agent: { image: 1000, video: 0, audio: 0 },
      limits: { maxConcurrent: 3, dailyImage: 2000, dailyVideo: 0, dailyAudio: 0 },
      // english-exempt: Chinese backend diagnostic fixture verifies English UI fallback.
      jobs: [{ jobId: 'failed-job', kind: 'image', status: 'failed', error: { code: 'provider_error', message: '生成服务返回错误' }, outputs: [], targets: [] }],
    }
    const html = renderToStaticMarkup(createElement(LocaleProvider, { locale: 'en', setLocale() {}, children: createElement(GenerationUsage, {
      usage, error: '', spaceId: undefined, onClose() {}, async onCancel() {}, async onRegenerate() {}, async onRecheck() {}, onSelectProject() {},
    }) }))
    expect(html).toContain('images 1,000')
    expect(html).toContain('<span>1,000 / 2,000</span>')
    expect(html).toContain('Unlimited')
    expect(html).toContain('Generation failed')
    expect(html).toContain('The generation service returned an error')
    expect(html).not.toMatch(/[㐀-鿿]/)
  })

  it('total submissions are not compared with limits; agent usage and limits for three media types are listed separately', () => {
    const usage: GenerationUsageData = {
      date: '2026-10-29', image: 7, video: 3, audio: 9,
      agent: { image: 1, video: 1, audio: 2 },
      limits: { maxConcurrent: 3, dailyImage: 2, dailyVideo: 0, dailyAudio: 1 },
      jobs: [{ jobId: 'audio-job', kind: 'audio', status: 'succeeded', outputs: [], targets: [] }],
    }
    const html = renderToStaticMarkup(createElement(GenerationUsage, {
      usage, error: '', spaceId: undefined, onClose() {}, async onCancel() {}, async onRegenerate() {}, async onRecheck() {}, onSelectProject() {},
    }))
    expect(html).toContain(`<p>${formatter('zh-CN').dateTime(new Date('2026-10-29T00:00:00').getTime(), { year: 'numeric', month: '2-digit', day: '2-digit' })} · 全部付费提交：图片 7 · 视频 3 · 音频 9</p>`)
    expect(html).toContain('Agent 已用 / 上限：图片 <span>1 / 2</span> · 视频 <span>1 / 不限</span> · 音频 <span class="is-over">2 / 1</span>')
    expect(html).toContain('音频 · 已完成')
    expect(html).toContain('包括失败和取消的任务。最大并发 3。')
  })

  it('unlimited usage shows no warning; reaching but not exceeding the limit also shows no warning', () => {
    for (const limit of [0, 2]) {
      expect(renderToStaticMarkup(createElement(UsageCount, { count: 2, limit }))).not.toContain('is-over')
    }
  })
})
