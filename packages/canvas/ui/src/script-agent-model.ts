import type { ScriptDoc } from '@vis/protocol'
import type { ScriptSessionOption } from './script-ui'

export function scriptOwner(doc: ScriptDoc, sessions: readonly ScriptSessionOption[]) {
  return sessions.find(session => session.sessionId === doc.sessionId && !session.archived)
}

export function defaultScriptSession(sessions: readonly ScriptSessionOption[], currentId?: string): string {
  const available = sessions.filter(session => !session.archived)
  return available.find(session => session.sessionId === currentId)?.sessionId ?? available[0]?.sessionId ?? 'new'
}

export function assetUseCount(doc: ScriptDoc, assetId: string): number {
  return doc.shots.filter(shot => shot.sceneId === assetId || shot.characterIds.includes(assetId) || shot.propIds.includes(assetId)).length
}
