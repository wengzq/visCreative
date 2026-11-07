import { z } from 'zod'
import { GenerationLimits } from './providers'
import { Id, MediaKind, RequestId, Revision } from './common'
import { GenerationOperation } from './operations'
import { GenerationFrames } from './batch'

export const JobStatus = z.enum(['queued', 'running', 'finalizing', 'succeeded', 'failed', 'unknown', 'cancelled'])
export type JobStatus = z.infer<typeof JobStatus>

// no_output: the Job has ended; this position has no output and will receive no delivery.
export const BindingStatus = z.enum(['pending', 'delivered', 'conflict', 'target_missing', 'no_output'])
export type BindingStatus = z.infer<typeof BindingStatus>

const SlotTarget = z.object({
  outputIndex: z.int().nonnegative(),
  kind: z.literal('slot'),
  slotId: Id,
  expectedRevision: Revision.optional(),
})
const NewNodeTarget = z.object({
  outputIndex: z.int().nonnegative(),
  kind: z.literal('new_node'),
  nearNodeId: Id.optional(),
})
export const GenerationTarget = z.discriminatedUnion('kind', [SlotTarget, NewNodeTarget])
export type GenerationTarget = z.infer<typeof GenerationTarget>

// Binding targets after the server fills in defaults
export const ResolvedTarget = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('slot'), nodeId: Id, slotId: Id, expectedRevision: Revision }),
  z.object({ kind: z.literal('new_node'), nearNodeId: Id.optional() }),
])
export type ResolvedTarget = z.infer<typeof ResolvedTarget>

export const JobOutput = z.object({
  outputIndex: z.int().nonnegative(),
  assetVersionId: Id,
  mime: z.string(),
  delivery: z.object({
    status: BindingStatus,
    nodeId: Id.optional(),
    slotId: Id.optional(),
  }),
})
export type JobOutput = z.infer<typeof JobOutput>

// Delivery destination for each output: an existing slot or a new node (near nearNodeId; has nodeId after delivery).
export const JobTarget = z.object({
  outputIndex: z.int().nonnegative(),
  kind: z.enum(['slot', 'new_node']),
  status: BindingStatus,
  nodeId: Id.optional(),
  slotId: Id.optional(),
  nearNodeId: Id.optional(),
})
export type JobTarget = z.infer<typeof JobTarget>

export const JobView = z.object({
  jobId: Id,
  status: JobStatus,
  spaceId: Id.optional(),
  spaceName: z.string().optional(),
  kind: MediaKind.optional(),
  // 0021: defaults to generate
  operation: GenerationOperation.optional(),
  createdAt: z.number().optional(),
  cancelRequestedAt: z.number().optional(),
  providerCancelled: z.boolean().optional(),
  queueReason: z.literal('concurrency_limit').optional(),
  outputs: z.array(JobOutput),
  /** All delivery targets by outputIndex; the UI uses these to show running and failed states on nodes. */
  targets: z.array(JobTarget),
  /** Result unknown but an external job ID is available: generation.recheck can continue querying without resubmission or additional charges. */
  recheckable: z.boolean().optional(),
  /** Positions without output after the Job ends (Provider returned fewer outputs than requested). */
  missingOutputIndexes: z.array(z.int().nonnegative()).optional(),
  error: z.object({
    code: z.string(), message: z.string(),
    data: z.object({ reason: z.string().optional(), params: z.record(z.string(), z.union([z.string(), z.number()])).optional() }).optional(),
  }).optional(),
})
export type JobView = z.infer<typeof JobView>

export const GENERATION_MAX_WAIT_MS = 30_000
export const GenerationInput = z.union([
  z.strictObject({ slotId: Id, revision: Revision.optional() }),
  z.strictObject({ assetVersionId: Id }),
])
export type GenerationInput = z.infer<typeof GenerationInput>

export const generation = {
  submit: {
    params: z
      .object({
        requestId: RequestId,
        kind: MediaKind,
        provider: z.string().min(1).optional(),
        model: z.string().min(1).optional(),
        // 0021: defaults to generate; other operations process the first input and may omit the prompt
        operation: GenerationOperation.optional(),
        prompt: z.string().default(''),
        params: z.record(z.string(), z.unknown()).optional(),
        inputs: z.array(GenerationInput).optional(),
        targets: z.array(GenerationTarget).optional(),
        // 0023: first / last frame for video; the provider maps them to its own parameters
        frames: GenerationFrames.optional(),
      })
      .refine(p => new Set(p.targets?.map(t => t.outputIndex)).size === (p.targets?.length ?? 0), {
        message: 'Each outputIndex can have only one target',
      })
      .refine(p => !p.frames || p.kind === 'video', {
        message: 'Frames are only accepted for video', path: ['frames'],
      })
      .refine(p => (p.operation ?? 'generate') !== 'generate' || p.prompt.length > 0, {
        message: 'The generate operation requires a prompt', path: ['prompt'],
      })
      .refine(p => (p.operation ?? 'generate') === 'generate' || (p.inputs?.length ?? 0) > 0, {
        message: 'This operation requires at least one input', path: ['inputs'],
      }),
    result: z.object({
      jobId: Id,
      status: z.literal('queued'),
      bindings: z.array(z.object({ bindingId: Id, outputIndex: z.int().nonnegative(), target: ResolvedTarget })),
    }),
  },
  cancel: {
    params: z.object({ requestId: RequestId, jobId: Id }),
    result: JobView,
  },
  recheck: {
    params: z.object({ requestId: RequestId, jobId: Id }),
    result: JobView,
  },
  regenerate: {
    params: z.object({ requestId: RequestId, jobId: Id }),
    result: z.object({ jobId: Id, status: z.literal('queued'), bindings: z.array(z.object({ bindingId: Id, outputIndex: z.int().nonnegative(), target: ResolvedTarget })) }),
  },
  usage: {
    params: z.object({}),
    result: z.object({ date: z.string(), image: z.int().nonnegative(), video: z.int().nonnegative(), audio: z.int().nonnegative(), // Count only paid jobs submitted by Agents, compared against limits.
      agent: z.object({ image: z.int().nonnegative(), video: z.int().nonnegative(), audio: z.int().nonnegative() }), limits: GenerationLimits, jobs: z.array(JobView), deletedProjectJobs: z.int().nonnegative().optional() }),
  },
  get: {
    params: z.object({ jobId: Id, waitMs: z.int().min(0).max(GENERATION_MAX_WAIT_MS).optional() }),
    result: JobView,
  },
} as const
