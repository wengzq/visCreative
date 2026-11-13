import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { LocaleProvider } from '@vis/ui-kit'
import type { NodeView } from '@vis/protocol'
import { describe, expect, it, vi } from 'vitest'
import type { ProviderCatalog } from './params'
import { numberedReferences } from './prompt-references'
import { videoReferenceState } from './reference-validation'
import { ReferenceFeedback } from './ReferenceFeedback'
import { PromptPanel } from './PromptPanel'
import type { useGenerationChoice } from './ModelPicker'
import type { CanvasActions } from './CanvasView'

const limits = { max: 3, minMs: 2000, maxMs: 15000, totalMs: 15000, requiresHosting: true }
const model = { id: 'reference-model', label: 'Reference model', kind: 'video' as const, paramsSchema: {}, referenceInputs: { image: 9, video: limits } }
const provider = { id: 'custom-service', type: 'custom', label: 'Custom service', available: true, needsKey: true, hasKey: true, models: [model, { ...model, id: 'text-only', referenceInputs: { image: 0 } }] }
const catalog: ProviderCatalog = { videoReferences: 'ready', providerTypes: [], providers: [provider], defaults: { video: { provider: provider.id, model: model.id } }, limits: { maxConcurrent: 3, dailyImage: 50, dailyVideo: 10, dailyAudio: 20 } }
const node = (nodeId: string, kind: 'video' | 'image' | 'text' = 'video'): NodeView => ({ nodeId, kind, x: 0, y: 0, w: 320, h: 180, z: 0, layoutRevision: 0, slots: [
  { slotId: nodeId, slotKey: 'main', contentType: kind, revision: 0, content: { type: 'asset', assetVersionId: nodeId, mime: `${kind}/mp4` } },
] })
const references = (...durations: (number | undefined)[]) => numberedReferences(durations.map((_, i) => `clip-${i}`), durations.map((_, i) => node(`clip-${i}`)))
  .map((reference, i) => ({ ...reference, durationMs: durations[i] }))

describe('Catalog-driven video references', () => {
  it('counts unique attached clips and sums their durations from pinned asset metadata', () => {
    expect(videoReferenceState(references(2500, 4000), model, 'ready', {})).toMatchObject({ count: 2, totalMs: 6500, knownCount: 2, blocked: false, hostingRequired: false })
    expect(videoReferenceState([], model, 'hosting_required', {})).toMatchObject({ count: 0, blocked: false, hostingRequired: false })
  })

  it('reports count, per-clip duration and total duration in that order, with catalog limits as error params', () => {
    expect(videoReferenceState(references(1000, 16000, 15000, 15000), model, 'ready', {}).problem).toEqual({ reason: 'generation.video_reference_count', params: { max: 3 } })
    for (const duration of [1999, 15001]) expect(videoReferenceState(references(duration, 15000), model, 'ready', {}).problem).toEqual({ reason: 'generation.video_reference_duration', params: { minMs: 2000, maxMs: 15000 } })
    expect(videoReferenceState(references(8000, 8000), model, 'ready', {}).problem).toEqual({ reason: 'generation.video_reference_total_duration', params: { totalMs: 15000 } })
    for (const duration of [2000, 15000]) expect(videoReferenceState(references(duration), model, 'ready', {}).blocked).toBe(false)
  })

  it('reads arbitrary model limits and defers unknown durations to the server while enforcing known rules', () => {
    const wider = { ...model, referenceInputs: { image: 30, video: { max: 10, minMs: 2000, maxMs: 30000, totalMs: 30000 } } }
    expect(videoReferenceState(references(20000, 10000), wider, 'ready', {}).blocked).toBe(false)
    for (const duration of [undefined, Number.NaN]) expect(videoReferenceState(references(duration), model, 'ready', {})).toMatchObject({ durationUnchecked: true, blocked: false, problem: undefined })
    expect(videoReferenceState(references(undefined), model, 'ready', { imageMode: 'first_frame' }).problem?.reason).toBe('generation.frames_reference_mix')
    expect(videoReferenceState(references(3000), provider.models[1], 'ready', {}).problem?.reason).toBe('unsupported')
    for (const imageMode of ['first_frame', 'first_last']) expect(videoReferenceState(references(3000), model, 'ready', { imageMode }).problem?.reason).toBe('generation.frames_reference_mix')
    for (const imageMode of ['auto', 'reference']) expect(videoReferenceState(references(3000), model, 'ready', { imageMode }).blocked).toBe(false)
  })

  it('requires hosting only for a model that declares it, regardless of provider identity', () => {
    expect(videoReferenceState(references(3000), model, 'hosting_required', {})).toMatchObject({ hostingRequired: true, blocked: true })
    const localModel = { ...model, referenceInputs: { image: 9, video: { ...limits, requiresHosting: false } } }
    expect(videoReferenceState(references(3000), localModel, 'hosting_required', {})).toMatchObject({ hostingRequired: false, blocked: false })
    const unspecified = { ...model, referenceInputs: { image: 9, video: { max: 1, minMs: 1, maxMs: 10000, totalMs: 10000 } } }
    expect(videoReferenceState(references(3000), unspecified, 'hosting_required', {}).blocked).toBe(false)
  })

  it('checks catalog image and combined-input limits when a video reference is attached', () => {
    const refs = [...references(3000), ...numberedReferences(['image-1', 'image-2'], [node('image-1', 'image'), node('image-2', 'image')])]
    expect(videoReferenceState(refs, { ...model, referenceInputs: { image: 1, video: limits } }, 'ready', {}).problem).toEqual({ reason: 'images', params: { max: 1 } })
    expect(videoReferenceState(refs, { ...model, referenceInputs: { image: 9, video: limits, total: 2 } }, 'ready', {}).problem).toEqual({ reason: 'total', params: { max: 2 } })
  })
})

