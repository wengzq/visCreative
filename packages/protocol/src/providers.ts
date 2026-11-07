import { z } from 'zod'
import { Id, MediaKind } from './common'
import { GenerationOperation } from './operations'
import { FrameMode } from './batch'

export const RENDER_MAX_DURATION_MS = 120_000
export const RenderVideoParams = z.object({
  width: z.int().min(64).max(3840).default(1920),
  height: z.int().min(64).max(2160).default(1080),
  fps: z.int().min(1).max(60).default(30),
  durationMs: z.int().positive().max(RENDER_MAX_DURATION_MS).optional(),
  transparent: z.boolean().default(false),
})

const ModelConfig = z.strictObject({ id: z.string().min(1), label: z.string().min(1) })
const DefaultModel = z.strictObject({ provider: Id, model: z.string().min(1) })
export const isBuiltinProviderType = (type: string) => type === 'mock' || type === 'render'
const ProviderDefaults = z.strictObject({ image: DefaultModel.optional(), video: DefaultModel.optional(), audio: DefaultModel.optional() })
export const ProviderBaseUrl = z.url().refine(value => {
  try {
    const url = new URL(value)
    return !url.username && !url.password && !value.includes('?') && !value.includes('#') && (url.protocol === 'https:' ||
      (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))
  } catch {
    return false
  }
}, { message: 'Provider endpoints require HTTPS, except localhost or 127.0.0.1 may use HTTP; usernames, passwords, query parameters and fragments are forbidden' })

const ENDPOINT_VARIABLES = /\{(model|id)\}/g
/** A path below the base URL: no query, fragment, escape or dot segment can move a keyed request elsewhere or put a secret in config. */
export const ProviderEndpointPath = z.string().max(256)
  .regex(/^(?:\/(?:[A-Za-z0-9._~:@+-]|\{(?:model|id)\})+)+$/)
  .refine(path => !path.split('/').some(segment => segment === '.' || segment === '..'), { message: 'Endpoint paths cannot contain dot segments' })
const EndpointId = z.string().regex(/^[a-z][a-zA-Z0-9]*$/)

/** An override keeps exactly the declared variables: some APIs carry the model only in the path, and a task path must name its task. */
export function endpointOverrideValid(declared: string, path: string): boolean {
  if (!ProviderEndpointPath.safeParse(path).success) return false
  const variables = (value: string) => [...new Set([...value.matchAll(ENDPOINT_VARIABLES)].map(match => match[1]!))].sort().join()
  return variables(path) === variables(declared)
}

export const GenerationLimits = z.object({
  maxConcurrent: z.int().nonnegative().default(3),
  dailyImage: z.int().nonnegative().default(50),
  dailyVideo: z.int().nonnegative().default(10),
  dailyAudio: z.int().nonnegative().default(20),
})
export type GenerationLimits = z.infer<typeof GenerationLimits>

/** Built-in models; mock and render are free of charge. */
export const BUILTIN_MODELS: Record<MediaKind, readonly { provider: string; model: string }[]> = {
  image: [{ provider: 'mock', model: 'mock-image-1' }],
  video: [{ provider: 'mock', model: 'mock-video-1' }, { provider: 'render', model: 'html' }],
  audio: [{ provider: 'mock', model: 'mock-music-1' }, { provider: 'mock', model: 'mock-sfx-1' }],
}

/** Daily limits count only paid jobs submitted by Agents; 0 means unlimited. */
export const DAILY_LIMIT_KEY = { image: 'dailyImage', video: 'dailyVideo', audio: 'dailyAudio' } as const satisfies Record<MediaKind, keyof GenerationLimits>

