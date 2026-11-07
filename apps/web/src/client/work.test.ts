import type { SpaceEvent, WorkInboxCounts, WorkItemView, WorkSlotsView } from '@vis/protocol'
import { describe, expect, it, vi } from 'vitest'
import { applyWorkEvent, emptyWork, fromWorkSnapshot, removeWorkItems, setWorkInboxCounts, setWorkSlots, upsertWorkItem, transitionWorkItem, updateWorkItem } from './work'
import { RpcError } from './rpc'

const item = (workItemId: string, revision = 1, patch: Partial<WorkItemView> = {}): WorkItemView => ({
  workItemId, spaceId: 'space', parentId: null, childIds: [], title: workItemId, brief: '', status: 'todo', pinned: false,
  reviewBy: 'user', workDir: '/work', createdBy: { kind: 'user' }, revision, activationSeq: null,
  waitingSlotSince: null, pendingFeedback: false, reviewReportId: null, activity: 'idle', sessions: [], unreadCount: 0, unresolvedCount: 0,
  waitingOn: null, todayGenerations: 0, changeCount: 0, lastChangeSeq: null, statusChangedAt: 1, createdAt: 1, archivedAt: null,
  ...patch,
})
const event = (seq: number, type: SpaceEvent['type'], payload: unknown): SpaceEvent => ({ seq, type, entityType: 'work', entityId: 'entity', payload })
const counts: WorkInboxCounts = { unread: 5, unresolved: 2, bySpace: [{ spaceId: 'other-space', unread: 5, unresolved: 2 }] }
const slots: WorkSlotsView = { used: 2, limit: 4, bySpace: [{ spaceId: 'other-space', used: 2, limit: null }], queue: [] }

