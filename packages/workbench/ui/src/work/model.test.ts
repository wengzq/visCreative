import { describe, expect, it } from 'vitest'
import type { WorkInboxGroup, WorkItemView, WorkMessageView, WorkSlotsView, WorkStatus } from '@vis/protocol'
import {
  BOARD_STATUSES,
  actionLabels,
  sessionDoing,
  statusLabels,
  boardChildGroups,
  buildWorkTree,
  canReparentWorkItem,
  getDropAction,
  runningNotice,
  getQuickActions,
  getWorkActivity,
  groupBoardItems,
  incompleteChildren,
  mergeInboxGroups,
  mergeWorkItems,
  queuePosition,
  relativeTime,
  reparentTargets,
  sortWorkItems,
  workDirectoryLabel,
  workFailureText,
  workMessageLabel,
} from './model'

function item(workItemId: string, patch: Partial<WorkItemView> = {}): WorkItemView {
  return {
    workItemId, spaceId: 'space-a', parentId: null, childIds: [], title: workItemId, brief: '',
    status: 'todo', pinned: false, reviewBy: 'user', workDir: `/project/workspaces/${workItemId}`,
    createdBy: { kind: 'user' }, revision: 1, activationSeq: null,
    waitingSlotSince: null, pendingFeedback: false, reviewReportId: null, activity: 'idle', sessions: [],
    unreadCount: 0, unresolvedCount: 0, waitingOn: null, todayGenerations: 0,
    changeCount: 0, lastChangeSeq: null, statusChangedAt: 1000, createdAt: 1000, archivedAt: null,
    ...patch,
  }
}

function message(messageId: string, patch: Partial<WorkMessageView> = {}): WorkMessageView {
  return {
    messageId, workItemId: 'work-a', kind: 'question', from: { kind: 'session', sessionId: 'session-a' },
    to: 'user', body: messageId, refs: {}, replyTo: null, deliveryId: null, resolvedBy: null,
    redelivered: false, createdAt: 1000, deliveredAt: null, ackedAt: null, readAt: null,
    ...patch,
  }
}

function inbox(spaceId: string, workItemId: string, messages: WorkMessageView[]): WorkInboxGroup {
  return {
    spaceId, spaceName: spaceId,
    items: [{ workItemId, title: workItemId, status: 'in_progress', parentTitle: null, messages, nodeLabels: {} }],
  }
}

it('renders an unreported turn as a localized notice without marking the card failed', () => {
  const failure = { sessionId: 'child', turnId: 'turn', reason: 'turn_unreported' as const, detail: JSON.stringify({ unfinishedJobs: 3, reply: 'Should I use A or B?' }) }
  expect(getWorkActivity(item('child', { status: 'in_progress', activity: 'idle', failure }))).toBe('idle')
  const en = workFailureText(failure, 'en')
  expect(en).toContain('Nothing was stopped; reply, recall it, or keep waiting.')
  expect(en).toContain('Unfinished generation jobs: 3.')
  expect(en).toContain('Should I use A or B?')
  const zh = workFailureText(failure, 'zh-CN')
  expect(zh).toContain('没有停止任何工作')
  expect(zh).toContain('尚未结束的生成任务：3。')
  expect(zh).toContain('Should I use A or B?')
  expect(workFailureText({ ...failure, detail: 'legacy detail' }, 'en')).not.toContain('legacy detail')
})

it('shares localized labels for silent, unreported and failed work messages in the inbox and review drawer', () => {
  const failure = { sessionId: 'child', turnId: 'turn', reason: 'turn_unreported' as const }
  const notice = message('notice', { kind: 'failure', from: { kind: 'system', failure } })
  expect(workMessageLabel(notice, 'en')).toBe('Ended without reporting')
  expect(workMessageLabel(notice, 'zh-CN')).toBe('未报告便结束')
  expect(workMessageLabel({ ...notice, from: { kind: 'system', failure: { ...failure, reason: 'turn_silent' } } }, 'en')).toBe('No activity')
  expect(workMessageLabel({ ...notice, from: { kind: 'system', failure: { ...failure, reason: 'turn_failed' } } }, 'en')).toBe('Work failed')
})

