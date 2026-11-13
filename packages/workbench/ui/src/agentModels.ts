import type { AgentModelOption, WorkSessionView } from '@vis/protocol'
import { createContext, useContext, useEffect, useState } from 'react'

type AgentModelCatalog = (kind: string) => Promise<AgentModelOption[]>
export const AgentModelsContext = createContext<AgentModelCatalog | null>(null)

/** Share in-flight reads and briefly retain failures so card reloads cannot restart probes. */
export function createAgentModelCatalog(load: AgentModelCatalog, now = Date.now): AgentModelCatalog {
  const entries = new Map<string, { result: Promise<AgentModelOption[]>; expiresAt: number }>()
  return kind => {
    const previous = entries.get(kind)
    if (previous && previous.expiresAt > now()) return previous.result
    const entry = { result: Promise.resolve().then(() => load(kind)), expiresAt: Infinity }
    entries.set(kind, entry)
    void entry.result.then(() => { entry.expiresAt = now() + 10 * 60_000 }, () => { entry.expiresAt = now() + 30_000 })
    return entry.result
  }
}

export function useAgentModels(sessions: readonly WorkSessionView[]) {
  const catalog = useContext(AgentModelsContext)
  const kinds = JSON.stringify([...new Set(sessions.filter(session => Object.values(session.agentConfig).some(value => value !== null)).map(session => session.agentKind))].sort())
  const configs = JSON.stringify(sessions.map(session => [session.agentKind, session.agentConfig]))
  const [state, setState] = useState<{ catalog: AgentModelCatalog | null; models: Record<string, AgentModelOption[]> }>({ catalog, models: {} })
  useEffect(() => {
    if (!catalog) return
    let current = true
    for (const kind of JSON.parse(kinds) as string[]) {
      void catalog(kind).then(models => {
        if (current) setState(previous => ({ catalog, models: { ...(previous.catalog === catalog ? previous.models : {}), [kind]: models } }))
      }, () => {})
    }
    return () => { current = false }
  }, [catalog, kinds, configs])
  return state.catalog === catalog ? state.models : {}
}
