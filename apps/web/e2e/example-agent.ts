import { codexDescriptor } from '../../../packages/workbench/codex/src/descriptor'
import { codexRuntime } from '../../../services/studiod/src/codex'
import type { AgentRegistration } from '../../../services/studiod/src/agents'

export const exampleDescriptor = {
  kind: 'example',
  label: 'Example Agent',
  icon: ['M12 2 22 12 12 22 2 12Z', 'M8 12h8M12 8v8'],
  homepage: 'https://example.invalid',
  install: { hint: { zh: 'Example fixture', en: 'Example fixture' } },
  envPassthrough: [],
  forbiddenPaths: [],
  capabilities: { resume: true, interrupt: true, models: true, effort: true, approvals: true },
}

export function exampleRegistrations(options: Parameters<typeof codexRuntime>[0]): AgentRegistration[] {
  return [
    { descriptor: codexDescriptor, runtime: codexRuntime(options) },
    { descriptor: exampleDescriptor, runtime: codexRuntime(options) },
    {
      descriptor: { ...exampleDescriptor, kind: 'missing-example', label: 'Missing Example', install: { hint: { zh: 'Install the missing example', en: 'Install the missing example' } } },
      runtime: codexRuntime(options),
      availability: () => ({ available: false, reason: 'executable_missing' }),
    },
  ]
}