describe('Board drag state machine', () => {
  it('Allow dragging between any two columns without blocking or requiring a reason', () => {
    for (const status of BOARD_STATUSES) {
      const work = item('work-a', { status, sessions: [{ sessionId: 's', agentKind: 'codex', agentConfig: { model: null, effort: null, serviceTier: null }, title: 'Agent', silentSince: null, activeTurnId: null, doing: null, lastActivityAt: null, archived: false }] })
      expect(getDropAction(work, 'pinned')).toEqual({ action: 'pin' })
      for (const target of BOARD_STATUSES) expect(getDropAction(work, target)).toEqual(target === status ? { action: 'none' } : { action: 'move', status: target })
    }
  })

  it('First activation without a session selects an Agent, defaulting children to Codex; other directions move directly', () => {
    const work = item('work-a')
    expect(getDropAction(work, 'in_progress')).toEqual({ action: 'activate', chooseAgent: true })
    expect(getDropAction({ ...work, parentId: 'parent' }, 'in_progress')).toEqual({ action: 'activate', chooseAgent: true, defaultAgent: 'codex' })
    expect(getDropAction(work, 'done')).toEqual({ action: 'move', status: 'done' })
    expect(getDropAction({ ...work, status: 'done' }, 'in_progress')).toEqual({ action: 'move', status: 'in_progress', chooseAgent: true })
  })

  it('When leaving in-progress, warn only if a turn or generation is running', () => {
    const session = { sessionId: 's', agentKind: 'codex' as const, agentConfig: { model: null, effort: null, serviceTier: null }, title: 'Agent', silentSince: null, activeTurnId: null, doing: null, lastActivityAt: null, archived: false }
    const idle = item('镜头', { status: 'in_progress', sessions: [session] })
    expect(runningNotice(idle, 'done')).toBeNull()
    expect(runningNotice({ ...idle, sessions: [{ ...session, activeTurnId: 'turn' }] }, 'todo')).toContain('还在运行')
    expect(runningNotice({ ...idle, sessions: [{ ...session, doing: '正在生成图片' }] }, 'done')).toContain('还在运行')
    expect(runningNotice({ ...idle, sessions: [{ ...session, activeTurnId: 'turn' }] }, 'in_progress')).toBeNull()
    expect(runningNotice({ ...idle, sessions: [{ ...session, activeTurnId: 'turn' }] }, 'todo', 'en')).toBe('“镜头” is still running and will finish its current step. To stop it now, stop it in the session')
  })

  it('Count only direct unfinished children in the same project', () => {
    const parent = item('parent', { status: 'in_progress', childIds: ['child-a', 'child-b'] })
    const children = [
      item('child-a', { parentId: 'parent', title: '镜头 1', status: 'in_review' }),
      item('child-b', { parentId: 'parent', title: '配乐', status: 'todo' }),
      item('finished', { parentId: 'parent', status: 'done' }),
      item('foreign', { spaceId: 'space-b', parentId: 'parent', status: 'in_progress' }),
    ]
    expect(incompleteChildren(parent, children).map(child => child.workItemId)).toEqual(['child-a', 'child-b'])
  })

  it('At most three quick actions per status; queued items use cancel queue', () => {
    expect(getQuickActions(item('todo'))).toEqual(['activate'])
    expect(getQuickActions(item('queued', { waitingSlotSince: 0 }))).toEqual(['cancelQueue'])
    expect(getQuickActions(item('active', { status: 'in_progress', changeCount: 1 }))).toEqual(['openSession', 'locate', 'recall'])
    expect(getQuickActions(item('review', { status: 'in_review', changeCount: 1 }))).toEqual(['review', 'locate'])
    expect(getQuickActions(item('done', { status: 'done', changeCount: 1 }))).toEqual(['locate', 'reopen'])
  })
})

describe('Workspace move destinations', () => {
  it('Accept only unarchived roots in the same project, excluding self, current parent, and children', () => {
    const child = item('child', { parentId: 'old' })
    const targets = [item('old'), child, item('new'), item('nested', { parentId: 'old' }), item('foreign', { spaceId: 'other' }), item('archived', { archivedAt: 1 })]
    expect(reparentTargets(child, targets).map(value => value.workItemId)).toEqual(['new'])
    expect(canReparentWorkItem(child, null)).toBe(true)
    expect(canReparentWorkItem(item('root'), null)).toBe(false)
  })

  it('Archived workspaces and those with children cannot move, regardless of status or running turns', () => {
    const parent = item('parent')
    for (const status of BOARD_STATUSES) {
      const work = item('work', { status, sessions: [{ sessionId: 's', agentKind: 'codex', agentConfig: { model: null, effort: null, serviceTier: null }, title: 'Agent', silentSince: null, activeTurnId: 'turn', doing: null, lastActivityAt: null, archived: false }] })
      expect(canReparentWorkItem(work, parent)).toBe(true)
      expect(canReparentWorkItem({ ...work, childIds: ['child'] }, parent)).toBe(false)
      expect(canReparentWorkItem({ ...work, parentId: 'old', childIds: ['child'] }, null)).toBe(false)
      expect(canReparentWorkItem({ ...work, archivedAt: 1 }, parent)).toBe(false)
    }
  })
})

