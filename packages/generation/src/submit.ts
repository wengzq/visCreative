import { type CanvasDeliveryPort, newId, VisError } from '@vis/domain'
import { isMediaKind, numberReferences, operationKind, PROMPT_REF_PATTERN, type GenerationLimits, type MediaKind, type MethodParams, type MethodResult, type ResolvedTarget, type SceneDoc } from '@vis/protocol'
import { and, appendEvent, eq, inArray, isNull, spaceSchema as s, sql, type SpaceTx } from '@vis/storage'
import { operationSpecOf, paramsSchemaOf, ProviderError, referenceImageLimit, type ProviderAdapter, type ProviderInputMetadata } from './providers/types'
import { checkLocalQuota, isPaidProvider, localDate } from './quota'
import { readJobView } from './view'
import { withScriptSettings } from './script-inputs'
import { sceneModelVersionIds, validateSceneRender } from './providers/render/scene'

/** Trusted agent caller identity, resolved by the gateway from the runtime token (0003 "Caller identity") */
export type SubmitCaller = { sessionId: string | null; turnId: string | null; inputSnapshotId: string | null; settingsResolved?: boolean }

export type ProviderDefaults = Partial<Record<MediaKind, { provider: string; model?: string }>>

type SubmitParams = MethodParams<'generation.submit'>
type SubmitResult = MethodResult<'generation.submit'>
type Job = typeof s.generationJobs.$inferSelect

export type SubmitContext = {
  providers: ReadonlyMap<string, ProviderAdapter>
  defaults: ProviderDefaults
  now: number
  limits: GenerationLimits
  reserve?: (jobId: string, kind: MediaKind, byAgent: boolean) => void
  /** Creates new_node result placeholders in this transaction (RFC 0047) */
  delivery?: Pick<CanvasDeliveryPort<SpaceTx>, 'reservePlaceholder'>
  /** Regeneration reuses original service configuration and validated parameters, unaffected by current configuration changes. */
  source?: { job: Job; adapter: ProviderAdapter }
}

/**
 * Transactional part of generation.submit (0003): resolves input versions, writes the Job and output bindings,
 * and makes target slots accept this request. Must run in a write transaction; the runner advances execution after commit.
 */
