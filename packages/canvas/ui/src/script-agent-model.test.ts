import { describe, expect, it } from 'vitest'
import { EMPTY_SCRIPT, type ScriptDoc } from '@vis/protocol'
import { assetUseCount, defaultScriptSession, scriptOwner } from './script-agent-model'
import type { ScriptSessionOption } from './script-ui'

const sessions: ScriptSessionOption[] = [
  { sessionId: 'old', title: 'Archived', agentKind: 'codex', archived: true },
  { sessionId: 'other', title: 'Other', agentKind: 'deepseek', archived: false },
  { sessionId: 'current', title: 'Current', agentKind: 'claude', archived: false },
]

describe('Script owning session chooser', () => {
  it('defaults to the current available session, otherwise the first available session or a new one', () => {
    expect(defaultScriptSession(sessions, 'current')).toBe('current')
    expect(defaultScriptSession(sessions, 'old')).toBe('other')
    expect(defaultScriptSession(sessions, 'missing')).toBe('other')
    expect(defaultScriptSession(sessions.slice(0, 1))).toBe('new')
  })

  it('asks again for missing and archived owners and reuses an available owner', () => {
    expect(scriptOwner({ ...EMPTY_SCRIPT, sessionId: 'old' }, sessions)).toBeUndefined()
    expect(scriptOwner({ ...EMPTY_SCRIPT, sessionId: 'missing' }, sessions)).toBeUndefined()
    expect(scriptOwner(EMPTY_SCRIPT, sessions)).toBeUndefined()
    expect(scriptOwner({ ...EMPTY_SCRIPT, sessionId: 'current' }, sessions)).toEqual(sessions[2])
  })

  it('counts distinct shots that use an asset before deletion', () => {
    const doc: ScriptDoc = { ...EMPTY_SCRIPT, shots: [
      { id: 'one', rev: 0, transition: 'cut', description: '', sceneId: 'a', characterIds: ['a'], propIds: [] },
      { id: 'two', rev: 0, transition: 'cut', description: '', characterIds: [], propIds: ['a'] },
      { id: 'three', rev: 0, transition: 'cut', description: '', characterIds: [], propIds: [] },
    ] }
    expect(assetUseCount(doc, 'a')).toBe(2)
    expect(assetUseCount(doc, 'missing')).toBe(0)
  })
})
