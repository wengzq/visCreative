// Shared write steps for apply and deliverOutput; both must run inside the caller's write transaction
import { newId, VisError } from '@vis/domain'
import { adoptPendingEntityImage } from '@vis/library-core'
import { markScriptEntitiesChanged } from './script-entities'
import { EMPTY_PREVIZ, EMPTY_SCENE, type PrevizDoc, type SceneDoc, EMPTY_SCRIPT, type ScriptDoc, type ShotLink, type ExportOf, type TimelineDoc, type AssetKind, isMediaKind, type MediaKind, type NodeGeneration, type NodeKind, type NodePurpose, type TextFormat } from '@vis/protocol'
import { and, appendEvent, eq, inArray, isNull, max, spaceSchema as s, type SpaceTx } from '@vis/storage'
import { readNodes } from './views'
import { frameIdAt } from './frames'
import { emptyTimeline } from './timeline'

// 0024: timeline documents are validated by the caller (timeline.set) before they reach the write path
export type SlotContentWrite = { text: string } | { assetVersionId: string } | { script: ScriptDoc } | { timeline: TimelineDoc } | { previz: PrevizDoc } | { scene: SceneDoc } | { clear: true }

export function assetVersionKind(tx: SpaceTx, assetVersionId: string): { kind: AssetKind; width: number | null; height: number | null } {
  const row = tx
    .select({ kind: s.assets.kind, width: s.assetVersions.width, height: s.assetVersions.height })
    .from(s.assetVersions)
    .innerJoin(s.assets, eq(s.assets.id, s.assetVersions.assetId))
    .where(eq(s.assetVersions.id, assetVersionId))
    .get()
  if (!row) throw VisError.of('not_found', 'canvas.asset_version_not_found', { assetVersionId }, `Asset version ${assetVersionId} does not exist`)
  return row
}

/** Like assetVersionKind, for places that place media on the canvas. */
export function mediaVersionKind(tx: SpaceTx, assetVersionId: string): { kind: MediaKind; width: number | null; height: number | null } {
  const row = assetVersionKind(tx, assetVersionId)
  if (!isMediaKind(row.kind)) throw VisError.of('invalid_params', 'media.kind_mismatch', { assetVersionId, kind: row.kind }, 'Only image, video and audio assets can be placed as media nodes')
  return { ...row, kind: row.kind }
}

export function assertContentFits(contentType: NodeKind, content: SlotContentWrite, tx: SpaceTx): void {
  if ('clear' in content) return
  if ('script' in content) {
    if (contentType !== 'script') throw VisError.of('invalid_params', 'script.slot_required', {}, 'Script operations require a script slot')
    return
  }
  if ('scene' in content) {
    if (contentType !== 'scene') throw VisError.of('invalid_params', 'scene.slot_required', {}, 'Scene documents require a scene slot')
    return
  }
  if ('previz' in content) {
    if (contentType !== 'previz') throw VisError.of('invalid_params', 'previz.slot_required', {}, 'Previz documents require a previz slot')
    return
  }
  if ('timeline' in content) {
    if (contentType !== 'timeline') throw VisError.of('invalid_params', 'timeline.slot_required', {}, 'Timeline documents require a timeline slot')
    return
  }
  if ('text' in content) {
    if (contentType !== 'text') throw VisError.of('invalid_params', 'canvas.text_content_mismatch', { contentType }, `Cannot write text to a ${contentType} slot`)
    return
  }
  const { kind } = assetVersionKind(tx, content.assetVersionId)
  if (kind !== contentType) throw VisError.of('invalid_params', 'canvas.asset_content_mismatch', { contentType, kind }, `${contentType} slots cannot contain ${kind} assets`)
}

/** Write the next slot revision and return its number. The caller must check the version condition first */
export function writeSlotRevision(
  tx: SpaceTx,
  slotId: string,
  currentRevision: number,
  content: SlotContentWrite,
  operationId: string,
  now: number,
  opts: { emitEvent?: boolean } = {},
): number {
  const revision = currentRevision + 1
  tx.insert(s.slotRevisions)
    .values({
      slotId,
      revision,
      textBody: 'text' in content ? content.text : null,
      scriptDoc: 'script' in content ? content.script : null,
      timelineDoc: 'timeline' in content ? content.timeline : null,
      previzDoc: 'previz' in content ? content.previz : null,
      sceneDoc: 'scene' in content ? content.scene : null,
      assetVersionId: 'assetVersionId' in content ? content.assetVersionId : null,
      operationId,
      createdAt: now,
    })
    .run()
  tx.update(s.slots).set({ currentRevision: revision }).where(eq(s.slots.id, slotId)).run()
  if ('assetVersionId' in content) {
    const target = tx.select().from(s.slots).where(eq(s.slots.id, slotId)).get()!
    if (target.slotKey === 'main' && target.contentType === 'image') {
      adoptPendingEntityImage(tx, target.nodeId, content.assetVersionId, now, (tx, ids) => markScriptEntitiesChanged(tx, ids, now))
    }
  }
  if (opts.emitEvent === false) return revision
  // Include new content in the payload so the UI does not need another query
  const { nodeId } = tx.select({ nodeId: s.slots.nodeId }).from(s.slots).where(eq(s.slots.id, slotId)).get()!
  const slot = readNodes(tx, [nodeId])[0]?.slots.find(x => x.slotId === slotId)
  appendEvent(tx, { type: 'slot.revised', entityType: 'slot', entityId: slotId, payload: { nodeId, slotId, revision, slot }, operationId }, now)
  return revision
}

