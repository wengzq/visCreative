import { resolveExecutable, type AcpAgentProfile, type AcpToolCall, type AcpToolClassification } from '@vis/workbench-core'
import { codebuddySandbox } from './descriptor'
import { resolveCodebuddy, type ResolveCodebuddyOptions } from './resolve'

const nativeKinds: Record<string, AcpToolClassification['kind']> = {
  Bash: 'execute', PowerShell: 'execute', BashOutput: 'execute', KillShell: 'execute',
  Write: 'edit', Edit: 'edit', MultiEdit: 'edit',
  Read: 'read', Glob: 'read', Grep: 'read', NotebookRead: 'read',
  WebFetch: 'fetch', WebSearch: 'fetch',
}

const visToolName = /^mcp__vis__[A-Za-z0-9_]+$/

function isVisTool(tool: AcpToolCall): boolean {
  const name = tool._meta?.['codebuddy.ai/toolName']
  if (typeof name === 'string' && visToolName.test(name)) return true
  // CodeBuddy loads MCP tools lazily and calls them through DeferExecuteTool, which applies the target's own
  // permission check; only the target named in rawInput decides, and any other target keeps asking.
  const target = tool.rawInput?.toolName
  return name === 'DeferExecuteTool' && typeof target === 'string' && visToolName.test(target)
}

export function classifyCodebuddyTool(tool: AcpToolCall): AcpToolClassification {
  // CodeBuddy rewrites titles for commands and edits; native identity survives in this metadata.
  const nativeName = typeof tool._meta?.['codebuddy.ai/toolName'] === 'string' ? tool._meta['codebuddy.ai/toolName'] : undefined
  const reported = tool.kind === 'search' ? 'read' : tool.kind
  const fallback: AcpToolClassification['kind'] = ['execute', 'edit', 'delete', 'move', 'fetch', 'read'].includes(reported) ? reported : 'other'
  const kind = nativeName !== undefined && Object.hasOwn(nativeKinds, nativeName) ? nativeKinds[nativeName]! : fallback
  const path = tool.rawInput?.file_path
  const paths = kind === 'edit' && nativeName !== undefined && ['Write', 'Edit', 'MultiEdit'].includes(nativeName)
    && typeof path === 'string' && path.trim() && !path.includes('\0')
    && (tool.locations === undefined || (Array.isArray(tool.locations) && tool.locations.every((location: any) => location?.path === path)))
    ? [path] : undefined
  // Native shells can change directory inside the turn; ACP does not prove their current cwd.
  return { kind, ...(paths ? { paths } : {}), ...(isVisTool(tool) ? { visTool: true } : {}) }
}

export function codebuddyProfile(options: ResolveCodebuddyOptions = {}): AcpAgentProfile {
  return {
    kind: 'codebuddy',
    label: 'CodeBuddy',
    processLabel: 'codebuddy',
    sandbox: codebuddySandbox,
    launch: ({ sandbox }) => {
      const executable = resolveCodebuddy(options)
      if (!executable) throw new Error('CodeBuddy was not found; install @tencent-ai/codebuddy-code or set VIS_CODEBUDDY_PATH')
      const resolved = resolveExecutable('codebuddy', executable, sandbox.env)
      return { command: resolved.command, args: [...resolved.args, '--acp', '--permission-mode', 'default'] }
    },
    instructions: 'prompt',
    config: { model: 'model', effort: 'thought_level', permission: { id: 'mode', ask: 'default' } },
    classifyTool: classifyCodebuddyTool,
    itemPrefix: 'cb',
    resume: 'session/resume',
    defaultEffort: option => option.currentValue,
  }
}
