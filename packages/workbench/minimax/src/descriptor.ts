import type { AcpAgentProfile, AgentDescriptor } from '@vis/workbench-core'

export const minimaxDescriptor: AgentDescriptor = {
  kind: 'minimax-code',
  label: 'MiniMax Code',
  icon: ['M3 18V6l5 7 4-7 4 7 5-7v12', 'M8 18h8'],
  homepage: 'https://github.com/MiniMax-AI/minimax-code',
  install: {
    hint: { zh: '请安装并配置 MiniMax Code 后重试', en: 'Install and configure MiniMax Code, then retry' },
    command: 'npm install -g @minimax-ai/code',
  },
  envPassthrough: ['MCODE_PROVIDER_API_KEY'],
  forbiddenPaths: ['~/.minimax', '~/.mavis', '~/.mavis-*'],
  capabilities: { resume: true, interrupt: true, models: true, effort: true, approvals: true },
}

export const minimaxSandbox: AcpAgentProfile['sandbox'] = {
  envPassthrough: minimaxDescriptor.envPassthrough,
  runtimeDirectory: '.minimax',
}