describe('Work-item sorting, grouping, and search', () => {
  it('Sort pinned first, then by status and status-change time, without mutating the original array', () => {
    const items = [
      item('done', { status: 'done', statusChangedAt: 9999 }),
      item('todo', { statusChangedAt: 9999 }),
      item('review', { status: 'in_review' }),
      item('old-active', { status: 'in_progress', statusChangedAt: 1 }),
      item('new-active', { status: 'in_progress', statusChangedAt: 2 }),
      item('pinned-done', { status: 'done', pinned: true }),
    ]
    expect(sortWorkItems(items).map(work => work.workItemId)).toEqual(['pinned-done', 'new-active', 'old-active', 'review', 'todo', 'done'])
    expect(items[0]?.workItemId).toBe('done')
  })

  it('Directory and title matches on children retain the parent and hide only unmatched siblings', () => {
    const items = [
      item('parent', { title: '短片', childIds: ['child-a', 'child-b'] }),
      item('child-a', { parentId: 'parent', title: '镜头 1', workDir: '/project/WORKSPACES/Shot-One' }),
      item('child-b', { parentId: 'parent', title: '配乐' }),
      item('other', { title: '另一个项目' }),
    ]
    const title = buildWorkTree(items, ' 镜头 1 ')
    expect(title.map(node => node.item.workItemId)).toEqual(['parent'])
    expect(title[0]?.children.map(node => node.item.workItemId)).toEqual(['child-a'])
    expect(buildWorkTree(items, 'shot-ONE')[0]?.children[0]?.item.workItemId).toBe('child-a')
    expect(buildWorkTree(items, '没有匹配')).toEqual([])
    expect(buildWorkTree(items)[0]?.children).toHaveLength(2)
  })

  it('Cards with missing parents remain visible; same-named parents in other projects do not adopt them', () => {
    const tree = buildWorkTree([
      item('parent', { spaceId: 'space-b' }),
      item('orphan', { parentId: 'parent' }),
    ])
    expect(tree).toHaveLength(2)
    expect(tree.every(node => node.children.length === 0)).toBe(true)
  })

  it('Keep the first three children in order and show all on expansion; three or fewer children and roots do not collapse', () => {
    const children = Array.from({ length: 5 }, (_, index) => item(`child-${index}`, { parentId: 'parent' }))
    const input = [item('parent'), ...children, item('other')]
    const folded = boardChildGroups(input, new Set())
    expect(folded.map(group => group.items.map(work => work.workItemId))).toEqual([['parent'], ['child-0', 'child-1', 'child-2'], ['other']])
    expect(folded[1]).toMatchObject({ hidden: 2, collapsible: true })
    const expanded = boardChildGroups(input, new Set([folded[1]!.key]))
    expect(expanded[1]).toMatchObject({ items: children, hidden: 0, collapsible: true })
    expect(boardChildGroups(children.slice(0, 3), new Set())[0]).toMatchObject({ hidden: 0, collapsible: false })
    expect(input).toHaveLength(7)
    expect(boardChildGroups([], new Set())).toEqual([])
  })

  it('Missing parents also support collapse, but counts remain separate by project, parent, and status', () => {
    const children = Array.from({ length: 4 }, (_, index) => item(`child-${index}`, { parentId: 'missing' }))
    const groups = boardChildGroups([...children, item('foreign', { spaceId: 'other', parentId: 'missing' }), item('review', { parentId: 'missing', status: 'in_review' }), item('sibling', { parentId: 'other' })], new Set())
    expect(groups.map(group => group.hidden)).toEqual([1, 0, 0, 0])
    expect(groups.flatMap(group => group.items).map(work => work.workItemId)).toEqual(['child-0', 'child-1', 'child-2', 'foreign', 'review', 'sibling'])
  })

  it('The done column preserves the seven-day boundary and groups older cards separately; pinned cards remain in their column', () => {
    const now = new Date(2026, 9, 28, 12).getTime()
    const cutoff = now - 7 * 24 * 60 * 60 * 1000
    const groups = groupBoardItems([
      item('todo', { pinned: true }),
      item('active', { status: 'in_progress' }),
      item('review', { status: 'in_review' }),
      item('recent', { status: 'done', statusChangedAt: cutoff }),
      item('old', { status: 'done', statusChangedAt: cutoff - 1, pinned: true }),
    ], now)
    expect(groups.todo.map(work => work.workItemId)).toEqual(['todo'])
    expect(groups.in_progress.map(work => work.workItemId)).toEqual(['active'])
    expect(groups.in_review.map(work => work.workItemId)).toEqual(['review'])
    expect(groups.done.map(work => work.workItemId)).toEqual(['recent'])
    expect(groups.olderDone.map(work => work.workItemId)).toEqual(['old'])
    expect(groups.pinned.map(work => work.workItemId)).toEqual(['todo', 'old'])
  })
})

