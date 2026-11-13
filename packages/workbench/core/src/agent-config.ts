import { VisError } from '@vis/domain'
import type { AgentModelOption, SessionSummary } from '@vis/protocol'
import type { AgentRuntimePort } from './runtime-port'

export async function readAgentOptions(runtime: Pick<AgentRuntimePort, 'agentOptions'>, kind: string, model: string | null = null): Promise<AgentModelOption[]> {
  if (!runtime.agentOptions) throw VisError.of('unavailable', 'session.models_unsupported', {}, 'The Agent does not support reading the model list')
  try {
    return await runtime.agentOptions(kind, model === null ? {} : { model })
  } catch (error) {
    if (error instanceof VisError) throw error
    const detail = error instanceof Error ? error.message : String(error)
    throw VisError.of('unavailable', 'session.models_unavailable', { detail }, `Cannot read the model list: ${detail}`)
  }
}

/** UI settings and parent dispatches must accept exactly the same Agent-declared ids. */
export async function validateAgentConfig(runtime: Pick<AgentRuntimePort, 'agentOptions'>, kind: string, config: SessionSummary['agentConfig']) {
  if (config.model === null && config.effort === null && config.serviceTier === null) return
  const models = await readAgentOptions(runtime, kind, config.model)
  const invalid = (field: string, validIds: string[]): never => {
    throw VisError.of('invalid_params', 'session.invalid_agent_config', {}, `Invalid ${field}; valid ids: ${validIds.join(', ') || '(none)'}`)
  }
  const model = models.find(option => config.model === null ? option.isDefault : option.id === config.model)
  if (!model && config.model === null) {
    const field = config.effort !== null ? 'effort' : 'serviceTier'
    throw VisError.of('invalid_params', 'session.invalid_agent_config', {}, `Invalid ${field}: the Agent has no default model; pass a model explicitly. Valid model ids: ${models.map(option => option.id).join(', ') || '(none)'}`)
  }
  if (!model) return invalid('model', models.map(option => option.id))
  if (config.effort !== null && !model.efforts.some(effort => effort.id === config.effort)) invalid('effort', model.efforts.map(effort => effort.id))
  // RFC 0014 permits standard speed for every model, including Agents without tiers.
  if (config.serviceTier !== null && config.serviceTier !== 'default' && !model.serviceTiers.some(tier => tier.id === config.serviceTier)) invalid('serviceTier', ['default', ...model.serviceTiers.map(tier => tier.id)])
}
