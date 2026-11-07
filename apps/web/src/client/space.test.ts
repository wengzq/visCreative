import type { JobView, NodeView, SessionSummary, SlotVersionView, SpaceEvent, TranscriptItem, WorkInboxCounts, WorkItemView, WorkSlotsView } from '@vis/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { connectRpc } from './rpc'
import { describeSpaceError, openSpace } from './space'
import { applyEvent, emptyState, fromSnapshot } from './store'

vi.mock('./rpc', () => ({ connectRpc: vi.fn() }))

const version = (revision: number): SlotVersionView => ({ revision, content: { type: 'asset', assetVersionId: `asset-${revision}`, mime: 'image/png' }, createdAt: revision, actor: 'user', isCurrent: revision === 4 })
const node: NodeView = {
  nodeId: 'node', kind: 'image', x: 0, y: 0, w: 320, h: 320, z: 1, layoutRevision: 1,
  slots: [{ slotId: 'main', slotKey: 'main', contentType: 'image', revision: 4, content: version(4).content }],
}
const workItem = (workItemId: string, revision = 1, patch: Partial<WorkItemView> = {}): WorkItemView => ({
  workItemId, spaceId: 'space', parentId: null, childIds: [], title: workItemId, brief: '', status: 'todo', pinned: false,
  reviewBy: 'user', workDir: '/work', createdBy: { kind: 'user' }, revision, activationSeq: null,
  waitingSlotSince: null, pendingFeedback: false, reviewReportId: null, activity: 'idle', sessions: [], unreadCount: 0, unresolvedCount: 0,
  waitingOn: null, todayGenerations: 0, changeCount: 0, lastChangeSeq: null, statusChangedAt: 1, createdAt: 1, archivedAt: null,
  ...patch,
})
const counts: WorkInboxCounts = { unread: 3, unresolved: 1, bySpace: [{ spaceId: 'other', unread: 3, unresolved: 1 }] }
const slots: WorkSlotsView = { used: 2, limit: 6, bySpace: [{ spaceId: 'other', used: 2, limit: null }], queue: [] }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

async function setup(history: (params: unknown) => Promise<{ versions: SlotVersionView[]; hasMore: boolean }>, workItems: WorkItemView[] = [], agents: () => Promise<unknown> = async () => ({ agents: [] })) {
  vi.stubGlobal('location', { search: '', protocol: 'http:', host: 'localhost' })
  const preferences = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => preferences.get(key) ?? null, setItem: (key: string, value: string) => preferences.set(key, value) })
  let opts!: Parameters<typeof connectRpc>[0]
  const call = vi.fn(async (method: string, params?: unknown): Promise<unknown> => {
    if (method === 'space.list') return { spaces: [{ spaceId: 'space', name: 'test', rootPath: '/projects/test' }, { spaceId: 'other', name: 'other', rootPath: '/projects/other' }], projectsDir: '/projects' }
    if (method === 'events.subscribe') return { reset: true, snapshot: { nodes: [node], sessions: [], activeJobs: [], workItems }, seq: 1 }
    if (method === 'providers.list') return { providers: [], defaults: {}, limits: { maxConcurrent: 3, dailyImage: 50, dailyVideo: 10 } }
    if (method === 'agents.list') return agents()
    if (method === 'work.inbox') return { groups: [], counts }
    if (method === 'work.slots') return slots
    if (method === 'slot.history') return history(params)
    throw new Error(`unexpected method ${method}`)
  })
  vi.mocked(connectRpc).mockImplementation(options => {
    opts = options
    return { call, close: vi.fn() } as ReturnType<typeof connectRpc>
  })
  const conn = openSpace('token')
  opts.onOpen()
  await vi.waitFor(() => expect(conn.getView().ready).toBe(true))
  const event = (seq: number, type: SpaceEvent['type'], payload: unknown) => opts.onNotification('events.event', { seq, type, entityId: 'main', entityType: 'slot', payload })
  return { conn, call, opts, event, preferences }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

it('keeps the registry loading after a failed read and retries it on reconnect without dropping the session snapshot', async () => {
  const pending = deferred<unknown>()
  const agents = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue({ agents: [] })
  const { conn, opts } = await setup(async () => ({ versions: [], hasMore: false }), [], agents)
  expect(conn.getView().agents).toBeUndefined()
  pending.reject(new Error('Registry temporarily unavailable'))
  await vi.waitFor(() => expect(conn.getView().error?.kind).toBe('request'))
  expect(conn.getView().ready).toBe(true)
  expect(conn.getView().agents).toBeUndefined()
  opts.onOpen()
  await vi.waitFor(() => expect(conn.getView().agents).toEqual([]))
  expect(agents).toHaveBeenCalledTimes(2)
})

it('receives transient media progress without requiring an agent session or advancing the durable cursor', async () => {
  const { conn, opts, event } = await setup(async () => ({ versions: [], hasMore: false }))
  const task = { taskId: 'media', nodeId: 'node', slotId: 'main', operation: 'image.crop', status: 'running', createdAt: 1 }
  event(2, 'mediaTask.stateChanged', task)
  opts.onNotification('events.mediaProgress', { taskId: 'media', progress: 0.7 })
  expect(conn.getView().state.mediaTasks.get('media')?.progress).toBe(0.7)
  expect(conn.getView().state.seq).toBe(2)
  event(3, 'mediaTask.stateChanged', { ...task, status: 'succeeded' })
  const state = conn.getView().state
  opts.onNotification('events.mediaProgress', { taskId: 'media', progress: 0.9 })
  expect(conn.getView().state).toBe(state)
})

