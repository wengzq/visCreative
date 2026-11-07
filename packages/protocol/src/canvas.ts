import { z } from 'zod'
import { CanvasNodeKind, Id, NodeKind, RequestId, Revision } from './common'
import { FrameColor } from './work'
import { SCRIPT_LIMITS, ScriptDoc, ScriptDocInput, ScriptOp, ShotLink } from './script'
import { PrevizDoc } from './previz'
import { SceneDoc } from './scene'
import { ExportOf, TIMELINE_LIMITS, TimelineDoc } from './timeline'

export { CanvasNodeKind } from './common'

export const SlotContent = z.union([
  z.object({ type: z.literal('empty') }),
  z.object({ type: z.literal('text'), body: z.string() }),
  z.object({ type: z.literal('asset'), assetVersionId: Id, mime: z.string(), hasAlpha: z.boolean().optional() }),
  // 0023: the main slot of a script node
  z.object({ type: z.literal('script'), doc: ScriptDoc }),
  // 0024: the main slot of a timeline node
  z.object({ type: z.literal('timeline'), doc: TimelineDoc }),
  z.object({ type: z.literal('previz'), doc: PrevizDoc }),
  // 0037: the main slot of a scene node
  z.object({ type: z.literal('scene'), doc: SceneDoc }),
])
export type SlotContent = z.infer<typeof SlotContent>

export const SlotView = z.object({
  slotId: Id,
  slotKey: z.string(),
  contentType: NodeKind,
  revision: Revision,
  content: SlotContent,
  // Preserve job and input-node provenance when the current revision is delivered by a generation job.
  source: z.object({ jobId: Id, inputNodeIds: z.array(Id) }).optional(),
  // 0024c: who wrote the current revision; sessionId is set when an Agent session (or a user in a session) wrote it
  writer: z.object({ actor: z.enum(['user', 'agent', 'system']), sessionId: Id.optional() }).optional(),
})
export type SlotView = z.infer<typeof SlotView>

// 0024c: a timelineFrom item; durationMs only applies to image sources
export const TimelineFromItem = z.union([Id, z.strictObject({ nodeId: Id, durationMs: z.int().min(TIMELINE_LIMITS.imageMinMs).max(TIMELINE_LIMITS.imageMaxMs) })])
export type TimelineFromItem = z.infer<typeof TimelineFromItem>

export const SlotVersionView = z.object({
  revision: Revision,
  content: SlotContent,
  createdAt: z.int(),
  actor: z.enum(['user', 'agent', 'system']),
  isCurrent: z.boolean(),
  source: z.object({
    jobId: Id,
    prompt: z.string().optional(),
    provider: z.string(),
    model: z.string(),
    params: z.record(z.string(), z.unknown()),
    inputNodeIds: z.array(Id),
  }).optional(),
})
export type SlotVersionView = z.infer<typeof SlotVersionView>

export const slot = {
  history: {
    params: z.object({
      slotId: Id,
      limit: z.int().min(1).max(200).default(50),
      beforeRevision: Revision.optional(),
      includeDeleted: z.boolean().optional(),
    }),
    result: z.object({ versions: z.array(SlotVersionView), hasMore: z.boolean() }),
  },
} as const

export const NodeGeneration = z.object({
  provider: z.string().optional(),
  model: z.string().optional(),
  params: z.record(z.string(), z.unknown()).optional(),
})
export type NodeGeneration = z.infer<typeof NodeGeneration>

export const FrameView = z.object({
  title: z.string(),
  color: FrameColor,
  // Bound work item; the frame title follows the work item title, edited on the card.
})
export type FrameView = z.infer<typeof FrameView>

// 0016: node categories are free text; purpose distinguishes artifacts from work documents; text node display format.
export const NodeCategory = z.string().trim().min(1).max(20)
export const NodePurpose = z.enum(['artifact', 'working'])
export type NodePurpose = z.infer<typeof NodePurpose>
export const TextFormat = z.enum(['plain', 'markdown', 'code'])
// 0021: node title; when empty the UI shows the kind name and a sequence number
export const NodeTitle = z.string().trim().min(1).max(60)
export type TextFormat = z.infer<typeof TextFormat>

export const NodeView = z.object({
  nodeId: Id,
  kind: CanvasNodeKind,
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
  z: z.number(),
  layoutRevision: Revision,
  slots: z.array(SlotView),
  inputs: z.array(Id).optional(),
  generation: NodeGeneration.optional(),
  // Frame nodes only
  frame: FrameView.optional(),
  // Innermost frame containing the node center; null if outside all frames.
  frameId: Id.nullable().optional(),
  // 0016: defaults are null, artifact and plain respectively (legacy data and events lack these fields).
  category: z.string().nullable().optional(),
  purpose: NodePurpose.optional(),
  format: TextFormat.optional(),
  // 0021: absent means null
  title: z.string().nullable().optional(),
  // 0023: the shot this generated node belongs to; absent means null
  shot: ShotLink.nullable().optional(),
  // 0024: set by the server on nodes produced by timeline.export; absent means null
  exportOf: ExportOf.nullable().optional(),
})
export type NodeView = z.infer<typeof NodeView>

