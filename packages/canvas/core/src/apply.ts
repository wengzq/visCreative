import { writingCardSize } from '@vis/protocol'
import { VisError } from '@vis/domain'
import type { CanvasOp, ExportOf, MethodParams, MethodResult, RevisionConflict, ShotLink } from '@vis/protocol'
import { and, appendEvent, currentSeq, eq, isNull, spaceSchema as s, type SpaceTx } from '@vis/storage'
import { previousInputs, previousSlot, recordUndo, type UndoStep } from './undo'
import { liveNodeRects, readNodes } from './views'
import { defaultNodeSize, firstFreeBelow, NODE_GAP, overlaps } from './placement'
import { createFrameNode, detachFrame, expandFrameToFit, frameMemberIds, recomputeFrameMemberships, writeFramePositions } from './frames'
import { assetVersionKind, createNodeWithSlot, insertOperation, type SlotContentWrite, assertContentFits, writeNodeInputs, writeSlotRevision } from './write'
import { fitNodeToAsset } from './fit'
import { patchScript, replaceScript } from './script'
import { projectScriptEntities } from '@vis/library-core'
import { scriptEntityAliases } from './script-entities'
import { EMPTY_SCRIPT } from '@vis/protocol'
import { validatePreviz } from './previz'
import { validateScene } from './scene'
import { emptyTimeline, timelineFromNodes, validateTimeline } from './timeline'

export type Actor = { kind: 'user' } | { kind: 'agent'; sessionId: string }

type ApplyParams = MethodParams<'canvas.apply'>
type ApplyResult = MethodResult<'canvas.apply'>

/**
 * Apply an operation batch (0003 canvas.apply). Must run inside a write transaction;
 * writing media assets adjusts node height to the asset ratio and is undone with the asset.
 * Any revision conflict throws revision_conflict so the transaction rolls back the entire batch.
 */
