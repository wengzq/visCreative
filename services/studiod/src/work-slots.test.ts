import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { appSchema as a, openAppDb, type AppDb } from '@vis/storage'
import type { WorkSlotsView } from '@vis/protocol'
import { createWorkSlots } from './work-slots'

let dir: string
let db: AppDb
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vis-work-slots-'))
  db = openAppDb(join(dir, 'app.db'))
  for (const id of ['a', 'b']) db.insert(a.spaces).values({ id, name: id, dir: id, createdAt: 1 }).run()
})
afterEach(() => { db.$client.close(); rmSync(dir, { recursive: true, force: true }) })

it('defaults to six global slots; repeated reservations and cross-project releases do not corrupt the ledger', () => {
  const slots = createWorkSlots(db, { queue: () => [], activate: () => {} })
  for (let i = 0; i < 6; i++) expect(slots.reserve('a', `work_${i}`)).toBe(true)
  expect(slots.reserve('a', 'work_0')).toBe(true)
  expect(slots.reserve('b', 'extra')).toBe(false)
  slots.release('b', 'work_0')
  expect(slots.view().used).toBe(6)
  slots.release('a', 'work_0')
  expect(slots.reserve('b', 'extra')).toBe(true)
})

it('cross-project FIFO skips a head item at its project limit and automatically fills slots after release', () => {
  let queue: WorkSlotsView['queue'] = []
  const activated: string[] = []
  const slots = createWorkSlots(db, { queue: () => queue, activate: (_space, id) => {
    activated.push(id)
    queue = queue.filter(row => row.workItemId !== id)
  } })
  slots.setLimit({ limit: 2 })
  slots.setLimit({ spaceId: 'a', limit: 1 })
  slots.reserve('a', 'active')
  queue = [
    { spaceId: 'a', workItemId: 'first', title: 'first', waitingSince: 1 },
    { spaceId: 'b', workItemId: 'second', title: 'second', waitingSince: 2 },
    { spaceId: 'b', workItemId: 'third', title: 'third', waitingSince: 3 },
  ]
  slots.drain()
  expect(activated).toEqual(['second'])
  slots.release('a', 'active')
  slots.drain()
  expect(activated).toEqual(['second', 'first'])
  expect(slots.view().queue.map(row => row.workItemId)).toEqual(['third'])
})

it('startup rebuild replaces old reservations and retains actual reservations exceeding the new limit', () => {
  const slots = createWorkSlots(db, { queue: () => [], activate: () => {} })
  slots.reserve('a', 'stale')
  slots.setLimit({ limit: 1 })
  slots.reconcile([{ spaceId: 'a', workItemId: 'one', acquiredAt: 1 }, { spaceId: 'b', workItemId: 'two', acquiredAt: 2 }])
  expect(slots.view().used).toBe(2)
  expect(slots.reserve('b', 'three')).toBe(false)
  expect(db.select().from(a.workSlots).all().map(row => row.workItemId)).toEqual(['one', 'two'])
})

it('activation failure withdraws reservations; rebuild failure rolls back to the old ledger', () => {
  const slots = createWorkSlots(db, { queue: () => [{ spaceId: 'a', workItemId: 'bad', title: 'bad', waitingSince: 1 }], activate: () => { throw new Error('failed') } })
  expect(() => slots.drain()).toThrow('failed')
  expect(slots.view().used).toBe(0)
  slots.reserve('a', 'old')
  expect(() => slots.reconcile([{ spaceId: 'missing', workItemId: 'new', acquiredAt: 2 }])).toThrow()
  expect(slots.view().used).toBe(1)
})
