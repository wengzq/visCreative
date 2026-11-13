import type { MediaTools } from '@vis/assets'
import { isBuiltinProviderType, ProviderTypeDescriptor, type MediaKind, type ModelDocLink, type ProviderConfig } from '@vis/protocol'
import type { z } from 'zod'
import type { ProviderEndpoint } from './http'
import type { HostedInputs, ProviderAdapter } from './types'
import { arkProviderType } from './ark/type'
import { klingProviderType } from './kling/type'
import { openaiProviderType } from './openai/type'
import { dashscopeProviderType } from './dashscope/type'
import { minimaxProviderType } from './minimax/type'
import { geminiProviderType } from './gemini/type'

export type ProviderEntry = ProviderConfig['providers'][number]
export type ProviderType = {
  type: string
  label: Record<'zh' | 'en', string>
  settingsSchema?: z.ZodType
  settingsFields?: Record<string, { label: Record<'zh' | 'en', string>; description?: Record<'zh' | 'en', string> }>
  needsKey: boolean
  kinds: readonly MediaKind[]
  regions: readonly { id: string; label: Record<'zh' | 'en', string>; baseUrl: string }[]
  allowCustomBaseUrl: boolean
  /** API paths offered for override with a custom URL; the request and response format stays the adapter's. */
  endpoints?: readonly ProviderEndpoint[]
  /** docs: official vendor pages (RFC 0045); cite them, never copy their text. */
  knownModels: readonly { id: string; kind: MediaKind; label: string; docs?: readonly ModelDocLink[] }[]
  /** Pages for a media kind that also cover IDs outside knownModels, such as custom endpoint IDs. */
  modelDocs?: Partial<Record<MediaKind, readonly ModelDocLink[]>>
  help: { consoleUrl: string; key: Record<'zh' | 'en', string>; model?: Record<'zh' | 'en', string> }
  availability?: Record<'zh' | 'en', string>
  verified: boolean
  create(config: ProviderEntry, deps: { getKey(): Promise<string | undefined>; dataDir: string; media: MediaTools; hosted?: HostedInputs }): ProviderAdapter
}

export function describeProviderType({ create: _create, settingsSchema, ...descriptor }: ProviderType) {
  return ProviderTypeDescriptor.parse({
    ...descriptor,
    ...(settingsSchema ? { settingsSchema: settingsSchema.toJSONSchema({ io: 'input', unrepresentable: 'any' }) } : {}),
  })
}

export const builtinProviderTypes: readonly ProviderType[] = [arkProviderType, klingProviderType, openaiProviderType, dashscopeProviderType, minimaxProviderType, geminiProviderType]

export function createProviderTypeRegistry(types: readonly ProviderType[] = builtinProviderTypes): ReadonlyMap<string, ProviderType> & { readonly descriptors: ReturnType<typeof describeProviderType>[] } {
  const registry = new Map<string, ProviderType>()
  const descriptors: ReturnType<typeof describeProviderType>[] = []
  for (const type of types) {
    descriptors.push(describeProviderType(type))
    if (registry.has(type.type) || isBuiltinProviderType(type.type)) throw new Error(`Duplicate or reserved generation service type: ${type.type}`)
    registry.set(type.type, type)
  }
  return Object.assign(registry, { descriptors })
}

/** RFC 0045: a known model's own pages win; any other ID of the type gets the type's pages for its media kind. */
export function modelDocsFor(type: ProviderType | undefined, kind: MediaKind, model: string): readonly ModelDocLink[] | undefined {
  if (!type) return undefined
  const known = type.knownModels.find(entry => entry.kind === kind && entry.id === model)?.docs
  const docs = known?.length ? known : type.modelDocs?.[kind]
  return docs?.length ? docs : undefined
}
