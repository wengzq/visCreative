import { z } from 'zod'
import type { FrameMode, GenerationOperation, MediaKind, ProviderConfig, ReferenceInputs, SceneDoc } from '@vis/protocol'

export const MAX_PRESIGN_SECONDS = 7 * 24 * 60 * 60

/**
 * url() key = `${idempotencyKey}:${ordinal}`; release() takes the bare idempotencyKey.
 * The host splits at the last colon and hashes only the bare key to keep every input under one job.
 */
export type HostedInputs = {
  /** Upload (or re-upload) a pinned local file. Hosting failures expose details.reason; invalid lifetimes are internal errors. */
  url(input: { path: string; mime: string; key: string }, ttlSeconds: number, signal?: AbortSignal): Promise<string>
  /** Delete everything uploaded under this key. Idempotent. */
  release(key: string): Promise<void>
  /** Removes the access key id, signatures and presigned URLs the host knows of. */
  redact(text: string): string
  readonly configured: boolean
}

export type ProviderInput =
  | { type: 'asset'; kind: MediaKind; mime: string; path: string; durationMs?: number; width?: number; height?: number; fps?: number; bytes?: number }
  | { type: 'text'; text: string }
  | { type: 'scene'; doc: SceneDoc; models: { assetVersionId: string; mime: string; path: string }[] }

export type ProviderInputMetadata = { kind: MediaKind; mime: string; durationMs?: number; width?: number; height?: number; fps?: number; bytes?: number; frameRole?: 'first' | 'last' }

export type ProviderRequest = {
  operation: GenerationOperation
  kind: MediaKind
  model: string
  prompt: string
  params: Record<string, unknown>
  inputs: ProviderInput[]
  frames?: { first: ProviderInput; last?: ProviderInput }
}

export type ProviderOutputRef = { outputIndex: number; ref: string }

export type ProviderTaskState =
  | { state: 'pending' | 'running'; progress?: number }
  | { state: 'cancelled' }
  | {
    state: 'succeeded'
    outputs: ProviderOutputRef[]
    /** Only from a vendor field documented as the prompt actually used. */
    revisedPrompt?: string
  }
  | { state: 'failed'; error: { code: string; message: string; data?: { reason: string; params?: Record<string, string | number> } } }

export type DownloadedOutput = {
  data: Uint8Array
  mime: string
  width?: number
  height?: number
  durationMs?: number
  fps?: number
  hasAlpha?: boolean
}

export function paramsSchemaOf(adapter: ProviderAdapter, kind: MediaKind, model: string): z.ZodType<Record<string, unknown>> {
  return adapter.paramsSchemaFor?.(kind, model) ?? adapter.paramsSchemas?.[kind] ?? adapter.paramsSchema
}

export type OperationSpec = {
  paramsSchema: z.ZodType<Record<string, unknown>>
  prompt: 'none' | 'optional' | 'required'
}

const emptyOperationSpec: OperationSpec = { paramsSchema: z.strictObject({}), prompt: 'none' }

export function operationSpecOf(adapter: ProviderAdapter, kind: MediaKind, model: string, operation: GenerationOperation): OperationSpec {
  if (operation === 'generate') return { paramsSchema: paramsSchemaOf(adapter, kind, model), prompt: 'required' }
  return adapter.operationSpecFor?.(kind, model, operation) ?? emptyOperationSpec
}

/** timeout means unknown result; transient means no effect and retryable; rejected means retries are futile; not_found means the job is missing. */
export class ProviderError extends Error {
  constructor(
    readonly kind: 'timeout' | 'transient' | 'rejected' | 'not_found',
    message: string,
    readonly reason?: string,
    readonly params?: Record<string, string | number>,
  ) {
    super(message)
    this.name = 'ProviderError'
  }
}

export interface ProviderAdapter {
  readonly id: string
  readonly type?: string
  /** Provider-recommended interval for pending/running tasks; retry backoff stays separate. */
  readonly pollIntervalMs?: number
  readonly kinds: readonly MediaKind[]
  readonly models: readonly string[]
  /** Default models by media type; used when submit omits model */
  readonly defaultModels: Partial<Record<MediaKind, string>>
  /** Non-secret configuration only, pinned on submission to restore the corresponding service after restart. */
  readonly configuration?: ProviderConfig['providers'][number]
  /** Validate input capabilities after pinning input revisions and before reserving paid quota. */
  validateInputs?(kind: MediaKind, model: string, inputs: ProviderInputMetadata[], params: Record<string, unknown>, operation: GenerationOperation): void
  operationsFor?(kind: MediaKind, model: string): readonly GenerationOperation[]
  operationSpecFor?(kind: MediaKind, model: string, operation: GenerationOperation): OperationSpec | undefined
  frameModesFor?(kind: MediaKind, model: string): readonly FrameMode[]
  referenceLimitsFor?(kind: MediaKind, model: string): ReferenceInputs | undefined
  referenceImageLimitFor?(kind: MediaKind, model: string): number
  /** Vendor prompt syntax for a numbered reference; absent keeps the legacy label. */
  referenceLabelFor?(kind: MediaKind, model: string, reference: { kind: MediaKind; number: number }): string | undefined
  prepareRequest?(request: ProviderRequest): ProviderRequest
  readonly paramsSchemas?: Partial<Record<MediaKind, z.ZodType<Record<string, unknown>>>>
  readonly paramsSchema: z.ZodType<Record<string, unknown>>
  /** Optional model-specific parameter constraints; otherwise use paramsSchemas by media type, then fall back to paramsSchema */
  paramsSchemaFor?(kind: MediaKind, model: string): z.ZodType<Record<string, unknown>>
  /** One key per Attempt; identical keys must return the same external job. */
  submit(req: ProviderRequest, opts: { idempotencyKey: string; signal?: AbortSignal }): Promise<{ externalTaskId: string }>
  getTask(externalTaskId: string, opts?: { signal?: AbortSignal }): Promise<ProviderTaskState>
  /** Optional capability: recover jobs by key after lost submission responses. */
  findTaskByIdempotencyKey?(idempotencyKey: string): Promise<{ externalTaskId: string } | null>
  /** Return true only when the provider confirms the job stopped; stopping local waits is not successful cancellation. */
  cancel?(externalTaskId: string, opts?: { signal?: AbortSignal }): Promise<{ cancelled: boolean }>
  download(output: ProviderOutputRef, opts?: { signal?: AbortSignal }): Promise<DownloadedOutput>
  /** Called after durable terminal settlement; retain recovery state needed to recheck unknown jobs. */
  cleanup?(options: { idempotencyKey: string; status: 'succeeded' | 'failed' | 'cancelled' | 'unknown' }): Promise<void>
}

export function referenceImageLimit(adapter: ProviderAdapter, kind: MediaKind, model: string): number {
  return adapter.referenceLimitsFor?.(kind, model)?.image ?? adapter.referenceImageLimitFor?.(kind, model) ?? Infinity
}
