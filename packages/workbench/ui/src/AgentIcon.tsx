import type { AgentKind } from '@vis/protocol'
import { useAgents } from './agents'

export function AgentIcon({ kind }: { kind: AgentKind }) {
  const paths = useAgents().find(agent => agent.kind === kind)?.icon ?? ['M5 7h14v13H5ZM9 11h.01M15 11h.01M9 16h6M12 7V3']
  return <svg className={`vis-agent-icon is-${kind}`} viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {paths.map((path, index) => <path key={index} d={path} />)}
  </svg>
}
