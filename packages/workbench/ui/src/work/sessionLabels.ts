import type { AgentModelOption, AgentView, WorkSessionView } from '@vis/protocol'
import { formatter, messagesFor, type Locale } from '@vis/ui-kit'
import { agentLabel } from '../agents'
import { workMessages } from '../messages'

export type AgentModels = Readonly<Record<string, readonly AgentModelOption[]>>

/** Accessible session names stay stable while the visible configuration resolves independently. */
export function workSessionLabel(session: WorkSessionView, sessions: readonly WorkSessionView[], agents: readonly AgentView[], locale: Locale, models: AgentModels) {
  const t = messagesFor(workMessages, locale)
  const index = sessions.filter(candidate => candidate.agentKind === session.agentKind).findIndex(candidate => candidate.sessionId === session.sessionId)
  const agentName = `${agentLabel(agents, session.agentKind)}${index > 0 ? ` ${formatter(locale).number(index + 1)}` : ''}`
  const { model, effort, serviceTier } = session.agentConfig
  if (model === null && effort === null && serviceTier === null) return { agentName, configLabel: '', label: agentName }
  const selected = models[session.agentKind]?.find(option => model === null ? option.isDefault : option.id === model)
  const modelLabel = selected?.label ?? model ?? t.defaultModel
  const effortLabel = effort === null ? null : selected?.efforts.find(option => option.id === effort)?.label ?? effort
  const tierLabel = serviceTier === null ? null : serviceTier === 'default' ? t.standardSpeed : selected?.serviceTiers.find(option => option.id === serviceTier)?.label ?? serviceTier
  const configLabel = t.agentConfigLabel(modelLabel, effortLabel, tierLabel)
  return { agentName, configLabel, label: t.agentWithModel(agentName, configLabel) }
}
