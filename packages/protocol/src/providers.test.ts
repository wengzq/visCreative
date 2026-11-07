import { describe, expect, it } from 'vitest'
import { METHODS, NOTIFICATIONS, ProviderConfigSchema, describeCapability, listCapabilities, endpointOverrideValid, ProviderEndpointPath } from './index'

const provider = {
  id: 'ark',
  type: 'volcengine-ark',
  label: '火山方舟',
  imageModels: [{ id: 'seedream', label: 'Seedream' }],
  videoModels: [{ id: 'seedance', label: 'Seedance' }],
}
const config = {
  providers: [provider],
  defaults: {
    image: { provider: 'ark', model: 'seedream' },
    video: { provider: 'ark', model: 'seedance' },
  },
}

describe('provider endpoint paths', () => {
  it.each(['/images/generations', '/v2/generation', '/models/{model}:generate', '/jobs/{id}/status'])('accepts %s', path => {
    expect(ProviderEndpointPath.safeParse(path).success).toBe(true)
  })
  it.each(['images', 'https://other.invalid/x', '//other.invalid/x', '/x?ak=secret', '/x#fragment', '/a/../b', '/a/./b', '/a//b', '/a/', '/%2e%2e/x', '/a\\b', '/{other}', '/a b'])('rejects %s', path => {
    expect(ProviderEndpointPath.safeParse(path).success).toBe(false)
  })
  it('keeps task identity and allows only declared variables', () => {
    expect(endpointOverrideValid('/tasks/{id}', '/jobs/{id}')).toBe(true)
    expect(endpointOverrideValid('/tasks/{id}', '/jobs')).toBe(false)
    expect(endpointOverrideValid('/tasks', '/jobs/{id}')).toBe(false)
    expect(endpointOverrideValid('/video/{model}', '/video')).toBe(false)
    expect(endpointOverrideValid('/video/{model}', '/v2/{model}/run')).toBe(true)
    expect(endpointOverrideValid('/video/{model}', '/video/{id}')).toBe(false)
  })
})