it('refreshes conflicting rows without regressing newer events or layout', async () => {
  const { conn, call, event } = await setup(async () => ({ versions: [], hasMore: false }))
  const pending = deferred<{ nodes: NodeView[] }>()
  call.mockImplementationOnce(() => pending.promise)
  const refreshing = conn.refreshNodes(['node'])
  event(2, 'node.updated', { ...node, x: 900, slots: [{ ...node.slots[0]!, revision: 6, content: version(6).content }] })
  pending.resolve({ nodes: [{ ...node, x: 50, slots: [{ ...node.slots[0]!, revision: 5, content: version(5).content }] }] })
  await refreshing
  expect(conn.getView().state.nodes.get('node')).toMatchObject({ x: 900, slots: [{ revision: 6 }] })
  call.mockResolvedValueOnce({ nodes: [{ ...node, slots: [{ ...node.slots[0]!, revision: 7, content: version(7).content }] }] })
  await conn.refreshNodes(['node'])
  expect(conn.getView().state.nodes.get('node')).toMatchObject({ x: 900, slots: [{ revision: 7 }] })
})

describe('Project switching', () => {
  it('project notifications reread the list; deleting the current project selects the most recently opened remaining project', async () => {
    const { conn, call, opts } = await setup(async () => ({ versions: [], hasMore: false }))
    const original = call.getMockImplementation()!
    call.mockImplementation((method, params) => method === 'space.list' ? Promise.resolve({ spaces: [{ spaceId: 'other', name: 'other', rootPath: '/projects/other' }], projectsDir: '/projects' }) : original(method, params))
    opts.onNotification('events.spacesChanged', {})
    await vi.waitFor(() => expect(conn.getView().space?.spaceId).toBe('other'))
    await vi.waitFor(() => expect(conn.getView().ready).toBe(true))
    expect(call).toHaveBeenCalledWith('events.subscribe', { spaceId: 'other' })
  })

  it('deleting all projects clears old data; restoring the first project resubscribes', async () => {
    const { conn, call, opts, preferences } = await setup(async () => ({ versions: [], hasMore: false }))
    const original = call.getMockImplementation()!
    let spaces: { spaceId: string; name: string; rootPath: string }[] = []
    call.mockImplementation((method, params) => method === 'space.list' ? Promise.resolve({ spaces, projectsDir: '/projects' }) : original(method, params))
    opts.onNotification('events.spacesChanged', {})
    await vi.waitFor(() => expect(conn.getView().space).toBeNull())
    expect(conn.getView().ready).toBe(false)
    expect(conn.getView().state.nodes.size).toBe(0)
    expect(conn.getView().error).toEqual({ kind: 'empty' })
    expect(describeSpaceError(conn.getView().error!, 'zh-CN')).toBe('还没有项目，请新建项目')
    expect(describeSpaceError(conn.getView().error!, 'en')).toBe('No projects yet. Create a project to get started')
    expect(preferences.get('vis.project')).toBe('')
    spaces = [{ spaceId: 'other', name: 'other', rootPath: '/projects/other' }]
    opts.onNotification('events.spacesChanged', {})
    await vi.waitFor(() => expect(conn.getView().ready).toBe(true))
    expect(conn.getView().space?.spaceId).toBe('other')
  })

  it.each(['成功', '失败'])('late project-list %s cannot restore deleted projects or overwrite new state', async outcome => {
    const { conn, call, opts } = await setup(async () => ({ versions: [], hasMore: false }))
    const old = deferred<{ spaces: { spaceId: string; name: string; rootPath: string }[] }>()
    const original = call.getMockImplementation()!
    let reads = 0
    call.mockImplementation((method, params) => method === 'space.list' ? ++reads === 1 ? old.promise : Promise.resolve({ spaces: [{ spaceId: 'other', name: 'other', rootPath: '/projects/other' }] }) : original(method, params))
    const loading = conn.refreshProjects()
    opts.onNotification('events.spacesChanged', {})
    await vi.waitFor(() => expect(conn.getView().space?.spaceId).toBe('other'))
    if (outcome === '成功') old.resolve({ spaces: [{ spaceId: 'space', name: 'test', rootPath: '/projects/test' }] })
    else old.reject(new Error('Old list read failed'))
    await loading
    expect(conn.getView().projects.map(project => project.spaceId)).toEqual(['other'])
    expect(conn.getView().space?.spaceId).toBe('other')
    expect(conn.getView().error).toBeNull()
  })

  it('reconnection checks the list first and does not resubscribe to projects deleted while disconnected', async () => {
    const { conn, call, opts } = await setup(async () => ({ versions: [], hasMore: false }))
    const original = call.getMockImplementation()!
    const before = call.mock.calls.length
    call.mockImplementation((method, params) => method === 'space.list' ? Promise.resolve({ spaces: [{ spaceId: 'other', name: 'other', rootPath: '/projects/other' }] }) : original(method, params))
    opts.onOpen()
    await vi.waitFor(() => expect(conn.getView().space?.spaceId).toBe('other'))
    await vi.waitFor(() => expect(conn.getView().ready).toBe(true))
    expect(call.mock.calls.slice(before).filter(([method]) => method === 'events.subscribe')).toEqual([['events.subscribe', { spaceId: 'other' }]])
  })

  it('subscription failures reject switching without marking ready and allow later retries', async () => {
    const { conn, call } = await setup(async () => ({ versions: [], hasMore: false }))
    const original = call.getMockImplementation()!
    let fail = true
    // english-exempt: Chinese connection diagnostic fixture verifies locale-specific error fallback.
    call.mockImplementation((method, params) => method === 'events.subscribe' && fail ? Promise.reject(new Error('项目连接失败')) : original(method, params))
    await expect(conn.selectProject('other')).rejects.toThrow('项目连接失败')
    expect(conn.getView().ready).toBe(false)
    expect(describeSpaceError(conn.getView().error!, 'zh-CN')).toBe('项目连接失败')
    expect(describeSpaceError(conn.getView().error!, 'en')).toBe('Something went wrong')
    fail = false
    await conn.selectProject('other')
    expect(conn.getView().ready).toBe(true)
    expect(conn.getView().error).toBeNull()
  })

  it('switching clears old state and in-flight records, persists selection, and resubscribes to the current project on reconnect', async () => {
    const { conn, call, opts, event, preferences } = await setup(async () => ({ versions: [], hasMore: false }))
    const transcript = deferred<any>()
    const original = call.getMockImplementation()!
    call.mockImplementation((method, params) => method === 'session.getTranscript' ? transcript.promise : original(method, params))
    const loading = conn.loadTranscript('old-session')
    await conn.selectProject('other')
    transcript.resolve({ items: [], hasMore: false })
    await loading
    expect(conn.getView().talk.transcripts.size).toBe(0)
    expect(conn.getView().space?.spaceId).toBe('other')
    expect(preferences.get('vis.project')).toBe('other')
    event(3, 'node.deleted', { nodeId: 'node' })
    opts.onOpen()
    await vi.waitFor(() => expect(call.mock.calls.at(-1)).toEqual(['events.subscribe', { spaceId: 'other', afterSeq: 3 }]))
  })

  it('rapid switching serializes subscriptions; old snapshots and events during switching cannot override the final selection', async () => {
    const { conn, call, event } = await setup(async () => ({ versions: [], hasMore: false }))
    const pending = deferred<any>()
    const original = call.getMockImplementation()!
    call.mockImplementation((method, params) => method === 'events.subscribe' && (params as any).spaceId === 'other' ? pending.promise : original(method, params))
    const first = conn.selectProject('other')
    await vi.waitFor(() => expect(call.mock.calls.at(-1)).toEqual(['events.subscribe', { spaceId: 'other' }]))
    const last = conn.selectProject('space')
    event(99, 'node.created', { ...node, nodeId: 'stale' })
    expect(conn.getView().state.nodes.size).toBe(0)
    pending.resolve({ reset: true, snapshot: { nodes: [{ ...node, nodeId: 'wrong' }], sessions: [], activeJobs: [], workItems: [] }, seq: 50 })
    await Promise.all([first, last])
    expect(conn.getView().space?.spaceId).toBe('space')
    expect([...conn.getView().state.nodes.keys()]).toEqual(['node'])
    expect(conn.getView().state.seq).toBe(1)
  })
})