export function submitJob(
  tx: SpaceTx,
  caller: SubmitCaller,
  params: SubmitParams,
  ctx: SubmitContext,
): SubmitResult {
  const { now } = ctx
  // A job shares its model and parameters, using the primary output (outputIndex 0) fill node as the default source.
  const primary = params.targets?.find(target => target.outputIndex === 0)
  const slot = primary?.kind === 'slot'
    ? tx.select().from(s.slots).where(and(eq(s.slots.id, primary.slotId), isNull(s.slots.deletedAt))).get()
    : undefined
  const saved = slot
    ? tx.select().from(s.nodes).where(and(eq(s.nodes.id, slot.nodeId), isNull(s.nodes.deletedAt))).get()?.generation
    : undefined
  const providerId = params.provider ?? saved?.provider ?? ctx.defaults[params.kind]?.provider ?? ''
  if (!providerId) throw VisError.of('invalid_params', 'generation.default_provider_unavailable', { kind: params.kind }, `No default generation service is available for ${params.kind}`)
  const adapter = ctx.source?.adapter ?? ctx.providers.get(providerId)
  if (!adapter) throw VisError.of('invalid_params', 'generation.provider_not_configured', { providerId }, `Generation service ${providerId} is not configured`)
  if (!adapter.kinds.includes(params.kind)) throw VisError.of('invalid_params', 'generation.kind_unsupported', { providerId, kind: params.kind }, `${providerId} does not support ${params.kind}`)
  const model =
    params.model ?? saved?.model ?? (providerId === ctx.defaults[params.kind]?.provider ? ctx.defaults[params.kind]?.model : undefined) ?? adapter.defaultModels[params.kind]
  if (!model || !adapter.models.includes(model) || (adapter.configuration && !adapter.configuration[`${params.kind}Models`].some(entry => entry.id === model))) throw VisError.of('invalid_params', 'generation.model_unavailable', { providerId, kind: params.kind, model: model ?? '' }, `${providerId} has no model available for ${params.kind}: ${model ?? ''}`)
  const operation = params.operation ?? 'generate'
  const snapshotRevisions = new Map(
    caller.inputSnapshotId
      ? tx.select().from(s.snapshotItems).where(eq(s.snapshotItems.snapshotId, caller.inputSnapshotId)).all().map(i => [i.slotId, i.slotRevision])
      : [],
  )
  if (!ctx.source && !caller.settingsResolved && operation === 'generate') params = withScriptSettings(tx, params, referenceImageLimit(adapter, params.kind, model), snapshotRevisions)
  if (!(adapter.operationsFor?.(params.kind, model) ?? ['generate']).includes(operation)) throw VisError.of('invalid_params', 'generation.operation_unsupported', { operation }, 'The selected model does not support this operation')
  if (operation !== 'generate' && (operationKind(operation) !== params.kind || !params.inputs?.length)) throw VisError.of('invalid_params', 'generation.subject_required', {}, 'The operation requires a subject of the matching media kind as its first input')
  if (params.frames && !(adapter.frameModesFor?.(params.kind, model) ?? []).includes(params.frames.last ? 'first_last' : 'first')) {
    throw VisError.of('invalid_params', 'generation.frame_mode_unsupported', {}, 'The model does not support the requested frame mode')
  }

  let providerParams: Record<string, unknown>
  if (ctx.source) providerParams = params.params ?? {}
  else {
    const spec = operation !== 'generate' ? operationSpecOf(adapter, params.kind, model, operation) : undefined
    if (spec?.prompt === 'required' && !params.prompt.trim()) throw VisError.of('invalid_params', 'generation.prompt_required', {}, 'This operation requires a prompt')
    if (spec?.prompt === 'none' && params.prompt.trim()) throw VisError.of('invalid_params', 'generation.prompt_unsupported', {}, 'This operation does not accept a prompt')
    const schema = spec?.paramsSchema ?? paramsSchemaOf(adapter, params.kind, model)
    const savedParams = operation === 'generate' ? saved?.params : undefined
    let parsed = schema.safeParse(params.params ?? savedParams ?? {})
    if (!parsed.success && !params.params && savedParams) {
      // Stored node settings may no longer fit narrowed model capabilities: remove invalid fields and fill defaults; explicit parameters still report errors
      const invalid = new Set(parsed.error.issues.map(issue => String(issue.path[0])))
      parsed = schema.safeParse(Object.fromEntries(Object.entries(savedParams).filter(([key]) => !invalid.has(key))))
    }
    if (!parsed.success) throw VisError.of('invalid_params', 'generation.invalid_params', { detail: parsed.error.message }, `Invalid generation parameters: ${parsed.error.message}`)
    providerParams = parsed.data
  }
  const outputCount = typeof providerParams.n === 'number' ? providerParams.n : 1
  const paid = isPaidProvider(adapter)
  const byAgent = caller.sessionId !== null
  const jobId = newId('job', now)
  // Inputs retain snapshot revisions inside snapshots; otherwise pin explicit or current revisions. Use only job_inputs afterward
  let firstInputNodeId: string | undefined
  const referenceInputs: { nodeId: string; kind: MediaKind; hasAsset: boolean }[] = []
  const inputMetadata: ProviderInputMetadata[] = []
  const originalInputs = ctx.source ? tx.select().from(s.jobInputs).where(eq(s.jobInputs.jobId, ctx.source.job.id)).orderBy(s.jobInputs.ordinal).all() : []
  const frameRefs = params.frames ? [params.frames.first, ...(params.frames.last ? [params.frames.last] : [])] : []
  const pinnedFrames: { slotId: string; revision: number }[] = []
  const jobInputs: (typeof s.jobInputs.$inferInsert)[] = []
  const sceneRender = adapter.type === 'render' && model === 'scene'
  let sceneDoc: SceneDoc | undefined
  const directAliases = new Map<string, string>()
  const directIds = [...new Set((params.inputs ?? []).flatMap(input => 'assetVersionId' in input ? [input.assetVersionId] : []))]
  const directAssets = directIds.length ? tx.select({ id: s.assetVersions.id, kind: s.assets.kind, mime: s.assetVersions.mime, durationMs: s.assetVersions.durationMs, width: s.assetVersions.width, height: s.assetVersions.height, fps: s.assetVersions.fps, bytes: s.blobs.byteSize })
    .from(s.assetVersions).innerJoin(s.assets, eq(s.assets.id, s.assetVersions.assetId)).innerJoin(s.blobs, eq(s.blobs.hash, s.assetVersions.blobHash)).where(inArray(s.assetVersions.id, directIds)).all() : []
  const directById = new Map(directAssets.map(asset => [asset.id, asset]))
  if (directIds.length) {
    const sources = tx.select({ nodeId: s.slots.nodeId, assetVersionId: s.slotRevisions.assetVersionId }).from(s.slots)
      .innerJoin(s.slotRevisions, and(eq(s.slotRevisions.slotId, s.slots.id), eq(s.slotRevisions.revision, s.slots.currentRevision)))
      .where(inArray(s.slotRevisions.assetVersionId, directIds)).orderBy(s.slots.id).all()
    for (const source of sources) directAliases.set(source.nodeId, source.assetVersionId!)
    const refs = tx.select({ refs: s.entities.refs }).from(s.entities).where(and(isNull(s.entities.deletedAt),
      sql`exists (select 1 from json_each(${s.entities.refs}) as ref where json_extract(ref.value, '$.assetVersionId') in (${sql.join(directIds.map(id => sql`${id}`), sql`, `)}))`)).orderBy(s.entities.id).all()
    for (const setting of refs) for (const ref of setting.refs) if (ref.sourceNodeId && directById.has(ref.assetVersionId)) directAliases.set(ref.sourceNodeId, ref.assetVersionId)
  }
  for (const [ordinal, input] of [...(params.inputs ?? []), ...frameRefs].entries()) {
    const isFrame = ordinal >= (params.inputs?.length ?? 0)
    if ('assetVersionId' in input) {
      const asset = directById.get(input.assetVersionId)
      if (!asset) throw VisError.of('not_found', 'generation.input_asset_not_found', { assetVersionId: input.assetVersionId }, 'The input asset version does not exist in this project')
      if (sceneRender && ctx.source && asset.kind === 'model') {
        jobInputs.push({ jobId, ordinal, assetVersionId: input.assetVersionId, fromSnapshot: false })
        continue
      }
      if (!isMediaKind(asset.kind)) throw VisError.of('invalid_params', 'generation.input_not_media', { assetVersionId: input.assetVersionId }, 'Fonts cannot be generation inputs')
      if (ordinal === 0 && operation !== 'generate') throw VisError.of('invalid_params', 'generation.subject_required', {}, 'Media operations require a subject node main slot')
      const kind = asset.kind
      inputMetadata.push({ kind, mime: asset.mime, ...(asset.durationMs !== null ? { durationMs: asset.durationMs } : {}), ...(asset.width !== null ? { width: asset.width } : {}), ...(asset.height !== null ? { height: asset.height } : {}), ...(asset.fps !== null ? { fps: asset.fps } : {}), bytes: asset.bytes })
      referenceInputs.push({ nodeId: input.assetVersionId, kind, hasAsset: true })
      jobInputs.push({ jobId, ordinal, assetVersionId: input.assetVersionId, fromSnapshot: false })
      continue
    }
    const slot = tx.select().from(s.slots).where(eq(s.slots.id, input.slotId)).get()
    if (!slot) throw VisError.of('not_found', 'generation.input_slot_not_found', { slotId: input.slotId }, `Slot ${input.slotId} does not exist`)
    if (ordinal === 0 && operation !== 'generate') {
      const node = tx.select().from(s.nodes).where(eq(s.nodes.id, slot.nodeId)).get()
      if (!node || node.deletedAt !== null || slot.deletedAt !== null || slot.slotKey !== 'main' || slot.contentType !== params.kind) throw VisError.of('invalid_params', 'generation.subject_required', {}, 'The first input must be the subject node main media slot')
    }
    const fromSnapshot = input.revision === undefined && snapshotRevisions.has(slot.id)
    const revision = input.revision ?? snapshotRevisions.get(slot.id) ?? slot.currentRevision
    if (revision < 1) throw VisError.of('invalid_params', 'generation.input_slot_empty', { slotId: input.slotId }, `Slot ${input.slotId} is empty and cannot be used as input`)
    const exists = tx
      .select({ r: s.slotRevisions.revision, assetVersionId: s.slotRevisions.assetVersionId, sceneDoc: s.slotRevisions.sceneDoc })
      .from(s.slotRevisions)
      .where(and(eq(s.slotRevisions.slotId, slot.id), eq(s.slotRevisions.revision, revision)))
      .get()
    if (!exists) throw VisError.of('not_found', 'generation.input_revision_not_found', { slotId: input.slotId, revision }, `Slot ${input.slotId} has no revision ${revision}`)
    if (exists.sceneDoc) {
      if (!sceneRender || ordinal !== 0) throw VisError.of('invalid_params', 'generation.render_scene_input_required', {}, 'A scene slot must be the first input of render/scene')
      sceneDoc = exists.sceneDoc
    }
    if (ordinal === 0 && operation !== 'generate' && !exists.assetVersionId) throw VisError.of('invalid_params', 'generation.subject_required', {}, 'The first input must contain the subject media asset')
    if (exists.assetVersionId) {
      const asset = tx.select({ kind: s.assets.kind, mime: s.assetVersions.mime, durationMs: s.assetVersions.durationMs, width: s.assetVersions.width, height: s.assetVersions.height, fps: s.assetVersions.fps, bytes: s.blobs.byteSize })
        .from(s.assetVersions).innerJoin(s.assets, eq(s.assets.id, s.assetVersions.assetId)).innerJoin(s.blobs, eq(s.blobs.hash, s.assetVersions.blobHash)).where(eq(s.assetVersions.id, exists.assetVersionId)).get()
      if (isFrame && asset?.kind !== 'image') throw VisError.of('invalid_params', 'generation.frame_image_required', {}, 'Video frames must contain image assets')
      // Font assets never sit in node slots; guard anyway so a font can never reach a provider
      if (asset) {
        const kind = asset.kind
        if (!isMediaKind(kind)) throw VisError.of('invalid_params', 'media.kind_mismatch', { slotId: input.slotId, kind }, 'Font assets cannot be generation inputs')
        if (isFrame) pinnedFrames.push({ slotId: slot.id, revision })
        inputMetadata.push({ kind, mime: asset.mime, ...(asset.durationMs !== null ? { durationMs: asset.durationMs } : {}), ...(asset.width !== null ? { width: asset.width } : {}), ...(asset.height !== null ? { height: asset.height } : {}), ...(asset.fps !== null ? { fps: asset.fps } : {}), bytes: asset.bytes, ...(isFrame ? { frameRole: ordinal === (params.inputs?.length ?? 0) ? 'first' as const : 'last' as const } : {}) })
        referenceInputs.push({ nodeId: slot.nodeId, kind, hasAsset: true })
      }
    }
    if (isFrame && !exists.assetVersionId) throw VisError.of('invalid_params', 'generation.frame_image_required', {}, 'Video frames must contain image assets')
    jobInputs.push({ jobId, ordinal, slotId: slot.id, slotRevision: revision, fromSnapshot: originalInputs[ordinal]?.fromSnapshot ?? fromSnapshot })
    firstInputNodeId ??= slot.nodeId
  }
  try {
    if (sceneRender) {
      if (!sceneDoc) throw new ProviderError('rejected', 'The first input must be a scene slot', 'generation.render_scene_input_required')
      validateSceneRender(params.kind, sceneDoc, providerParams)
      const modelIds = sceneModelVersionIds(sceneDoc)
      const models = modelIds.length ? tx.select({ id: s.assetVersions.id, kind: s.assets.kind }).from(s.assetVersions)
        .innerJoin(s.assets, eq(s.assets.id, s.assetVersions.assetId)).where(inArray(s.assetVersions.id, modelIds)).all() : []
      for (const id of modelIds) {
        if (!models.some(model => model.id === id && model.kind === 'model') || jobInputs.some(input => input.assetVersionId === id)) continue
        jobInputs.push({ jobId, ordinal: jobInputs.length, assetVersionId: id, fromSnapshot: false })
      }
    }
    adapter.validateInputs?.(params.kind, model, inputMetadata, providerParams, operation)
  } catch (error) {
    if (error instanceof ProviderError && error.kind === 'rejected') {
      throw VisError.of('invalid_params', error.reason ?? 'generation.invalid_params', error.params ?? (error.reason ? {} : { detail: error.message }), error.message)
    }
    throw error
  }
  if (paid && byAgent && !ctx.reserve) checkLocalQuota(tx, params.kind, now, ctx.limits)
  const { actualPrompt: _actualPrompt, revisedPrompt: _revisedPrompt, ...sourceParams } = (ctx.source?.job.params ?? {}) as Record<string, unknown>
  tx.insert(s.generationJobs)
    .values({
      id: jobId,
      sessionId: caller.sessionId,
      turnId: caller.turnId,
      inputSnapshotId: ctx.source ? ctx.source.job.inputSnapshotId : caller.inputSnapshotId,
      kind: params.kind,
      provider: providerId,
      model,
      operation,
      params: ctx.source ? sourceParams : { prompt: params.prompt, ...providerParams, ...(adapter.configuration ? { providerConfiguration: adapter.configuration } : {}) },
      status: 'queued',
      quotaDate: paid ? localDate(now) : null,
      createdAt: now,
      updatedAt: now,
    })
    .run()
  for (const input of jobInputs) tx.insert(s.jobInputs).values(input).run()
  const references = new Map(numberReferences(referenceInputs).map(reference => [reference.nodeId, reference]))
  for (const [nodeId, versionId] of directAliases) if (!references.has(nodeId) && references.has(versionId)) references.set(nodeId, references.get(versionId)!)
  const resolvedPrompt = ctx.source ? params.prompt : params.prompt.replace(PROMPT_REF_PATTERN, (_marker, nodeId: string) => {
    const input = references.get(nodeId)
    if (!input) throw VisError.of('invalid_params', 'generation.prompt_reference_missing', { nodeId }, 'A prompt reference is not among this submission media inputs')
    const label = { image: '图片', video: '视频', audio: '音频' }[input.kind]
    return adapter.referenceLabelFor?.(params.kind, model, input) ?? `${label} ${input.number}`
  })
  if (!ctx.source) tx.update(s.generationJobs).set({ params: { prompt: params.prompt, ...(resolvedPrompt !== params.prompt ? { resolvedPrompt } : {}), ...providerParams, ...(pinnedFrames.length ? { frameRefs: { first: pinnedFrames[0], ...(pinnedFrames[1] ? { last: pinnedFrames[1] } : {}) } } : {}), ...(adapter.configuration ? { providerConfiguration: adapter.configuration } : {}) } }).where(eq(s.generationJobs.id, jobId)).run()

  const explicit = new Map((params.targets ?? []).map(t => [t.outputIndex, t]))
  for (const index of explicit.keys()) {
    if (index >= outputCount) throw VisError.of('invalid_params', 'generation.output_index_out_of_range', { index, outputCount }, `outputIndex ${index} exceeds output count ${outputCount}`)
  }
  const targetedSlots = new Set<string>()
  const bindings: SubmitResult['bindings'] = []
  for (let outputIndex = 0; outputIndex < outputCount; outputIndex++) {
    const bindingId = newId('binding', now)
    const t = explicit.get(outputIndex)
    let target: ResolvedTarget
    if (t?.kind === 'slot') {
      if (targetedSlots.has(t.slotId)) throw VisError.of('invalid_params', 'generation.duplicate_target_slot', { slotId: t.slotId }, `Slot ${t.slotId} is targeted by multiple outputs`)
      targetedSlots.add(t.slotId)
      const slot = tx.select().from(s.slots).where(and(eq(s.slots.id, t.slotId), isNull(s.slots.deletedAt))).get()
      const node = slot && tx.select().from(s.nodes).where(and(eq(s.nodes.id, slot.nodeId), isNull(s.nodes.deletedAt))).get()
      if (!slot || !node) throw VisError.of('not_found', 'generation.target_slot_not_found', { slotId: t.slotId }, `Target slot ${t.slotId} does not exist or has been deleted`)
      if (slot.contentType !== params.kind) throw VisError.of('invalid_params', 'generation.target_kind_mismatch', { contentType: slot.contentType, kind: params.kind }, `${slot.contentType} slots cannot accept ${params.kind} outputs`)
      target = { kind: 'slot', nodeId: node.id, slotId: slot.id, expectedRevision: t.expectedRevision ?? slot.currentRevision }
      tx.insert(s.deliveryBindings)
        .values({ id: bindingId, jobId, outputIndex, targetKind: 'slot', nodeId: node.id, slotId: slot.id, expectedContentRevision: target.expectedRevision, status: 'pending' })
        .run()
      // Accepting a new request revokes the old request automatic fill eligibility
      tx.update(s.slots).set({ acceptedBindingId: bindingId }).where(eq(s.slots.id, slot.id)).run()
    } else {
      const nearNodeId = t?.kind === 'new_node' ? t.nearNodeId : firstInputNodeId
      tx.insert(s.deliveryBindings)
        .values({ id: bindingId, jobId, outputIndex, targetKind: 'new_node', placement: nearNodeId ? { nearNodeId } : null, status: 'pending' })
        .run()
      ctx.delivery?.reservePlaceholder?.(tx, { bindingId })
      const placeholder = tx.select({ nodeId: s.deliveryBindings.nodeId, slotId: s.deliveryBindings.slotId }).from(s.deliveryBindings).where(eq(s.deliveryBindings.id, bindingId)).get()
      target = { kind: 'new_node', ...(nearNodeId ? { nearNodeId } : {}), ...(placeholder?.nodeId && placeholder.slotId ? { nodeId: placeholder.nodeId, slotId: placeholder.slotId } : {}) }
    }
    bindings.push({ bindingId, outputIndex, target })
  }

  if (paid) ctx.reserve?.(jobId, params.kind, byAgent)
  appendEvent(tx, { type: 'job.stateChanged', entityType: 'job', entityId: jobId, payload: { jobId, status: 'queued', job: readJobView(tx, jobId) } }, now)
  return { jobId, status: 'queued', bindings }
}
