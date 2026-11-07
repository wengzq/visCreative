import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { VisError } from '@vis/domain'
import type { SpaceTx } from './events'
import type { SpaceDb } from './open'
import { idempotencyKeys } from './schema/space'
import { isLegacyWorkspaceRequest } from './migrate-workspaces'

/** JSON with sorted keys makes parameter fingerprints independent of field order. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function fingerprint(method: string, params: unknown): string {
  return createHash('sha256').update(method).update('\0').update(canonicalJson(params)).digest('hex')
}

/**
 * Execute changes in one write transaction and deduplicate by requestId (RFC 0003 "Common rules"):
 * The same requestId and content return the first result; different content throws idempotency_conflict.
 * If fn throws, the transaction rolls back without registering requestId, allowing the caller to retry with the same requestId.
 */
export function runIdempotent<T>(
  db: SpaceDb,
  request: { requestId: string; method: string; params: unknown },
  fn: (tx: SpaceTx) => T,
  now: () => number = Date.now,
): T {
  const fp = fingerprint(request.method, request.params)
  return db.transaction(
    tx => {
      const existing = tx.select().from(idempotencyKeys).where(eq(idempotencyKeys.requestId, request.requestId)).get()
      if (existing) {
        if (existing.method !== request.method || existing.fingerprint !== fp) {
          throw VisError.of('idempotency_conflict', 'request.id_conflict', { requestId: request.requestId }, `requestId ${request.requestId} has already been used for a different request`)
        }
        // Legacy stop and recall plans must still finish; protocol upgrades must not leave jobs running.
        if (isLegacyWorkspaceRequest(tx, request.requestId) && !['work.recall', 'work.delete', 'session.stop', 'generation.cancel'].includes(request.method)) {
          throw VisError.of('request_not_replayable', 'request.legacy_not_replayable', {}, 'This request was executed before the protocol upgrade and its old result cannot be replayed; reread the current state without executing the operation again')
        }
        return existing.result as T
      }
      const result = fn(tx)
      tx.insert(idempotencyKeys)
        .values({ requestId: request.requestId, method: request.method, fingerprint: fp, result: result ?? null, createdAt: now() })
        .run()
      return result
    },
    { behavior: 'immediate' },
  )
}
