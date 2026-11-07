import { sql } from 'drizzle-orm'
import { integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import type { EntityKind } from '@vis/protocol'

export type SeriesMedia = {
  refId: string
  hash: string
  byteSize: number
  mime: string
  width?: number
  height?: number
  durationMs?: number
}

export const seriesEntities = sqliteTable('series_entities', {
  id: text('id').primaryKey(),
  kind: text('kind').$type<EntityKind>().notNull(),
  name: text('name').notNull(),
  createdAt: integer('created_at').notNull(),
  deletedAt: integer('deleted_at'),
}, t => [uniqueIndex('series_entities_live_kind_name').on(t.kind, sql`lower(trim(${t.name}))`).where(sql`${t.deletedAt} IS NULL`)])

export const seriesEntityRevisions = sqliteTable('series_entity_revisions', {
  seriesEntityId: text('series_entity_id').notNull().references(() => seriesEntities.id),
  revision: integer('revision').notNull(),
  name: text('name').notNull(),
  description: text('description').notNull(),
  refs: text('refs', { mode: 'json' }).$type<SeriesMedia[]>().notNull(),
  voice: text('voice', { mode: 'json' }).$type<SeriesMedia | null>(),
  publishedAt: integer('published_at').notNull(),
  publishedFromSpaceId: text('published_from_space_id'),
}, t => [primaryKey({ columns: [t.seriesEntityId, t.revision] })])

// Written with the immutable revision, before pinning its project copy, to recover cross-database retries.
export const seriesPublishRequests = sqliteTable('series_publish_requests', {
  requestId: text('request_id').primaryKey(),
  fingerprint: text('fingerprint').notNull(),
  seriesEntityId: text('series_entity_id').notNull().references(() => seriesEntities.id),
  revision: integer('revision').notNull(),
})
