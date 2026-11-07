import type { ProviderCatalog } from '@vis/canvas-ui'
import { isBuiltinProviderType } from '@vis/protocol'
import { messagesFor, type Locale } from '@vis/ui-kit'
import { messages } from './messages'

/** Built-in names are UI copy; user-configured service and model names stay unchanged. */
export function localizedProvider(provider: ProviderCatalog['providers'][number], locale: Locale): ProviderCatalog['providers'][number] {
  if (!isBuiltinProviderType(provider.type)) return provider
  const m = messagesFor(messages, locale)
  return {
    ...provider,
    label: provider.type === 'render' ? m.localRender : provider.label,
    models: provider.models.map(model => ({
      ...model,
      label: provider.type === 'mock' && model.id === 'mock-music-1' ? m.mockMusic : provider.type === 'mock' && model.id === 'mock-sfx-1' ? m.mockSound : model.label,
    })),
  }
}
