import Database from 'better-sqlite3'
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { fileURLToPath } from 'node:url'
import * as appSchema from './schema/app'
import * as spaceSchema from './schema/space'
import * as seriesSchema from './schema/series'
import { migrateWorkspaces } from './migrate-workspaces'

export type SpaceDb = BetterSQLite3Database<typeof spaceSchema> & { $client: Database.Database }
export type AppDb = BetterSQLite3Database<typeof appSchema> & { $client: Database.Database }
export type SeriesDb = BetterSQLite3Database<typeof seriesSchema> & { $client: Database.Database }

// Ship the migrations directory with the package; copy it when bundling into Electron.
const migrationsDir = (name: 'space' | 'app' | 'series') => fileURLToPath(new URL(`../migrations/${name}`, import.meta.url))

function openClient(file: string): Database.Database {
  const client = new Database(file)
  try {
    // See RFC 0002 "Conventions": return success only after the commit decision is durable, hence FULL.
    client.pragma('journal_mode = WAL')
    client.pragma('synchronous = FULL')
    client.pragma('foreign_keys = ON')
    client.pragma('busy_timeout = 5000')
  } catch (error) {
    // Corrupt databases fail while setting pragmas; unclosed handles on Windows lock files and prevent directory deletion.
    client.close()
    throw error
  }
  return client
}

/** Open a space's space.db and run migrations. Only studiod should call this; `:memory:` is for tests. */
export function openSpaceDb(file: string): SpaceDb {
  const db = drizzle(openClient(file), { schema: spaceSchema })
  try {
    // drizzle table-rebuild migrations run in transactions; SQLite only allows toggling foreign key checks outside transactions.
    db.$client.pragma('foreign_keys = OFF')
    try {
      migrate(db, { migrationsFolder: migrationsDir('space') })
    } finally {
      db.$client.pragma('foreign_keys = ON')
    }
    if (db.$client.prepare('PRAGMA foreign_key_check').get()) throw new Error('Space database foreign key validation failed after migration')
    migrateWorkspaces(db)
    return db
  } catch (error) {
    db.$client.close()
    throw error
  }
}

/** Open the global app.db and run migrations. */
export function openAppDb(file: string): AppDb {
  const db = drizzle(openClient(file), { schema: appSchema })
  try {
    migrate(db, { migrationsFolder: migrationsDir('app') })
  } catch (error) {
    db.$client.close()
    throw error
  }
  return db
}

export function openSeriesDb(file: string): SeriesDb {
  const db = drizzle(openClient(file), { schema: seriesSchema })
  try {
    migrate(db, { migrationsFolder: migrationsDir('series') })
    return db
  } catch (error) {
    db.$client.close()
    throw error
  }
}


/** Read an episode without migrating it or changing its runtime state. */
export function openSpaceDbReadOnly(file: string): SpaceDb {
  const client = new Database(file, { readonly: true, fileMustExist: true })
  client.pragma('busy_timeout = 5000')
  return drizzle(client, { schema: spaceSchema })
}