// internal is for server callers only and never reachable from RPC: exportOf stamps the nodes created in this batch (0024 timeline.export)
export function applyOps(tx: SpaceTx, actor: Actor, params: ApplyParams, now: number, internal?: { exportOf?: ExportOf }): ApplyResult {
  const operationId = params.requestId
  insertOperation(tx, { id: operationId, actor, description: params.description }, now)

  const placements: NonNullable<ApplyResult['placements']> = {}
  const idMap: Record<string, string> = Object.create(null)
  const tempSlots = new Map<string, string>()
  const slotRevisions: Record<string, number> = {}
  const conflicts: RevisionConflict[] = []
  const inverse: UndoStep[] = []

  const resolveNode = (id: string) => idMap[id] ?? id
  const resolveSlot = (id: string) => tempSlots.get(id) ?? id
  const resolveShot = (shot: ShotLink | null) => shot && { ...shot, scriptNodeId: resolveNode(shot.scriptNodeId), shotId: idMap[shot.shotId] ?? shot.shotId }

  const liveNode = (nodeId: string) => {
    const node = tx.select().from(s.nodes).where(and(eq(s.nodes.id, nodeId), isNull(s.nodes.deletedAt))).get()
    if (!node) throw VisError.of('not_found', 'canvas.node_not_found', { nodeId }, `Node ${nodeId} does not exist or has been deleted`)
    return node
  }

  for (const op of params.ops) {
    switch (op.op) {
      case 'frame.create': {
        if (idMap[op.tempId]) throw VisError.of('invalid_params', 'canvas.duplicate_temp_id', { tempId: op.tempId }, `Duplicate tempId ${op.tempId}`)
        const created = createFrameNode(tx, op, operationId, now)
        inverse.push({ kind: 'presence', nodeId: created.nodeId, deleted: true }, ...created.memberships.map(member => ({ kind: 'frameId' as const, ...member })))
        idMap[op.tempId] = created.nodeId
        break
      }
      case 'frame.update': {
        const node = liveNode(resolveNode(op.nodeId))
        if (node.kind !== 'frame' || !node.frame) throw VisError.of('invalid_params', 'canvas.not_frame', {}, 'The target node is not a frame')
        inverse.push({ kind: 'frame', nodeId: node.id, frame: { ...(op.title !== undefined ? { title: node.frame.title } : {}), ...(op.color !== undefined ? { color: node.frame.color } : {}) } })
        tx.update(s.nodes).set({ frame: { ...node.frame, ...(op.title !== undefined ? { title: op.title } : {}), ...(op.color !== undefined ? { color: op.color } : {}) },
          layoutRevision: node.layoutRevision + 1 }).where(eq(s.nodes.id, node.id)).run()
        appendEvent(tx, { type: 'node.updated', entityType: 'node', entityId: node.id, payload: readNodes(tx, [node.id])[0], operationId }, now)
        break
      }
      case 'frame.move': {
        const nodeId = resolveNode(op.nodeId)
        const positions = readNodes(tx, frameMemberIds(tx, nodeId)).map(node => ({ nodeId: node.nodeId, x: node.x + op.dx, y: node.y + op.dy }))
        inverse.push({ kind: 'frameMove', nodeId, positions: writeFramePositions(tx, positions, operationId, now) })
        break
      }
      case 'node.create': {
        if (idMap[op.tempId]) throw VisError.of('invalid_params', 'canvas.duplicate_temp_id', { tempId: op.tempId }, `Duplicate tempId ${op.tempId}`)
        if (op.kind === 'previz' && op.content) throw VisError.of('invalid_params', 'previz.content_mismatch', {}, 'Create an empty previz, then use previz.set')
        if (op.kind === 'scene' && op.content) throw VisError.of('invalid_params', 'scene.content_mismatch', {}, 'Create an empty scene, then use scene.set')
        const from = op.content && 'timelineFrom' in op.content ? op.content.timelineFrom.map(item => typeof item === 'string' ? { nodeId: resolveNode(item) } : { nodeId: resolveNode(item.nodeId), durationMs: item.durationMs }) : undefined
        if ((from && op.kind !== 'timeline') || (op.kind === 'timeline' && op.content && !from)) {
          throw VisError.of('invalid_params', 'timeline.content_mismatch', {}, 'Timeline nodes only accept timelineFrom content, which requires a timeline node')
        }
        const content: SlotContentWrite | undefined = op.kind === 'timeline'
          ? { timeline: from ? timelineFromNodes(tx, from) : emptyTimeline() }
          : op.content
          ? 'text' in op.content ? { text: op.content.text } : 'assetVersionId' in op.content ? { assetVersionId: op.content.assetVersionId } : undefined
          : undefined
        const inputIds = content && 'timeline' in content ? validateTimeline(tx, content.timeline)
          : op.inputNodeIds?.filter(id => id !== op.tempId).map(resolveNode)
        const media = content && 'assetVersionId' in content ? assetVersionKind(tx, content.assetVersionId) : undefined
        const defaults = op.kind === 'text' && op.format !== 'code'
          ? writingCardSize(content && 'text' in content ? content.text : '') : defaultNodeSize(op.kind, media)
        const w = op.w ?? defaults.w
        const h = media?.width && media.height && (op.kind === 'image' || op.kind === 'video')
          ? Math.max(80, Math.min(4 * w, Math.round(w * media.height / media.width))) : defaults.h
        const size = { w, h: op.h ?? h }
        const existing = op.purpose === 'working' ? [] : liveNodeRects(tx)
        const explicit = op.x !== undefined && op.y !== undefined
        const requested = { x: op.x ?? 0, y: op.y ?? 0 }
        const adjusted = !explicit || (actor.kind === 'agent' && existing.some(r => overlaps({ ...requested, ...size }, r)))
        let pos = requested
        let frameId: string | undefined
        if (adjusted) {
          const inputs = readNodes(tx, inputIds ?? []).filter(node => inputIds?.includes(node.nodeId))
          const frame = op.category ? readNodes(tx).find(node => node.kind === 'frame' && node.frame?.title === op.category && node.purpose !== 'working') : undefined
          if (inputs.length) {
            pos = firstFreeBelow({ x: Math.max(...inputs.map(node => node.x + node.w)) + NODE_GAP, y: Math.min(...inputs.map(node => node.y)) }, size, existing)
          } else if (frame) {
            pos = firstFreeBelow({ x: frame.x + NODE_GAP, y: frame.y + NODE_GAP }, size, existing)
            frameId = frame.nodeId
            expandFrameToFit(tx, frame.nodeId, { ...pos, ...size }, operationId, now, inverse)
          } else {
            pos = explicit ? firstFreeBelow(requested, size, existing) : existing.length
              ? { x: Math.max(...existing.map(node => node.x + node.w)) + NODE_GAP * 2, y: Math.max(...existing.map(node => node.y + node.h)) + NODE_GAP }
              : { x: 0, y: 0 }
          }
          placements[op.tempId] = { ...pos, ...size }
        }
        const created = createNodeWithSlot(
          tx,
          { kind: op.kind, ...pos, ...size, ...(frameId ? { frameId } : {}),
            ...(op.category !== undefined ? { category: op.category } : {}), ...(op.purpose ? { purpose: op.purpose } : {}), ...(op.format ? { format: op.format } : {}), ...(content ? { content } : {}), ...(op.prompt !== undefined ? { prompt: op.prompt } : {}),
            ...(op.title !== undefined ? { title: op.title } : {}),
            ...(op.shot !== undefined ? { shot: resolveShot(op.shot) } : {}),
            ...(internal?.exportOf ? { exportOf: internal.exportOf } : {}),
            ...(inputIds !== undefined ? { inputNodeIds: inputIds } : {}),
            ...(op.generation !== undefined ? { generation: op.generation } : {}),
          },
          operationId,
          now,
        )
        inverse.push({ kind: 'presence', nodeId: created.nodeId, deleted: true })
        idMap[op.tempId] = created.nodeId
        tempSlots.set(`${op.tempId}:main`, created.slotId)
        if (created.promptSlotId) {
          tempSlots.set(`${op.tempId}:prompt`, created.promptSlotId)
          slotRevisions[created.promptSlotId] = 1
        }
        slotRevisions[created.slotId] = created.revision
        break
      }
      case 'node.setMeta': {
        const node = liveNode(resolveNode(op.nodeId))
        const meta = { ...(op.title !== undefined ? { title: op.title } : {}), ...(op.category !== undefined ? { category: op.category } : {}), ...(op.purpose !== undefined ? { purpose: op.purpose } : {}), ...(op.format !== undefined ? { format: op.format } : {}), ...(op.shot !== undefined ? { shot: resolveShot(op.shot) } : {}) }
        inverse.push({ kind: 'meta', nodeId: node.id, meta: Object.fromEntries(Object.keys(meta).map(key => [key, node[key as keyof typeof meta]])) })
        tx.update(s.nodes).set({ ...meta, layoutRevision: node.layoutRevision + 1 }).where(eq(s.nodes.id, node.id)).run()
        appendEvent(tx, { type: 'node.updated', entityType: 'node', entityId: node.id, payload: readNodes(tx, [node.id])[0], operationId }, now)
        break
      }
      case 'node.layout': {
        const node = liveNode(resolveNode(op.nodeId))
        const { x, y, w, h, z } = node
        inverse.push({ kind: 'layout', nodeId: node.id, layout: { x, y, w, h, z } })
        const patch = { x: op.x, y: op.y, w: op.w, h: op.h, z: op.z }
        // Layout changes do not require a version condition; the last write wins (0003)
        tx.update(s.nodes)
          .set({ ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)), layoutRevision: node.layoutRevision + 1 })
          .where(eq(s.nodes.id, node.id))
          .run()
        recomputeFrameMemberships(tx, operationId, now, node.kind === 'frame' ? undefined : node.id, node.id)
        appendEvent(tx, { type: 'node.updated', entityType: 'node', entityId: node.id, payload: readNodes(tx, [node.id])[0], operationId }, now)
        break
      }
      case 'node.setInputs': {
        const node = liveNode(resolveNode(op.nodeId))
        inverse.push({ kind: 'inputs', nodeId: node.id, inputs: previousInputs(tx, node.id) })
        writeNodeInputs(tx, node.id, op.inputNodeIds.map(resolveNode))
        tx.update(s.nodes).set({ layoutRevision: node.layoutRevision + 1 }).where(eq(s.nodes.id, node.id)).run()
        appendEvent(tx, { type: 'node.updated', entityType: 'node', entityId: node.id, payload: readNodes(tx, [node.id])[0], operationId }, now)
        break
      }
      case 'node.setGeneration': {
        const node = liveNode(resolveNode(op.nodeId))
        if (node.kind === 'frame') throw VisError.of('invalid_params', 'canvas.frame_generation_unsupported', {}, 'Frames do not support generation settings')
        if (op.onlyIfUnset && node.generation !== null) break
        inverse.push({ kind: 'generation', nodeId: node.id, generation: node.generation })
        tx.update(s.nodes).set({ generation: op.generation ?? null, layoutRevision: node.layoutRevision + 1 }).where(eq(s.nodes.id, node.id)).run()
        appendEvent(tx, { type: 'node.updated', entityType: 'node', entityId: node.id, payload: readNodes(tx, [node.id])[0], operationId }, now)
        break
      }
      case 'node.delete': {
        const node = liveNode(resolveNode(op.nodeId))
        if (node.kind === 'frame') {
          const detached = detachFrame(tx, node.id, operationId, now)
          inverse.push(...detached.map(member => ({ kind: 'frameId' as const, ...member })))
        }
        inverse.push({ kind: 'presence', nodeId: node.id, deleted: false })
        // Tombstone: IDs are never reused; active generation jobs use this to detect target_missing; assets are retained
        tx.update(s.nodes).set({ deletedAt: now }).where(eq(s.nodes.id, node.id)).run()
        tx.update(s.slots).set({ deletedAt: now }).where(and(eq(s.slots.nodeId, node.id), isNull(s.slots.deletedAt))).run()
        appendEvent(tx, { type: 'node.deleted', entityType: 'node', entityId: node.id, payload: { nodeId: node.id }, operationId }, now)
        break
      }
      case 'previz.set': {
        const slotId = resolveSlot(op.slotId)
        const slot = tx.select().from(s.slots).where(and(eq(s.slots.id, slotId), isNull(s.slots.deletedAt))).get()
        if (!slot) throw VisError.of('not_found', 'canvas.slot_not_found', { slotId }, 'The previz slot does not exist or has been deleted')
        if (slot.contentType !== 'previz') throw VisError.of('invalid_params', 'previz.slot_required', {}, 'Previz operations require a previz slot')
        if (slot.currentRevision !== op.expectedRevision) {
          conflicts.push({ slotId, expectedRevision: op.expectedRevision, currentRevision: slot.currentRevision })
          break
        }
        const doc = validatePreviz(tx, op.doc)
        inverse.push(previousSlot(tx, slotId))
        slotRevisions[slotId] = writeSlotRevision(tx, slotId, slot.currentRevision, { previz: doc }, operationId, now)
        break
      }
      case 'scene.set': {
        const slotId = resolveSlot(op.slotId)
        const slot = tx.select().from(s.slots).where(and(eq(s.slots.id, slotId), isNull(s.slots.deletedAt))).get()
        if (!slot) throw VisError.of('not_found', 'canvas.slot_not_found', { slotId }, 'The scene slot does not exist or has been deleted')
        if (slot.contentType !== 'scene') throw VisError.of('invalid_params', 'scene.slot_required', {}, 'Scene operations require a scene slot')
        if (slot.currentRevision !== op.expectedRevision) {
          conflicts.push({ slotId, expectedRevision: op.expectedRevision, currentRevision: slot.currentRevision })
          break
        }
        const doc = validateScene(tx, op.doc)
        inverse.push(previousSlot(tx, slotId))
        slotRevisions[slotId] = writeSlotRevision(tx, slotId, slot.currentRevision, { scene: doc }, operationId, now)
        break
      }
      case 'timeline.set': {
        const slotId = resolveSlot(op.slotId)
        const slot = tx.select().from(s.slots).where(and(eq(s.slots.id, slotId), isNull(s.slots.deletedAt))).get()
        if (!slot) throw VisError.of('not_found', 'canvas.slot_not_found', { slotId }, 'The timeline slot does not exist or has been deleted')
        if (slot.contentType !== 'timeline') throw VisError.of('invalid_params', 'timeline.slot_required', {}, 'Timeline operations require a timeline slot. See guide "timeline".')
        if (slot.currentRevision !== op.expectedRevision) {
          conflicts.push({ slotId, expectedRevision: op.expectedRevision, currentRevision: slot.currentRevision })
          break
        }
        const inputIds = validateTimeline(tx, op.doc, slot.nodeId)
        inverse.push(previousSlot(tx, slotId), { kind: 'inputs', nodeId: slot.nodeId, inputs: previousInputs(tx, slot.nodeId) })
        writeNodeInputs(tx, slot.nodeId, inputIds)
        const node = liveNode(slot.nodeId)
        tx.update(s.nodes).set({ layoutRevision: node.layoutRevision + 1 }).where(eq(s.nodes.id, node.id)).run()
        slotRevisions[slotId] = writeSlotRevision(tx, slotId, slot.currentRevision, { timeline: op.doc }, operationId, now)
        appendEvent(tx, { type: 'node.updated', entityType: 'node', entityId: node.id, payload: readNodes(tx, [node.id])[0], operationId }, now)
        break
      }
      case 'script.patch':
      case 'script.replace': {
        const slotId = resolveSlot(op.slotId)
        const slot = tx.select().from(s.slots).where(and(eq(s.slots.id, slotId), isNull(s.slots.deletedAt))).get()
        if (!slot) throw VisError.of('not_found', 'canvas.slot_not_found', { slotId }, 'The script slot does not exist or has been deleted')
        if (slot.contentType !== 'script') throw VisError.of('invalid_params', 'script.slot_required', {}, 'Script operations require a script slot. See guide "script".')
        if (op.op === 'script.replace' && slot.currentRevision !== op.expectedRevision) {
          conflicts.push({ slotId, expectedRevision: op.expectedRevision, currentRevision: slot.currentRevision })
          break
        }
        const previous = previousSlot(tx, slotId)
        const source = projectScriptEntities(tx, 'script' in previous.content ? previous.content.script : EMPTY_SCRIPT)
        const aliases = scriptEntityAliases(tx, slotId, now)
        const doc = op.op === 'script.patch'
          ? patchScript(source, op.ops, actor, slotId, slot.currentRevision, idMap, aliases)
          : replaceScript(source, op.doc, actor, idMap, aliases)
        inverse.push(previous)
        slotRevisions[slotId] = writeSlotRevision(tx, slotId, slot.currentRevision, { script: doc }, operationId, now)
        break
      }
      case 'slot.setText':
      case 'slot.setAsset':
      case 'slot.clear': {
        const slotId = resolveSlot(op.slotId)
        const slot = tx.select().from(s.slots).where(and(eq(s.slots.id, slotId), isNull(s.slots.deletedAt))).get()
        if (!slot) throw VisError.of('not_found', 'canvas.slot_not_found', { slotId: op.slotId }, `Slot ${op.slotId} does not exist or has been deleted`)
        if (slot.contentType === 'previz') throw VisError.of('invalid_params', 'previz.edit_required', {}, 'Previz slots must be edited with previz.set')
        if (slot.contentType === 'scene') throw VisError.of('invalid_params', 'scene.edit_required', {}, 'Scene slots must be edited with scene.set')
        if (slot.contentType === 'timeline') throw VisError.of('invalid_params', 'timeline.edit_required', {}, 'Timeline slots must be edited with timeline.set')
        if (op.op === 'slot.clear' && slot.contentType === 'script') throw VisError.of('invalid_params', 'canvas.script_clear_unsupported', {}, 'Script slots must be edited with script.patch or script.replace')
        if (slot.currentRevision !== op.expectedRevision) {
          conflicts.push({ slotId, expectedRevision: op.expectedRevision, currentRevision: slot.currentRevision })
          break
        }
        inverse.push(previousSlot(tx, slotId))
        const content = slotContentOf(op)
        assertContentFits(slot.contentType, content, tx)
        slotRevisions[slotId] = writeSlotRevision(tx, slotId, slot.currentRevision, content, operationId, now)
        if (op.op === 'slot.setAsset' && slot.slotKey === 'main') {
          const { x, y, w, z } = liveNode(slot.nodeId)
          const previous = fitNodeToAsset(tx, slot.nodeId, op.assetVersionId, operationId, now, inverse)
          if (previous) inverse.push({ kind: 'layout', nodeId: slot.nodeId, layout: { x, y, w, h: previous.h, z } })
        }
        break
      }
    }
  }

  if (conflicts.length > 0) {
    throw VisError.of('revision_conflict', 'canvas.revision_conflict', {}, 'Slot content has changed; read it again and retry', conflicts)
  }
  if (actor.kind === 'user' && inverse.length > 0) recordUndo(tx, operationId, inverse, now)
  return { operationId, idMap, placements, slotRevisions, eventSeq: currentSeq(tx) }
}

function slotContentOf(op: Extract<CanvasOp, { op: 'slot.setText' | 'slot.setAsset' | 'slot.clear' }>): SlotContentWrite {
  switch (op.op) {
    case 'slot.setText':
      return { text: op.body }
    case 'slot.setAsset':
      return { assetVersionId: op.assetVersionId }
    case 'slot.clear':
      return { clear: true }
  }
}
