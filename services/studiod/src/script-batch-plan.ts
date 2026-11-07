import { linkedPrevizPanels, panelFrameCandidates } from './previz-frames'
import { VisError } from '@vis/domain'
import { PROMPT_REF_PATTERN, type BatchStep, type EntityView, type FrameMode, type MethodParams, type MethodResult, type NodeView, type ScriptDoc, type ShotRole } from '@vis/protocol'

export type BatchParams = MethodParams<'script.batch.plan'>
export type BatchCatalog = {
  providers: { id: string; paid: boolean; defaultModels?: Partial<Record<'image' | 'video' | 'audio', string>>; models: { id: string; kind: 'image' | 'video' | 'audio'; frameModes: readonly FrameMode[]; referenceImageLimit?: number }[] }[]
  defaults: Partial<Record<'image' | 'video', { provider: string; model?: string }>>
}
export type NodeSource = { nodeId: string } | { step: string }
export type BatchInput = NodeSource | { assetVersionId: string; style?: boolean }
export type PlannedStep = {
  key: string
  shotId: string
  role: ShotRole
  source: 'generate' | 'extract'
  dependencies: string[]
  inputs: BatchInput[]
  prompt: string
  provider: string
  model: string
  frames?: { first: NodeSource; last?: NodeSource }
  extractFrom?: NodeSource
}
export type BatchPlan = {
  view: MethodResult<'script.batch.plan'>
  steps: PlannedStep[]
  revisions: Record<string, number>
}
export const stepKey = (shotId: string, role: ShotRole) => `${shotId}:${role}`

export function currentShotNode(nodes: NodeView[], scriptNodeId: string, shotId: string, role: ShotRole) {
  return nodes.filter(node => node.shot?.scriptNodeId === scriptNodeId && node.shot.shotId === shotId && node.shot.role === role)
    .sort((a, b) => a.nodeId.slice(5, 15).localeCompare(b.nodeId.slice(5, 15))).at(-1)
}

export function imageReady(node: NodeView | undefined) {
  return node?.kind === 'image' && node.slots.some(slot => slot.slotKey === 'main' && slot.content.type === 'asset' && slot.content.mime.startsWith('image/'))
}

