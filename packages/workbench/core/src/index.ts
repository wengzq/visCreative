// Task management: SessionService (messages, queues, turns, snapshots, transcripts) and the AgentRuntime contract. See docs/rfc/0001, 0003, and 0004.
export { createSessionService, readSessionSummary, type SessionService, type TurnWatchdogOptions } from './session-service'
export * from './runtime-port'
export { exitInstance, markInstanceReady, startTurnInstance } from './agent-instances'
export { type ChildLike, createRpcPeer, RpcRequestError, type ServerRequestHandler, type SpawnFn } from './stdio-rpc'
export { buildSandboxPolicy, prepareSandbox } from './sandbox'
export { agentPath } from './agent-path'
export { nodeChildEnv, resolveExecutable, type ResolvedExecutable } from './resolve-executable'
export { killTree, spawnAgentProcess } from './kill-tree'
export { agentInstructions, CORE_INSTRUCTIONS, getGuide, GUIDES, listGuides, turnPrompt, type AgentEnvironment, type Guide } from './instructions'

export { appendNotice, upsertItem } from './transcript'
export { truncateReasoning } from './reasoning'

export type { AgentDescriptor } from './agent-descriptor'

export { skillReceipt } from './skill-receipt'

export { ACP_PROTOCOL_VERSION, createAcpRuntime, MCP_SERVER, type AcpRuntimeOptions } from './acp/runtime'
export type { AcpAgentProfile, AcpPreparedTurn, AcpToolCall, AcpToolClassification, PreparedSandbox } from './acp/profile'
export type { AcpChoice, AcpConfigOption } from './acp/config'
export { createTranslator as createAcpTranslator, type TranslatedItem as AcpTranslatedItem } from './acp/translate'

export { toolReceipts } from './tool-receipts'
