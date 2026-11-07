import type { NodeView, providers } from '@vis/protocol'

export type ProviderCatalog = ReturnType<typeof providers.list.result.parse>
export type GenerationChoice = { provider: string; model: string; params: Record<string, unknown> }
export type ParamField = { type: string; title?: string; enum?: (string | number | boolean)[]; examples?: string[]; default?: unknown; minimum?: number; maximum?: number; description?: string }
export function schemaFields(schema: Record<string, unknown>): [string, ParamField][] {
  if (!schema.properties || typeof schema.properties !== 'object') return []
  return Object.entries(schema.properties).flatMap(([key, value]) => {
    if (!value || typeof value !== 'object') return []
    let field = value as ParamField
    const shape = value as Record<string, unknown>
    if (shape.const !== undefined) field = { ...field, enum: [shape.const as string | number | boolean] }
    // Ark represents duration as a union of constant -1 and an integer range; expand to finite options while preserving bounds.
    if (Array.isArray(shape.anyOf)) {
      const options: number[] = []
      for (const branch of shape.anyOf) {
        if (!branch || typeof branch !== 'object') { options.length = 0; break }
        if (typeof branch.const === 'number') options.push(branch.const)
        else if (branch.type === 'integer' && Number.isInteger(branch.minimum) && Number.isInteger(branch.maximum) && branch.maximum - branch.minimum <= 100) {
          for (let n = branch.minimum; n <= branch.maximum; n++) options.push(n)
        } else { options.length = 0; break }
      }
      if (options.length) field = { ...field, type: 'integer', enum: options }
    }
    if (!['string', 'number', 'integer', 'boolean'].includes(field.type)) {
      // i18n-exempt: Development console diagnostics only, not UI copy.
      if ((import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV) console.warn('Skipping unsupported generation parameter shape', key)
      return []
    }
    return [[key, field] as [string, ParamField]]
  })
}
export function parameterFields(schema: Record<string, unknown>) {
  return schemaFields(schema).filter(([, field]) => field.enum?.length !== 1 && !(field.type === 'integer' && field.minimum !== undefined && field.minimum === field.maximum))
}
export function segmentOptions(field: ParamField): (string | number | boolean)[] | undefined {
  if (field.enum) return field.enum.length <= 4 ? field.enum : undefined
  if (field.type === 'string' && field.examples?.length) return field.examples
  const { minimum, maximum } = field
  if (field.type === 'integer' && Number.isInteger(minimum) && Number.isInteger(maximum) && maximum! >= minimum! && maximum! - minimum! <= 4) {
    return Array.from({ length: maximum! - minimum! + 1 }, (_, index) => minimum! + index)
  }
}
export function defaultParams(schema: Record<string, unknown>) {
  return Object.fromEntries(schemaFields(schema).filter(([, field]) => field.default !== undefined).map(([key, field]) => [key, field.default]))
}
export function parameterSummary(schema: Record<string, unknown>, params: Record<string, unknown>, format: {
  number(value: number): string
  boolean(value: boolean): string
  label(name: string, field: ParamField): string
  value(label: string, value: string): string
}): string {
  return schemaFields(schema).flatMap(([name, field]) => {
    const value = params[name] ?? field.default
    if (value === undefined || value === null) return []
    if (typeof value === 'string') return value ? [value] : []
    if (typeof value === 'number') return [format.value(format.label(name, field), format.number(value))]
    if (typeof value === 'boolean') return [format.value(format.label(name, field), format.boolean(value))]
    return []
  }).join(' · ')
}
/** Drop old values the current model no longer accepts (such as residual 1080p after capabilities narrow), filling missing values from defaults */
export function fitParams(schema: Record<string, unknown>, params: Record<string, unknown>) {
  const fields = new Map(schemaFields(schema))
  return Object.fromEntries(Object.entries(params).filter(([key, value]) => {
    const field = fields.get(key)
    if (!field) return false
    if (field.enum) return field.enum.includes(value as string | number | boolean)
    if (typeof value === 'number') return (field.minimum === undefined || value >= field.minimum) && (field.maximum === undefined || value <= field.maximum)
    return true
  }))
}
export function resolveChoice(catalog: ProviderCatalog, kind: 'image' | 'video' | 'audio', saved?: NodeView['generation'] | null): GenerationChoice | null {
  const available = (choice: { provider?: string | undefined; model?: string | undefined } | null | undefined) => catalog.providers.find(p => p.available && p.id === choice?.provider)?.models.find(m => m.id === choice?.model && m.kind === kind)
  const fallback = catalog.providers.filter(p => p.available).flatMap(p => p.models.filter(m => m.kind === kind).map(m => ({ provider: p.id, model: m.id })))[0]
  const defaults = available(catalog.defaults[kind]) ? catalog.defaults[kind] : fallback
  const requested = { provider: saved?.provider ?? defaults?.provider, model: saved?.model ?? (saved?.provider && saved.provider !== defaults?.provider ? catalog.providers.find(p => p.available && p.id === saved.provider)?.models.find(m => m.kind === kind)?.id : defaults?.model) }
  const preferred = available(requested) ? requested : defaults
  const chosen = available(preferred) ? preferred! : fallback
  if (!chosen?.provider || !chosen.model) return null
  const model = available(chosen)
  const schema = model?.paramsSchema ?? {}
  return { provider: chosen.provider, model: chosen.model, params: { ...defaultParams(schema), ...(available(requested) && saved?.params ? fitParams(schema, saved.params) : {}) } }
}
export function readChoice(key: string): GenerationChoice | null {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? 'null')
    return value && typeof value.provider === 'string' && typeof value.model === 'string' && value.params && typeof value.params === 'object' && !Array.isArray(value.params) ? { provider: value.provider, model: value.model, params: value.params } : null
  } catch { return null }
}
