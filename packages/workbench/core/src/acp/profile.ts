import type { AgentKind, AgentModelOption } from '@vis/protocol'
import type { DispatchInput } from '../runtime-port'
import type { prepareSandbox, SandboxAgent } from '../sandbox'
import type { AcpChoice, AcpConfigOption } from './config'

export type PreparedSandbox = ReturnType<typeof prepareSandbox>

export type AcpPreparedTurn = {
  sessionId: string
  cwd: string
  sandbox: PreparedSandbox
  work?: DispatchInput['workContext']
  skillsPath?: string
}

export type AcpToolCall = Record<string, any>

export type AcpToolClassification = {
  kind: 'execute' | 'edit' | 'delete' | 'move' | 'fetch' | 'read' | 'other'
  /** Omit when the native command's directory cannot be determined. */
  cwd?: string
  /** Complete native write targets; descriptive ACP locations alone are insufficient. */
  paths?: string[]
  autoApprovalBlocked?: boolean
  /** The profile verified this tool's native identity as a vis MCP tool. */
  visTool?: boolean
}

export type AcpAgentProfile = {
  kind: AgentKind
  label: string
  /** Native executable name, used for connection diagnostics. */
  processLabel: string
  sandbox: SandboxAgent
  /** Per-session launch files, retained for turns and removed after probes. */
  sessionFiles?(prepared: AcpPreparedTurn): { path: string; content: string }[]
  launch(prepared: AcpPreparedTurn): { command: string; args: string[] }
  instructions: 'launch' | 'prompt'
  /** True only when the Agent itself disables mutating tools in read-only fallback (dsh's overlay disables writes, edits and risky tools, with approval never). */
  readOnlyEnforcedByAgent?: boolean
  config: { model?: string; effort?: string; permission?: { id: string; ask: string } }
  classifyTool(tool: AcpToolCall, cwd: string): AcpToolClassification
  permissionSummary?: string
  itemPrefix: string
  resume: 'session/resume' | 'session/load'
  defaultEffort(option: AcpConfigOption): string
  modelOption?(choice: AcpChoice, options: unknown, defaultModel: string): AgentModelOption
}
