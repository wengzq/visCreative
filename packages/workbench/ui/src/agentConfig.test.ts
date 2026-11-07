import type { SessionSummary } from '@vis/protocol'
import { describe, expect, it } from 'vitest'
import { pendingAgentConfigTurns } from './agentConfig'

const session: SessionSummary = {
  sessionId: 'session', agentKind: 'codex', title: '会话', workDir: '/tmp', workItemId: null,
  titleSource: 'default', queuePaused: false, silentSince: null, activeTurnId: 'turn-1', pendingApprovals: 0,
  agentConfig: { model: null, effort: null, serviceTier: null }, createdAt: 0,
}

describe('Next-turn settings notice', () => {
  it('Changes while running retain the notice through completion or stopping, clearing it only when the next turn starts', () => {
    const changed = { ...session, agentConfig: { model: 'fast', effort: null, serviceTier: null } }
    const pending = pendingAgentConfigTurns([session], [changed], new Map())
    expect(pending.get(session.sessionId)).toBe('turn-1')
    const stopped = { ...changed, activeTurnId: null }
    expect(pendingAgentConfigTurns([changed], [stopped], pending)).toBe(pending)
    expect(pendingAgentConfigTurns([stopped], [{ ...changed, activeTurnId: 'turn-2' }], pending).size).toBe(0)
  })

  it('Idle changes show no notice; updates to other sessions do not clear it', () => {
    const idle = { ...session, activeTurnId: null }
    const changed = { ...idle, agentConfig: { model: null, effort: 'high', serviceTier: null } }
    expect(pendingAgentConfigTurns([idle], [changed], new Map()).size).toBe(0)
    expect(pendingAgentConfigTurns([idle], [{ ...changed, activeTurnId: 'turn-2' }], new Map()).size).toBe(0)
    const pending = new Map([[session.sessionId, 'turn-1']])
    expect(pendingAgentConfigTurns([session], [session, { ...changed, sessionId: 'other' }], pending)).toBe(pending)
    expect(pendingAgentConfigTurns([session], [], pending).size).toBe(0)
  })

  it('Changing only speed while running also shows the next-turn notice', () => {
    const changed = { ...session, agentConfig: { ...session.agentConfig, serviceTier: 'fast' } }
    expect(pendingAgentConfigTurns([session], [changed], new Map()).get(session.sessionId)).toBe('turn-1')
  })
})
