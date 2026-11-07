import type { AgentDescriptor } from '@vis/workbench-core'

export const codexDescriptor: AgentDescriptor = {
  kind: 'codex',
  label: 'Codex',
  icon: ['M8 5 3 12l5 7M16 5l5 7-5 7M14 4l-4 16', 'M4 3h3M17 21h3'],
  homepage: 'https://developers.openai.com/codex/cli',
  install: { hint: { zh: '请安装并配置 Codex 后重试', en: 'Install and configure Codex, then retry' }, command: 'npm install -g @openai/codex' },
  envPassthrough: [],
  forbiddenPaths: ['~/.codex'],
  capabilities: { resume: true, interrupt: true, models: true, effort: true, approvals: true },
}

export const codexSandbox = { envPassthrough: codexDescriptor.envPassthrough, runtimeDirectory: '.codex', runtimeHomeVariable: 'CODEX_HOME' }