function feedback(state: ReturnType<typeof videoReferenceState>, locale: 'en' | 'zh-CN' = 'en') {
  return renderToStaticMarkup(createElement(LocaleProvider, { locale, setLocale() {}, children: createElement(ReferenceFeedback, { state, loading: false, failed: false, onManage() {}, onRetry() {} }) }))
}

it('shows localized count, duration, billing and linked hosting copy before submission', () => {
  const state = videoReferenceState(references(2500, 4000), model, 'hosting_required', {})
  const en = feedback(state)
  expect(en).toContain('2 / 3 videos')
  expect(en).toContain('6.5 / 15 s')
  expect(en).toContain('duration adds to billed tokens')
  expect(en).toContain('Video references require media hosting')
  expect(en).toContain('Media hosting settings</button>')
  expect(en).not.toMatch(/[\u3400-\u9fff]/)
  const zh = feedback(state, 'zh-CN')
  expect(zh).toContain('2 / 3 段视频')
  expect(zh).toContain('6.5 / 15 秒')
  expect(zh).toContain('计费 token')
  expect(zh).toContain('媒体托管设置</button>')
  expect(feedback(videoReferenceState(references(8000, 8000), model, 'ready', {}))).toContain('cannot exceed 15 seconds')
  expect(feedback(videoReferenceState([], model, 'ready', {}))).toBe('')
})

it('wires the hosting settings action and blocks the actual panel submit before duration metadata resolves', () => {
  const onManage = vi.fn()
  const state = videoReferenceState(references(3000), model, 'hosting_required', {})
  // The link uses the same settings navigation as the model picker.
  expect(feedback(state)).toContain('Media hosting settings')
  const settings = { catalog: { ...catalog, videoReferences: 'hosting_required' }, model, provider, choice: { provider: provider.id, model: model.id, params: {} }, configured: true, onManage, blocked: false } as unknown as ReturnType<typeof useGenerationChoice>
  const target = { ...node('target'), inputs: ['clip'], slots: [{ slotId: 'prompt', slotKey: 'prompt', revision: 0, contentType: 'text', content: { type: 'text', body: 'Move the camera' } }] } as NodeView
  const html = renderToStaticMarkup(createElement(LocaleProvider, { locale: 'en', setLocale() {}, children: createElement(PromptPanel, {
    view: target, nodes: [target, node('clip')], text: 'Move the camera', generation: settings, actions: {} as CanvasActions,
    saving: false, picking: false, assetUrl: id => `/assets/${id}`, posterUrl: id => `/posters/${id}`, onPick() {}, onChange() {}, onReset() {}, onCommit: async () => true,
  }) }))
  expect(html).toContain('Media hosting settings')
  expect(html).toMatch(/aria-label="Generate"[^>]*disabled=""/)
})

it('leaves Generate enabled with a non-blocking duration note when a host has no asset resolver', () => {
  const settings = { catalog, model, provider, choice: { provider: provider.id, model: model.id, params: {} }, configured: true, onManage() {}, blocked: false } as unknown as ReturnType<typeof useGenerationChoice>
  const target = { ...node('target'), inputs: ['clip'], slots: [{ slotId: 'prompt', slotKey: 'prompt', revision: 0, contentType: 'text', content: { type: 'text', body: 'Move the camera' } }] } as NodeView
  const html = renderToStaticMarkup(createElement(LocaleProvider, { locale: 'en', setLocale() {}, children: createElement(PromptPanel, {
    view: target, nodes: [target, node('clip')], text: 'Move the camera', generation: settings, actions: {} as CanvasActions,
    saving: false, picking: false, assetUrl: id => `/assets/${id}`, posterUrl: id => `/posters/${id}`, onPick() {}, onChange() {}, onReset() {}, onCommit: async () => true,
  }) }))
  expect(html).toContain('Duration limits could not be checked here')
  expect(html).not.toMatch(/aria-label="Generate"[^>]*disabled=""/)
  expect(html).not.toContain('Retry reading duration')
  expect(feedback(videoReferenceState(references(undefined), model, 'ready', {}), 'zh-CN')).toContain('时长限制')
})
