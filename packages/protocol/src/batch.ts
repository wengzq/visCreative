import { z } from 'zod'
import { Id, RequestId, Revision } from './common'
import { ShotRole } from './script'

// 0023 step 4b-2: first/last frames and script batches. Batches run on the server; Agent-started batches wait for the
// user's approval, enforced by the gateway.

/** Frame inputs a video model accepts; a model without any declares none and generates from the prompt only */
export const FrameMode = z.enum(['first', 'first_last'])
export type FrameMode = z.infer<typeof FrameMode>

/** A slot pinned as a video frame; revision defaults to the slot's current one at submission */
export const FrameRef = z.object({ slotId: Id, revision: Revision.optional() })
export const GenerationFrames = z.strictObject({ first: FrameRef, last: FrameRef.optional() })
export type GenerationFrames = z.infer<typeof GenerationFrames>

export const BatchMedia = z.enum(['frames', 'video'])
export type BatchMedia = z.infer<typeof BatchMedia>
export const BatchStatus = z.enum(['pending_approval', 'running', 'paused', 'succeeded', 'failed', 'cancelled', 'rejected', 'expired'])
export type BatchStatus = z.infer<typeof BatchStatus>
export const BatchStepStatus = z.enum(['waiting', 'queued', 'running', 'succeeded', 'failed', 'skipped', 'cancelled'])
export type BatchStepStatus = z.infer<typeof BatchStepStatus>

export const BatchStep = z.object({
  role: ShotRole,
  status: BatchStepStatus,
  // How a first frame is obtained: generated, or extracted from the previous shot's video (strict continuity)
  source: z.enum(['generate', 'extract', 'panel']).optional(),
  nodeId: Id.optional(),
  jobId: Id.optional(),
  mediaTaskId: Id.optional(),
  /** waiting_previous: depends on the previous shot of the chain; quota: stopped by the daily limit */
  blockedBy: z.enum(['waiting_previous', 'quota']).optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
})
export type BatchStep = z.infer<typeof BatchStep>

export const BatchEstimate = z.object({
  shots: z.int().nonnegative(),
  /** Generation jobs the batch will submit (frame extraction is local and not counted) */
  jobs: z.int().nonnegative(),
  /** Jobs on a paid provider */
  billedJobs: z.int().nonnegative(),
  provider: z.string(),
  model: z.string(),
  /** Remaining jobs today for this media kind; null when unlimited */
  quotaRemaining: z.int().nonnegative().nullable(),
  /** Frame mode actually used for video; fallback when the model lacks first_last or any frame mode */
  frameMode: FrameMode.nullable().optional(),
  // Warnings shown in the confirmation and the approval card; never blocking
  staleShots: z.int().nonnegative(),
  shotsMissingAssetImages: z.int().nonnegative(),
  shotsMissingFirstFrame: z.int().nonnegative(),
  shotsWithoutPrompt: z.int().nonnegative(),
  // 0027: style samples omitted to preserve cast and continuity references at the model limit.
  styleRefsDropped: z.int().nonnegative().optional(),
  castRefsDropped: z.int().nonnegative().optional(),
  compositionRefsUsed: z.int().nonnegative().optional(),
  compositionRefsDropped: z.array(z.object({
    previzNodeId: Id, panelId: Id, panelNumber: z.int().positive(), shotId: Id, reason: z.enum(['unsupported', 'limit']),
  })).optional(),
  panelFramesUsed: z.int().nonnegative().optional(),
})
export type BatchEstimate = z.infer<typeof BatchEstimate>

export const BatchView = z.object({
  batchId: Id,
  scriptNodeId: Id,
  status: BatchStatus,
  origin: z.enum(['user', 'agent']),
  /** The Agent session that requested it */
  sessionId: Id.optional(),
  media: BatchMedia,
  createdAt: z.number(),
  /** Pending only: shots edited after the request, highlighted in the approval card */
  changedShotIds: z.array(Id).optional(),
  pausedReason: z.literal('quota').optional(),
  estimate: BatchEstimate,
  shots: z.array(z.object({ shotId: Id, steps: z.array(BatchStep) })),
})
export type BatchView = z.infer<typeof BatchView>

export const BATCH_APPROVAL_TTL_MS = 24 * 60 * 60_000
export const BATCH_MAX_WAIT_MS = 30_000

const PlanParams = {
  scriptNodeId: Id,
  media: BatchMedia,
  /** Absent means every shot */
  shotIds: z.array(Id).min(1).max(200).optional(),
  /** Video only: continuous shots whose first frame is extracted from the previous shot's finished video */
  strictShotIds: z.array(Id).max(200).optional(),
  /** Video only: shots without a first frame get one generated first ('generate', default) or are skipped */
  missingFirstFrames: z.enum(['generate', 'skip']).optional(),
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
}

export const scriptBatch = {
  // Dry run for the confirmation dialog: nothing is created or submitted
  plan: { params: z.object(PlanParams), result: BatchView.omit({ batchId: true, status: true, origin: true, createdAt: true }) },
  start: { params: z.object({ requestId: RequestId, ...PlanParams }), result: BatchView },
  get: { params: z.object({ batchId: Id, waitMs: z.int().min(0).max(BATCH_MAX_WAIT_MS).optional() }), result: BatchView },
  list: { params: z.object({ scriptNodeId: Id.optional(), activeOnly: z.boolean().optional() }), result: z.object({ batches: z.array(BatchView) }) },
  approve: { params: z.object({ requestId: RequestId, batchId: Id }), result: BatchView },
  reject: { params: z.object({ requestId: RequestId, batchId: Id }), result: BatchView },
  cancel: { params: z.object({ requestId: RequestId, batchId: Id }), result: BatchView },
  // A batch paused by the daily limit continues from its current step
  resume: { params: z.object({ requestId: RequestId, batchId: Id }), result: BatchView },
} as const

