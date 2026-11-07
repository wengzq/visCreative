import { describe, expect, it } from 'vitest'
import { defaultParams, fitParams, parameterFields, segmentOptions, resolveChoice, type ProviderCatalog } from './params'

const catalog: ProviderCatalog = { providerTypes: [], providers: [
  { id: 'mock', type: 'mock', label: 'Mock', needsKey: false, available: true, hasKey: false, models: [{ id: 'mock-image-1', label: 'Mock', kind: 'image', paramsSchema: { properties: { n: { type: 'integer', default: 1 } } } }] },
  { id: 'ark', type: 'volcengine-ark', label: '方舟', needsKey: true, available: true, hasKey: true, models: [{ id: 'ep-image', label: '图片', kind: 'image', paramsSchema: { properties: { size: { type: 'string', default: '2K' } } } }] },
], defaults: { image: { provider: 'ark', model: 'ep-image' } }, limits: { maxConcurrent: 3, dailyImage: 50, dailyAudio: 20, dailyVideo: 10 } }

describe('Generation parameter selection', () => {
  it('never offers unavailable service models even when saved settings or defaults point to them', () => {
    const removed = { ...catalog, providers: catalog.providers.map(provider => ({ ...provider, available: provider.id !== 'ark' })) }
    expect(resolveChoice(removed, 'image', { provider: 'ark', model: 'ep-image' })?.provider).toBe('mock')
  })
  it('Audio duration uses the default or saved music/sound-effect model without borrowing an image model', () => {
    const audio: ProviderCatalog = { ...catalog, defaults: { audio: { provider: 'mock', model: 'mock-music-1' } }, providers: [
      catalog.providers[1]!,
      { id: 'audio', type: 'volcengine-ark', label: '音频服务', needsKey: true, available: true, hasKey: true, models: [{ id: 'configured-audio', label: '音频', kind: 'audio', paramsSchema: {} }] },
      { id: 'mock', type: 'mock', label: 'Mock', needsKey: false, available: true, hasKey: false, models: [
        { id: 'mock-music-1', label: 'Mock 音乐', kind: 'audio', paramsSchema: { properties: { duration: { type: 'integer', default: 10 } } } },
        { id: 'mock-sfx-1', label: 'Mock 音效', kind: 'audio', paramsSchema: { properties: { duration: { type: 'integer', default: 2 } } } },
      ] },
    ] }
    expect(resolveChoice(audio, 'audio')).toEqual({ provider: 'mock', model: 'mock-music-1', params: { duration: 10 } })
    expect(resolveChoice(audio, 'audio', { provider: 'mock', model: 'mock-sfx-1' })).toEqual({ provider: 'mock', model: 'mock-sfx-1', params: { duration: 2 } })
    expect(resolveChoice(audio, 'audio', { provider: 'audio', model: 'configured-audio' })?.model).toBe('configured-audio')
    expect(resolveChoice(audio, 'audio', { provider: 'ark', model: 'ep-image' })?.model).toBe('mock-music-1')
  })
  it('New nodes use global defaults; existing nodes retain parameters; deleted models fall back and drop old parameters', () => {
    expect(resolveChoice(catalog, 'image', null)).toEqual({ provider: 'ark', model: 'ep-image', params: { size: '2K' } })
    expect(resolveChoice(catalog, 'image', { provider: 'ark', model: 'ep-image', params: { size: '4K' } })?.params).toEqual({ size: '4K' })
    expect(resolveChoice(catalog, 'image', { provider: 'deleted', model: 'gone', params: { obsolete: true } })).toEqual({ provider: 'ark', model: 'ep-image', params: { size: '2K' } })
  })
  it('Partial node settings merge defaults; models never cross media types, and empty catalogs do not crash', () => {
    expect(resolveChoice(catalog, 'image', { params: { size: '4K' } })).toEqual({ provider: 'ark', model: 'ep-image', params: { size: '4K' } })
    expect(resolveChoice(catalog, 'image', { provider: 'mock', params: { n: 3 } })).toEqual({ provider: 'mock', model: 'mock-image-1', params: { n: 3 } })
    expect(resolveChoice(catalog, 'video', { provider: 'ark', model: 'ep-image' })).toBeNull()
    expect(resolveChoice({ ...catalog, providers: [], defaults: {} }, 'image', null)).toBeNull()
    expect(resolveChoice({ ...catalog, defaults: {} }, 'image', { params: { n: 2 } })).toEqual({ provider: 'mock', model: 'mock-image-1', params: { n: 2 } })
  })
  it('After model capabilities narrow, discard old node values that are no longer accepted and fill from defaults', () => {
    const video: ProviderCatalog = { ...catalog, providers: [{ id: 'ark', type: 'volcengine-ark', label: '方舟', needsKey: true, available: true, hasKey: true, models: [{ id: 'fast', label: 'fast', kind: 'video', paramsSchema: { properties: {
      resolution: { type: 'string', enum: ['480p', '720p'] },
      duration: { type: 'integer', minimum: 4, maximum: 15 },
      watermark: { type: 'boolean', default: false },
    } } }] }], defaults: { video: { provider: 'ark', model: 'fast' } } }
    const saved = { provider: 'ark', model: 'fast', params: { resolution: '1080p', duration: 30, watermark: true, obsolete: 1 } }
    expect(resolveChoice(video, 'video', saved)?.params).toEqual({ watermark: true })
    expect(fitParams(video.providers[0]!.models[0]!.paramsSchema, { resolution: '720p', duration: 12 })).toEqual({ resolution: '720p', duration: 12 })
  })
  it('Hide const, single-value enums, and fixed integers while retaining submission defaults', () => {
    const schema = { properties: {
      n: { type: 'number', const: 1, default: 1 },
      mode: { type: 'string', enum: ['auto'], default: 'auto' },
      fixed: { type: 'integer', minimum: 2, maximum: 2, default: 2 },
      size: { type: 'string', examples: ['1K', '2K', '4K'], default: '2K' },
    } }
    expect(parameterFields(schema).map(([key]) => key)).toEqual(['size'])
    expect(defaultParams(schema)).toEqual({ n: 1, mode: 'auto', fixed: 2, size: '2K' })
    expect(segmentOptions(parameterFields(schema)[0]![1])).toEqual(['1K', '2K', '4K'])
  })
  it('Only convert finite small integer ranges, short enums, and string examples to segmented options', () => {
    expect(segmentOptions({ type: 'integer', minimum: 1, maximum: 4 })).toEqual([1, 2, 3, 4])
    expect(segmentOptions({ type: 'integer', minimum: -1, maximum: 3 })).toEqual([-1, 0, 1, 2, 3])
    expect(segmentOptions({ type: 'integer', minimum: 1, maximum: 6 })).toBeUndefined()
    expect(segmentOptions({ type: 'integer', minimum: 1 })).toBeUndefined()
    expect(segmentOptions({ type: 'integer', minimum: 4, maximum: 1 })).toBeUndefined()
    expect(segmentOptions({ type: 'number', minimum: 1, maximum: 4 })).toBeUndefined()
    expect(segmentOptions({ type: 'string', enum: ['a', 'b'] })).toEqual(['a', 'b'])
    expect(segmentOptions({ type: 'string', enum: ['a', 'b', 'c', 'd', 'e'] })).toBeUndefined()
    expect(segmentOptions({ type: 'string', examples: [] })).toBeUndefined()
  })
  it('Generate finite union controls, preserve false/0 defaults, and skip object shapes', () => {
    const schema = { properties: { duration: { anyOf: [{ type: 'number', const: -1 }, { type: 'integer', minimum: 2, maximum: 4 }] }, flag: { type: 'boolean', default: false }, seed: { type: 'integer', default: 0 }, nested: { type: 'object' } } }
    expect(parameterFields(schema).map(([key]) => key)).toEqual(['duration', 'flag', 'seed'])
    expect(parameterFields(schema)[0]![1].enum).toEqual([-1, 2, 3, 4])
    expect(defaultParams(schema)).toEqual({ flag: false, seed: 0 })
  })
})