export function createNodeWithSlot(
  tx: SpaceTx,
  input: { nodeId?: string; kind: NodeKind; x: number; y: number; w: number; h: number; content?: SlotContentWrite; prompt?: string; inputNodeIds?: string[]; generation?: NodeGeneration; title?: string | null; category?: string | null; purpose?: NodePurpose; format?: TextFormat; frameId?: string; shot?: ShotLink | null; exportOf?: ExportOf | null },
  operationId: string,
  now: number,
): { nodeId: string; slotId: string; revision: number; promptSlotId?: string } {
  if (input.prompt !== undefined && input.kind === 'text') throw VisError.of('invalid_params', 'canvas.prompt_unsupported', {}, 'Only image, video, and audio nodes support prompts')
  if (input.content) assertContentFits(input.kind, input.content, tx)
  const topZ = tx.select({ z: max(s.nodes.z) }).from(s.nodes).where(isNull(s.nodes.deletedAt)).get()?.z ?? 0
  const nodeId = input.nodeId ?? newId('node')
  const slotId = newId('slot')
  tx.insert(s.nodes)
    .values({ id: nodeId, kind: input.kind, x: input.x, y: input.y, w: input.w, h: input.h, z: topZ + 1, generation: input.generation ?? null,
      title: input.title ?? null, category: input.category ?? null, purpose: input.purpose ?? 'artifact', format: input.format ?? 'plain', shot: input.shot ?? null, exportOf: input.exportOf ?? null,
      frameId: input.frameId ?? frameIdAt(tx, { ...input, id: nodeId }), createdAt: now })
    .run()
  // Always retain the main slot; generation nodes have an additional text prompt slot
  tx.insert(s.slots).values({ id: slotId, nodeId, slotKey: 'main', contentType: input.kind }).run()
  // Initial content is already included in the node.created payload; do not emit a separate slot.revised
  const content = input.content ?? (input.kind === 'script' ? { script: EMPTY_SCRIPT } : input.kind === 'timeline' ? { timeline: emptyTimeline() } : input.kind === 'previz' ? { previz: EMPTY_PREVIZ } : input.kind === 'scene' ? { scene: EMPTY_SCENE } : undefined)
  const revision = content ? writeSlotRevision(tx, slotId, 0, content, operationId, now, { emitEvent: false }) : 0
  let promptSlotId: string | undefined
  if (input.prompt !== undefined || input.kind === 'script') {
    promptSlotId = newId('slot')
    tx.insert(s.slots).values({ id: promptSlotId, nodeId, slotKey: 'prompt', contentType: 'text' }).run()
    writeSlotRevision(tx, promptSlotId, 0, { text: input.prompt ?? '' }, operationId, now, { emitEvent: false })
  }
  if (input.inputNodeIds !== undefined) writeNodeInputs(tx, nodeId, input.inputNodeIds)
  const [view] = readNodes(tx, [nodeId])
  appendEvent(tx, { type: 'node.created', entityType: 'node', entityId: nodeId, payload: view, operationId }, now)
  return { nodeId, slotId, revision, ...(promptSlotId ? { promptSlotId } : {}) }
}

/** Replace node input relationships wholesale; any node can declare the inputs behind its output */
export function writeNodeInputs(tx: SpaceTx, nodeId: string, inputNodeIds: string[]): void {
  const ids = [...new Set(inputNodeIds)].filter(id => id !== nodeId)
  const liveIds = new Set(ids.length ? tx.select({ id: s.nodes.id }).from(s.nodes)
    .where(and(inArray(s.nodes.id, ids), isNull(s.nodes.deletedAt))).all().map(node => node.id) : [])
  const missing = ids.find(id => !liveIds.has(id))
  if (missing) throw VisError.of('not_found', 'canvas.input_node_not_found', { nodeId: missing }, `Input node ${missing} does not exist or has been deleted`)
  tx.delete(s.nodeInputs).where(eq(s.nodeInputs.nodeId, nodeId)).run()
  if (ids.length) tx.insert(s.nodeInputs).values(ids.map((inputNodeId, ordinal) => ({ nodeId, ordinal, inputNodeId }))).run()
}

export function insertOperation(
  tx: SpaceTx,
  op: { id: string; actor: { kind: 'user' } | { kind: 'agent'; sessionId: string } | { kind: 'system' }; description?: string | undefined },
  now: number,
): void {
  tx.insert(s.operations)
    .values({
      id: op.id,
      actorKind: op.actor.kind,
      actorSessionId: op.actor.kind === 'agent' ? op.actor.sessionId : null,
      description: op.description ?? null,
      createdAt: now,
    })
    .run()
}
