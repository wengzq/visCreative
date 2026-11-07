import type { ComponentType, ReactNode } from 'react'
import type { AgentKind, BatchView, JobView, MethodParams, MethodResult, NodeView, ScriptDoc, ScriptOp, ShotRole, SlotView } from '@vis/protocol'

// 0023: the seam between the script node shell (table, editor, card) and the asset and Agent pieces that it mounts.

/** What the owning session is asked to do (RFC 0023 §4) */
export type ScriptAgentTask = 'breakdown' | 'prompts' | 'custom'

export type ScriptAgentRequest = {
  nodeId: string
  task: ScriptAgentTask
  /** The user's own words from the input panel; may be empty for breakdown and prompts */
  text: string
  /** prompts: only these shots; absent means all */
  shotIds?: string[]
  /** Overrides ScriptDoc.sessionId; 'new' creates a session of agentKind in the current workspace */
  session?: { sessionId: string } | { new: true; agentKind: AgentKind }
}

export type ScriptSessionOption = { sessionId: string; title: string; agentKind: AgentKind; archived: boolean }

/** Host-provided state about a script node's owning session, for the "working" badge */
export type ScriptAgentState = { sessionId: string; title: string; task: ScriptAgentTask | null; running: boolean }

export type ScriptActions = {
  agents?: readonly import('@vis/protocol').AgentView[] | undefined
  renderScriptSettingPicker?(props: {
    castIds: readonly string[]
    styleId?: string
    castLimitReached?: boolean
    onPick(setting: { id: string; kind: 'character' | 'scene' | 'prop' | 'style' }): Promise<void>
    onClose(): void
  }): ReactNode
  onAssembleScriptTimeline?(scriptNodeId: string): Promise<string>
  onPlanScriptBatch?(params: MethodParams<'script.batch.plan'>): Promise<MethodResult<'script.batch.plan'>>
  onStartScriptBatch?(params: MethodParams<'script.batch.start'>): Promise<BatchView>
  onCancelScriptBatch?(params: MethodParams<'script.batch.cancel'>): Promise<BatchView>
  onResumeScriptBatch?(params: MethodParams<'script.batch.resume'>): Promise<BatchView>
  onCreateScript?(at: { x: number; y: number }): Promise<string>
  /** Sends a visible message to the owning session (choosing or creating it when needed) and returns that session */
  onScriptAgent?(request: ScriptAgentRequest): Promise<{ sessionId: string }>
  /** Sessions the user may choose as owner */
  scriptSessions?: readonly ScriptSessionOption[]
  currentScriptSessionId?: string
  onCreateScriptSession?(agentKind: AgentKind): Promise<{ sessionId: string }>
  /** Imports a reference image or creates an unsubmitted image node for an asset. */
  onScriptAssetImage?(scriptNodeId: string, assetId: string, file?: File): Promise<string>
  onOpenSession?(sessionId: string): void
  /** Creates one generation node for a shot (RFC 0023 §6, single node; batches come in step 4b-2) */
  onCreateShotNode?(scriptNodeId: string, shotId: string, role: Exclude<ShotRole, 'last'>): Promise<string>
}

/** Props shared by the pieces the script editor mounts */
export type ScriptPartProps = {
  batches?: readonly BatchView[]
  batchJobs?: readonly JobView[]
  view: NodeView
  slot: SlotView
  doc: ScriptDoc
  /** The current input-panel draft, when mounted beside an editor with unsaved text. */
  requestText?: string
  /** Applies row ops as one undoable user step; rejects with revision_conflict like canvas.apply */
  onPatch(ops: ScriptOp[]): Promise<void>
  /** Generated nodes linked to this script, by shot id */
  outputs: ReadonlyMap<string, readonly NodeView[]>
  blockouts?: ReadonlyMap<string, NodeView>
}

/** The assets tab (characters, scenes, props) — owned by the assets and Agent worker */
export type ScriptAssetsTab = ComponentType<ScriptPartProps>
/** Owning session picker plus the breakdown / prompts / custom buttons — owned by the assets and Agent worker */
export type ScriptAgentBar = ComponentType<ScriptPartProps & { tasks: readonly ScriptAgentTask[]; shotIds?: string[] }>
