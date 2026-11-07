import type { AgentDescriptor } from '@vis/workbench-core'

export const claudeDescriptor: AgentDescriptor = {
  kind: 'claude',
  label: 'Claude',
  icon: ['M12 3c-1 5-7 6-7 12a7 7 0 0 0 14 0c0-3-2-5-4-6 0 3-1 4-3 5 2-4 2-7 0-11Z', 'M9 18c1 1 3 1 4 0'],
  homepage: 'https://code.claude.com/docs',
  install: { hint: { zh: '请安装并配置 Claude Code 后重试', en: 'Install and configure Claude Code, then retry' }, command: 'npm install -g @anthropic-ai/claude-code' },
  envPassthrough: [],
  forbiddenPaths: ['~/.claude', '~/.claude.json', '~/.claude.json.*'],
  capabilities: { resume: true, interrupt: true, models: false, effort: false, approvals: false },
}
