import { asc, gt, max } from 'drizzle-orm'
import type { EventType } from '@vis/protocol'
import type { SpaceDb } from './open'
import { events } from './schema/space'

/** Query interface shared by transaction handles and db itself. */
export type SpaceTx = Pick<SpaceDb, 'select' | 'insert' | 'update' | 'delete' | 'query'>

export type NewEvent = {
  type: EventType
  entityType: string
  entityId: string
  payload: unknown
  operationId?: string
}

/** Register a persistent event in the same transaction as its business change. Returns the event sequence number. */
export function appendEvent(tx: SpaceTx, event: NewEvent, now: number = Date.now()): number {
  const row = tx
    .insert(events)
    .values({ ...event, operationId: event.operationId ?? null, createdAt: now })
    .returning({ seq: events.seq })
    .get()
  return row.seq
}

/** Current maximum sequence; read in the same transaction as the snapshot for a consistent subscription cursor. */
export function currentSeq(tx: SpaceTx): number {
  return tx.select({ seq: max(events.seq) }).from(events).get()?.seq ?? 0
}

export function readEventsAfter(tx: SpaceTx, afterSeq: number, limit = 500) {
  return tx.select().from(events).where(gt(events.seq, afterSeq)).orderBy(asc(events.seq)).limit(limit).all()
}
