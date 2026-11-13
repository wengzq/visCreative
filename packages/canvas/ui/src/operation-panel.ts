import { modelOperations, operationKind, type GenerationOperation, type NodeView } from '@vis/protocol'
import { defaultParams, fitParams, type GenerationChoice, type ProviderCatalog } from './params'

type CatalogModel = ProviderCatalog['providers'][number]['models'][number]
export type OperationRequest = GenerationChoice & { operation: GenerationOperation; prompt: string }

export function operationModels(catalog: ProviderCatalog | null, kind: NodeView['kind'], operation: GenerationOperation) {
  return (catalog?.providers ?? []).filter(provider => provider.available).flatMap(provider => provider.models
    .filter(model => model.kind === kind && operationKind(operation) === kind && modelOperations(model).includes(operation))
    .map(model => ({ provider, model })))
}

export function operationSpec(model: CatalogModel | undefined, operation: GenerationOperation) {
  return model?.operationSpecs?.[operation] ?? { paramsSchema: {}, prompt: 'none' as const }
}

export function operationChoiceKey(spaceId: string, operation: GenerationOperation): string {
  return `vis.gen.operation.${spaceId}.${operation}`
}

/** Only a previous operation choice contributes settings; the node contributes its model, never its generate params. */
export function resolveOperationChoice(catalog: ProviderCatalog | null, kind: NodeView['kind'], operation: GenerationOperation, saved: GenerationChoice | null, nodeChoice?: NodeView['generation']): GenerationChoice | null {
  const models = operationModels(catalog, kind, operation)
  const find = (choice: NodeView['generation'] | null | undefined) => models.find(({ provider, model }) => provider.id === choice?.provider && model.id === choice?.model)
  const last = find(saved)
  const selected = last ?? find(nodeChoice) ?? models[0]
  if (!selected) return null
  const schema = operationSpec(selected.model, operation).paramsSchema
  return { provider: selected.provider.id, model: selected.model.id, params: { ...defaultParams(schema), ...(last && saved ? fitParams(schema, saved.params) : {}) } }
}

export function operationSubmitDisabled(promptRule: 'none' | 'optional' | 'required', text: string, state: {
  blocked: boolean; sending: boolean; composing: boolean; broken: boolean; hasSubject: boolean
}): boolean {
  return state.blocked || state.sending || state.composing || !state.hasSubject
    || (promptRule !== 'none' && state.broken) || (promptRule === 'required' && !text.trim())
}