describe('Card display and global queue', () => {
  it('Todo and done status dots stay idle; other statuses retain activity values', () => {
    expect(getWorkActivity(item('todo', { activity: 'active' }))).toBe('idle')
    expect(getWorkActivity(item('done', { status: 'done', activity: 'error' }))).toBe('idle')
    expect(getWorkActivity(item('review', { status: 'in_review', activity: 'waiting' }))).toBe('waiting')
  })

  it('Directories show the last two levels, supporting trailing separators and Windows paths', () => {
    expect(workDirectoryLabel('/project/workspaces/镜头-1/')).toBe('workspaces/镜头-1')
    expect(workDirectoryLabel('C:\\project\\workspaces\\镜头-1')).toBe('workspaces/镜头-1')
    expect(workDirectoryLabel('workspace')).toBe('workspace')
  })

  it('Relative time uses minutes, hours, yesterday, and dates; empty times show nothing', () => {
    const now = new Date(2026, 9, 28, 12).getTime()
    expect(relativeTime(null, now)).toBe('')
    expect(relativeTime(now + 1, now)).toBe('刚刚')
    expect(relativeTime(now - 59_999, now)).toBe('刚刚')
    expect(relativeTime(now - 60_000, now)).toBe('1 分钟前')
    expect(relativeTime(now - 59 * 60_000, now)).toBe('59 分钟前')
    expect(relativeTime(now - 3_600_000, now)).toBe('1 小时前')
    expect(relativeTime(new Date(2026, 9, 27, 10).getTime(), now)).toBe('昨天')
    expect(relativeTime(new Date(2026, 9, 26, 10).getTime(), now)).toBe('10 月 26 日')
    expect(relativeTime(new Date(2025, 9, 27, 10).getTime(), now)).toBe('10 月 27 日')
    expect(relativeTime(null, now, 'en')).toBe('')
    expect(relativeTime(now - 59_999, now, 'en')).toBe('Just now')
    expect(relativeTime(now - 60_000, now, 'en')).toBe('1 minute ago')
    expect(relativeTime(now - 59 * 60_000, now, 'en')).toBe('59 minutes ago')
    expect(relativeTime(now - 3_600_000, now, 'en')).toBe('1 hour ago')
    expect(relativeTime(new Date(2026, 9, 27, 10).getTime(), now, 'en')).toBe('Yesterday')
    expect(relativeTime(new Date(2026, 9, 26, 10).getTime(), now, 'en')).toBe('Oct 26')
  })

  it('Queue position follows global order and also matches project; return empty for nonqueued items or unloaded queues', () => {
    const work = item('work-a', { waitingSlotSince: 0 })
    const slots: WorkSlotsView = {
      used: 6, limit: 6, bySpace: [], queue: [
        { spaceId: 'space-b', workItemId: 'work-a', title: '其他项目', waitingSince: 0 },
        { spaceId: 'space-a', workItemId: 'work-a', title: '当前项目', waitingSince: 0 },
      ],
    }
    expect(queuePosition(work, slots)).toBe(2)
    expect(queuePosition(work, null)).toBeNull()
    expect(queuePosition(item('work-a'), slots)).toBeNull()
    expect(queuePosition(item('missing', { waitingSlotSince: 1 }), slots)).toBeNull()
  })
})