describe('Work-item connection state', () => {
  it('snapshots, events, and RPC share work-item state; duplicate events do not refresh messages again', async () => {
    const initial = workItem('initial')
    const { conn, event } = await setup(async () => ({ versions: [], hasMore: false }), [initial])
    expect(conn.getView().work.items.get('initial')).toEqual(initial)
    expect(conn.getView().work.seq).toBe(1)
    const updated = workItem('initial', 2, { unreadCount: 2 })
    event(2, 'work.itemChanged', updated)
    event(3, 'work.messageAdded', { workItemId: 'initial' })
    event(3, 'work.messageAdded', { workItemId: 'initial' })
    event(4, 'node.updated', node)
    expect(conn.getView().work.items.get('initial')).toEqual(updated)
    expect(conn.getView().work.messageVersions.get('initial')).toBe(1)
    expect(conn.getView().work.seq).toBe(conn.getView().state.seq)
    conn.mergeWorkItems([workItem('initial', 1), workItem('initial', 2, { title: 'stale' }), workItem('extra')])
    expect(conn.getView().work.items.get('initial')).toEqual(updated)
    expect(conn.getView().work.items.has('extra')).toBe(true)
    conn.mergeWorkItems([workItem('initial', 3)])
    expect(conn.getView().work.items.get('initial')?.revision).toBe(3)
  })

  it('each connection reads actual global state; notifications apply directly and late reads cannot overwrite them', async () => {
    const { conn, call, opts } = await setup(async () => ({ versions: [], hasMore: false }))
    expect(conn.getView().work.inboxCounts).toEqual(counts)
    expect(conn.getView().work.slots).toEqual(slots)
    const inbox = deferred<{ groups: []; counts: WorkInboxCounts }>()
    const slotRead = deferred<WorkSlotsView>()
    const original = call.getMockImplementation()!
    call.mockImplementation((method, params) => method === 'work.inbox' ? inbox.promise : method === 'work.slots' ? slotRead.promise : original(method, params))
    opts.onOpen()
    await vi.waitFor(() => expect(call.mock.calls.filter(([method]) => method === 'work.inbox')).toHaveLength(2))
    const nextCounts = { ...counts, unread: 7 }
    const nextSlots = { ...slots, used: 4 }
    opts.onNotification('events.workInboxChanged', nextCounts)
    opts.onNotification('events.workSlotsChanged', nextSlots)
    expect(conn.getView().work.inboxCounts).toEqual(nextCounts)
    expect(conn.getView().work.slots).toEqual(nextSlots)
    inbox.resolve({ groups: [], counts })
    slotRead.resolve(slots)
    await Promise.all([inbox.promise, slotRead.promise])
    expect(conn.getView().work.inboxCounts).toEqual(nextCounts)
    expect(conn.getView().work.slots).toEqual(nextSlots)
  })

  it('late responses from the previous connection cannot overwrite reconnect reads', async () => {
    const { conn, call, opts } = await setup(async () => ({ versions: [], hasMore: false }))
    const inbox = deferred<{ groups: []; counts: WorkInboxCounts }>()
    const slotRead = deferred<WorkSlotsView>()
    const original = call.getMockImplementation()!
    call.mockImplementation((method, params) => method === 'work.inbox' ? inbox.promise : method === 'work.slots' ? slotRead.promise : original(method, params))
    opts.onOpen()
    await vi.waitFor(() => expect(call.mock.calls.filter(([method]) => method === 'work.inbox')).toHaveLength(2))
    const nextCounts = { ...counts, unread: 8 }
    const nextSlots = { ...slots, used: 5 }
    call.mockImplementation((method, params) => method === 'work.inbox' ? Promise.resolve({ groups: [], counts: nextCounts }) : method === 'work.slots' ? Promise.resolve(nextSlots) : original(method, params))
    opts.onOpen()
    await vi.waitFor(() => expect(conn.getView().work.inboxCounts).toEqual(nextCounts))
    inbox.resolve({ groups: [], counts })
    slotRead.resolve(slots)
    await Promise.all([inbox.promise, slotRead.promise])
    expect(conn.getView().work.inboxCounts).toEqual(nextCounts)
    expect(conn.getView().work.slots).toEqual(nextSlots)
  })

  it.each([
    ['space', '成功'], ['space', '失败'], ['all', '成功'], ['all', '失败'],
  ] as const)('project switching clears cards and preserves global state, ignoring old %s read %s', async (scope, outcome) => {
    const { conn, call, event } = await setup(async () => ({ versions: [], hasMore: false }), [workItem('initial')])
    event(2, 'work.messageAdded', { workItemId: 'initial' })
    const pending = deferred<{ items: WorkItemView[] }>()
    const original = call.getMockImplementation()!
    call.mockImplementation((method, params) => {
      if (method === 'work.list') return pending.promise
      if (method === 'events.subscribe') return Promise.resolve({ reset: true, snapshot: { nodes: [], sessions: [], activeJobs: [], workItems: [workItem('other-item', 1, { spaceId: 'other' })] }, seq: 10 })
      return original(method, params)
    })
    const loading = conn.refreshWork(scope)
    const switching = conn.selectProject('other')
    expect(conn.getView().work.items.size).toBe(0)
    expect(conn.getView().work.messageVersions.size).toBe(0)
    expect(conn.getView().work.seq).toBe(0)
    expect(conn.getView().work.inboxCounts).toEqual(counts)
    expect(conn.getView().work.slots).toEqual(slots)
    await switching
    if (outcome === '成功') pending.resolve({ items: [workItem('late')] })
    else pending.reject(new Error('Old project read failed'))
    await expect(loading).resolves.toBeUndefined()
    expect([...conn.getView().work.items.keys()]).toEqual(['other-item'])
    expect(conn.getView().work.messageVersions.size).toBe(0)
    expect(conn.getView().work.seq).toBe(10)
    expect(conn.getView().work.inboxCounts).toEqual(counts)
    expect(conn.getView().work.slots).toEqual(slots)
    expect(conn.getView().error).toBeNull()
  })

  it('current-project and cross-project lists both merge; late lists cannot roll back event updates', async () => {
    const initial = workItem('initial', 2)
    const { conn, call, event } = await setup(async () => ({ versions: [], hasMore: false }), [initial])
    const pending = deferred<{ items: WorkItemView[] }>()
    const original = call.getMockImplementation()!
    call.mockImplementation((method, params) => method === 'work.list' ? pending.promise : original(method, params))
    const loading = conn.refreshWork()
    expect(call).toHaveBeenCalledWith('work.list', { scope: 'space', spaceId: 'space' })
    event(2, 'work.itemChanged', workItem('initial', 3, { title: 'newest' }))
    pending.resolve({ items: [workItem('initial', 2), workItem('local')] })
    await loading
    expect(conn.getView().work.items.get('initial')?.title).toBe('newest')
    call.mockImplementation((method, params) => method === 'work.list' ? Promise.resolve({ items: [workItem('initial', 3, { title: 'newest' }), workItem('local'), workItem('remote', 1, { spaceId: 'other', spaceName: 'other' })] }) : original(method, params))
    await conn.refreshWork('all')
    expect(call).toHaveBeenCalledWith('work.list', { scope: 'all' })
    expect([...conn.getView().work.items.keys()]).toEqual(['initial', 'local', 'remote'])
  })

  it('complete lists remove missing items within their scope, preserving other projects and new events during reads', async () => {
    const { conn, call, event } = await setup(async () => ({ versions: [], hasMore: false }), [workItem('deleted'), workItem('changed')])
    conn.mergeWorkItems([workItem('remote', 1, { spaceId: 'other' })])
    const pending = deferred<{ items: WorkItemView[] }>()
    const original = call.getMockImplementation()!
    call.mockImplementation((method, params) => method === 'work.list' ? pending.promise : original(method, params))
    const loading = conn.refreshWork('space')
    event(2, 'work.itemChanged', workItem('changed', 2))
    event(3, 'work.itemChanged', workItem('arrived'))
    pending.resolve({ items: [] })
    await loading
    expect([...conn.getView().work.items.keys()]).toEqual(['changed', 'remote', 'arrived'])
    expect(conn.getView().work.deletedIds.has('deleted')).toBe(true)
    call.mockImplementation((method, params) => method === 'work.list' ? Promise.resolve({ items: [workItem('changed', 2), workItem('arrived')] }) : original(method, params))
    await conn.refreshWork('all')
    expect([...conn.getView().work.items.keys()]).toEqual(['changed', 'arrived'])
    conn.mergeWorkItems([workItem('remote', 5, { spaceId: 'other' })])
    expect(conn.getView().work.items.has('remote')).toBe(false)
  })

  it('callers handle current-project read failures; retries still merge by revision', async () => {
    const { conn, call } = await setup(async () => ({ versions: [], hasMore: false }), [workItem('initial')])
    const original = call.getMockImplementation()!
    call.mockImplementation((method, params) => method === 'work.list' ? Promise.reject(new Error('Offline')) : original(method, params))
    await expect(conn.refreshWork()).rejects.toThrow('Offline')
    expect([...conn.getView().work.items.keys()]).toEqual(['initial'])
    call.mockImplementation((method, params) => method === 'work.list' ? Promise.resolve({ items: [workItem('initial', 2)] }) : original(method, params))
    await conn.refreshWork()
    expect(conn.getView().work.items.get('initial')?.revision).toBe(2)
  })
})