const Size = { x: z.number(), y: z.number(), w: z.number().positive(), h: z.number().positive() }
// 0016: new nodes may omit position and size; the server finds a non-overlapping position and uses type-specific default dimensions.
const OptionalSize = { x: z.number().optional(), y: z.number().optional(), w: z.number().positive().optional(), h: z.number().positive().optional() }
const NodeMeta = { category: NodeCategory.nullable().optional(), purpose: NodePurpose.optional(), format: TextFormat.optional(), title: NodeTitle.nullable().optional(), shot: ShotLink.nullable().optional() }

// Within a batch, tempId can reference new nodes and `${tempId}:main` can reference their slots.
export const CanvasOp = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('node.create'),
    tempId: z.string().min(1).max(64),
    kind: NodeKind,
    ...OptionalSize,
    ...NodeMeta,
    prompt: z.string().optional(),
    inputNodeIds: z.array(Id).optional(),
    generation: NodeGeneration.optional(),
    // 0024: timelineFrom builds a timeline node's first document from these nodes in the given order
    // (video / image to the video track, audio to the first audio track); the server reads durations.
    // 0024c: an item may carry durationMs to set an image clip's display length
    content: z.union([z.object({ text: z.string() }), z.object({ assetVersionId: Id }), z.object({ timelineFrom: z.array(TimelineFromItem).min(1).max(TIMELINE_LIMITS.clipsPerTrack) })]).optional(),
  }),
  z.object({
    op: z.literal('node.layout'),
    nodeId: Id,
    x: z.number().optional(),
    y: z.number().optional(),
    w: z.number().positive().optional(),
    h: z.number().positive().optional(),
    z: z.number().optional(),
  }),
  // The server recursively moves the entire frame by current membership; members do not count toward the operation batch size.
  z.object({ op: z.literal('frame.move'), nodeId: Id, dx: z.number(), dy: z.number() }),
  z.object({ op: z.literal('frame.create'), tempId: z.string().min(1).max(64), ...Size, title: z.string().trim().min(1).max(60), color: FrameColor.optional() }),
  // Frames bound to work items can only change color; their titles follow the work item.
  z.object({ op: z.literal('frame.update'), nodeId: Id, title: z.string().trim().min(1).max(60).optional(), color: FrameColor.optional() }),
  z.object({ op: z.literal('node.setInputs'), nodeId: Id, inputNodeIds: z.array(Id) }),
  // 0016: only change provided fields; null category or title means clear.
  z.object({ op: z.literal('node.setMeta'), nodeId: Id, ...NodeMeta }),
  z.object({ op: z.literal('node.setGeneration'), nodeId: Id, generation: NodeGeneration.optional(), onlyIfUnset: z.boolean().optional() }),
  z.object({ op: z.literal('node.delete'), nodeId: Id }),
  // Content edits require expectedRevision (read before write); layout edits do not.
  z.object({ op: z.literal('slot.setText'), slotId: Id, body: z.string(), expectedRevision: Revision }),
  z.object({ op: z.literal('slot.setAsset'), slotId: Id, assetVersionId: Id, expectedRevision: Revision }),
  z.object({ op: z.literal('slot.clear'), slotId: Id, expectedRevision: Revision }),
  // 0023: row-level edits of a script slot; each row op carries that row's rev, so other rows never conflict
  z.object({ op: z.literal('script.patch'), slotId: Id, ops: z.array(ScriptOp).min(1).max(SCRIPT_LIMITS.opsPerBatch) }),
  // 0023: replace the whole document (first breakdown or a full redo); ids and revs are assigned by the server
  z.object({ op: z.literal('script.replace'), slotId: Id, expectedRevision: Revision, doc: ScriptDocInput }),
  // 0024: replace the whole timeline document; the server checks sources and syncs the node inputs
  z.object({ op: z.literal('timeline.set'), slotId: Id, expectedRevision: Revision, doc: TimelineDoc }),
  z.object({ op: z.literal('previz.set'), slotId: Id, expectedRevision: Revision, doc: PrevizDoc }),
  z.object({ op: z.literal('scene.set'), slotId: Id, expectedRevision: Revision, doc: SceneDoc }),
])
export type CanvasOp = z.infer<typeof CanvasOp>

const history = {
  params: z.object({ requestId: RequestId }),
  result: z.union([z.object({ operationId: Id, description: z.string() }), z.object({ nothing: z.literal(true) })]),
}

export const canvas = {
  undo: history,
  redo: history,
  apply: {
    params: z.object({
      requestId: RequestId,
      description: z.string().max(500).optional(),
      ops: z.array(CanvasOp).min(1).max(200),
    }),
    result: z.object({
      operationId: Id,
      idMap: z.record(z.string(), Id),
      // 0016: final positions and sizes of nodes created in this batch, keyed by tempId; the server may adjust them to avoid overlap.
      placements: z.record(z.string(), z.object(Size)).optional(),
      slotRevisions: z.record(Id, Revision),
      eventSeq: z.int(),
    }),
  },
  get: {
    params: z.object({
      nodeIds: z.array(Id).optional(),
      // 'turn': read the fixed snapshot for this turn; available only to Agent callers.
      snapshot: z.literal('turn').optional(),
    }),
    result: z.object({ nodes: z.array(NodeView) }),
  },
} as const
