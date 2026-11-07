import { and, asc, eq, isNotNull, isNull, ne, sql } from 'drizzle-orm'
import { VisError } from '@vis/domain'
import { appendEvent, type SpaceTx } from './events'
import { workMessages } from './schema/space'

export type WorkMessageRow = typeof workMessages.$inferSelect
export type WorkMessageBatch = { deliveryId: string; messages: WorkMessageRow[] }

/** Use the same write transaction as session queue insertion; deliveryId must be the newly created batch ID. */
export function claimWorkMessages(tx: SpaceTx, sessionId: string, deliveryId: string): WorkMessageRow[] {
  if (tx.select({ id: workMessages.id }).from(workMessages).where(eq(workMessages.deliveryId, deliveryId)).get()) {
    throw VisError.of('invalid_params', 'work.delivery_batch_exists', { deliveryId }, `Delivery batch already exists: ${deliveryId}`)
  }
  return tx.update(workMessages).set({ deliveryId }).where(and(
    eq(workMessages.targetSessionId, sessionId),
    ne(workMessages.to, 'user'),
    isNull(workMessages.deliveryId),
    isNull(workMessages.ackedAt),
  )).returning().all().sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
}

/** Mark the entire batch when the turn actually starts; duplicate notifications preserve the first delivery time. */
export function markWorkMessagesDelivered(tx: SpaceTx, sessionId: string, deliveryId: string, now = Date.now()): number {
  return tx.update(workMessages).set({ deliveredAt: now }).where(and(
    eq(workMessages.targetSessionId, sessionId),
    eq(workMessages.deliveryId, deliveryId),
    ne(workMessages.to, 'user'),
    isNull(workMessages.deliveredAt),
    isNull(workMessages.ackedAt),
  )).run().changes
}

/** Recover unacknowledged batches after failure or restart; started batches retain their IDs and are marked as redelivered. */
export function replayWorkMessages(tx: SpaceTx, sessionId: string): WorkMessageBatch[] {
  const messages = tx.update(workMessages).set({
    redelivered: sql`CASE WHEN ${workMessages.deliveredAt} IS NOT NULL THEN 1 ELSE ${workMessages.redelivered} END`,
  }).where(and(
    eq(workMessages.targetSessionId, sessionId),
    ne(workMessages.to, 'user'),
    isNotNull(workMessages.deliveryId),
    isNull(workMessages.ackedAt),
  )).returning().all().sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  const batches = new Map<string, WorkMessageBatch>()
  for (const message of messages) {
    const deliveryId = message.deliveryId!
    let batch = batches.get(deliveryId)
    if (!batch) {
      batch = { deliveryId, messages: [] }
      batches.set(deliveryId, batch)
    }
    batch.messages.push(message)
  }
  return [...batches.values()]
}

/** In the same write transaction as successful turn completion, acknowledge the whole batch and register an event; individual messages cannot be acknowledged. */
export function ackWorkMessages(tx: SpaceTx, sessionId: string, deliveryId: string, now = Date.now()): number {
  const messages = tx.update(workMessages).set({ ackedAt: now }).where(and(
    eq(workMessages.targetSessionId, sessionId),
    eq(workMessages.deliveryId, deliveryId),
    ne(workMessages.to, 'user'),
    isNotNull(workMessages.deliveredAt),
    isNull(workMessages.ackedAt),
  )).returning({ id: workMessages.id }).all()
  if (messages.length) appendEvent(tx, {
    type: 'work.messageAcked', entityType: 'work_message_batch', entityId: deliveryId,
    payload: { deliveryId, sessionId, messageIds: messages.map(message => message.id).sort(), ackedAt: now },
  }, now)
  return messages.length
}

export function readWorkMessageBatch(tx: SpaceTx, sessionId: string, deliveryId: string): WorkMessageRow[] {
  return tx.select().from(workMessages).where(and(
    eq(workMessages.targetSessionId, sessionId),
    eq(workMessages.deliveryId, deliveryId),
    ne(workMessages.to, 'user'),
  )).orderBy(asc(workMessages.createdAt), asc(workMessages.id)).all()
}
