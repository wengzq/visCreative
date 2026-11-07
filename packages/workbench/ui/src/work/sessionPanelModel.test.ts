import { describe, expect, it } from 'vitest'
import type { AgentView, WorkItemView, WorkSessionView } from '@vis/protocol'
import { agentTabLabels, childPreview, mainSession, shortStatus } from './sessionPanelModel'

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

function session(sessionId: string, patch: Partial<WorkSessionView> = {}): WorkSessionView {
  return { sessionId, agentKind: 'codex', title: sessionId, silentSince: null, activeTurnId: null, doing: null, lastActivityAt: null, archived: false, ...patch }
}

describe('Session panel', () => {
  it('The main session is the first unarchived one; when all are archived, open the most recent history', () => {
    const sessions = [session('archived', { archived: true }), session('first'), session('second')]
    expect(mainSession(sessions)?.sessionId).toBe('first')
    expect(mainSession([sessions[0]!, session('latest-archive', { archived: true })])?.sessionId).toBe('latest-archive')
    expect(mainSession([])).toBeUndefined()
  })

  it('Number Agent labels separately by type without using session titles or roles', () => {
    const sessions = [session('a'), session('b', { agentKind: 'deepseek' }), session('c'), session('d', { agentKind: 'claude' }), session('e')]
    const agents = Object.entries({ codex: 'Codex', deepseek: 'DeepSeek', claude: 'Claude' }).map(([kind, label]) => ({ kind, label })) as AgentView[]
    expect(agentTabLabels(sessions, 'zh-CN', agents)).toEqual(['Codex', 'DeepSeek', 'Codex 2', 'Claude', 'Codex 3'])
    expect(agentTabLabels(sessions, 'en', agents)).toEqual(['Codex', 'DeepSeek', 'Codex 2', 'Claude', 'Codex 3'])
  })

  it('Preview only the first three unfinished items; waiting for a reply takes priority over running, review, queued, in-progress, and todo', () => {
    const waiting = item('waiting', { status: 'in_progress', waitingOn: { messageId: 'm', kind: 'question', excerpt: '选择版本' } })
    const running = item('running', { status: 'in_progress', sessions: [session('s', { silentSince: null, activeTurnId: 't' })] })
    const review = item('review', { status: 'in_review' })
    const queued = item('queued', { waitingSlotSince: 10 })
    const active = item('active', { status: 'in_progress' })
    const todo = item('todo')
    const done = item('done', { ...waiting, workItemId: 'done', status: 'done' })
    const input = [todo, active, queued, review, running, waiting, done]
    expect(childPreview(input).map(item => item.workItemId)).toEqual(['waiting', 'running', 'review'])
    expect(childPreview([todo, active, queued]).map(item => item.workItemId)).toEqual(['queued', 'active', 'todo'])
    expect(input[0]).toBe(todo)
    expect(shortStatus(waiting)).toBe('等你回复')
    expect(shortStatus(running)).toBe('运行中')
    expect(shortStatus(queued, 4)).toBe('排队第 4 位')
    expect(shortStatus(waiting, undefined, 'en')).toBe('Waiting for your reply')
    expect(shortStatus(running, undefined, 'en')).toBe('Running')
    expect(shortStatus(review, undefined, 'en')).toBe('In review')
    expect(shortStatus(todo, undefined, 'en')).toBe('To do')
    expect(shortStatus(queued, 4, 'en')).toBe('Queue position 4')
    expect(shortStatus(queued, undefined, 'en')).toBe('Queue position …')
    expect(shortStatus(queued, 1234, 'en')).toBe('Queue position 1,234')
  })

  it('Sort peers by latest session activity or status change descending; archived turns do not count as running', () => {
    const old = item('old', { status: 'in_progress' })
    const recent = item('recent', { status: 'in_progress', sessions: [session('s', { lastActivityAt: 3000 })] })
    const changed = item('changed', { status: 'in_progress', statusChangedAt: 4000 })
    const archived = item('archived', { sessions: [session('s', { silentSince: null, activeTurnId: 't', archived: true })] })
    expect(childPreview([archived, old, recent, changed]).map(item => item.workItemId)).toEqual(['changed', 'recent', 'old'])
  })
})
