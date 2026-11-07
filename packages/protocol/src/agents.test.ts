import { describe, expect, it } from 'vitest'
import { AgentKind, DEFAULT_AGENT_KIND, METHODS } from './index'

describe('Agent registry contract', () => {
  it('accepts community identifiers without expanding an enum', () => {
    expect(AgentKind.parse('example-agent')).toBe('example-agent')
    expect(AgentKind.parse(DEFAULT_AGENT_KIND)).toBe(DEFAULT_AGENT_KIND)
    for (const kind of ['', 'Example', 'example_agent', '<svg>', 'a/b']) {
      expect(AgentKind.safeParse(kind).success).toBe(false)
    }
  })

  it('exposes descriptors only to the UI', () => {
    expect(METHODS['agents.list'].callers).toEqual(['ui'])
    expect(METHODS['agents.list'].params.parse({})).toEqual({})
    expect(METHODS['agents.list'].result.parse({ agents: [] })).toEqual({ agents: [] })
  })
})
