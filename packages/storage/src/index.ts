// Persistence abstraction and event store (sequences, cursors, replay). Storage choices affect only this package. See docs/rfc/0002.
export * as spaceSchema from './schema/space'
export * as appSchema from './schema/app'
export * as seriesSchema from './schema/series'
export * from './open'
export * from './events'
export * from './idempotency'
export { workspaceMigrationBoundary, isLegacyWorkspaceRequest } from './migrate-workspaces'
export * from './work-messages'
export { acquireFileLock, LockHeldError } from './lock'
// Import query operators here so service packages do not depend directly on drizzle-orm.
export { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, max, min, ne, notInArray, or, sql } from 'drizzle-orm'
