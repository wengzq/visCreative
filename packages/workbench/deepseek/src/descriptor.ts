import type { AgentDescriptor } from '@vis/workbench-core'

export const deepseekDescriptor: AgentDescriptor = {
  kind: 'deepseek',
  label: 'DeepSeek',
  icon: ['M3 12c0-4 3-6 7-6 5 0 7 3 7 7 2 0 3-2 4-4 1 6-3 10-9 10-5 0-9-2-9-7Z', 'M10 15c1 2 3 3 5 2M8 3l2 3 2-3', 'M7 11h0'],
  homepage: 'https://github.com/deepseek-ai/DeepSeek-Harness',
  install: { hint: { zh: '请安装并配置 DeepSeek 后重试', en: 'Install and configure DeepSeek, then retry' }, command: 'npm install -g @deepseek-ai/dsh' },
  envPassthrough: ['DEEPSEEK_API_KEY'],
  forbiddenPaths: ['~/.dsh'],
  capabilities: { resume: true, interrupt: true, models: true, effort: true, approvals: true },
}

export const deepseekSandbox = { envPassthrough: deepseekDescriptor.envPassthrough, runtimeDirectory: '.dsh' }
