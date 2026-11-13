import type { AgentDescriptor } from '@vis/workbench-core'

export const codebuddyDescriptor: AgentDescriptor = {
  kind: 'codebuddy',
  label: 'CodeBuddy',
  icon: ['M8 5H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h3M16 5h3a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-3', 'M9 9l-3 3 3 3M15 9l3 3-3 3M13 8l-2 8'],
  homepage: 'https://www.codebuddy.ai/docs/cli/',
  install: {
    hint: { zh: '请安装并配置 CodeBuddy（WorkBuddy 的底层引擎）后重试', en: 'Install and configure CodeBuddy, the engine behind WorkBuddy, then retry' },
    command: 'npm install -g @tencent-ai/codebuddy-code',
  },
  envPassthrough: ['CODEBUDDY_API_KEY', 'CODEBUDDY_AUTH_TOKEN'],
  forbiddenPaths: ['~/.codebuddy', '~/.codebuddy.json', '~/.codebuddy.json.*'],
  capabilities: { resume: true, interrupt: true, models: true, effort: true, approvals: true },
}

export const codebuddySandbox = {
  envPassthrough: codebuddyDescriptor.envPassthrough,
  forbiddenPaths: codebuddyDescriptor.forbiddenPaths,
  runtimeDirectory: '.codebuddy',
  runtimeHomeVariable: 'CODEBUDDY_CONFIG_DIR',
}
