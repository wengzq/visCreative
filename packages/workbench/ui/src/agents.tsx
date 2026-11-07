import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { DEFAULT_AGENT_KIND, type AgentView } from '@vis/protocol'
import { useLocale } from '@vis/ui-kit'
import { AgentIcon } from './AgentIcon'

export const EMPTY_AGENTS: readonly AgentView[] = []
export const AgentsContext = createContext<readonly AgentView[] | undefined>(undefined)
export const useAgents = () => useContext(AgentsContext) ?? EMPTY_AGENTS
export const useAgentsLoaded = () => useContext(AgentsContext) !== undefined

export function usePreferredAgent() {
  const agents = useAgents()
  const loaded = useAgentsLoaded()
  const selected = useRef(false)
  const [kind, setKind] = useState<string | null>(() => preferredAgent(agents))
  useEffect(() => { if (loaded && !selected.current) setKind(preferredAgent(agents)) }, [agents, loaded])
  return [kind, (value: string | null) => { selected.current = true; setKind(value) }] as const
}

export function agentLabel(agents: readonly AgentView[], kind: string) {
  return agents.find(agent => agent.kind === kind)?.label ?? kind
}

export function preferredAgent(agents: readonly AgentView[]) {
  try {
    const saved = localStorage.getItem('vis.workspace.agent')
    if (saved && agents.some(agent => agent.kind === saved)) return saved
  } catch { /* Ignore unavailable preference storage */ }
  return DEFAULT_AGENT_KIND
}

export function AgentChoices({ value, onChange }: { value: string | null; onChange(kind: string): void }) {
  const agents = useAgents()
  const { locale } = useLocale()
  return agents.map(agent => <button key={agent.kind} type="button" aria-label={agent.label} disabled={!agent.available} aria-pressed={value === agent.kind} title={!agent.available ? agent.install.hint[locale === 'zh-CN' ? 'zh' : 'en'] : undefined} onClick={() => onChange(agent.kind)}>
    <AgentIcon kind={agent.kind} />{agent.label}
    {!agent.available ? <small>{agent.install.hint[locale === 'zh-CN' ? 'zh' : 'en']}</small> : null}
  </button>)
}
