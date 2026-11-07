import { existsSync } from 'node:fs'
import { writingWordCount } from '@vis/protocol'
import { and, asc, eq, isNull, ne, openSpaceDbReadOnly, spaceSchema as s, type SpaceDb } from '@vis/storage'

/** A read-only handle avoids starting another episode's agents, recovery or database migrations. */
export function readSeriesTexts(file: string, opened?: SpaceDb) {
  if (!opened && !existsSync(file)) return []
  const db = opened ?? openSpaceDbReadOnly(file)
  try {
    return db.transaction(tx => tx.select({ nodeId: s.nodes.id, slotId: s.slots.id, title: s.nodes.title, revision: s.slots.currentRevision, body: s.slotRevisions.textBody, format: s.nodes.format })
      .from(s.nodes).innerJoin(s.slots, eq(s.slots.nodeId, s.nodes.id))
      .innerJoin(s.slotRevisions, and(eq(s.slotRevisions.slotId, s.slots.id), eq(s.slotRevisions.revision, s.slots.currentRevision)))
      .where(and(eq(s.nodes.kind, 'text'), ne(s.nodes.format, 'code'), ne(s.nodes.purpose, 'working'), eq(s.slots.slotKey, 'main'), isNull(s.nodes.deletedAt), isNull(s.slots.deletedAt)))
      .orderBy(asc(s.nodes.createdAt), asc(s.nodes.id)).all().map(row => ({ ...row, format: row.format as 'markdown' | 'plain', body: row.body ?? '', words: writingWordCount(row.body ?? '') })))
  } finally { if (!opened) db.$client.close() }
}
