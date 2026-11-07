import { PROMPT_REF_PATTERN, type GenerationInput, type MethodParams } from '@vis/protocol'
import { and, eq, inArray, isNull, or, spaceSchema as s, type SpaceTx } from '@vis/storage'

/** Caller inputs keep their order and numbering; script settings only fill remaining image capacity. */
export function withScriptSettings(tx: SpaceTx, params: MethodParams<'generation.submit'>, referenceLimit: number, snapshotRevisions = new Map<string, number>()) {
  const target = params.targets?.find(target => target.outputIndex === 0)
  if (target?.kind !== 'slot') return params
  const node = tx.select({ shot: s.nodes.shot }).from(s.slots).innerJoin(s.nodes, eq(s.nodes.id, s.slots.nodeId)).where(eq(s.slots.id, target.slotId)).get()
  if (!node?.shot) return params
  const link = node.shot
  const script = tx.select({ doc: s.slotRevisions.scriptDoc }).from(s.slots)
    .innerJoin(s.nodes, eq(s.nodes.id, s.slots.nodeId))
    .innerJoin(s.slotRevisions, and(eq(s.slotRevisions.slotId, s.slots.id), eq(s.slotRevisions.revision, s.slots.currentRevision)))
    .where(and(eq(s.nodes.id, link.scriptNodeId), eq(s.slots.slotKey, 'main'), isNull(s.nodes.deletedAt))).get()?.doc
  const shot = script?.shots.find(shot => shot.id === link.shotId)
  if (!script?.castIds || !shot) return params
  const castIds = [...shot.characterIds, ...(shot.sceneId ? [shot.sceneId] : []), ...shot.propIds]
  const ids = [...new Set([...castIds, ...(script.styleId ? [script.styleId] : [])])]
  const settings = ids.length ? tx.select().from(s.entities).where(and(inArray(s.entities.id, ids), isNull(s.entities.deletedAt))).all() : []
  const byId = new Map(settings.map(row => [row.id, row]))
  const castSettings = castIds.flatMap(id => { const row = byId.get(id); return row ? [row] : [] })
  const style = script.styleId ? byId.get(script.styleId) : undefined
  const description = style?.description
  const prompt = description && !params.prompt.endsWith(description) ? `${params.prompt}\n${description}` : params.prompt
  if (params.frames) return { ...params, prompt }

  const inputs: GenerationInput[] = [...(params.inputs ?? [])]
  const slotInputs = inputs.flatMap(input => 'slotId' in input ? [input] : [])
  const slots = slotInputs.length ? tx.select().from(s.slots).where(inArray(s.slots.id, slotInputs.map(input => input.slotId))).all() : []
  const revisionOf = (input: typeof slotInputs[number]) => input.revision ?? snapshotRevisions.get(input.slotId) ?? slots.find(slot => slot.id === input.slotId)?.currentRevision ?? 0
  const versions = slotInputs.length ? tx.select().from(s.slotRevisions).where(or(...slotInputs.map(input => and(
    eq(s.slotRevisions.slotId, input.slotId), eq(s.slotRevisions.revision, revisionOf(input)),
  )))).all() : []
  const versionOf = (input: GenerationInput) => 'assetVersionId' in input ? input.assetVersionId : versions.find(row => row.slotId === input.slotId && row.revision === revisionOf(input))?.assetVersionId
  const suppliedIds = new Set(inputs.flatMap(input => { const id = versionOf(input); return id ? [id] : [] }))
  const images = suppliedIds.size ? tx.select({ id: s.assetVersions.id }).from(s.assetVersions)
    .innerJoin(s.assets, eq(s.assets.id, s.assetVersions.assetId)).where(and(inArray(s.assetVersions.id, [...suppliedIds]), eq(s.assets.kind, 'image'))).all() : []
  const imageIds = new Set(images.map(row => row.id))
  let imageCount = inputs.filter(input => imageIds.has(versionOf(input) ?? '')).length
  const add = (assetVersionId: string) => {
    if (suppliedIds.has(assetVersionId) || imageCount >= referenceLimit) return
    inputs.push({ assetVersionId })
    suppliedIds.add(assetVersionId)
    imageCount++
  }
  for (const setting of castSettings) for (const ref of setting.refs) add(ref.assetVersionId)
  for (const ref of style?.refs ?? []) add(ref.assetVersionId)
  const resolved = prompt.replace(PROMPT_REF_PATTERN, (marker, nodeId: string) => {
    const setting = settings.find(setting => setting.refs.some(ref => ref.sourceNodeId === nodeId))
    if (!setting) return marker
    return setting.refs.some(ref => ref.sourceNodeId === nodeId && suppliedIds.has(ref.assetVersionId)) ? marker : setting.name
  })
  return { ...params, prompt: resolved, inputs }
}