describe('Opening archived agents on demand', () => {
  const session: SessionSummary = {
    sessionId: 'archived-agent', agentKind: 'codex', title: '之前的 Agent', workDir: '/work', workItemId: 'work',
    agentConfig: { model: null, effort: null, serviceTier: null }, titleSource: 'user', queuePaused: false, queuedMessageCount: 0, silentSince: null, activeTurnId: null, pendingApprovals: 0, createdAt: 1,
  }

  it('adds only the target session, does not reread existing sessions, and does not import other archived sessions', async () => {
    const { conn, call, event } = await setup(async () => ({ versions: [], hasMore: false }))
    const existing = { ...session, sessionId: 'existing' }
    event(2, 'session.created', existing)
    const original = call.getMockImplementation()!
    call.mockImplementation((method, params) => method === 'session.list' ? Promise.resolve({ sessions: [session, { ...session, sessionId: 'unrelated' }] }) : original(method, params))
    await conn.loadSession('existing')
    expect(call.mock.calls.filter(([method]) => method === 'session.list')).toHaveLength(0)
    await conn.loadSession(session.sessionId)
    expect(call).toHaveBeenCalledWith('session.list', { includeArchived: true })
    expect([...conn.getView().state.sessions.keys()]).toEqual(['existing', 'archived-agent'])
    expect(conn.getView().state.sessions.get(session.sessionId)).toEqual(session)
    await conn.loadSession(session.sessionId)
    expect(call.mock.calls.filter(([method]) => method === 'session.list')).toHaveLength(1)
  })

  it('late lists cannot overwrite session state received during reads', async () => {
    const { conn, call, event } = await setup(async () => ({ versions: [], hasMore: false }))
    const pending = deferred<{ sessions: SessionSummary[] }>()
    const original = call.getMockImplementation()!
    call.mockImplementation((method, params) => method === 'session.list' ? pending.promise : original(method, params))
    const loading = conn.loadSession(session.sessionId)
    const updated = { ...session, title: '最新标题', silentSince: null, activeTurnId: 'running-turn' }
    event(2, 'session.updated', updated)
    pending.resolve({ sessions: [session] })
    await loading
    expect(conn.getView().state.sessions.get(session.sessionId)).toEqual(updated)
    expect(conn.getView().state.seq).toBe(2)
  })

  it.each(['成功', '失败'])('ignores %s session-read responses after switching projects', async outcome => {
    const { conn, call } = await setup(async () => ({ versions: [], hasMore: false }))
    const pending = deferred<{ sessions: SessionSummary[] }>()
    const original = call.getMockImplementation()!
    call.mockImplementation((method, params) => method === 'session.list' ? pending.promise : original(method, params))
    const loading = conn.loadSession(session.sessionId)
    await conn.selectProject('other')
    if (outcome === '成功') pending.resolve({ sessions: [session] })
    else pending.reject(new Error('Old project read failed'))
    await expect(loading).resolves.toBeUndefined()
    expect(conn.getView().state.sessions.size).toBe(0)
    expect(conn.getView().error).toBeNull()
  })

  it('current read failures or missing sessions reject and allow later retries', async () => {
    const { conn, call } = await setup(async () => ({ versions: [], hasMore: false }))
    const original = call.getMockImplementation()!
    call.mockImplementation((method, params) => method === 'session.list' ? Promise.reject(new Error('Offline')) : original(method, params))
    await expect(conn.loadSession(session.sessionId)).rejects.toThrow('Offline')
    call.mockImplementation((method, params) => method === 'session.list' ? Promise.resolve({ sessions: [] }) : original(method, params))
    await expect(conn.loadSession(session.sessionId)).rejects.toThrow('会话不存在')
    expect(conn.getView().state.sessions.size).toBe(0)
    call.mockImplementation((method, params) => method === 'session.list' ? Promise.resolve({ sessions: [session] }) : original(method, params))
    await conn.loadSession(session.sessionId)
    expect(conn.getView().state.sessions.get(session.sessionId)).toEqual(session)
  })
})

