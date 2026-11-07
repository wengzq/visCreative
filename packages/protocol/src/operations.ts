import { z } from 'zod'
import { Id, MediaKind, NodeKind, RequestId, Revision } from './common'

// 0021: node operation catalog. Components know only these operation IDs, never providers or models.

// Local operations: studiod runs them with ffmpeg; free, and they use neither generation concurrency nor execution slots
export const LocalOperation = z.enum([
  'image.crop', 'image.gridSplit',
  'video.trim', 'video.frame', 'video.extractAudio', 'video.exportMov',
  'audio.trim', 'audio.split', 'audio.speed',
  // 0024: render a timeline node to a new video / audio node
  'timeline.export',
])
export type LocalOperation = z.infer<typeof LocalOperation>

// Generation operations: available only when a model declares them in providers.list; generate is prompt-based generation for every media kind
export const GenerationOperation = z.enum([
  'generate',
  'image.upscale', 'image.outpaint', 'image.matting', 'image.multiview',
  'video.upscale', 'video.removeSubtitles', 'video.reshoot',
])
export type GenerationOperation = z.infer<typeof GenerationOperation>

/** Node kind an operation applies to; generate applies to all kinds and returns undefined */
export function operationKind(operation: LocalOperation | GenerationOperation): NodeKind | undefined {
  if (operation === 'generate') return undefined
  return NodeKind.parse(operation.slice(0, operation.indexOf('.')))
}

/** A model without declared operations supports only generate (older configs and Ark models) */
export function modelOperations(model: { operations?: readonly GenerationOperation[] | undefined }): readonly GenerationOperation[] {
  return model.operations ?? ['generate']
}

// Times and pixels are integers; the server checks them against the asset duration and size
const Ms = z.int().nonnegative()
const TimeRange = z.strictObject({ startMs: Ms, endMs: Ms.positive() })
  .refine(p => p.endMs > p.startMs, { message: 'endMs must be greater than startMs' })

export const LOCAL_OPERATION_PARAMS = {
  'image.crop': z.strictObject({ x: z.int().nonnegative(), y: z.int().nonnegative(), w: z.int().positive(), h: z.int().positive() }),
  'image.gridSplit': z.strictObject({ rows: z.int().min(2).max(3), cols: z.int().min(2).max(3) }),
  'video.trim': TimeRange,
  'video.frame': z.strictObject({ atMs: Ms }),
  'video.extractAudio': z.strictObject({}),
  // UI-only delivery artifact; never registers a canvas asset or version.
  'video.exportMov': z.strictObject({}),
  'audio.trim': TimeRange,
  'audio.split': z.strictObject({ pointsMs: z.array(Ms.positive()).min(1).max(20) })
    .refine(p => p.pointsMs.every((ms, i) => i === 0 || ms > p.pointsMs[i - 1]!), { message: 'pointsMs must be strictly increasing' }),
  // Pitch-preserving speed change in 0.25 steps; 1x is meaningless
  'audio.speed': z.strictObject({ rate: z.literal([0.5, 0.75, 1.25, 1.5, 1.75, 2]) }),
  // Exports the revision named by expectedRevision; later edits do not conflict
  'timeline.export': z.strictObject({}),
} as const satisfies Record<LocalOperation, z.ZodType>

/** replace: replace the node asset (new version); new_nodes: create nodes whose inputs link to the source node, which stays unchanged */
export const LOCAL_OPERATION_OUTPUT = {
  'image.crop': 'replace',
  'image.gridSplit': 'new_nodes',
  'video.trim': 'replace',
  'video.frame': 'new_nodes',
  'video.extractAudio': 'new_nodes',
  'video.exportMov': 'download',
  'audio.trim': 'replace',
  'audio.split': 'new_nodes',
  'audio.speed': 'replace',
  'timeline.export': 'new_nodes',
} as const satisfies Record<LocalOperation, 'replace' | 'new_nodes' | 'download'>

export const MEDIA_EXPORT_RETENTION_MS = 60 * 60_000

export const MEDIA_MAX_WAIT_MS = 30_000
/** Time limit for one local task; on timeout ffmpeg is stopped and the task fails */
export const MEDIA_TASK_TIMEOUT_MS = 30 * 60_000

// MCP requires tool input to be a top-level object, so no union discriminated by operation; params are validated per operation in a refine
const ProcessParams = z.object({
  requestId: RequestId,
  operation: LocalOperation,
  nodeId: Id,
  slotId: Id,
  // Read before write; checked again when the task writes back, failing with revision_conflict if the node changed meanwhile
  expectedRevision: Revision,
  params: z.record(z.string(), z.unknown()),
  waitMs: z.int().min(0).max(MEDIA_MAX_WAIT_MS).optional(),
}).superRefine((p, ctx) => {
  const parsed = LOCAL_OPERATION_PARAMS[p.operation].safeParse(p.params)
  if (!parsed.success) {
    for (const issue of parsed.error.issues) ctx.addIssue({ code: 'custom', path: ['params', ...issue.path], message: issue.message })
  }
})

export const MediaTaskStatus = z.enum(['queued', 'running', 'succeeded', 'failed'])
export type MediaTaskStatus = z.infer<typeof MediaTaskStatus>

