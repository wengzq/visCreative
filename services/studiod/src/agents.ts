import { VisError } from '@vis/domain'
import { AgentDescriptor as DescriptorSchema, type AgentView } from '@vis/protocol'
import type { AgentDescriptor } from '@vis/workbench-core'
import type { AgentRuntimeFactory, AgentRuntimes } from './space-host'

export type AgentRegistration = {
  descriptor: AgentDescriptor
  runtime: AgentRuntimeFactory
  availability?: () => { available: boolean; reason?: string }
}

/** Pair metadata and runtime once; every consumer uses the descriptor's stable identifier. */
export function registerAgents(registrations: readonly AgentRegistration[]): AgentRuntimes {
  const runtimes: AgentRuntimes = Object.create(null)
  for (const registration of registrations) {
    const descriptor = DescriptorSchema.parse(registration.descriptor)
    if (Object.hasOwn(runtimes, descriptor.kind)) throw new Error(`Duplicate Agent: ${descriptor.kind}`)
    runtimes[descriptor.kind] = Object.assign(
      ((ctx) => registration.runtime(ctx)) as AgentRuntimeFactory,
      { descriptor, availability: registration.availability ?? (() => ({ available: true })) },
    )
  }
  return runtimes
}

export function listAgents(runtimes: AgentRuntimes): AgentView[] {
  return Object.entries(runtimes).flatMap(([kind, runtime]) => {
    if (!runtime) return []
    // Older embedders can still supply bare runtimes; production registration always supplies metadata.
    const descriptor = runtime.descriptor ?? {
      kind, label: agentLabel(runtimes, kind), icon: [], homepage: '', install: { hint: { zh: '', en: '' } },
      envPassthrough: [], forbiddenPaths: [],
      capabilities: { resume: true, interrupt: true, models: runtime.modelsSupported ?? false, effort: runtime.modelsSupported ?? false, approvals: true },
    }
    return [{ ...descriptor, icon: [...descriptor.icon], envPassthrough: [...descriptor.envPassthrough], forbiddenPaths: [...descriptor.forbiddenPaths], ...(runtime.availability?.() ?? { available: true }) }]
  })
}

export function assertAgent(runtimes: AgentRuntimes, kind: string) {
  if (!Object.hasOwn(runtimes, kind) || !runtimes[kind]) throw VisError.of('unavailable', 'session.agent_unconfigured', { kind }, `${kind} Agent is not configured`)
}

export function agentLabel(runtimes: AgentRuntimes, kind: string) {
  return runtimes[kind]?.descriptor?.label ?? `${kind[0]?.toUpperCase()}${kind.slice(1)}`
}
