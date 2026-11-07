import Database from 'better-sqlite3'

export class LockHeldError extends Error {
  constructor(readonly file: string) {
    super(`Lock ${file} is already held by another process`)
    this.name = 'LockHeldError'
  }
}

/**
 * Process-level mutex: open and hold an exclusive transaction on a SQLite file.
 * The OS holds the lock and releases it on process exit (including crashes), leaving no stale files whose validity needs checking.
 * A second connection in the same process also cannot acquire the lock.
 */
export function acquireFileLock(file: string): { release(): void } {
  const client = new Database(file)
  client.pragma('busy_timeout = 0')
  try {
    client.exec('BEGIN EXCLUSIVE')
  } catch (error) {
    client.close()
    if ((error as { code?: string }).code === 'SQLITE_BUSY') throw new LockHeldError(file)
    throw error
  }
  let released = false
  return {
    release() {
      if (released) return
      released = true
      client.exec('ROLLBACK')
      client.close()
    },
  }
}
