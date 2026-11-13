import { resolve } from 'node:path'
import { createAcpRuntime, resolveExecutable, type AcpAgentProfile, type AcpRuntimeOptions, type AcpToolCall, type AcpToolClassification } from '@vis/workbench-core'
import { minimaxDescriptor, minimaxSandbox } from './descriptor'
import { resolveMcode, type ResolveMcodeOptions } from './resolve'

export type MinimaxRuntimeOptions = AcpRuntimeOptions & Pick<ResolveMcodeOptions, 'mcodePath'>

/** MiniMax's kind is inferred from substrings; only verified native tool names establish approval categories. */
export function classifyMinimaxTool(tool: AcpToolCall, cwd: string): AcpToolClassification {
  if (typeof tool.name === 'string' && /^mcp__vis__[A-Za-z0-9_]+$/.test(tool.name)) return { kind: 'other', visTool: true }
  switch (tool.name) {
    case 'bash':
      return { kind: 'execute', cwd }
    case 'write':
    case 'edit': {
      const path = tool.rawInput?.[tool.name === 'write' ? 'path' : 'file_path']
      // Match native lexical path resolution; home aliases need expansion context and remain manual.
      // Previews and locations describe output, but cannot establish complete write targets.
      return { kind: 'edit', ...(typeof path === 'string' && path.trim() && !path.startsWith('~') ? { paths: [resolve(cwd, path)] } : {}) }
    }
    case 'web_fetch':
      return { kind: 'fetch' }
    case 'read':
    case 'grep':
    case 'glob':
      return { kind: 'read' }
    default:
      return { kind: 'other', autoApprovalBlocked: true }
  }
}

export function minimaxProfile(options: ResolveMcodeOptions = {}): AcpAgentProfile {
  return {
    kind: minimaxDescriptor.kind,
    label: minimaxDescriptor.label,
    processLabel: 'mcode',
    sandbox: minimaxSandbox,
    launch: ({ sandbox }) => {
      const path = resolveMcode(options)
      if (!path) throw new Error('mcode was not found; install @minimax-ai/code or set VIS_MCODE_PATH')
      const executable = resolveExecutable('mcode', path, sandbox.env)
      return { command: executable.command, args: [...executable.args, 'acp'] }
    },
    instructions: 'prompt',
    config: { model: 'model', effort: 'thinkingEffort', permission: { id: 'permissionMode', ask: 'default' } },
    classifyTool: classifyMinimaxTool,
    itemPrefix: 'mm',
    resume: 'session/resume',
    defaultEffort: option => option.options.some((choice: any) => choice?.value === 'default') ? 'default' : option.currentValue,
  }
}

export function createMinimaxRuntime(ctx: Parameters<typeof createAcpRuntime>[0], options: MinimaxRuntimeOptions): ReturnType<typeof createAcpRuntime> {
  return createAcpRuntime(ctx, options, minimaxProfile(options))
}
