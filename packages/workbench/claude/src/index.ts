// Claude Agent adapter: implements AgentRuntimePort. See docs/rfc/0004 "Claude Adapter".
export { ALLOWED_TOOLS, type ClaudeRuntimeOptions, createClaudeRuntime, type QueryFn, TOOLS } from './adapter'
export { buildPrompt, SYSTEM_APPEND, systemAppend } from './prompt'
export { translate } from './translate'

export { claudeDescriptor } from './descriptor'
