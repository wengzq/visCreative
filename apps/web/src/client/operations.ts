import { GenerationOperation, modelOperations, operationKind, type MediaKind } from '@vis/protocol'
import type { ProviderCatalog } from '@vis/canvas-ui'

export function generationOperations(catalog: ProviderCatalog | null) {
  const result: Record<MediaKind, GenerationOperation[]> = { image: [], video: [], audio: [] }
  for (const provider of catalog?.providers ?? []) {
    if (!provider.available || (provider.needsKey && !provider.hasKey)) continue
    for (const model of provider.models) {
      for (const operation of modelOperations(model)) {
        if (!GenerationOperation.safeParse(operation).success || operationKind(operation) !== model.kind) continue
        if (!result[model.kind].includes(operation)) result[model.kind].push(operation)
      }
    }
  }
  return result
}
