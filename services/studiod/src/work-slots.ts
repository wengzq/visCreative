import { VisError } from '@vis/domain'
import type { MethodParams, WorkSlotsView } from '@vis/protocol'
import { appSchema as a, eq, type AppDb } from '@vis/storage'

type QueuedWork = WorkSlotsView['queue'][number]
type SlotSource = {
  queue(): QueuedWork[]
  activate(spaceId: string, workItemId: string): void
}

// Immediate app.db write transactions serialize reservations across all projects; project state remains in each space.db.
export function createWorkSlots(db: AppDb, source: SlotSource, now = Date.now) {
  let draining = false
  const key = (spaceId?: string) => spaceId ? `work.slotLimit.${spaceId}` : 'work.slotLimit'
  function limit(spaceId?: string): number | null {
    const value = db.select().from(a.settings).where(eq(a.settings.key, key(spaceId))).get()?.value
    return typeof value === 'number' ? value : spaceId ? null : 6
  }
  function reserve(spaceId: string, workItemId: string) {
    return db.transaction(tx => {
      const rows = tx.select().from(a.workSlots).all()
      const existing = rows.find(row => row.workItemId === workItemId)
      if (existing) {
        if (existing.spaceId !== spaceId) throw VisError.of('forbidden', 'work.slot_other_project', {}, 'Work item slot belongs to another project')
        return true
      }
      const projectLimit = limit(spaceId)
      if (rows.length >= limit()! || (projectLimit !== null && rows.filter(row => row.spaceId === spaceId).length >= projectLimit)) return false
      tx.insert(a.workSlots).values({ workItemId, spaceId, acquiredAt: now() }).run()
      return true
    }, { behavior: 'immediate' })
  }
  function release(spaceId: string, workItemId: string) {
    db.transaction(tx => {
      const row = tx.select().from(a.workSlots).where(eq(a.workSlots.workItemId, workItemId)).get()
      if (row?.spaceId === spaceId) tx.delete(a.workSlots).where(eq(a.workSlots.workItemId, workItemId)).run()
    }, { behavior: 'immediate' })
  }
  function view(): WorkSlotsView {
    const rows = db.select().from(a.workSlots).all()
    return {
      used: rows.length, limit: limit()!,
      bySpace: db.select().from(a.spaces).all().filter(space => space.deletedAt === null).map(space => ({ spaceId: space.id, used: rows.filter(row => row.spaceId === space.id).length, limit: limit(space.id) })),
      queue: source.queue().sort((left, right) => left.waitingSince - right.waitingSince || left.workItemId.localeCompare(right.workItemId)),
    }
  }
  function drain() {
    if (draining) return
    draining = true
    try {
      for (const queued of view().queue) {
        if (!reserve(queued.spaceId, queued.workItemId)) continue
        try { source.activate(queued.spaceId, queued.workItemId) }
        catch (error) {
          release(queued.spaceId, queued.workItemId)
          // Removed adapters stay queued for reinstall without blocking other projects.
          if (error instanceof VisError && error.details?.reason === 'session.agent_unconfigured') continue
          throw error
        }
      }
    } finally { draining = false }
  }
  return {
    reserve, release, view, drain,
    setLimit(params: MethodParams<'work.setSlotLimit'>) {
      if (params.spaceId) {
        const space = db.select().from(a.spaces).where(eq(a.spaces.id, params.spaceId)).get()
        if (!space) throw VisError.of('not_found', 'space.not_found', {}, 'Project does not exist')
        if (space.deletedAt !== null) throw VisError.of('not_found', 'space.deleted', {}, 'Project has been deleted')
      }
      if (params.limit === null && !params.spaceId) throw VisError.of('invalid_params', 'work.slot_limit_required', {}, 'Global limit cannot be null')
      db.transaction(tx => {
        tx.insert(a.settings).values({ key: key(params.spaceId), value: params.limit }).onConflictDoUpdate({ target: a.settings.key, set: { value: params.limit } }).run()
      }, { behavior: 'immediate' })
      drain()
      return view()
    },
    reconcile(items: { spaceId: string; workItemId: string; acquiredAt: number }[]) {
      db.transaction(tx => {
        tx.delete(a.workSlots).run()
        for (const item of items) tx.insert(a.workSlots).values(item).run()
      }, { behavior: 'immediate' })
    },
  }
}
export type WorkSlots = ReturnType<typeof createWorkSlots>