describe('Work-item state merging', () => {
  it('snapshots replace current-project cards and refresh markers while preserving global counts', () => {
    const previous = applyWorkEvent(setWorkSlots(setWorkInboxCounts(fromWorkSnapshot({ workItems: [item('old')] }, 10), counts), slots), event(11, 'work.messageAdded', { workItemId: 'old' }))
    const next = fromWorkSnapshot({ workItems: [item('new', 3)] }, 20, previous)
    expect([...next.items.keys()]).toEqual(['new'])
    expect(next.seq).toBe(20)
    expect(next.messageVersions.size).toBe(0)
    expect(next.inboxCounts).toBe(counts)
    expect(next.slots).toBe(slots)
    expect([...previous.items.keys()]).toEqual(['old'])
    expect(previous.messageVersions.get('old')).toBe(1)
  })

  it('full-card replacements accept only higher revisions; neither RPC reads nor events can roll cards back', () => {
    const original = item('one', 2, { unreadCount: 4, unresolvedCount: 1, waitingOn: { messageId: 'question', kind: 'question', excerpt: '请确认' } })
    const base = fromWorkSnapshot({ workItems: [original, item('two')] }, 10)
    const replacement = item('one', 3, { status: 'done' })
    const next = applyWorkEvent(base, event(11, 'work.itemChanged', replacement))
    expect(next.items.get('one')).toBe(replacement)
    expect(next.items.get('one')).toMatchObject({ status: 'done', unreadCount: 0, unresolvedCount: 0, waitingOn: null, archivedAt: null })
    expect(next.items.get('two')).toBe(base.items.get('two'))
    expect(base.items.get('one')).toBe(original)
    expect(upsertWorkItem(next, item('one', 2))).toBe(next)
    expect(upsertWorkItem(next, item('one', 3, { title: '同修订的迟到读取' }))).toBe(next)
    // Events with the same revision can change derived fields and must replace the card
    const counted = item('one', 3, { status: 'done', unreadCount: 2 })
    expect(applyWorkEvent(next, event(12, 'work.itemChanged', counted)).items.get('one')).toBe(counted)
    const stale = applyWorkEvent(next, event(12, 'work.itemChanged', item('one', 1)))
    expect(stale.seq).toBe(12)
    expect(stale.items).toBe(next.items)
    expect(upsertWorkItem(stale, item('new')).items.has('new')).toBe(true)
  })

  it('deletion tombstones remove cards; late reads, events, and snapshots cannot restore deleted work items', () => {
    const base = fromWorkSnapshot({ workItems: [item('parent'), item('child'), item('keep')] }, 10)
    const deleted = applyWorkEvent(base, event(11, 'work.itemChanged', item('parent', 2, { archivedAt: 30 })))
    expect([...deleted.items.keys()]).toEqual(['child', 'keep'])
    expect(deleted.deletedIds.has('parent')).toBe(true)
    expect(upsertWorkItem(deleted, item('parent', 9))).toBe(deleted)
    const cascade = removeWorkItems(deleted, ['parent', 'child', 'not-loaded'])
    expect([...cascade.items.keys()]).toEqual(['keep'])
    expect(cascade.deletedIds.has('not-loaded')).toBe(true)
    expect(applyWorkEvent(cascade, event(12, 'work.itemChanged', item('child', 9))).items.has('child')).toBe(false)
    expect([...fromWorkSnapshot({ workItems: [item('parent'), item('keep'), item('archived', 2, { archivedAt: 30 })] }, 20, cascade).items.keys()]).toEqual(['keep'])
    expect(base.items.size).toBe(3)
  })

  it('duplicate and stale events return unchanged; other events also advance the deduplication watermark', () => {
    const base = fromWorkSnapshot({ workItems: [item('one')] }, 10)
    expect(applyWorkEvent(base, event(10, 'work.itemChanged', item('one', 5)))).toBe(base)
    const next = applyWorkEvent(base, event(12, 'session.updated', {}))
    expect(next.seq).toBe(12)
    expect(next.items).toBe(base.items)
    expect(applyWorkEvent(next, event(11, 'work.messageAdded', { workItemId: 'one' }))).toBe(next)
  })

  it('message events refresh only corresponding details and inbox without changing authoritative cards or global counts', () => {
    const base = setWorkInboxCounts(fromWorkSnapshot({ workItems: [item('one', 3)] }, 10), counts)
    const added = applyWorkEvent(base, event(11, 'work.messageAdded', { workItemId: 'one', unreadCount: 99, unresolvedCount: 99, waitingOn: { excerpt: '不能据此推算' } }))
    expect(added.items).toBe(base.items)
    expect(added.items.get('one')?.unreadCount).toBe(0)
    expect(added.inboxCounts).toBe(counts)
    expect(added.messageVersions.get('one')).toBe(1)
    expect(added.inboxVersion).toBe(base.inboxVersion + 1)
    expect(base.messageVersions.size).toBe(0)
    expect(applyWorkEvent(added, event(11, 'work.messageAdded', { workItemId: 'one' }))).toBe(added)
    const acked = applyWorkEvent(added, event(12, 'work.messageAcked', { workItemId: 'one' }))
    expect(acked.messageVersions.get('one')).toBe(2)
    expect(acked.items).toBe(base.items)
    const other = applyWorkEvent(acked, event(13, 'work.messageAdded', { workItemId: 'two' }))
    expect(other.messageVersions.get('one')).toBe(2)
    expect(other.messageVersions.get('two')).toBe(1)
    expect(other.items.has('two')).toBe(false)
  })

  it('cross-project global notifications replace only counts and slots and mark the inbox for rereading', () => {
    const base = fromWorkSnapshot({ workItems: [item('one', 1, { unreadCount: 1, unresolvedCount: 1 })] }, 10)
    const inbox = setWorkInboxCounts(base, counts)
    const next = setWorkSlots(inbox, slots)
    expect(next.items).toBe(base.items)
    expect(next.items.get('one')).toMatchObject({ unreadCount: 1, unresolvedCount: 1 })
    expect(next.seq).toBe(10)
    expect(next.inboxCounts).toBe(counts)
    expect(next.slots).toBe(slots)
    expect(next.inboxVersion).toBe(1)
    expect(next.messageVersions).toBe(base.messageVersions)
    expect(base.inboxCounts).toBeNull()
    expect(base.slots).toBeNull()
    expect(setWorkInboxCounts(next, counts).inboxVersion).toBe(2)
    expect(emptyWork().inboxVersion).toBe(0)
  })
})