/** Pure planning: dependencies refer to step keys, and existing inputs refer to canvas nodes. */
export function planScriptBatch(doc: ScriptDoc, nodes: NodeView[], params: BatchParams, catalog: BatchCatalog, quotaRemaining: number | null, settings?: EntityView[]): BatchPlan {
  const selected = new Set(params.shotIds ?? doc.shots.map(shot => shot.id))
  if ([...selected].some(id => !doc.shots.some(shot => shot.id === id))) throw VisError.of('invalid_params', 'script.batch_shot_not_found', {}, 'A selected shot no longer exists')
  const strict = new Set(params.strictShotIds ?? [])
  if ([...strict].some(id => params.media !== 'video' || !selected.has(id) || doc.shots.find(shot => shot.id === id)?.transition !== 'continuous')) {
    throw VisError.of('invalid_params', 'script.batch_strict_invalid', {}, 'Strict continuity requires a selected continuous video shot')
  }
  const saved = nodes.find(node => node.nodeId === params.scriptNodeId)?.generation
  const resolve = (kind: 'image' | 'video', primary: boolean) => {
    const savedChoice = catalog.providers.find(provider => provider.id === saved?.provider)?.models.some(model => model.id === saved?.model && model.kind === kind) ? saved : undefined
    const explicitProvider = primary ? params.provider : undefined
    const providerId = explicitProvider ?? (primary ? savedChoice?.provider : undefined) ?? catalog.defaults[kind]?.provider
    if (!providerId) throw VisError.of('invalid_params', 'generation.default_provider_unavailable', { kind }, `No default generation service is available for ${kind}`)
    const provider = catalog.providers.find(provider => provider.id === providerId)
    const modelId = (primary ? params.model : undefined)
      ?? (!explicitProvider && primary ? savedChoice?.model : undefined)
      ?? (!explicitProvider && providerId === catalog.defaults[kind]?.provider ? catalog.defaults[kind]?.model : undefined)
      ?? provider?.defaultModels?.[kind] ?? provider?.models.find(model => model.kind === kind)?.id
    const model = provider?.models.find(model => model.id === modelId && model.kind === kind)
    if (!provider || !model) throw VisError.of('invalid_params', 'generation.model_unavailable', { providerId, kind, model: modelId ?? '' }, 'The selected generation model is unavailable')
    return { provider: provider.id, model: model.id, paid: provider.paid, frameModes: model.frameModes, referenceImageLimit: model.referenceImageLimit ?? Infinity }
  }
  const primary = resolve(params.media === 'frames' ? 'image' : 'video', true)
  const steps: PlannedStep[] = []
  const rows: BatchPlan['view']['shots'] = []
  const revisions: Record<string, number> = {}
  const sources = new Map<string, NodeSource>()
  const lookup = (shotId: string, role: ShotRole): NodeSource | undefined => {
    const key = stepKey(shotId, role)
    if (sources.has(key)) return sources.get(key)
    const node = currentShotNode(nodes, params.scriptNodeId, shotId, role)
    if (role === 'video' ? node?.kind === 'video' && node.slots.some(slot => slot.slotKey === 'main' && slot.content.type === 'asset') : imageReady(node)) return { nodeId: node!.nodeId }
    return undefined
  }
  let staleShots = 0
  let shotsMissingAssetImages = 0
  let shotsMissingFirstFrame = 0
  let shotsWithoutPrompt = 0
  let billedJobs = 0
  let usedLast = false
  let styleRefsDropped = 0
  let castRefsDropped = 0
  let compositionRefsUsed = 0
  let panelFramesUsed = 0
  const compositionRefsDropped: NonNullable<BatchPlan['view']['estimate']['compositionRefsDropped']> = []
  const style = settings?.find(setting => setting.id === doc.styleId)
  for (const [index, shot] of doc.shots.entries()) {
    if (!selected.has(shot.id)) continue
    revisions[shot.id] = shot.rev
    const row: typeof rows[number] = { shotId: shot.id, steps: [] }
    rows.push(row)
    const assetIds = [...shot.characterIds, shot.sceneId, ...shot.propIds].filter((id): id is string => !!id)
    const assets = assetIds.map(id => doc.assets.find(asset => asset.id === id))
    const references: BatchInput[] = settings
      ? [...new Set(assetIds.flatMap(id => settings.find(setting => setting.id === id)?.refs.map(ref => ref.assetVersionId) ?? []))].map(assetVersionId => ({ assetVersionId }))
      : [...new Set(assets.flatMap(asset => asset?.imageNodeId && imageReady(nodes.find(node => node.nodeId === asset.imageNodeId)) ? [asset.imageNodeId] : []))].map(nodeId => ({ nodeId }))
    if (settings ? assetIds.some(id => !settings.find(setting => setting.id === id)?.refs.length) : assets.some(asset => !asset?.imageNodeId || !imageReady(nodes.find(node => node.nodeId === asset.imageNodeId)))) shotsMissingAssetImages++
    if (shot.promptState === 'stale') staleShots++
    if (params.media === 'frames' ? !shot.framePrompt || (!!shot.endState && !shot.endFramePrompt) : !shot.videoPrompt) shotsWithoutPrompt++
    const panels = linkedPrevizPanels(nodes, params.scriptNodeId, shot.id)
    const framePanels = panelFrameCandidates(nodes, params.scriptNodeId, [shot.id])
    const panelFrame = (role: 'first' | 'last') => {
      const candidate = framePanels.find(({ panel }) => (panel.frameRole === 'last' ? 'last' : 'first') === role)
      const current = currentShotNode(nodes, params.scriptNodeId, shot.id, role)
      const content = current?.slots.find(slot => slot.slotKey === 'main')?.content
      return candidate && content?.type === 'asset' && content.assetVersionId === candidate.panel.image ? { nodeId: current!.nodeId } : undefined
    }
    const first = lookup(shot.id, 'first')
    if (!first && (params.media === 'frames' || primary.frameModes.length)) shotsMissingFirstFrame++
    const add = (role: ShotRole, source: PlannedStep['source'], inputs: BatchInput[], prompt: string, extra: Partial<PlannedStep> = {}) => {
      const model = role === 'video' || params.media === 'frames' ? primary : resolve('image', false)
      if (source === 'generate') {
        const description = style?.description ?? doc.style
        if (description) prompt = `${prompt}\n${description}`
        if (!extra.frames) {
          const firstCandidate = panels.find(({ panel }) => panel.image && !(panel.use === 'frame' && panel.frameRole === 'last'))
          const compositions = role === 'first' ? panels.filter(candidate => {
            const { panel } = candidate
            return (panel.blockout ?? panel.image) && !(panel.use === 'frame' && panel.frameRole === 'last') && (panel.use === 'composition' || candidate !== firstCandidate)
          }) : []
          const accepted = compositions.slice(0, model.referenceImageLimit)
          compositionRefsUsed += accepted.length
          compositionRefsDropped.push(...compositions.slice(accepted.length).map(({ node, panel, panelNumber }) => ({ previzNodeId: node.nodeId, panelId: panel.id, panelNumber, shotId: shot.id, reason: model.referenceImageLimit === 0 ? 'unsupported' as const : 'limit' as const })))
          const composition: BatchInput[] = accepted.map(({ panel }) => ({ assetVersionId: (panel.blockout ?? panel.image)! }))
          const continuity = inputs.filter(input => !('assetVersionId' in input))
          const cast = inputs.filter(input => 'assetVersionId' in input)
          const castCapacity = Math.max(0, model.referenceImageLimit - composition.length - continuity.length)
          castRefsDropped += Math.max(0, cast.length - castCapacity)
          inputs = [...composition, ...cast.slice(0, castCapacity), ...continuity.slice(0, Math.max(0, model.referenceImageLimit - composition.length))]
          const available = Math.max(0, model.referenceImageLimit - inputs.length)
          const samples = (style?.refs ?? []).filter(ref => !inputs.some(input => 'assetVersionId' in input && input.assetVersionId === ref.assetVersionId))
          styleRefsDropped += Math.max(0, samples.length - available)
          inputs = [...inputs, ...samples.slice(0, available).map(ref => ({ assetVersionId: ref.assetVersionId, style: true }))]
          prompt = prompt.replace(PROMPT_REF_PATTERN, (marker, nodeId: string) => {
            const setting = settings?.find(setting => setting.refs.some(ref => ref.sourceNodeId === nodeId))
            if (!setting) return marker
            return setting.refs.some(ref => ref.sourceNodeId === nodeId && inputs.some(input => 'assetVersionId' in input && input.assetVersionId === ref.assetVersionId)) ? marker : setting.name
          })
        }
      }
      const key = stepKey(shot.id, role)
      const step: PlannedStep = { key, shotId: shot.id, role, source, inputs, prompt, provider: model.provider, model: model.model, dependencies: [], ...extra }
      step.dependencies = [...new Set([...step.dependencies, ...[...inputs, ...(step.frames ? [step.frames.first, ...(step.frames.last ? [step.frames.last] : [])] : []), ...(step.extractFrom ? [step.extractFrom] : [])].flatMap(input => 'step' in input ? [input.step] : [])])]
      steps.push(step)
      sources.set(key, { step: key })
      const view: BatchStep = { role, source, status: step.dependencies.length ? 'waiting' : 'queued', ...(step.dependencies.length ? { blockedBy: 'waiting_previous' as const } : {}) }
      row.steps.push(view)
      if (source === 'generate' && model.paid) billedJobs++
      return { step: key }
    }
    if (params.media === 'frames') {
      const previous = index > 0 && shot.transition === 'continuous' ? lookup(doc.shots[index - 1]!.id, 'last') ?? lookup(doc.shots[index - 1]!.id, 'first') : undefined
      const existingFirst = panelFrame('first')
      const existingLast = panelFrame('last')
      const usePanel = (role: 'first' | 'last', source: NodeSource) => {
        panelFramesUsed++
        row.steps.push({ role, source: 'panel', status: 'skipped', ...source })
        return source
      }
      const ownFirst = existingFirst ? usePanel('first', existingFirst) : add('first', 'generate', [...references, ...(previous ? [previous] : [])], shot.framePrompt || shot.description)
      if (existingLast) usePanel('last', existingLast)
      else if (shot.endState) add('last', 'generate', [...references, ownFirst], shot.endFramePrompt || shot.endState)
      continue
    }
    if (!primary.frameModes.length) {
      add('video', 'generate', references, shot.videoPrompt || shot.description)
      continue
    }
    let videoFirst = first
    if (strict.has(shot.id)) {
      const previous = index > 0 ? lookup(doc.shots[index - 1]!.id, 'video') : undefined
      if (!previous) throw VisError.of('invalid_params', 'script.batch_previous_video_required', {}, 'Strict continuity requires the previous shot video or its inclusion in this batch')
      videoFirst = add('first', 'extract', [], '', { extractFrom: previous })
    } else if (!videoFirst) {
      if (params.missingFirstFrames === 'skip') {
        row.steps.push({ role: 'video', source: 'generate', status: 'skipped' })
        continue
      }
      videoFirst = add('first', 'generate', references, shot.framePrompt || shot.description)
    }
    const last = lookup(shot.id, 'last')
    const mode = last && primary.frameModes.includes('first_last') ? 'first_last' : primary.frameModes.includes('first') ? 'first' : null
    if (mode === 'first_last') usedLast = true
    const prompt = shot.videoPrompt || shot.description
    // Asset appearance is already baked into the frames; keep its name without a dangling input reference.
    const videoPrompt = mode ? prompt.replace(PROMPT_REF_PATTERN, (marker, nodeId: string) => assets.find(asset => asset?.imageNodeId === nodeId)?.name ?? marker) : prompt
    add('video', 'generate', mode ? [] : references, videoPrompt, {
      dependencies: 'step' in videoFirst ? [videoFirst.step] : [],
      ...(mode ? { frames: { first: videoFirst, ...(mode === 'first_last' && last ? { last } : {}) } } : {}),
    })
  }
  return {
    view: {
      scriptNodeId: params.scriptNodeId,
      media: params.media,
      estimate: {
        shots: rows.length, jobs: steps.filter(step => step.source === 'generate').length, billedJobs,
        provider: primary.provider, model: primary.model, quotaRemaining,
        ...(params.media === 'video' ? { frameMode: usedLast ? 'first_last' : primary.frameModes.includes('first') ? 'first' : null } : {}),
        staleShots, shotsMissingAssetImages, shotsMissingFirstFrame, shotsWithoutPrompt,
        ...(compositionRefsUsed ? { compositionRefsUsed } : {}),
        ...(compositionRefsDropped.length ? { compositionRefsDropped } : {}),
        ...(panelFramesUsed ? { panelFramesUsed } : {}),
        ...(styleRefsDropped ? { styleRefsDropped } : {}),
        ...(castRefsDropped ? { castRefsDropped } : {}),
      },
      shots: rows,
    },
    steps, revisions,
  }
}
