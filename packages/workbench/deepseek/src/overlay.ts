import { agentInstructions } from './prompt'
import type { DispatchInput } from '@vis/workbench-core'

/** macOS uses outer Seatbelt isolation; Windows enables tools without claiming isolation; other cases retain read-only fallback. */
export const DEFAULT_MODEL = 'deepseek-flash'

export const DISABLED_ENTRIES = ['tool-bash', 'tool-pwsh', 'tool-jobs', 'tool-web', 'tool-subagent', 'tool-subagent-fork', 'tool-subagent-control', 'tool-workflow']

export function dshOverlay(model: string = DEFAULT_MODEL, skillsPath?: string, expanded = false, work?: DispatchInput['workContext'], isolation: 'sandbox' | 'none' = 'sandbox'): string {
  const mode = expanded ? 'danger-full-access' : 'read-only'
  const approval = expanded ? 'ask' : 'never'
  const preset = expanded ? isolation === 'sandbox' ? 'vis-isolated' : 'vis-unisolated' : 'vis-read-only'
  const lines = [
    '# vis 生成，勿手改',
    '- id: sandbox-policy',
    '  config:',
    `    mode: ${mode}`,
    '    workspaceRoot: !!js process.cwd()',
    '- id: approval',
    '  config:',
    `    policy: ${approval}`,
    '- id: tool-fs',
    '  config:',
    '    read: true',
    '    readImage: true',
    `    write: ${expanded}`,
    `    edit: ${expanded}`,
    ...(expanded ? [] : DISABLED_ENTRIES).flatMap(id => [`- id: ${id}`, '  disabled: true']),
    '- id: permission',
    '  config:',
    `    defaultPreset: ${preset}`,
    '    presets:',
    `      ${preset}:`,
    `        sandbox: ${mode}`,
    `        approval: ${approval}`,
    `        name: ${expanded ? isolation === 'sandbox' ? 'vis 隔离工作区' : 'vis 工作区' : 'vis 只读'}`,
    `        description: ${expanded ? isolation === 'sandbox' ? '工作区可写，外层隔离不可解除' : '工作区可写，没有隔离沙箱，保留工具审批' : '只能读文件，升级审批一律拒绝'}`,
    '- id: session-log-deepseek',
    '  config:',
    '    enabled: false',
  ]
  lines.push('- id: system-prompt', '  config:', '    personaPrefix: You are a coding agent powered by the {{model}} model.', `    personaSuffix: ${JSON.stringify(agentInstructions(expanded, work, isolation))}`)
  if (skillsPath) lines.push('- id: skill-filesystem', '  config:', '    includeDefaultRoots: false', `    customSkillDirs: [${JSON.stringify(skillsPath)}]`)
  lines.push('- id: acp', '  config:', '    provider: deepseek-official', `    model: ${JSON.stringify(model)}`)
  return `${lines.join('\n')}\n`
}
