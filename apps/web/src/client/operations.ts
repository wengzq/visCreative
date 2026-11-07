import { GenerationOperation, modelOperations, operationKind, type MediaKind, type NodeView } from '@vis/protocol'
import { resolveChoice, type ProviderCatalog } from '@vis/canvas-ui'

export function generationOperations(catalog: ProviderCatalog | null) {
  const result: Record<MediaKind, GenerationOperation[]> = { image: [], video: [], audio: [] }
  for (const provider of catalog?.providers ?? []) {
    for (const model of provider.models) {
      for (const operation of modelOperations(model)) {
        if (!GenerationOperation.safeParse(operation).success || operationKind(operation) !== model.kind) continue
        if (!result[model.kind].includes(operation)) result[model.kind].push(operation)
      }
    }
  }
  return result
}

export function operationChoice(catalog: ProviderCatalog, node: NodeView, operation: GenerationOperation) {
  // Generation operations are always named after a media kind
  const kind = operationKind(operation) as MediaKind | undefined
  if (!kind || kind !== node.kind) return null
  const providers = catalog.providers.map(provider => ({ ...provider, models: provider.models.filter(model => model.kind === kind && modelOperations(model).includes(operation)) }))
  // resolveChoice preserves compatible saved parameters, and fills the chosen model's defaults.
  return resolveChoice({ ...catalog, providers, defaults: {} }, kind, node.generation)
}
