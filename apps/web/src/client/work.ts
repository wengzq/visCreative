import type { MethodParams, SpaceEvent, SpaceSnapshot, WorkInboxCounts, WorkItemView, WorkMessageView, WorkSlotsView } from '@vis/protocol'
import { RpcError, type RpcClient } from './rpc'

export type WorkState = {
  seq: number
  items: ReadonlyMap<string, WorkItemView>
  deletedIds: ReadonlySet<string>
  inboxCounts: WorkInboxCounts | null
  slots: WorkSlotsView | null
  /** Message changes invalidate only open details; work.itemChanged is authoritative for cards. */
  messageVersions: ReadonlyMap<string, number>
  /** While the inbox is open, reread on version changes and preserve items handled during this opening. */
  inboxVersion: number
}

export const emptyWork = (): WorkState => ({ seq: 0, items: new Map(), deletedIds: new Set(), inboxCounts: null, slots: null, messageVersions: new Map(), inboxVersion: 0 })

/** Complete current-project snapshots replace cards; project switches do not clear global counts. */
export function fromWorkSnapshot(snapshot: Pick<SpaceSnapshot, 'workItems'>, seq: number, previous = emptyWork()): WorkState {
  return { ...previous, seq, items: new Map(snapshot.workItems.filter(item => item.archivedAt === null && !previous.deletedIds.has(item.workItemId)).map(item => [item.workItemId, item])), messageVersions: new Map() }
}

/** Deletion is irreversible; retain tombstones to prevent pre-deletion reads from restoring cards. */
export function removeWorkItems(state: WorkState, ids: readonly string[]): WorkState {
  const items = new Map(state.items)
  const deletedIds = new Set(state.deletedIds)
  for (const id of ids) { items.delete(id); deletedIds.add(id) }
  return { ...state, items, deletedIds }
}

/** RPC acknowledgments accept only higher revisions so late reads cannot overwrite new cards.
 * Events are ordered by seq: unread counts, activity, and doing derive from messages and turns without revision bumps, so equal revisions also replace. */
export function upsertWorkItem(state: WorkState, item: WorkItemView, fromEvent = false): WorkState {
  if (state.deletedIds.has(item.workItemId)) return state
  const current = state.items.get(item.workItemId)
  if (current && (fromEvent ? current.revision > item.revision : current.revision >= item.revision)) return state
  if (item.archivedAt !== null) return removeWorkItems(state, [item.workItemId])
  return { ...state, items: new Map(state.items).set(item.workItemId, item) }
}

/** All space events advance the watermark so duplicate deliveries do not refresh messages twice. */
export function applyWorkEvent(state: WorkState, event: SpaceEvent): WorkState {
  if (event.seq <= state.seq) return state
  const next = { ...state, seq: event.seq }
  if (event.type === 'work.itemChanged') return upsertWorkItem(next, event.payload as WorkItemView, true)
  if (event.type === 'work.messageAdded' || event.type === 'work.messageAcked') {
    const { workItemId } = event.payload as Pick<WorkMessageView, 'workItemId'>
    return {
      ...next,
      messageVersions: new Map(state.messageVersions).set(workItemId, (state.messageVersions.get(workItemId) ?? 0) + 1),
      inboxVersion: state.inboxVersion + 1,
    }
  }
  return next
}

/** Global notifications do not derive or modify current-project cards. */
export function setWorkInboxCounts(state: WorkState, inboxCounts: WorkInboxCounts): WorkState {
  return { ...state, inboxCounts, inboxVersion: state.inboxVersion + 1 }
}

export function setWorkSlots(state: WorkState, slots: WorkSlotsView): WorkState {
  return { ...state, slots }
}

/** Derived fields also advance revisions: user title and pin intent can reread and retry once. */
export async function updateWorkItem(rpc: RpcClient, item: WorkItemView, patch: Partial<Pick<MethodParams<'work.update'>, 'title' | 'brief' | 'pinned' | 'reviewBy'>>, onRefresh: (item: WorkItemView) => void): Promise<WorkItemView> {
  const target = { spaceId: item.spaceId, workItemId: item.workItemId }
  const call = (revision: number) => rpc.call<WorkItemView>('work.update', { ...target, requestId: `web-${crypto.randomUUID()}`, expectedRevision: revision, ...patch })
  try { return await call(item.revision) }
  catch (error) {
    if (!(error instanceof RpcError) || error.code !== 'revision_conflict' || (!('title' in patch) && !('pinned' in patch))) throw error
    const fresh = await rpc.call<{ item: WorkItemView }>('work.get', target)
    onRefresh(fresh.item)
    return call(fresh.item.revision)
  }
}

/** State transitions: the backend also increments revision when derived fields such as unread counts and activity change.
 * Reread after conflicts and retry once with the new revision if status is unchanged; changed status is a real conflict for the caller to report. */
export async function transitionWorkItem<T = any>(rpc: RpcClient, item: WorkItemView, method: string, extra: Record<string, unknown>, onRefresh: (item: WorkItemView) => void): Promise<T> {
  const target = { spaceId: item.spaceId, workItemId: item.workItemId }
  const call = (revision: number) => rpc.call<T>(`work.${method}`, { ...target, requestId: `web-${crypto.randomUUID()}`, expectedRevision: revision, ...extra })
  try { return await call(item.revision) }
  catch (error) {
    if (!(error instanceof RpcError) || error.code !== 'revision_conflict') throw error
    const fresh = await rpc.call<{ item: WorkItemView }>('work.get', target)
    onRefresh(fresh.item)
    if (fresh.item.status !== item.status) throw error
    return call(fresh.item.revision)
  }
}
