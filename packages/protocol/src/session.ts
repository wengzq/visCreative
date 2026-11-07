import { z } from 'zod'
import { Id, RequestId, Revision } from './common'

export const DeliveryState = z.enum(['draft', 'submitted', 'delivered', 'unknown', 'rejected', 'withdrawn'])
export type DeliveryState = z.infer<typeof DeliveryState>

export const TurnStatus = z.enum(['running', 'waiting_user', 'completed', 'failed', 'interrupted'])
export type TurnStatus = z.infer<typeof TurnStatus>

// Reference canvas nodes (0001) or assets imported outside the canvas (0015); legacy messages only reference nodes.
export const NodeMessageRef = z
  .object({
    nodeId: Id,
    slotId: Id.optional(),
    versionPolicy: z.enum(['latest-at-execution', 'pinned']),
    pinnedRevision: Revision.optional(),
  })
  .refine(r => (r.versionPolicy === 'pinned') === (r.pinnedRevision !== undefined), {
    message: 'pinnedRevision is required if and only if versionPolicy is pinned',
  })
export const AssetMessageRef = z.object({ assetVersionId: Id })
export const MessageRef = z.union([NodeMessageRef, AssetMessageRef])
export type MessageRef = z.infer<typeof MessageRef>

// Agent used by the session; immutable after creation (0005).
export const AgentKind = z.string().regex(/^[a-z][a-z0-9-]*$/)
export type AgentKind = z.infer<typeof AgentKind>
export const DEFAULT_AGENT_KIND: AgentKind = 'codex'

export const TitleSource = z.enum(['default', 'user', 'agent'])
export type TitleSource = z.infer<typeof TitleSource>

// 0023: generation_batch is answered with script.batch.approve / reject, not session.respondApproval
export const ApprovalKind = z.enum(['command', 'file_write', 'network', 'other', 'generation_batch', 'text_delete', 'work_delete'])
export type ApprovalKind = z.infer<typeof ApprovalKind>
export const ApprovalDecision = z.enum(['allow_once', 'allow_session', 'deny'])
export type ApprovalDecision = z.infer<typeof ApprovalDecision>
export const ApprovalStatus = z.enum(['pending', 'approved', 'denied', 'expired'])
export type ApprovalStatus = z.infer<typeof ApprovalStatus>
export const ApprovalPayload = z.object({
  approvalId: Id,
  kind: ApprovalKind,
  summary: z.string(),
  detail: z.string(),
  cwd: z.string().optional(),
  mcpTool: z.object({ serverName: z.literal('vis'), toolName: z.string().min(1) }).optional(),
  status: ApprovalStatus,
  decision: ApprovalDecision.optional(),
  // 0015: allowed by automatic approval rather than a user click.
  auto: z.boolean().optional(),
  // 0023: the batch a generation_batch approval is about
  batchId: Id.optional(),
  // 0031: a one-node deletion authorized only by a revision-pinned user approval.
  textDelete: z.object({ nodeId: Id, slotId: Id, revision: Revision, title: z.string(), expiresAt: z.int() }).optional(),
  workDelete: z.object({
    items: z.array(z.object({ workItemId: Id, title: z.string() })).min(1).max(20),
    runningTurns: z.int().nonnegative(),
    unfinishedJobs: z.int().nonnegative(),
    childrenTotal: z.int().nonnegative(),
    unresolvedMessages: z.int().nonnegative(),
    hasUnreviewedReport: z.boolean(),
    expiresAt: z.int(),
  }).optional(),
})
export type ApprovalPayload = z.infer<typeof ApprovalPayload>

export const ApprovalMode = z.enum(['ask', 'auto'])
export type ApprovalMode = z.infer<typeof ApprovalMode>

export const SessionSummary = z.object({
  sessionId: Id,
  agentKind: AgentKind,
  title: z.string(),
  workDir: z.string(),
  // Owning work item and role (0009)
  workItemId: Id.nullable(),
  titleSource: TitleSource,
  queuePaused: z.boolean(),
  activeTurnId: Id.nullable(),
  // 0035: in-memory silence notice; old events and idempotent results predate the watchdog.
  silentSince: z.int().nullable().default(null),
  pendingApprovals: z.int().nonnegative(),
  // 0014: session-level model and reasoning effort; null uses Agent defaults, effective next turn.
  // Pre-upgrade idempotent results and events lack this field; fill defaults during parsing without rewriting old records.
  // serviceTier (speed tier) was added later: old records lack it and likewise receive null.
  agentConfig: z.object({ model: z.string().nullable(), effort: z.string().nullable(), serviceTier: z.string().nullable().default(null) }).default({ model: null, effort: null, serviceTier: null }),
  // 0015: defaults to ask; auto only automatically approves command / file_write inside the working directory and project directory.
  approvalMode: ApprovalMode.optional(),
  // 0015: queued (draft) message count, allowing "N waiting to send" after refresh; legacy events lack this field and default to 0.
  queuedMessageCount: z.int().nonnegative().optional(),
  createdAt: z.int(),
})
export type SessionSummary = z.infer<typeof SessionSummary>

// Transcript reads include the persisted delivery state so a refreshed page does not infer queued/sent from missing live events.
export const UserMessagePayload = z.object({
  messageId: Id, text: z.string(), refs: z.array(MessageRef), skills: z.array(z.string()).optional(), deliveryState: DeliveryState.optional(),
  // Work deliveries have viewable references but are never user-reorderable drafts.
  workDeliveryId: Id.optional(),
})
export type UserMessagePayload = z.infer<typeof UserMessagePayload>

