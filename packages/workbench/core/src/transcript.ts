import { newId } from '@vis/domain'
import type { TranscriptItem } from '@vis/protocol'
import { and, appendEvent, desc, eq, lt, max, spaceSchema as s, type SpaceTx } from '@vis/storage'
import type { TranscriptItemKind } from './runtime-port'

type Row = typeof s.transcriptEntries.$inferSelect

export function toItem(r: Row): TranscriptItem {
  return {
    itemId: r.itemId,
    createdSeq: r.createdSeq,
    revision: r.revision,
    turnId: r.turnId,
    kind: r.kind,
    payload: r.payload,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }
}

/**
 * Write transcript entries (0002 "Responsibilities of Transcripts and Claude Context"):
 * append new entries; existing entries accept only higher revisions and discard late older revisions; display order always follows the first creation sequence.
 * Return whether a write occurred.
 */
export function upsertItem(
  tx: SpaceTx,
  item: { sessionId: string; itemId: string; revision: number; turnId: string | null; kind: TranscriptItemKind; payload: unknown },
  now: number,
): boolean {
  const existing = tx
    .select()
    .from(s.transcriptEntries)
    .where(and(eq(s.transcriptEntries.sessionId, item.sessionId), eq(s.transcriptEntries.itemId, item.itemId)))
    .get()
  let row: Row
  if (!existing) {
    const seq = (tx.select({ m: max(s.transcriptEntries.createdSeq) }).from(s.transcriptEntries).where(eq(s.transcriptEntries.sessionId, item.sessionId)).get()?.m ?? 0) + 1
    row = { ...item, createdSeq: seq, createdAt: now, updatedAt: now }
    tx.insert(s.transcriptEntries).values(row).run()
  } else {
    if (item.revision <= existing.revision) return false
    row = { ...existing, revision: item.revision, payload: item.payload, kind: item.kind, updatedAt: now }
    tx.update(s.transcriptEntries)
      .set({ revision: row.revision, payload: row.payload, kind: row.kind, updatedAt: now })
      .where(and(eq(s.transcriptEntries.sessionId, item.sessionId), eq(s.transcriptEntries.itemId, item.itemId)))
      .run()
  }
  appendEvent(tx, { type: 'transcript.itemUpserted', entityType: 'session', entityId: item.sessionId, payload: toItem(row) }, now)
  return true
}

export function appendNotice(tx: SpaceTx, sessionId: string, turnId: string | null, code: string, message: string, now: number, details?: { reason: string; params: Record<string, string | number>; cause?: unknown }): void {
  upsertItem(tx, { sessionId, itemId: newId('transcriptItem', now), revision: 1, turnId, kind: 'notice', payload: { code, message, ...details } }, now)
}

export function readTranscript(tx: SpaceTx, sessionId: string, beforeSeq: number | undefined, limit: number) {
  const rows = tx
    .select()
    .from(s.transcriptEntries)
    .where(and(eq(s.transcriptEntries.sessionId, sessionId), beforeSeq !== undefined ? lt(s.transcriptEntries.createdSeq, beforeSeq) : undefined))
    .orderBy(desc(s.transcriptEntries.createdSeq))
    .limit(limit + 1)
    .all()
  const items = rows.slice(0, limit).reverse().map(row => {
    const item = toItem(row)
    if (item.kind !== 'user') return item
    const payload = item.payload as { messageId?: string }
    const message = payload.messageId ? tx.select({ deliveryState: s.messages.deliveryState, workDeliveryId: s.messages.workDeliveryId }).from(s.messages).where(eq(s.messages.id, payload.messageId)).get() : undefined
    return message ? { ...item, payload: { ...payload, deliveryState: message.deliveryState, ...(message.workDeliveryId ? { workDeliveryId: message.workDeliveryId } : {}) } } : item
  })
  return { items, hasMore: rows.length > limit }
}