describe('providers', () => {
  it('accepts open provider types and non-secret settings without adding fields to legacy entries', () => {
    const legacy = ProviderConfigSchema.parse(config)
    expect(ProviderConfigSchema.parse(legacy)).toEqual(legacy)
    expect(legacy.providers[0]).not.toHaveProperty('region')
    expect(legacy.providers[0]).not.toHaveProperty('settings')
    expect(ProviderConfigSchema.parse({ ...config, providers: [{ ...provider, type: 'example', baseUrl: 'https://example.invalid', region: 'east', settings: { project: 'demo' } }] }).providers[0])
      .toMatchObject({ type: 'example', region: 'east', settings: { project: 'demo' } })
    expect(ProviderConfigSchema.safeParse({ ...config, providers: [{ ...provider, type: 'invalid type' }] }).success).toBe(false)
  })
  it('fills the Ark endpoint; allows HTTPS or local HTTP and rejects URL credentials', () => {
    expect(ProviderConfigSchema.safeParse({ ...config, providers: [{ ...provider, type: 'example' }] }).success).toBe(false)
    expect(ProviderConfigSchema.parse(config).providers[0]?.baseUrl).toBe('https://ark.cn-beijing.volces.com/api/v3')
    for (const baseUrl of ['https://ark.example/api/v3', 'http://localhost:4321/api/v3', 'http://127.0.0.1:4321/api/v3']) {
      expect(ProviderConfigSchema.safeParse({ ...config, providers: [{ ...provider, baseUrl }] }).success).toBe(true)
    }
    for (const baseUrl of ['not a URL', 'http://ark.example/api/v3', 'http://localhost.example/api', 'ftp://localhost/api', 'https://user:secret@ark.example/api', 'http://user@localhost/api', 'https://ark.example/api?key=secret', 'https://ark.example/api#secret', 'https://ark.example/api?', 'https://ark.example/api#']) {
      expect(ProviderConfigSchema.safeParse({ ...config, providers: [{ ...provider, baseUrl }] }).success, baseUrl).toBe(false)
    }
  })

  it('legacy configuration fills audio models and Agent limits; default audio models must support audio', () => {
    const parsed = ProviderConfigSchema.parse(config)
    expect(parsed.providers[0]?.audioModels).toEqual([])
    expect(parsed.limits.dailyAudio).toBe(20)
    for (const model of ['mock-music-1', 'mock-sfx-1']) {
      expect(ProviderConfigSchema.safeParse({ providers: [], defaults: { audio: { provider: 'mock', model } } }).success).toBe(true)
    }
    const audioProvider = { ...provider, audioModels: [{ id: 'seed-audio', label: 'Seed-Audio' }] }
    expect(ProviderConfigSchema.safeParse({ providers: [audioProvider], defaults: { audio: { provider: 'ark', model: 'seed-audio' } }, limits: { dailyAudio: 0 } }).success).toBe(true)
    expect(ProviderConfigSchema.safeParse({ providers: [audioProvider], defaults: { audio: { provider: 'ark', model: 'seedance' } } }).success).toBe(false)
    expect(ProviderConfigSchema.safeParse({ providers: [audioProvider], defaults: { image: { provider: 'ark', model: 'seed-audio' } } }).success).toBe(false)
    expect(ProviderConfigSchema.safeParse({ providers: [{ ...audioProvider, audioModels: provider.imageModels }], defaults: {} }).success).toBe(false)
  })

  it('rejects reserved provider IDs, duplicate IDs and mismatched default models', () => {
    for (const id of ['mock', 'render']) {
      expect(ProviderConfigSchema.safeParse({ providers: [{ ...provider, id }], defaults: {} }).success).toBe(false)
    }
    expect(ProviderConfigSchema.safeParse({ ...config, providers: [provider, provider] }).success).toBe(false)
    expect(ProviderConfigSchema.safeParse({ ...config, providers: [{ ...provider, imageModels: [provider.imageModels[0], provider.imageModels[0]] }] }).success).toBe(false)
    expect(ProviderConfigSchema.safeParse({ ...config, providers: [{ ...provider, videoModels: provider.imageModels }] }).success).toBe(false)
    for (const image of [{ provider: 'missing', model: 'seedream' }, { provider: 'ark', model: 'seedance' }, { provider: 'ark', model: 'missing' }, { provider: 'render', model: 'html' }]) {
      expect(ProviderConfigSchema.safeParse({ ...config, defaults: { image } }).success).toBe(false)
    }
    expect(ProviderConfigSchema.safeParse({ providers: [], defaults: {} }).success).toBe(true)
    expect(ProviderConfigSchema.safeParse({ providers: [], defaults: { image: { provider: 'mock', model: 'mock-image-1' }, video: { provider: 'render', model: 'html' } } }).success).toBe(true)
    expect(ProviderConfigSchema.safeParse({ providers: [], defaults: { video: { provider: 'mock', model: 'mock-video-1' } } }).success).toBe(true)
  })

  it('rejects provider ID control characters unsupported by Keychain before writing configuration', () => {
    for (const id of ['ark\rtest', 'ark\ntest', 'ark\0test']) {
      const invalidConfig = { providers: [{ ...provider, id }], defaults: {} }
      expect(ProviderConfigSchema.safeParse(invalidConfig).success).toBe(false)
      expect(METHODS['providers.update'].params.safeParse({ config: invalidConfig }).success).toBe(false)
    }
  })

  it('configuration and list results reject key fields; listings include interpretable parameter schemas', () => {
    expect(ProviderConfigSchema.safeParse({ ...config, apiKey: 'secret' }).success).toBe(false)
    expect(ProviderConfigSchema.safeParse({ ...config, providers: [{ ...provider, apiKey: 'secret' }] }).success).toBe(false)
    const entry = {
      id: 'ark', type: 'volcengine-ark', label: '火山方舟', hasKey: true, needsKey: true, available: true,
      models: [{ id: 'seedream', label: 'Seedream', kind: 'image', paramsSchema: {
        type: 'object', properties: { size: { type: 'string', enum: ['2K', '4K'], default: '2K', description: '输出尺寸' } },
      } }],
    }
    const result = { providerTypes: [], providers: [entry], defaults: config.defaults, limits: { maxConcurrent: 3, dailyImage: 50, dailyVideo: 10 } }
    expect(METHODS['providers.list'].result.parse(result)).toEqual({ ...result, limits: { ...result.limits, dailyAudio: 20 } })
    expect(METHODS['providers.list'].result.safeParse({ ...result, providers: [{ ...entry, apiKey: 'secret' }] }).success).toBe(false)
  })

  it('Agents can only read providers; configuration and key requests strictly forbid requestId', () => {
    expect(METHODS['providers.list'].callers).toEqual(['ui', 'agent'])
    expect(listCapabilities('agent').filter(item => item.method.startsWith('providers.')).map(item => item.method)).toEqual(['providers.list'])
    for (const method of ['providers.update', 'providers.setKey', 'providers.clearKey'] as const) {
      expect(METHODS[method].callers).toEqual(['ui'])
      expect(describeCapability(method, 'agent')).toBeUndefined()
    }
    const cases = [
      ['providers.update', { config }],
      ['providers.setKey', { providerId: 'ark', apiKey: 'secret' }],
      ['providers.clearKey', { providerId: 'ark' }],
    ] as const
    for (const [method, params] of cases) {
      expect(METHODS[method].params.safeParse(params).success).toBe(true)
      expect(METHODS[method].params.safeParse({ ...params, requestId: 'never-persist-secret' }).success).toBe(false)
    }
    expect(METHODS['providers.setKey'].params.safeParse({ providerId: 'ark', apiKey: '  ' }).success).toBe(false)
    expect(NOTIFICATIONS['events.providersChanged'].safeParse({}).success).toBe(true)
    expect(NOTIFICATIONS['events.providersChanged'].safeParse({ apiKey: 'secret' }).success).toBe(false)
  })
})
