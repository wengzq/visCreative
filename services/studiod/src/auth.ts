import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { and, eq, inArray, isNull, spaceSchema as s, type SpaceTx } from '@vis/storage'

const ACTIVE_INSTANCE = ['starting', 'ready'] as const
const ACTIVE_TURN = ['running', 'waiting_user'] as const

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function newSecret(): string {
  return randomBytes(32).toString('base64url')
}

export function sameSecret(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest())
}

/**
 * Runtime token: `<spaceId>.<random string>`. The prefix only locates the space database; validation uses the stored hash (RFC 0004 "Handshake and credentials").
 * When creating a runtime instance, the caller writes tokenHash to agent_instances and injects token into the Agent process via VIS_AGENT_TOKEN.
 */
export function issueAgentToken(spaceId: string): { token: string; tokenHash: string } {
  const token = `${spaceId}.${newSecret()}`
  return { token, tokenHash: hashToken(token) }
}

export function spaceIdOfToken(token: string): string | undefined {
  const dot = token.indexOf('.')
  return dot > 0 ? token.slice(0, dot) : undefined
}

/** The active runtime instance for a token; the token expires when the instance exits. */
export function findAgentInstance(tx: SpaceTx, token: string) {
  return tx.select({ id: s.agentInstances.id, sessionId: s.agentInstances.sessionId }).from(s.agentInstances)
    .innerJoin(s.sessions, eq(s.sessions.id, s.agentInstances.sessionId))
    .where(and(eq(s.agentInstances.tokenHash, hashToken(token)), inArray(s.agentInstances.status, [...ACTIVE_INSTANCE]), isNull(s.sessions.archivedAt)))
    .get()
}

/** The current turn of the runtime instance; rechecked on every call so the token cannot operate on the space after the turn ends. */
export function findInstanceTurn(tx: SpaceTx, instanceId: string) {
  const instance = tx.select({ id: s.agentInstances.id }).from(s.agentInstances)
    .where(and(eq(s.agentInstances.id, instanceId), inArray(s.agentInstances.status, [...ACTIVE_INSTANCE]))).get()
  if (!instance) return undefined
  return tx.select({ turnId: s.turns.id, inputSnapshotId: s.turns.inputSnapshotId }).from(s.turns)
    .where(and(eq(s.turns.instanceId, instanceId), inArray(s.turns.status, [...ACTIVE_TURN]))).get()
}