describe('Live work-item and inbox merging', () => {
  it('Replace whole work-item cards only with newer revisions, without mixing projects', () => {
    const current = item('work-a', { revision: 3, title: '当前' })
    const incoming = [
      item('work-a', { revision: 2, title: '过时' }),
      item('work-a', { revision: 3, title: '同版本' }),
      item('work-a', { spaceId: 'space-b', title: '其他项目' }),
    ]
    const merged = mergeWorkItems([current], incoming)
    expect(merged).toEqual([current, incoming[2]])
    expect(merged[0]).toBe(current)
    const updated = item('work-a', { revision: 4, title: '新标题', unreadCount: 3, activity: 'waiting' })
    expect(mergeWorkItems(merged, [updated])[0]).toBe(updated)
    expect(current.title).toBe('当前')
  })

  it('The inbox retains messages handled during this opening and their positions, refreshes old messages, and appends new ones', () => {
    const processed = message('processed', { resolvedBy: 'reply-a', readAt: 2000 })
    const pending = message('pending')
    const current = [inbox('space-a', 'work-a', [processed, pending]), inbox('space-b', 'work-b', [message('other')])]
    const refreshed = message('pending', { body: '更新的内容', readAt: 3000 })
    const arriving = message('arriving')
    const incoming = [inbox('space-a', 'work-a', [refreshed, arriving])]
    incoming[0]!.spaceName = '新项目名'
    incoming[0]!.items[0]!.title = '新工作项标题'
    incoming[0]!.items[0]!.status = 'in_review'
    const merged = mergeInboxGroups(current, incoming)
    expect(merged.map(group => group.spaceId)).toEqual(['space-a', 'space-b'])
    expect(merged[0]?.spaceName).toBe('新项目名')
    expect(merged[0]?.items[0]).toMatchObject({ title: '新工作项标题', status: 'in_review' })
    expect(merged[0]?.items[0]?.messages).toEqual([processed, refreshed, arriving])
    expect(current[0]?.items[0]?.messages).toEqual([processed, pending])
    expect(mergeInboxGroups(merged, [])[0]?.items[0]?.messages).toEqual([processed, refreshed, arriving])
    expect(mergeInboxGroups([], incoming)[0]?.items[0]?.messages).toEqual([refreshed, arriving])
    current[0]!.items[0]!.nodeLabels = { 'node-old': '旧节点' }
    incoming[0]!.items[0]!.nodeLabels = { 'node-new': '新节点' }
    expect(mergeInboxGroups(current, incoming)[0]?.items[0]?.nodeLabels).toEqual({ 'node-old': '旧节点', 'node-new': '新节点' })
  })

  it('Projects and work items do not overwrite each other; new work items in the same project append after retained items', () => {
    const current = [inbox('space-a', 'work-a', [message('old')])]
    const incoming = [
      inbox('space-a', 'work-b', [message('new')]),
      inbox('space-b', 'work-a', [message('old', { body: '其他项目同名消息' })]),
    ]
    const merged = mergeInboxGroups(current, incoming)
    expect(merged.map(group => group.spaceId)).toEqual(['space-a', 'space-b'])
    expect(merged[0]?.items.map(work => work.workItemId)).toEqual(['work-a', 'work-b'])
    expect(merged[0]?.items[0]?.messages[0]?.body).toBe('old')
    expect(merged[1]?.items[0]?.messages[0]?.body).toBe('其他项目同名消息')
  })
})


describe('Work UI language', () => {
  it('Statuses and actions follow the language, still defaulting to Chinese', () => {
    expect(statusLabels()).toEqual({ todo: '待办', in_progress: '进行中', in_review: '待审阅', done: '已完成' })
    expect(statusLabels('en')).toEqual({ todo: 'To do', in_progress: 'In progress', in_review: 'In review', done: 'Done' })
    expect(actionLabels().submitReview).toBe('送审')
    expect(actionLabels('en').submitReview).toBe('Submit for review')
  })

  it('Translate backend-generated activity states while preserving unknown text and tool names', () => {
    expect(sessionDoing(null, 'en')).toBeNull()
    const statuses = ['正在生成图片', '正在生成视频', '正在生成音频', '等待回复', '等待审批', '正在处理']
    expect(statuses.map(status => sessionDoing(status))).toEqual(statuses)
    expect(statuses.map(status => sessionDoing(status, 'en'))).toEqual(['Generating image', 'Generating video', 'Generating audio', 'Waiting for reply', 'Waiting for approval', 'Processing'])
    expect(sessionDoing('正在调用 canvas.read', 'en')).toBe('Calling canvas.read')
    expect(sessionDoing('用户自定义的状态', 'en')).toBe('用户自定义的状态')
  })
})
