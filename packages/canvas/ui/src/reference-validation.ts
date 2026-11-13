import type { ProviderCatalog } from './params'
import type { PromptReference } from './prompt-references'

type CatalogModel = ProviderCatalog['providers'][number]['models'][number]
type Problem = { reason: string; params: Record<string, number> }

export function videoReferenceState(references: readonly PromptReference[], model: CatalogModel | undefined, readiness: ProviderCatalog['videoReferences'] | undefined, params: Record<string, unknown>) {
  const videos = references.filter(reference => reference.node?.kind === 'video' && reference.node.slots.some(slot => slot.slotKey === 'main' && slot.content.type === 'asset'))
  const limits = model?.referenceInputs?.video
  const durations = videos.map(reference => reference.durationMs).filter((duration): duration is number => duration !== undefined && Number.isFinite(duration) && duration >= 0)
  const count = videos.length
  const knownCount = durations.length
  const totalMs = durations.reduce((total, duration) => total + duration, 0)
  const hostingRequired = count > 0 && limits?.requiresHosting === true && readiness === 'hosting_required'
  let problem: Problem | undefined
  if (count) {
    if (!limits) problem = { reason: 'unsupported', params: {} }
    else if (count > limits.max) problem = { reason: 'generation.video_reference_count', params: { max: limits.max } }
    else if (durations.some(duration => duration < limits.minMs || duration > limits.maxMs)) problem = { reason: 'generation.video_reference_duration', params: { minMs: limits.minMs, maxMs: limits.maxMs } }
    else if (totalMs > limits.totalMs) problem = { reason: 'generation.video_reference_total_duration', params: { totalMs: limits.totalMs } }
    else if (params.imageMode === 'first_frame' || params.imageMode === 'first_last') problem = { reason: 'generation.frames_reference_mix', params: {} }
    else if (model?.referenceInputs?.total !== undefined && references.filter(reference => reference.number !== undefined).length > model.referenceInputs.total) problem = { reason: 'total', params: { max: model.referenceInputs.total } }
    else if (model?.referenceInputs && references.filter(reference => reference.node?.kind === 'image' && reference.number !== undefined).length > model.referenceInputs.image) problem = { reason: 'images', params: { max: model.referenceInputs.image } }
  }
  return { count, knownCount, totalMs, limits, hostingRequired, durationUnchecked: count > 0 && Boolean(limits) && knownCount < count, problem, blocked: Boolean(problem) || hostingRequired }
}
