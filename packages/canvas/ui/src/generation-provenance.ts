import type { CanvasOp, NodeView, SlotVersionView } from '@vis/protocol'
import { defaultParams, type ProviderCatalog } from './params'

export type GenerationSource = NonNullable<SlotVersionView['source']>

export function isOperationSource(source: GenerationSource | undefined): source is GenerationSource & { operation: Exclude<GenerationSource['operation'], 'generate' | undefined> } {
  return source?.operation !== undefined && source.operation !== 'generate'
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]))
  return value
}

/** The inputs a restore writes: the version's references minus deleted nodes and the node itself */
export function restorableInputs(view: NodeView, source: GenerationSource, nodes: readonly NodeView[]): string[] {
  const live = new Set(nodes.map(node => node.nodeId))
  return source.inputNodeIds.filter(id => id !== view.nodeId && live.has(id))
}

/**
 * Whether the draft matches what Restore would write. Job params carry every schema default while a saved choice may
 * hold only changed values, so both sides are compared with the model defaults filled in.
 */
export function sameGenerationDraft(view: NodeView, source: GenerationSource, nodes: readonly NodeView[], text: string, generation: NodeView['generation'], defaults: Record<string, unknown> = {}): boolean {
  return text === (source.prompt ?? '') && generation?.provider === source.provider && generation.model === source.model
    && JSON.stringify(canonical({ ...defaults, ...generation.params })) === JSON.stringify(canonical({ ...defaults, ...source.params }))
    && JSON.stringify(view.inputs ?? []) === JSON.stringify(restorableInputs(view, source, nodes))
}

export function restoreGenerationOps(view: NodeView, source: GenerationSource, nodes: readonly NodeView[], expectedRevision: number): CanvasOp[] {
  if (isOperationSource(source)) return []
  return [
    { op: 'node.setPrompt', nodeId: view.nodeId, body: source.prompt ?? '', expectedRevision },
    { op: 'node.setGeneration', nodeId: view.nodeId, generation: { provider: source.provider, model: source.model, params: source.params } },
    { op: 'node.setInputs', nodeId: view.nodeId, inputNodeIds: restorableInputs(view, source, nodes) },
  ]
}

/** Schema defaults of the version's model, when it is still in the catalog */
export function sourceDefaults(catalog: ProviderCatalog | null | undefined, source: GenerationSource): Record<string, unknown> {
  const model = catalog?.providers.find(provider => provider.id === source.provider)?.models.find(model => model.id === source.model)
  return model ? defaultParams(isOperationSource(source) ? model.operationSpecs?.[source.operation]?.paramsSchema ?? {} : model.paramsSchema) : {}
}