export const TranscriptItem = z.object({
  itemId: Id,
  createdSeq: z.int(),
  revision: Revision,
  turnId: Id.nullable(),
  kind: z.enum(['user', 'assistant_text', 'reasoning', 'plan', 'tool_call', 'tool_result', 'notice', 'approval']),
  payload: z.unknown(),
  createdAt: z.int(),
  updatedAt: z.int(),
})
export type TranscriptItem = z.infer<typeof TranscriptItem>

// 0013: payloads for reasoning and plan entries; the UI infers reasoning completion and duration from subsequent entries and turn state.
export const ReasoningPayload = z.object({ text: z.string() })
export type ReasoningPayload = z.infer<typeof ReasoningPayload>

export const PlanStatus = z.enum(['pending', 'in_progress', 'completed'])
export const PlanPayload = z.object({
  entries: z.array(z.object({ text: z.string(), status: PlanStatus })),
  explanation: z.string().optional(),
})
export type PlanPayload = z.infer<typeof PlanPayload>

// 0014: Agent-declared model and reasoning effort options; Codex uses model/list, dsh uses ACP configOptions.
export const AgentModelOption = z.object({
  id: z.string().min(1),
  label: z.string(),
  description: z.string().optional(),
  isDefault: z.boolean(),
  efforts: z.array(z.object({ id: z.string().min(1), label: z.string(), description: z.string().optional() })),
  defaultEffort: z.string().nullable(),
  // Speed tiers (e.g. Codex fast), excluding standard speed; empty if the Agent supplies none, so the UI hides speed options.
  serviceTiers: z.array(z.object({ id: z.string().min(1), label: z.string(), description: z.string().optional() })).default([]),
})
export type AgentModelOption = z.infer<typeof AgentModelOption>

export const session = {
  create: {
    params: z.object({ requestId: RequestId, title: z.string().trim().max(200).optional(), agentKind: AgentKind.optional(), workDir: z.string().min(1).optional() }),
    result: SessionSummary,
  },
  list: {
    params: z.object({ includeArchived: z.boolean().optional() }),
    result: z.object({ sessions: z.array(SessionSummary) }),
  },
  agentOptions: {
    params: z.object({ sessionId: Id }),
    result: z.object({ models: z.array(AgentModelOption) }),
  },
  setAgentConfig: {
    params: z.object({ requestId: RequestId, sessionId: Id, model: z.string().min(1).nullable(), effort: z.string().min(1).nullable(), serviceTier: z.string().min(1).nullable() }),
    result: SessionSummary,
  },
  setApprovalMode: {
    params: z.object({ requestId: RequestId, sessionId: Id, mode: ApprovalMode }),
    result: SessionSummary,
  },
  rename: {
    params: z.object({ requestId: RequestId, sessionId: Id, title: z.string().trim().min(1).max(60) }),
    result: SessionSummary,
  },
  resetTitle: {
    params: z.object({ requestId: RequestId, sessionId: Id }),
    result: SessionSummary,
  },
  setTitle: {
    params: z.strictObject({ requestId: RequestId, title: z.string().trim().min(1).max(24) }),
    result: z.discriminatedUnion('applied', [
      z.object({ applied: z.literal(true), title: z.string() }),
      z.object({ applied: z.literal(false), reason: z.literal('user_named'), title: z.string() }),
    ]),
  },
  sendMessage: {
    params: z.object({
      requestId: RequestId,
      sessionId: Id,
      text: z.string().min(1),
      refs: z.array(MessageRef),
      skills: z.array(z.string().min(1)).optional(),
    }),
    result: z.object({
      messageId: Id,
      deliveryState: z.enum(['draft', 'submitted']),
      queuePosition: z.int().nonnegative().optional(),
    }),
  },
  stop: {
    params: z.object({ requestId: RequestId, sessionId: Id, turnId: Id }),
    // Accepting a stop request does not mean stopping is complete; turn.stateChanged events confirm the actual result.
    result: z.object({ accepted: z.literal(true) }),
  },
  sendNow: {
    params: z.strictObject({ requestId: RequestId, sessionId: Id, messageId: Id }),
    // Queue promotion and stop intent are accepted together; turn events confirm interruption.
    result: z.object({ accepted: z.literal(true) }),
  },
  respondApproval: {
    params: z.strictObject({ requestId: RequestId, approvalId: Id, decision: ApprovalDecision }),
    result: z.object({ status: z.enum(['approved', 'denied', 'expired']) }),
  },
  resumeQueue: {
    params: z.object({ requestId: RequestId, sessionId: Id }),
    result: z.object({ queuePaused: z.literal(false) }),
  },
  clearQueue: {
    params: z.object({ requestId: RequestId, sessionId: Id }),
    // Withdraw only user-queued messages; retain work item report batches in the queue to prevent report loss.
    result: z.object({ withdrawnMessageIds: z.array(Id) }),
  },
  retryMessage: {
    params: z.object({ requestId: RequestId, messageId: Id }),
    result: z.object({ messageId: Id, withdrawnMessageId: Id, deliveryState: z.enum(['draft', 'submitted']) }),
  },
  getTranscript: {
    params: z.object({ sessionId: Id, beforeSeq: z.int().optional(), limit: z.int().min(1).max(500).optional() }),
    result: z.object({ items: z.array(TranscriptItem), hasMore: z.boolean() }),
  },
} as const