export const MediaTaskView = z.object({
  taskId: Id,
  // Absent for user tasks and legacy events; UI stop confirmation follows session ownership.
  sessionId: Id.optional(),
  status: MediaTaskStatus,
  operation: LocalOperation,
  nodeId: Id,
  slotId: Id,
  createdAt: z.number(),
  // 0–1, from ffmpeg -progress; absent when unavailable
  progress: z.number().min(0).max(1).optional(),
  // succeeded only: newly registered asset versions; new nodes of new_nodes operations, in output order
  assetVersionIds: z.array(Id).optional(),
  nodeIds: z.array(Id).optional(),
  // UI delivery only; the filesystem path is available only through media.exportDownload.
  download: z.object({ filename: z.string(), byteSize: z.int().nonnegative(), expiresAt: z.number() }).optional(),
  // Only for successful user-initiated tasks: the matching undo batch
  operationId: Id.optional(),
  // failed only; media.timeout on timeout, media.interrupted when a restart interrupted it
  error: z.object({ code: z.string(), message: z.string() }).optional(),
})
export type MediaTaskView = z.infer<typeof MediaTaskView>

export const media = {
  process: {
    params: ProcessParams,
    result: MediaTaskView,
  },
  get: {
    params: z.object({ taskId: Id, waitMs: z.int().min(0).max(MEDIA_MAX_WAIT_MS).optional() }),
    result: MediaTaskView,
  },
  cancel: { params: z.strictObject({ taskId: Id }), result: MediaTaskView },
  dismiss: { params: z.strictObject({ taskId: Id }), result: MediaTaskView },
  exportDownload: {
    params: z.strictObject({ taskId: Id }),
    result: z.object({ path: z.string(), filename: z.string(), mime: z.literal('video/quicktime'), byteSize: z.int().nonnegative() }),
  },
  analyze: {
    params: z.object({
      operation: z.literal('audio.silence'),
      nodeId: Id,
      slotId: Id,
      params: z.strictObject({
        minSilenceMs: z.int().min(100).max(5000).optional(),
        thresholdDb: z.number().min(-90).max(-10).optional(),
      }).optional(),
    }),
    // pointsMs: midpoint of each silence, ascending, as candidate split points
    result: z.object({ durationMs: z.int().nonnegative(), pointsMs: z.array(z.int().nonnegative()) }),
  },
  // 0024b: cached waveform peaks, filmstrips, video posters and image thumbnails; asset versions are immutable, so results never change
  preview: {
    params: z.object({ assetVersionId: Id, kind: z.enum(['peaks', 'filmstrip', 'poster', 'thumbnail']) }),
    result: z.discriminatedUnion('kind', [
      // peaks are 0–1, at most 90000; binsPerSecond is the actual density and may be below the requested 50
      z.object({ kind: z.literal('peaks'), durationMs: z.number().nonnegative(), binsPerSecond: z.number().positive(), peaks: z.array(z.number().min(0).max(1)) }),
      // One frame at 0.001 seconds, fit within 960 x 960 without upscaling. The web host alone uses path.
      z.object({ kind: z.literal('poster'), width: z.int().positive().max(960), height: z.int().positive().max(960), path: z.string().optional() }),
      // Image-only preview using the same size bound and local cache as video posters.
      z.object({ kind: z.literal('thumbnail'), width: z.int().positive().max(960), height: z.int().positive().max(960), path: z.string().optional() }),
      // One horizontal JPEG strip of `frames` frames, `intervalMs` apart. Like asset.get, `path` is for the web host's
      // preview route; the browser loads the strip from that route, never from the path
      z.object({ kind: z.literal('filmstrip'), durationMs: z.number().nonnegative(), frameWidth: z.int().positive(), frameHeight: z.int().positive(), intervalMs: z.number().positive(), frames: z.int().positive(), path: z.string().optional() }),
    ]),
  },
} as const
export type MediaPreview = z.infer<typeof media.preview.result>

// Reference markers in prompts (0021 §8): store node IDs; numbers are computed from the current input order when shown and submitted
export const PROMPT_REF_PATTERN = /\{\{ref:([^{}\s]{1,64})\}\}/g
/** Number unique media nodes with assets, excluding text and empty inputs. */
export function numberReferences(inputs: readonly { nodeId: string; kind: string; hasAsset: boolean }[]): { nodeId: string; kind: MediaKind; number: number }[] {
  const seen = new Set<string>()
  const references: { nodeId: string; kind: MediaKind; number: number }[] = []
  for (const input of inputs) {
    if (!input.hasAsset || !MediaKind.options.includes(input.kind as MediaKind) || seen.has(input.nodeId)) continue
    seen.add(input.nodeId)
    references.push({ nodeId: input.nodeId, kind: input.kind as MediaKind, number: references.length + 1 })
  }
  return references
}
export function promptRef(nodeId: string): string {
  return `{{ref:${nodeId}}}`
}
/** Node IDs referenced in a prompt, in order of appearance, deduplicated */
export function promptRefs(prompt: string): string[] {
  return [...new Set(Array.from(prompt.matchAll(PROMPT_REF_PATTERN), match => match[1]!))]
}
