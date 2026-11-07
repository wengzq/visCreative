import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { acquireFileLock, LockHeldError } from './lock'

let dir: string
let file: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vis-lock-'))
  file = join(dir, 'studiod.lock')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** Try acquiring the lock in another process; when release is false, exit without releasing it to simulate a crash. */
function otherProcess(release: boolean): string {
  const script = `
    const Database = require('better-sqlite3')
    const db = new Database(process.argv[1]); db.pragma('busy_timeout = 0')
    try { db.exec('BEGIN EXCLUSIVE'); process.stdout.write('acquired') } catch (e) { process.stdout.write(e.code) }
    if (${release}) { try { db.exec('ROLLBACK') } catch {} db.close() }
    process.exit(0)`
  const cwd = fileURLToPath(new URL('..', import.meta.url))
  return spawnSync(process.execPath, ['-e', script, file], { cwd, encoding: 'utf8' }).stdout
}

it('a second lock acquisition in the same process fails; acquisition succeeds after release', () => {
  const lock = acquireFileLock(file)
  expect(() => acquireFileLock(file)).toThrow(LockHeldError)
  lock.release()
  acquireFileLock(file).release()
})

it('another process cannot acquire the lock', () => {
  const lock = acquireFileLock(file)
  expect(otherProcess(true)).toBe('SQLITE_BUSY')
  lock.release()
  expect(otherProcess(true)).toBe('acquired')
})

it('the lock releases automatically when its process exits, without stale-file cleanup', () => {
  expect(otherProcess(false)).toBe('acquired')
  acquireFileLock(file).release()
})
