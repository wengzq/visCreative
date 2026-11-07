import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { appSchema as a, eq, openAppDb } from '@vis/storage'
import { createSpaceLifecycle } from './space-lifecycle'

let dir: string
let db: ReturnType<typeof openAppDb>
let lifecycle: ReturnType<typeof createSpaceLifecycle>
const pending = { lifecycle: 'space.delete', spaceId: 'space_cached', finished: false }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vis-lifecycle-cache-'))
  db = openAppDb(join(dir, 'app.db'))
  lifecycle = createSpaceLifecycle({ db, dataDir: dir, projectsDir: join(dir, 'projects'), now: Date.now,
    open: () => undefined, close: async () => {}, drain() {},
  })
})

afterEach(() => {
  db.$client.close()
  rmSync(dir, { recursive: true, force: true })
})

it.each(['same', 'other'] as const)('caches unchanged recovery records and invalidates on %s-connection writes', writer => {
  const select = vi.spyOn(db, 'select')
  expect(lifecycle.pendingDelete('space_cached')).toBe(false)
  for (let index = 0; index < 10; index++) expect(lifecycle.pendingDelete('space_cached')).toBe(false)
  expect(select).toHaveBeenCalledTimes(1)
  const other = writer === 'other' ? openAppDb(join(dir, 'app.db')) : undefined
  try {
    const target = other ?? db
    target.insert(a.idempotencyKeys).values({ requestId: 'delete-cache', fingerprint: 'test', result: pending }).run()
    expect(lifecycle.pendingDelete('space_cached')).toBe(true)
    target.update(a.idempotencyKeys).set({ result: { ...pending, finished: true } }).where(eq(a.idempotencyKeys.requestId, 'delete-cache')).run()
    expect(lifecycle.pendingDelete('space_cached')).toBe(false)
    expect(select).toHaveBeenCalledTimes(3)
  } finally { other?.$client.close() }
})

it('does not retain pending recovery records from a rolled-back transaction', () => {
  expect(lifecycle.pendingDelete('space_cached')).toBe(false)
  expect(() => db.transaction(tx => {
    tx.insert(a.idempotencyKeys).values({ requestId: 'rollback-cache', fingerprint: 'test', result: pending }).run()
    expect(lifecycle.pendingDelete('space_cached')).toBe(true)
    throw new Error('Rollback test transaction')
  })).toThrow('Rollback test transaction')
  expect(lifecycle.pendingDelete('space_cached')).toBe(false)
})
