// app.db schema; see docs/rfc/0002-sqlite-storage.md.
import { sql } from 'drizzle-orm'
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

export const series = sqliteTable('series', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  createdAt: integer('created_at').notNull(),
  deletedAt: integer('deleted_at'),
}, t => [uniqueIndex('series_live_name').on(sql`lower(trim(${t.name}))`).where(sql`${t.deletedAt} IS NULL`)])

export const spaces = sqliteTable('spaces', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  dir: text('dir').notNull(),
  rootPath: text('root_path').notNull().default(''),
  createdAt: integer('created_at').notNull(),
  lastOpenedAt: integer('last_opened_at'),
  deletedAt: integer('deleted_at'),
  purgeError: text('purge_error'),
  seriesId: text('series_id').references(() => series.id),
  episode: integer('episode'),
  // Membership changes are recovered on the next open without starting closed projects.
  seriesDetachPending: integer('series_detach_pending', { mode: 'boolean' }).notNull().default(false),
}, t => [uniqueIndex('spaces_live_series_episode').on(t.seriesId, t.episode).where(sql`${t.deletedAt} IS NULL AND ${t.seriesId} IS NOT NULL`)])

export const idempotencyKeys = sqliteTable('idempotency_keys', {
  requestId: text('request_id').primaryKey(),
  fingerprint: text('fingerprint').notNull(),
  result: text('result', { mode: 'json' }).notNull(),
})

// Provider enabled state, default models, endpoints, etc.; no keys.
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).notNull(),
})

// Global ledger for paid generation; jobs and outputs remain in each space's space.db.
export const generationQuota = sqliteTable('generation_quota', {
  jobId: text('job_id').primaryKey(),
  spaceId: text('space_id').notNull(),
  kind: text('kind', { enum: ['image', 'video', 'audio'] }).notNull(),
  // Daily limits count only Agent-submitted jobs (0012); concurrency applies to all paid jobs.
  byAgent: integer('by_agent', { mode: 'boolean' }).notNull().default(false),
  date: text('date').notNull(),
  state: text('state', { enum: ['queued', 'active', 'released'] }).notNull(),
  createdAt: integer('created_at').notNull(),
}, t => [index('generation_quota_date_kind').on(t.date, t.kind)])

// Work items and queues belong to projects; executor slots are reserved and released in global write transactions.
export const workSlots = sqliteTable('work_slots', {
  workItemId: text('work_item_id').primaryKey(),
  spaceId: text('space_id').notNull().references(() => spaces.id),
  acquiredAt: integer('acquired_at').notNull(),
}, t => [index('work_slots_space').on(t.spaceId)])

// Author skills keep stable identities; versions are immutable content-addressed files (0033).
export const authorSkills = sqliteTable('author_skills', {
  addToNewProjects: integer('add_to_new_projects', { mode: 'boolean' }).notNull().default(false),
  deletedAt: integer('deleted_at'),
  id: text('id').primaryKey(),
  revision: integer('revision').notNull(),
  version: text('version').notNull(),
  name: text('name').notNull(),
  description: text('description').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
})

export const authorSkillVersions = sqliteTable('author_skill_versions', {
  id: text('id').primaryKey(),
  skillId: text('skill_id').notNull().references(() => authorSkills.id),
  contentHash: text('content_hash').notNull(),
  name: text('name').notNull(),
  description: text('description').notNull(),
  createdAt: integer('created_at').notNull(),
}, t => [uniqueIndex('author_skill_version_hash').on(t.skillId, t.contentHash)])

export const authorSkillDrafts = sqliteTable('author_skill_drafts', {
  status: text('status', { enum: ['draft', 'saved', 'discarded'] }).notNull().default('draft'),
  id: text('id').primaryKey(),
  revision: integer('revision').notNull(),
  name: text('name').notNull(),
  description: text('description').notNull(),
  body: text('body').notNull(),
  spaceId: text('space_id').notNull(),
  sessionId: text('session_id').notNull(),
  createdAt: integer('created_at').notNull(),
})

// Library changes are global; retain a sequence independently of any project's lifetime.
export const authorSkillEvents = sqliteTable('author_skill_events', {
  seq: integer('seq').primaryKey({ autoIncrement: true }),
  type: text('type').notNull(),
  payload: text('payload', { mode: 'json' }).notNull(),
  createdAt: integer('created_at').notNull(),
})
