import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { appSchema as a, openAppDb } from '@vis/storage'
import { databaseVersion } from './database-version'

let dir: string
let db: ReturnType<typeof openAppDb>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vis-db-version-'))
  db = openAppDb(join(dir, 'app.db'))
})

afterEach(() => {
  db.$client.close()
  rmSync(dir, { recursive: true, force: true })
})

it('reuses one probe per connection and observes local and external writes', () => {
  const prepare = vi.spyOn(db.$client, 'prepare')
  const initial = databaseVersion(db)
  expect(databaseVersion(db)).toBe(initial)
  expect(prepare).toHaveBeenCalledTimes(1)
  db.insert(a.settings).values({ key: 'local', value: 1 }).run()
  const local = databaseVersion(db)
  expect(local).not.toBe(initial)
  const other = openAppDb(join(dir, 'app.db'))
  try {
    other.insert(a.settings).values({ key: 'external', value: 2 }).run()
    expect(databaseVersion(db)).not.toBe(local)
  } finally { other.$client.close() }
})

it('returns no cacheable token inside transactions, including writes later rolled back', () => {
  const initial = databaseVersion(db)
  expect(() => db.transaction(tx => {
    expect(databaseVersion(db)).toBeUndefined()
    tx.insert(a.settings).values({ key: 'rollback', value: 1 }).run()
    expect(databaseVersion(db)).toBeUndefined()
    throw new Error('Rollback version test')
  })).toThrow('Rollback version test')
  expect(databaseVersion(db)).not.toBe(initial)
  expect(db.select().from(a.settings).all()).toHaveLength(0)
  expect(databaseVersion(db)).toBeDefined()
})
