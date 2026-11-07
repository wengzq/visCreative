import type { AgentView, WorkItemView, WorkSessionView } from '@vis/protocol'
import { formatter, messagesFor, type Locale } from '@vis/ui-kit'
import { workMessages } from '../messages'
import { statusLabels } from './model'

import { agentLabel } from '../agents'

// work.list returns ascending creation order; when all are archived, the latest history can still be opened.
export function mainSession(sessions: readonly WorkSessionView[]) {
  return sessions.find(session => !session.archived) ?? sessions.at(-1)
}

export function agentTabLabels(sessions: readonly WorkSessionView[], locale: Locale = 'zh-CN', agents: readonly AgentView[] = []) {
  const counts = new Map<string, number>()
  return sessions.map(session => {
    const count = (counts.get(session.agentKind) ?? 0) + 1
    counts.set(session.agentKind, count)
    return `${agentLabel(agents, session.agentKind)}${count > 1 ? ` ${formatter(locale).number(count)}` : ''}`
  })
}

export function isRunning(item: WorkItemView) {
  return item.sessions.some(session => !session.archived && session.activeTurnId)
}

function rank(item: WorkItemView) {
  return item.waitingOn ? 0 : isRunning(item) ? 1 : item.status === 'in_review' ? 2 : item.waitingSlotSince !== null ? 3 : item.status === 'in_progress' ? 4 : 5
}

export function childPreview(items: readonly WorkItemView[]) {
  const recent = (item: WorkItemView) => Math.max(item.statusChangedAt, ...item.sessions.map(session => session.lastActivityAt ?? 0))
  return items.filter(item => item.status !== 'done').sort((a, b) => rank(a) - rank(b) || recent(b) - recent(a)).slice(0, 3)
}

export function shortStatus(item: WorkItemView, queuePosition?: number, locale: Locale = 'zh-CN') {
  const t = messagesFor(workMessages, locale)
  return item.waitingOn ? t.waitingReplyShort : isRunning(item) ? t.running : item.status === 'in_review' ? t.inReview : item.waitingSlotSince !== null ? t.queuePosition(queuePosition === undefined ? '…' : formatter(locale).number(queuePosition)) : statusLabels(locale)[item.status]
}
