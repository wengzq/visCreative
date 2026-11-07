import { newId } from '@vis/domain'
import { and, eq, inArray, spaceSchema as s, type SpaceDb } from '@vis/storage'

const ACTIVE = ['starting', 'ready'] as const

/**
 * Register a runtime instance and bind it to a turn (0004 "One Runtime Instance per Turn").
 * Finalize lingering instances in the same session first: at most one active instance per session, with old tokens invalidated.
 */
export function startTurnInstance(db: SpaceDb, input: { sessionId: string; turnId: string; tokenHash: string }, now: number): string {
  const instanceId = newId('agentInstance', now)
  db.transaction(tx => {
    tx.update(s.agentInstances).set({ status: 'exited', exitedAt: now, exitReason: 'superseded' })
      .where(and(eq(s.agentInstances.sessionId, input.sessionId), inArray(s.agentInstances.status, [...ACTIVE]))).run()
    tx.insert(s.agentInstances).values({ id: instanceId, sessionId: input.sessionId, status: 'starting', tokenHash: input.tokenHash, startedAt: now }).run()
    tx.update(s.turns).set({ instanceId }).where(eq(s.turns.id, input.turnId)).run()
  }, { behavior: 'immediate' })
  return instanceId
}

export function markInstanceReady(db: SpaceDb, instanceId: string, pid?: number): void {
  db.update(s.agentInstances).set({ status: 'ready', ...(pid !== undefined ? { pid } : {}) })
    .where(and(eq(s.agentInstances.id, instanceId), eq(s.agentInstances.status, 'starting'))).run()
}

/** Instance exit invalidates its token immediately. Do not record exits twice */
export function exitInstance(db: SpaceDb, instanceId: string, reason: string, now: number): void {
  db.update(s.agentInstances).set({ status: 'exited', exitedAt: now, exitReason: reason })
    .where(and(eq(s.agentInstances.id, instanceId), inArray(s.agentInstances.status, [...ACTIVE]))).run()
}