describe('Slot history cache', () => {
  it('reads and caches all pages on demand; repeated calls share one read', async () => {
    const first = deferred<{ versions: SlotVersionView[]; hasMore: boolean }>()
    const history = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce({ versions: [version(1)], hasMore: false })
    const { conn, call } = await setup(history)
    expect(history).not.toHaveBeenCalled()
    const loading = conn.loadHistory('main')
    const duplicate = conn.loadHistory('main')
    first.resolve({ versions: Array.from({ length: 200 }, (_, i) => version(201 - i)), hasMore: true })
    await Promise.all([loading, duplicate])
    expect(call.mock.calls.filter(([method]) => method === 'slot.history')).toEqual([
      ['slot.history', { slotId: 'main', limit: 200 }],
      ['slot.history', { slotId: 'main', limit: 200, beforeRevision: 2 }],
    ])
    expect(conn.getView().state.histories.get('main')?.map(v => v.revision)).toEqual(Array.from({ length: 201 }, (_, i) => 201 - i))
    await conn.loadHistory('main')
    expect(history).toHaveBeenCalledTimes(2)
  })

  it.each(['成功', '失败'])('revisions refresh only requested slots, duplicate events do not refresh, and old request %s does not affect new history', async outcome => {
    const old = deferred<{ versions: SlotVersionView[]; hasMore: boolean }>()
    const history = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue({ versions: [version(5), version(4)], hasMore: false })
    const { conn, event } = await setup(history)
    event(2, 'slot.revised', { nodeId: 'node', slotId: 'unopened' })
    expect(history).not.toHaveBeenCalled()
    const stale = conn.loadHistory('main')
    const revised = { nodeId: 'node', slotId: 'main', slot: { ...node.slots[0], revision: 5, content: version(5).content } }
    event(3, 'slot.revised', revised)
    await vi.waitFor(() => expect(conn.getView().state.histories.get('main')?.[0]?.revision).toBe(5))
    if (outcome === '成功') old.resolve({ versions: [version(4)], hasMore: false })
    else old.reject(new Error('Stale request failed'))
    await expect(stale).resolves.toBeUndefined()
    expect(conn.getView().state.histories.get('main')?.[0]?.revision).toBe(5)
    expect(conn.getView().error).toBeNull()
    event(3, 'slot.revised', revised)
    expect(history).toHaveBeenCalledTimes(2)
    await conn.loadHistory('main')
    expect(history).toHaveBeenCalledTimes(2)
    event(4, 'slot.revised', { ...revised, slot: { ...revised.slot, revision: 6 } })
    await vi.waitFor(() => expect(history).toHaveBeenCalledTimes(3))
  })

  it.each(['成功', '失败'])('reconnect snapshots refresh requested history; node deletion ignores %s from requests still in flight', async outcome => {
    const pending = deferred<{ versions: SlotVersionView[]; hasMore: boolean }>()
    const history = vi.fn().mockResolvedValueOnce({ versions: [version(4)], hasMore: false }).mockReturnValueOnce(pending.promise)
    const { conn, opts, event } = await setup(history)
    await conn.loadHistory('main')
    opts.onOpen()
    await vi.waitFor(() => expect(history).toHaveBeenCalledTimes(2))
    const loading = conn.loadHistory('main')
    expect(conn.getView().state.histories.has('main')).toBe(false)
    event(2, 'node.deleted', { nodeId: 'node' })
    if (outcome === '成功') pending.resolve({ versions: [version(4)], hasMore: false })
    else pending.reject(new Error('Stale request failed'))
    await expect(loading).resolves.toBeUndefined()
    expect(conn.getView().state.nodes.size).toBe(0)
    expect(conn.getView().state.histories.has('main')).toBe(false)
    expect(conn.getView().error).toBeNull()
  })

  it('read failures can retry; malformed pagination does not request indefinitely', async () => {
    const history = vi.fn().mockRejectedValueOnce(new Error('Offline')).mockResolvedValueOnce({ versions: [], hasMore: true }).mockResolvedValueOnce({ versions: [], hasMore: false })
    const { conn } = await setup(history)
    await expect(conn.loadHistory('main')).rejects.toThrow('Offline')
    await expect(conn.loadHistory('main')).rejects.toThrow('版本历史分页没有前进')
    await conn.loadHistory('main')
    expect(conn.getView().state.histories.get('main')).toEqual([])
  })
})

