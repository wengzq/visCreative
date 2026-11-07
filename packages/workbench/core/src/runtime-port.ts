// Contract between SessionService and AgentRuntime. SessionService stores intent and decides when to deliver;
// AgentRuntime manages runtime instances and native protocols, reporting runtime events to SessionService.
import type { AgentKind, AgentModelOption, ApprovalDecision, ApprovalKind, SkillView, TitleSource, TranscriptItem, TransientEvent } from '@vis/protocol'

export type ApprovalRequest = {
  sessionId: string
  turnId: string
  kind: ApprovalKind
  summary: string
  detail: string
  cwd?: string
  /** Complete target paths from native file-change metadata; writes cannot be auto-approved when absent. */
  paths?: string[]
  /** The request includes additional permissions that cannot be assessed from cwd or target paths alone. */
  autoApprovalBlocked?: boolean
  mcpTool?: { serverName: 'vis'; toolName: string }
}
export type RequestApproval = (request: ApprovalRequest) => Promise<ApprovalDecision>

/** Reference targets and fixed inputs for this turn, used by adapters to assemble turn context */
export type TurnRef = { nodeId: string; slotId: string; revision: number | null }

export type DispatchInput = {
  sessionId: string
  sessionTitle: string
  titleSource: TitleSource
  turnId: string
  text: string
  inputSnapshotId: string
  refs: TurnRef[]
  resumeId: string | null
  projectContext?: { rootPath: string; assetsPath: string; skillsPath: string; workDir: string; skills: SkillView[] }
  workContext?: { workItemId: string; parentId: string | null; hasChildren: boolean }
  agentConfig?: { model: string | null; effort: string | null; serviceTier: string | null }
  skills?: string[]
}

/**
 * Delivery failure classification (0001 "A Timeout Does Not Mean It Was Not Received"):
 * - rejected: provably not received by the Agent
 * - unknown: may have been received; must not resend automatically
 */
export class DispatchError extends Error {
  constructor(readonly kind: 'rejected' | 'unknown', message: string) {
    super(message)
    this.name = 'DispatchError'
  }
}

export interface AgentRuntimePort {
  agentOptions?(agentKind: AgentKind, options: { model?: string }): Promise<AgentModelOption[]>
  /** Ensure the session has a ready runtime instance; throw on failure (the message has not yet reached the Agent) */
  ensureReady(sessionId: string): Promise<void>
  /** Hand the turn to the Agent. Resolution means acceptance; failure throws DispatchError */
  dispatchTurn(input: DispatchInput): Promise<void>
  /** Request turn interruption. Resolution only means the request was sent; turn_ended determines actual completion */
  interruptTurn(input: { sessionId: string; turnId: string }): Promise<void>
  /** Fence and hard-kill this turn's process tree, including a turn still starting. Never wait for Agent cooperation. */
  terminateTurn(input: { sessionId: string; turnId: string }): Promise<void>
}

export type TranscriptItemKind = TranscriptItem['kind']

/** Events reported by AgentRuntime to SessionService */
export type AgentEvent =
  | { type: 'resume_id'; sessionId: string; resumeId: string }
  | { type: 'leaf'; sessionId: string; leafUuid: string }
  | { type: 'item'; sessionId: string; turnId: string | null; itemId: string; revision: number; kind: Exclude<TranscriptItemKind, 'user' | 'approval'>; payload: unknown }
  | { type: 'turn_waiting'; sessionId: string; turnId: string; waiting: boolean }
  | { type: 'turn_ended'; sessionId: string; turnId: string; status: 'completed' | 'failed' | 'interrupted' }
  | { type: 'context_compacted'; sessionId: string }

/**
 * Streaming text fragments (0003 events.transient): bypass SessionService and persistence, pushing directly to the UI.
 * itemId matches the final assistant_text / reasoning entry; revision is its next persisted revision; losing fragments is harmless.
 */
export type AgentStreamEvent = TransientEvent
