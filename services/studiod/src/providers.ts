import type { MediaTools } from '@vis/assets'
import { VisError } from '@vis/domain'
import { createProviderTypeRegistry, paramsSchemaOf, type ProviderAdapter, type ProviderDefaults, type ProviderType } from '@vis/generation'
import { BUILTIN_MODELS, endpointOverrideValid, MediaKind, ProviderConfigSchema, type MethodResult, type ProviderConfig } from '@vis/protocol'
import { loadProviderConfig, saveProviderConfig } from './provider-config'
import type { SecretStore } from './secret-store'

export type ProviderManager = ReturnType<typeof createProviderManager>

export function createProviderManager(opts: {
  dataDir: string
  builtins: ProviderAdapter[]
  defaults: ProviderDefaults
  secrets: SecretStore
  media: MediaTools
  providerTypes?: readonly ProviderType[]
  onChange(providers: ProviderAdapter[], defaults: ProviderDefaults, limits: ProviderConfig['limits']): void
}) {
  let config = loadProviderConfig(opts.dataDir)
  const types = createProviderTypeRegistry(opts.providerTypes)
  function validate(entry: ProviderConfig['providers'][number]) {
    const type = types.get(entry.type)
    if (!type) throw VisError.of('invalid_params', 'provider.type_unavailable', { type: entry.type }, `Generation service type ${entry.type} is not registered`)
    const region = type.regions.find(region => region.id === entry.region)
    if ((entry.region !== undefined && (!region || region.baseUrl !== entry.baseUrl)) ||
      (!type.allowCustomBaseUrl && !type.regions.some(region => region.baseUrl === entry.baseUrl))) {
      throw VisError.of('invalid_params', 'provider.region_invalid', {}, 'Choose a supported generation service region')
    }
    // Overrides belong to a custom URL: official hosts keep the paths their adapter was written against.
    const custom = entry.region === undefined && !type.regions.some(region => region.baseUrl === entry.baseUrl?.replace(/\/+$/, ''))
    if (entry.endpoints !== undefined && !custom) throw VisError.of('invalid_params', 'provider.endpoint_invalid', {}, 'Generation service endpoint paths are invalid')
    for (const [id, path] of Object.entries(entry.endpoints ?? {})) {
      const declared = type.endpoints?.find(endpoint => endpoint.id === id)
      if (!declared || !endpointOverrideValid(declared.path, path)) throw VisError.of('invalid_params', 'provider.endpoint_invalid', {}, 'Generation service endpoint paths are invalid')
    }
    if (entry.endpoints !== undefined && type.endpoints?.some(endpoint => !entry.endpoints![endpoint.id] && endpoint.requiredFor?.some(kind => entry[`${kind}Models`].length))) {
      throw VisError.of('invalid_params', 'provider.endpoint_required', {}, 'Fill in the task paths the configured models need')
    }
    if (MediaKind.options.some(kind => !type.kinds.includes(kind) && entry[`${kind}Models`].length)) {
      throw VisError.of('invalid_params', 'provider.model_kind_invalid', {}, 'Generation service does not support the configured media kind')
    }
    if (!type.settingsSchema) return entry
    const settings = type.settingsSchema.safeParse(entry.settings ?? {})
    if (!settings.success) throw VisError.of('invalid_params', 'provider.settings_invalid', {}, 'Generation service settings are invalid')
    return { ...entry, settings: settings.data as Record<string, unknown> }
  }
  function unavailableReason(entry: ProviderConfig['providers'][number]): string | undefined {
    try { validate(entry); return undefined }
    catch (error) { return error instanceof VisError ? String(error.details?.reason) : 'provider.settings_invalid' }
  }

  // Cache by full configuration: every polling step gets the same instance so adapter-level concurrent submission deduplication works.
  const adapterCache = new Map<string, ProviderAdapter>()
  function configured(configuration: ProviderConfig['providers'][number]): ProviderAdapter | undefined {
    const type = types.get(configuration.type)
    if (!type) return undefined
    const validated = validate(configuration)
    const cacheKey = JSON.stringify(configuration)
    let adapter = adapterCache.get(cacheKey)
    if (!adapter) {
      adapter = {
        ...type.create(validated, { dataDir: opts.dataDir, getKey: () => opts.secrets.get(configuration.id), media: opts.media }),
        configuration,
      }
      adapterCache.set(cacheKey, adapter)
    }
    return adapter
  }

  function adapters(snapshot = config) { return [...opts.builtins, ...snapshot.providers.flatMap(entry => { const adapter = unavailableReason(entry) ? undefined : configured(entry); return adapter ? [adapter] : [] })] }
  function defaults(snapshot = config): ProviderDefaults {
    const available = adapters(snapshot)
    const result: ProviderDefaults = {}
    for (const kind of MediaKind.options) {
      const supports = (choice: ProviderDefaults[typeof kind]) => choice && available.some(adapter => adapter.id === choice.provider && adapter.kinds.includes(kind) && (!choice.model || adapter.models.includes(choice.model)))
      const selected = snapshot.defaults[kind] ?? opts.defaults[kind]
      const fallback = available.find(adapter => adapter.kinds.includes(kind) && adapter.defaultModels[kind])
      const choice = supports(selected) ? selected : supports(opts.defaults[kind]) ? opts.defaults[kind] : fallback ? { provider: fallback.id, model: fallback.defaultModels[kind]! } : undefined
      if (choice) result[kind] = choice
    }
    return result
  }

  function resolve(id: string, snapshot: unknown): ProviderAdapter | undefined {
    if (snapshot !== undefined) {
      const parsed = ProviderConfigSchema.safeParse({ providers: [snapshot], defaults: {} })
      if (!parsed.success || parsed.data.providers[0]?.id !== id) throw VisError.of('invalid_params', 'provider.job_config_invalid', {}, 'The job generation provider configuration is invalid')
      if (!config.providers.some(entry => entry.id === id)) return undefined
      return configured(parsed.data.providers[0])
    }
    return adapters().find(p => p.id === id)
  }

  async function list(): Promise<MethodResult<'providers.list'>> {
    const snapshot = config
    const available = adapters(snapshot)
    const services: MethodResult<'providers.list'>['providers'] = []
    for (const adapter of available) {
      const entry = snapshot.providers.find(p => p.id === adapter.id)
      const models = entry
        ? [...entry.imageModels.map(m => ({ ...m, kind: 'image' as const })), ...entry.videoModels.map(m => ({ ...m, kind: 'video' as const })), ...entry.audioModels.map(m => ({ ...m, kind: 'audio' as const }))]
        : adapter.kinds.flatMap(kind => adapter.models.filter(id => BUILTIN_MODELS[kind].some(model => model.provider === adapter.id && model.model === id)).map(id => ({ id, label: id === 'mock-music-1' ? 'Mock 音乐' : id === 'mock-sfx-1' ? 'Mock 音效' : id, kind })))
      services.push({
        id: adapter.id,
        type: entry?.type ?? (adapter.id === 'render' ? 'render' : 'mock'),
        label: entry?.label ?? (adapter.id === 'render' ? '本机代码渲染' : 'Mock'),
        ...(entry ? { baseUrl: entry.baseUrl, ...(entry.region !== undefined ? { region: entry.region } : {}), ...(entry.settings !== undefined ? { settings: entry.settings } : {}), ...(entry.endpoints !== undefined ? { endpoints: entry.endpoints } : {}) } : {}),
        needsKey: entry ? types.get(entry.type)!.needsKey : false,
        available: true,
        hasKey: entry ? await opts.secrets.has(entry.id) : false,
        models: models.map(m => ({ ...m, operations: [...(adapter.operationsFor?.(m.kind, m.id) ?? ['generate'])], frameModes: [...(adapter.frameModesFor?.(m.kind, m.id) ?? [])], paramsSchema: paramsSchemaOf(adapter, m.kind, m.id).toJSONSchema({ io: 'input', unrepresentable: 'any' }) })),
      })
    }
    for (const entry of snapshot.providers.filter(entry => unavailableReason(entry))) {
      const { imageModels, videoModels, audioModels, ...fields } = entry
      services.push({
        ...fields, needsKey: types.get(entry.type)?.needsKey ?? false, available: false, unavailableReason: unavailableReason(entry), hasKey: false,
        models: [{ kind: 'image' as const, models: imageModels }, { kind: 'video' as const, models: videoModels }, { kind: 'audio' as const, models: audioModels }].flatMap(({ kind, models }) => models.map(model => ({ ...model, kind, paramsSchema: {} }))),
      })
    }
    const order = [...opts.builtins.map(provider => provider.id), ...snapshot.providers.map(provider => provider.id)]
    services.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id))
    const effective = defaults(snapshot)
    const resultDefaults: MethodResult<'providers.list'>['defaults'] = {}
    for (const kind of MediaKind.options) {
      const selected = snapshot.defaults[kind] ?? effective[kind]
      // Embedders (tests, legacy callers) may omit defaults for some kinds; omit the default model instead of failing the entire catalog read.
      if (!selected) continue
      const model = selected.model ?? available.find(p => p.id === selected.provider)?.defaultModels[kind]
      if (model) resultDefaults[kind] = { provider: selected.provider, model }
    }
    const unavailableDefaults = MediaKind.options.filter(kind => snapshot.defaults[kind] && !available.some(adapter => adapter.id === snapshot.defaults[kind]!.provider))
    return { providerTypes: types.descriptors, providers: services, defaults: resultDefaults, ...(unavailableDefaults.length ? { unavailableDefaults } : {}), limits: snapshot.limits, agentIsolation: process.platform === 'darwin' ? 'sandbox' : 'none' }
  }

  return {
    adapters, defaults, resolve, list, limits: () => config.limits,
    async update(next: ProviderConfig) {
      const parsed = ProviderConfigSchema.parse(next)
      for (const entry of parsed.providers) {
        // Preserve unavailable entries byte-for-byte in the draft while editing unrelated settings.
        if (unavailableReason(entry) && config.providers.some(previous => JSON.stringify(previous) === JSON.stringify(entry))) continue
        validate(entry)
      }
      saveProviderConfig(opts.dataDir, parsed)
      config = parsed
      opts.onChange(adapters(), defaults(), config.limits)
      return list()
    },
    async setKey(providerId: string, apiKey: string) {
      if (!config.providers.some(p => p.id === providerId)) throw VisError.of('not_found', 'provider.not_found', {}, 'Generation provider does not exist')
      await opts.secrets.set(providerId, apiKey)
      return { providerId, hasKey: true }
    },
    async clearKey(providerId: string) {
      if (!config.providers.some(p => p.id === providerId)) throw VisError.of('not_found', 'provider.not_found', {}, 'Generation provider does not exist')
      await opts.secrets.delete(providerId)
      return { providerId, hasKey: false }
    },
  }
}
