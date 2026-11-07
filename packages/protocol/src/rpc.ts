import { z } from 'zod'
import { Id, MediaKind, Revision } from './common'
import { WorkMessageView, WorkStatus } from './work'

// JSON-RPC error.data.code; see RFC 0003 "Error codes".
export const ErrorCode = z.enum([
  'invalid_params',
  'not_found',
  'forbidden',
  'revision_conflict',
  'idempotency_conflict',
  'request_not_replayable',
  'busy',
  'unavailable',
  'provider_error',
  'job_terminal',
  'quota_exceeded',
  'invalid_transition',
  'already_resolved',
])
export type ErrorCode = z.infer<typeof ErrorCode>

export const RevisionConflict = z.object({
  slotId: Id,
  expectedRevision: Revision,
  currentRevision: Revision,
})
export type RevisionConflict = z.infer<typeof RevisionConflict>

export const ErrorData = z.object({
  code: ErrorCode,
  conflicts: z.array(RevisionConflict).optional(),
  // Work item revision conflict; slot conflicts still use conflicts.
  expectedRevision: Revision.optional(),
  currentRevision: Revision.optional(),
  kind: MediaKind.optional(),
  count: z.int().nonnegative().optional(),
  limit: z.int().nonnegative().optional(),
  // invalid_transition: current status and unfinished child work items
  status: WorkStatus.optional(),
  incompleteChildren: z.array(Id).optional(),
  // already_resolved: the first reply or recall that resolved this message
  resolution: WorkMessageView.optional(),
  // 0018: the UI translates errors into the current language using this; falls back to message when reason is absent.
  reason: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/).optional(),
  params: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
})
export type ErrorData = z.infer<typeof ErrorData>

// All business errors map to this single JSON-RPC error code; see data.code for the specific cause.
export const RPC_APPLICATION_ERROR = -32000

export type RpcRequest = { jsonrpc: '2.0'; id: string | number; method: string; params?: unknown }
export type RpcNotification = { jsonrpc: '2.0'; method: string; params?: unknown }
export type RpcSuccess = { jsonrpc: '2.0'; id: string | number; result: unknown }
export type RpcFailure = {
  jsonrpc: '2.0'
  id: string | number | null
  error: { code: number; message: string; data?: ErrorData }
}
export type RpcResponse = RpcSuccess | RpcFailure