describe('Generation job state in historical tools', () => {
  const job = (jobId: string, status: JobView['status'] = 'cancelled'): JobView => ({ jobId, status, providerCancelled: false, outputs: [], targets: [] })
  const receipt = (jobId: string, itemId = jobId): TranscriptItem => ({
    itemId, createdSeq: 1, revision: 1, turnId: 'turn', kind: 'tool_result',
    payload: { text: JSON.stringify({ jobId, status: 'queued' }) }, createdAt: 0, updatedAt: 0,
  })

  it('reload restores cancelled Mock state without active targets from tool results; duplicate IDs and concurrent reads share one request', async () => {
    const { conn, call } = await setup(async () => ({ versions: [], hasMore: false }))
    const pending = deferred<JobView>()
    const original = call.getMockImplementation()!
    call.mockImplementation((method, params) => method === 'generation.get' ? pending.promise : original(method, params))
    const items = [receipt('old-mock'), receipt('old-mock', 'duplicate')]
    const first = conn.loadTranscriptJobs(items, new Map())
    const second = conn.loadTranscriptJobs(items, new Map())
    expect(call.mock.calls.filter(([method]) => method === 'generation.get')).toEqual([['generation.get', { jobId: 'old-mock' }]])
    pending.resolve(job('old-mock'))
    await Promise.all([first, second])
    expect(conn.getView().talk.jobs.get('old-mock')).toEqual(job('old-mock'))
    expect(conn.getView().state.jobs.size).toBe(0)
    await conn.loadTranscriptJobs(items, new Map())
    expect(call.mock.calls.filter(([method]) => method === 'generation.get')).toHaveLength(1)
  })

  it('does not reread state already present in current jobs or usage; terminal cache survives dismissal of notices', async () => {
    const { conn, call, event } = await setup(async () => ({ versions: [], hasMore: false }))
    const live = job('live', 'running')
    event(2, 'job.stateChanged', { jobId: live.jobId, status: live.status, job: live })
    const paid = job('paid')
    const items = [receipt('live'), receipt('paid')]
    await conn.loadTranscriptJobs(items, new Map([[paid.jobId, paid]]))
    expect(call.mock.calls.filter(([method]) => method === 'generation.get')).toHaveLength(0)
    expect(conn.getView().talk.jobs.get('live')?.status).toBe('running')
    const cancelled = job('live')
    event(3, 'job.stateChanged', { jobId: cancelled.jobId, status: cancelled.status, job: cancelled })
    await conn.loadTranscriptJobs(items, new Map([['live', live]]))
    conn.dismissJobs(['live'])
    await conn.loadTranscriptJobs(items, new Map([['live', live]]))
    expect(conn.getView().talk.jobs.get('live')?.status).toBe('cancelled')
    expect(call.mock.calls.filter(([method]) => method === 'generation.get')).toHaveLength(0)
  })

  it('late running-state queries cannot overwrite cancellation events already received and cached', async () => {
    const { conn, call, event } = await setup(async () => ({ versions: [], hasMore: false }))
    const pending = deferred<JobView>()
    const original = call.getMockImplementation()!
    call.mockImplementation((method, params) => method === 'generation.get' ? pending.promise : original(method, params))
    const items = [receipt('old')]
    const loading = conn.loadTranscriptJobs(items, new Map())
    const cancelled = job('old')
    event(2, 'job.stateChanged', { jobId: cancelled.jobId, status: cancelled.status, job: cancelled })
    await conn.loadTranscriptJobs(items, new Map())
    conn.dismissJobs(['old'])
    pending.resolve(job('old', 'running'))
    await loading
    expect(conn.getView().talk.jobs.get('old')?.status).toBe('cancelled')
  })

  it.each(['成功', '失败'])('ignores %s responses from old state requests after switching projects', async outcome => {
    const { conn, call } = await setup(async () => ({ versions: [], hasMore: false }))
    const pending = deferred<JobView>()
    const original = call.getMockImplementation()!
    call.mockImplementation((method, params) => method === 'generation.get' ? pending.promise : original(method, params))
    const loading = conn.loadTranscriptJobs([receipt('old')], new Map())
    await conn.selectProject('other')
    if (outcome === '成功') pending.resolve(job('old'))
    else pending.reject(new Error('Old project read failed'))
    await expect(loading).resolves.toBeUndefined()
    expect(conn.getView().talk.jobs.size).toBe(0)
    expect(conn.getView().error).toBeNull()
  })

  it('current-project read failures preserve errors and allow retry', async () => {
    const { conn, call } = await setup(async () => ({ versions: [], hasMore: false }))
    const original = call.getMockImplementation()!
    let failed = false
    call.mockImplementation((method, params) => {
      if (method !== 'generation.get') return original(method, params)
      if (!failed) { failed = true; return Promise.reject(new Error('Offline')) }
      return Promise.resolve(job('old'))
    })
    await expect(conn.loadTranscriptJobs([receipt('old')], new Map())).rejects.toThrow('Offline')
    await conn.loadTranscriptJobs([receipt('old')], new Map())
    expect(conn.getView().talk.jobs.get('old')?.status).toBe('cancelled')
  })
})