describe('work.update conflict retries', () => {
  it.each([{ title: '新标题' }, { pinned: true }])('rereads and retries user intent %j with a new revision and request ID', async patch => {
    const changed = item('one', 3, patch)
    const call = vi.fn().mockRejectedValueOnce(new RpcError('revision_conflict', 'changed')).mockResolvedValueOnce({ item: item('one', 2) }).mockResolvedValueOnce(changed)
    const refresh = vi.fn()
    expect(await updateWorkItem({ call, close() {} }, item('one'), patch, refresh)).toBe(changed)
    expect(call.mock.calls[0]).toEqual(['work.update', expect.objectContaining({ spaceId: 'space', workItemId: 'one', expectedRevision: 1, ...patch })])
    expect(call.mock.calls[1]).toEqual(['work.get', { spaceId: 'space', workItemId: 'one' }])
    expect(call.mock.calls[2]).toEqual(['work.update', expect.objectContaining({ expectedRevision: 2, ...patch })])
    expect(call.mock.calls[0]![1].requestId).not.toBe(call.mock.calls[2]![1].requestId)
    expect(refresh).toHaveBeenCalledWith(item('one', 2))
  })

  it('does not retry a second conflict or permission errors', async () => {
    const conflict = new RpcError('revision_conflict', 'changed')
    const call = vi.fn().mockRejectedValueOnce(conflict).mockResolvedValueOnce({ item: item('one', 2) }).mockRejectedValueOnce(conflict)
    await expect(updateWorkItem({ call, close() {} }, item('one'), { pinned: true }, () => {})).rejects.toBe(conflict)
    expect(call).toHaveBeenCalledTimes(3)
    for (const [patch, error] of [[{ title: '新标题' }, new RpcError('forbidden', 'no')]] as const) {
      const fail = vi.fn().mockRejectedValue(error)
      await expect(updateWorkItem({ call: fail, close() {} }, item('one'), patch, () => {})).rejects.toBe(error)
      expect(fail).toHaveBeenCalledTimes(1)
    }
  })
})

describe('State-transition conflict retries', () => {
  it('retries once with a new revision and request ID when only derived fields change and status stays the same', async () => {
    const done = { item: item('one', 3, { status: 'done' }), queued: false }
    const call = vi.fn().mockRejectedValueOnce(new RpcError('revision_conflict', 'changed')).mockResolvedValueOnce({ item: item('one', 2, { status: 'in_review' }) }).mockResolvedValueOnce(done)
    const refresh = vi.fn()
    expect(await transitionWorkItem({ call, close() {} }, item('one', 1, { status: 'in_review' }), 'review', { decision: 'approve' }, refresh)).toBe(done)
    expect(call.mock.calls[0]).toEqual(['work.review', expect.objectContaining({ workItemId: 'one', expectedRevision: 1, decision: 'approve' })])
    expect(call.mock.calls[2]).toEqual(['work.review', expect.objectContaining({ expectedRevision: 2, decision: 'approve' })])
    expect(call.mock.calls[0]![1].requestId).not.toBe(call.mock.calls[2]![1].requestId)
    expect(refresh).toHaveBeenCalledOnce()
  })

  it('does not retry when someone else changed status; other errors propagate directly', async () => {
    const conflict = new RpcError('revision_conflict', 'changed')
    const call = vi.fn().mockRejectedValueOnce(conflict).mockResolvedValueOnce({ item: item('one', 2, { status: 'done' }) })
    await expect(transitionWorkItem({ call, close() {} }, item('one', 1, { status: 'in_review' }), 'review', { decision: 'approve' }, () => {})).rejects.toBe(conflict)
    expect(call).toHaveBeenCalledTimes(2)
    const forbidden = new RpcError('forbidden', 'no')
    const fail = vi.fn().mockRejectedValue(forbidden)
    await expect(transitionWorkItem({ call: fail, close() {} }, item('one'), 'activate', {}, () => {})).rejects.toBe(forbidden)
    expect(fail).toHaveBeenCalledTimes(1)
  })
})
