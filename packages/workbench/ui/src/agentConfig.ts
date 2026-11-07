import type { SessionSummary } from '@vis/protocol'

// Retain the notice until the next turn starts; returning to the list or switching sessions must not clear it.
export function pendingAgentConfigTurns(previous: SessionSummary[], sessions: SessionSummary[], pending: ReadonlyMap<string, string>): ReadonlyMap<string, string> {
  const next = new Map(pending)
  for (const session of sessions) {
    const before = previous.find(item => item.sessionId === session.sessionId)
    if (before && session.activeTurnId && before.activeTurnId === session.activeTurnId && (before.agentConfig.model !== session.agentConfig.model || before.agentConfig.effort !== session.agentConfig.effort || before.agentConfig.serviceTier !== session.agentConfig.serviceTier)) next.set(session.sessionId, session.activeTurnId)
    else if (session.activeTurnId && next.get(session.sessionId) !== session.activeTurnId) next.delete(session.sessionId)
  }
  for (const id of next.keys()) if (!sessions.some(session => session.sessionId === id)) next.delete(id)
  return next.size === pending.size && [...next].every(([id, turn]) => pending.get(id) === turn) ? pending : next
}