/** Complete global configuration file contents; keys are stored only in the system Keychain. */
export const ProviderConfigSchema = z.strictObject({
  providers: z.array(z.strictObject({
    id: Id.refine(id => !/[\r\n\0]/.test(id), { message: 'Provider IDs cannot contain newlines or null characters' })
      .refine(id => id !== 'mock' && id !== 'render', { message: 'mock and render are built-in provider IDs' }),
    type: Id.regex(/^[a-z][a-z0-9-]*$/),
    label: z.string().min(1),
    baseUrl: ProviderBaseUrl.optional(),
    region: Id.optional(),
    settings: z.record(z.string(), z.unknown()).optional(),
    endpoints: z.record(EndpointId, ProviderEndpointPath).optional(),
    imageModels: z.array(ModelConfig),
    videoModels: z.array(ModelConfig),
    audioModels: z.array(ModelConfig).default([]),
  }).transform((entry, ctx) => {
    const { baseUrl, ...fields } = entry
    if (baseUrl !== undefined) return { ...fields, baseUrl }
    if (entry.type === 'volcengine-ark') return { ...fields, baseUrl: 'https://ark.cn-beijing.volces.com/api/v3' }
    ctx.addIssue({ code: 'custom', path: ['baseUrl'], message: 'Generation services require an explicit endpoint' })
    return z.NEVER
  })),
  defaults: ProviderDefaults,
  limits: GenerationLimits.default({ maxConcurrent: 3, dailyImage: 50, dailyVideo: 10, dailyAudio: 20 }),
}).superRefine((config, ctx) => {
  const providerIds = new Set<string>()
  for (const [index, provider] of config.providers.entries()) {
    if (providerIds.has(provider.id)) {
      ctx.addIssue({ code: 'custom', path: ['providers', index, 'id'], message: 'Provider IDs must be unique' })
    }
    providerIds.add(provider.id)
    const modelIds = new Set<string>()
    for (const key of ['imageModels', 'videoModels', 'audioModels'] as const) {
      for (const [modelIndex, model] of provider[key].entries()) {
        if (modelIds.has(model.id)) {
          ctx.addIssue({ code: 'custom', path: ['providers', index, key, modelIndex, 'id'], message: 'Model IDs within a provider must be unique' })
        }
        modelIds.add(model.id)
      }
    }
  }
  for (const kind of MediaKind.options) {
    const selected = config.defaults[kind]
    if (!selected) continue
    const builtin = BUILTIN_MODELS[kind].some(model => model.provider === selected.provider && model.model === selected.model)
    const models = config.providers.find(provider => provider.id === selected.provider)?.[`${kind}Models`]
    if (!builtin && !models?.some(model => model.id === selected.model)) {
      ctx.addIssue({ code: 'custom', path: ['defaults', kind], message: 'Default models must belong to the specified provider and support the corresponding media kind' })
    }
  }
})
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>

const LocalizedText = z.strictObject({ zh: z.string(), en: z.string() })
export const ProviderTypeDescriptor = z.strictObject({
  type: Id.regex(/^[a-z][a-z0-9-]*$/),
  label: LocalizedText,
  settingsSchema: z.record(z.string(), z.unknown()).optional(),
  settingsFields: z.record(z.string(), z.strictObject({ label: LocalizedText, description: LocalizedText.optional() })).optional(),
  needsKey: z.boolean(),
  kinds: z.array(MediaKind),
  regions: z.array(z.strictObject({ id: Id, label: LocalizedText, baseUrl: ProviderBaseUrl })),
  allowCustomBaseUrl: z.boolean(),
  endpoints: z.array(z.strictObject({ id: EndpointId, label: LocalizedText, path: ProviderEndpointPath, requiredFor: z.array(MediaKind).optional() })).optional(),
  knownModels: z.array(z.strictObject({ id: z.string().min(1), kind: MediaKind, label: z.string().min(1) })),
  help: z.strictObject({ consoleUrl: z.url(), key: LocalizedText, model: LocalizedText.optional() }),
  availability: LocalizedText.optional(),
  verified: z.boolean(),
})

const ProviderCatalog = z.strictObject({
  providerTypes: z.array(ProviderTypeDescriptor),
  providers: z.array(z.strictObject({
    id: Id,
    type: Id,
    label: z.string().min(1),
    baseUrl: ProviderBaseUrl.optional(),
    region: Id.optional(),
    settings: z.record(z.string(), z.unknown()).optional(),
    endpoints: z.record(EndpointId, ProviderEndpointPath).optional(),
    needsKey: z.boolean(),
    available: z.boolean(),
    unavailableReason: z.string().optional(),
    hasKey: z.boolean(),
    models: z.array(z.strictObject({
      id: z.string().min(1),
      label: z.string().min(1),
      kind: MediaKind,
      // JSON Schema preserves parameter default, enum and description without exposing keys.
      paramsSchema: z.record(z.string(), z.unknown()),
      // 0021: supported generation operations; absent means ['generate']; read with modelOperations()
      operations: z.array(GenerationOperation).optional(),
      // 0023: frame inputs a video model accepts; absent means none (prompt-only video)
      frameModes: z.array(FrameMode).optional(),
    })),
  })),
  defaults: ProviderDefaults,
  unavailableDefaults: z.array(MediaKind).optional(),
  limits: GenerationLimits.default({ maxConcurrent: 3, dailyImage: 50, dailyVideo: 10, dailyAudio: 20 }),
  // 0022: whether Agents run in an isolated sandbox; for none (Windows), the UI warns before key entry. Defaults to sandbox.
  agentIsolation: z.enum(['sandbox', 'none']).optional(),
})

const KeyStatus = z.strictObject({ providerId: Id, hasKey: z.boolean() })

export const providers = {
  list: { params: z.strictObject({}), result: ProviderCatalog },
  update: { params: z.strictObject({ config: ProviderConfigSchema }), result: ProviderCatalog },
  setKey: {
    params: z.strictObject({ providerId: Id, apiKey: z.string().trim().min(1) }),
    result: KeyStatus,
  },
  clearKey: { params: z.strictObject({ providerId: Id }), result: KeyStatus },
} as const