describe('Session pagination lifecycle', () => {
  const item = (seq: number): TranscriptItem => ({ itemId: `item-${seq}`, turnId: null, kind: 'user', revision: 1, createdSeq: seq, createdAt: seq, updatedAt: seq, payload: { text: String(seq) } })
  const page = (seq: number) => ({ items: [item(seq)], hasMore: true })

  it('deduplicates concurrent first-page and history-page reads, retries after failure, and stops requesting at the earliest page', async () => {
    const { conn, call } = await setup(async () => ({ versions: [], hasMore: false }))
    const first = deferred<ReturnType<typeof page>>()
    call.mockImplementationOnce(() => first.promise)
    const initial = conn.loadTranscript('session')
    const duplicate = conn.loadTranscript('session')
    expect(call.mock.calls.filter(([method]) => method === 'session.getTranscript')).toHaveLength(1)
    first.resolve(page(100))
    await Promise.all([initial, duplicate])
    const older = deferred<ReturnType<typeof page>>()
    call.mockImplementationOnce(() => older.promise)
    const loading = conn.loadTranscript('session', true)
    const repeated = conn.loadTranscript('session', true)
    expect(call.mock.calls.filter(([method]) => method === 'session.getTranscript')).toHaveLength(2)
    expect(call).toHaveBeenLastCalledWith('session.getTranscript', { sessionId: 'session', limit: 100, beforeSeq: 100 })
    older.resolve(page(50))
    await Promise.all([loading, repeated])
    expect(conn.getView().talk.transcripts.get('session')?.items.map(i => i.createdSeq)).toEqual([50, 100])
    call.mockRejectedValueOnce(new Error('Read failed'))
    await expect(conn.loadTranscript('session', true)).rejects.toThrow('Read failed')
    call.mockResolvedValueOnce({ items: [item(1)], hasMore: false })
    await conn.loadTranscript('session', true)
    const calls = call.mock.calls.length
    await conn.loadTranscript('session', true)
    expect(call).toHaveBeenCalledTimes(calls)
    expect(conn.getView().talk.transcripts.get('session')?.items.map(i => i.createdSeq)).toEqual([1, 50, 100])
  })

  it('switching sessions discards old pages; closing and reopening the same session does not reuse old requests', async () => {
    const { conn, call } = await setup(async () => ({ versions: [], hasMore: false }))
    const old = deferred<ReturnType<typeof page>>()
    call.mockImplementationOnce(() => old.promise)
    const initial = conn.loadTranscript('a')
    call.mockResolvedValueOnce(page(20))
    await conn.loadTranscript('b')
    old.resolve(page(10))
    await initial
    expect(conn.getView().talk.transcripts.has('a')).toBe(false)
    const stale = deferred<ReturnType<typeof page>>()
    call.mockImplementationOnce(() => stale.promise)
    const loading = conn.loadTranscript('b', true)
    conn.closeTranscript('b')
    call.mockResolvedValueOnce(page(5))
    await conn.loadTranscript('b', true)
    stale.resolve(page(1))
    await loading
    expect(conn.getView().talk.transcripts.get('b')?.items.map(i => i.createdSeq)).toEqual([5, 20])
  })

  it('failures after closing do not propagate; pages from before closing no longer enter the cache', async () => {
    const { conn, call } = await setup(async () => ({ versions: [], hasMore: false }))
    const pending = deferred<ReturnType<typeof page>>()
    call.mockImplementationOnce(() => pending.promise)
    const loading = conn.loadTranscript('closed')
    conn.closeTranscript('closed')
    pending.reject(new Error('Old request failed'))
    await expect(loading).resolves.toBeUndefined()
    expect(conn.getView().talk.transcripts.has('closed')).toBe(false)
  })

  it('snapshots, old events, and archived lists all fill in default queue counts', async () => {
    const old = { sessionId: 'legacy' } as SessionSummary
    expect(fromSnapshot({ nodes: [], sessions: [old], activeJobs: [] } as any, 1).sessions.get('legacy')?.queuedMessageCount).toBe(0)
    const state = applyEvent(emptyState(), { seq: 1, type: 'session.updated', payload: old } as SpaceEvent)
    expect(state.sessions.get('legacy')?.queuedMessageCount).toBe(0)
    const current = applyEvent(state, { seq: 2, type: 'session.updated', payload: { ...old, queuedMessageCount: 3 } } as SpaceEvent)
    expect(current.sessions.get('legacy')?.queuedMessageCount).toBe(3)
    const { conn, call } = await setup(async () => ({ versions: [], hasMore: false }))
    call.mockResolvedValueOnce({ sessions: [old] })
    await conn.loadSession('legacy')
    expect(conn.getView().state.sessions.get('legacy')?.queuedMessageCount).toBe(0)
  })
})
