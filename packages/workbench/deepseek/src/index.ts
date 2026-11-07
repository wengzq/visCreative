// DeepSeek Harness Agent adapter: implements AgentRuntimePort through dsh ACP mode. See docs/rfc/0005.
export { ACP_PROTOCOL_VERSION, createDeepseekRuntime, type DeepseekRuntimeOptions, MCP_SERVER } from './adapter'
export { DEFAULT_MODEL, DISABLED_ENTRIES, dshOverlay } from './overlay'
export { AGENT_INSTRUCTIONS, agentInstructions, buildPrompt } from './prompt'
export { createTranslator } from './translate'
export { resolveDsh, type ResolvedDsh, type ResolveDshOptions } from './resolve-dsh'

export { deepseekDescriptor } from './descriptor'
