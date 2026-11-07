import { formatter, messagesFor, type Locale } from '@vis/ui-kit'
import { workMessages } from '../messages'
import { DEFAULT_AGENT_KIND } from '@vis/protocol'
import type { AgentKind, WorkActivity, WorkInboxGroup, WorkItemView, WorkMessageView, WorkSlotsView, WorkStatus, WorkFailure } from '@vis/protocol'

export function statusLabels(locale: Locale = 'zh-CN'): Record<WorkStatus, string> {
  const t = messagesFor(workMessages, locale)
  return { todo: t.todo, in_progress: t.inProgress, in_review: t.inReview, done: t.done }
}

export function workMessageLabel(message: WorkMessageView, locale: Locale = 'zh-CN'): string {
  const t = messagesFor(workMessages, locale)
  const reason = message.from.kind === 'system' ? message.from.failure?.reason : undefined
  const labels = {
    failure: reason === 'turn_unreported' ? t.unreported : reason === 'turn_silent' ? t.noActivity : t.failure,
    brief: t.brief, question: t.question, blocked: t.blocked, escalation: t.escalation, done: t.completed,
    reply: t.reply, review_feedback: t.reviewFeedback, recall: t.recall, deleted: t.deleted,
  }
  return labels[message.kind]
}

export const STATUS_ORDER: WorkStatus[] = ['in_progress', 'in_review', 'todo', 'done']
export const BOARD_STATUSES: WorkStatus[] = ['todo', 'in_progress', 'in_review', 'done']

export type WorkQuickAction = 'activate' | 'cancelQueue' | 'openSession' | 'locate' | 'recall' | 'review' | 'reopen'
export function actionLabels(locale: Locale = 'zh-CN') {
  const t = messagesFor(workMessages, locale)
  return {
    activate: t.activate, cancelQueue: t.cancelQueue, openSession: t.openSession, locate: t.locate,
    recall: t.recall, review: t.review, reopen: t.reopen, submitReview: t.submitReview,
    approve: t.approve, reject: t.reject, pin: t.pin,
  }
}

/** doing is backend-generated status copy; translate only known states without rewriting Agent or user content. */
export function sessionDoing(doing: string | null, locale: Locale = 'zh-CN'): string | null {
  if (!doing || locale === 'zh-CN') return doing
  const zh = messagesFor(workMessages, 'zh-CN')
  const t = messagesFor(workMessages, locale)
  const known = [
    [zh.generatingImage, t.generatingImage], [zh.generatingVideo, t.generatingVideo],
    [zh.generatingAudio, t.generatingAudio], [zh.waitingReply, t.waitingReply],
    [zh.waitingApproval, t.waitingApproval], [zh.processing, t.processing],
  ]
  const matched = known.find(([source]) => source === doing)
  if (matched) return matched[1]!
  const prefix = zh.callingTool('')
  return doing.startsWith(prefix) ? t.callingTool(doing.slice(prefix.length)) : doing
}

export type WorkDropAction = 'activate' | 'move' | 'pin' | 'none'
export type DropResult = { action: WorkDropAction; status?: WorkStatus; chooseAgent?: boolean; defaultAgent?: AgentKind }

export function incompleteChildren(item: WorkItemView, items: readonly WorkItemView[]): WorkItemView[] {
  return items.filter(child => child.spaceId === item.spaceId && child.parentId === item.workItemId && child.status !== 'done')
}

/** The board belongs to the user: allow dragging between any columns without blocking or requiring reasons. Cards without sessions must select an Agent when entering in-progress. */
export function getDropAction(item: WorkItemView, target: WorkStatus | 'pinned'): DropResult {
  if (target === 'pinned') return { action: 'pin' }
  if (target === item.status) return { action: 'none' }
  if (item.status === 'todo' && target === 'in_progress' && !item.sessions.length) {
    return item.parentId ? { action: 'activate', chooseAgent: true, defaultAgent: DEFAULT_AGENT_KIND } : { action: 'activate', chooseAgent: true }
  }
  return target === 'in_progress' && !item.sessions.length ? { action: 'move', status: target, chooseAgent: true } : { action: 'move', status: target }
}

export function canReparentWorkItem(item: WorkItemView, parent: WorkItemView | null): boolean {
  if (item.archivedAt !== null || item.childIds.length) return false
  if (!parent) return item.parentId !== null
  return parent.archivedAt === null && parent.parentId === null && parent.spaceId === item.spaceId
    && parent.workItemId !== item.workItemId && parent.workItemId !== item.parentId
}

export function reparentTargets(item: WorkItemView, items: readonly WorkItemView[]): WorkItemView[] {
  return items.filter(parent => canReparentWorkItem(item, parent))
}

/** Dragging only changes status without interrupting Agents; warn when leaving in-progress if turns or generation are still running. */
export function runningNotice(item: WorkItemView, target: WorkStatus, locale: Locale = 'zh-CN'): string | null {
  if (target === 'in_progress') return null
  const running = item.sessions.filter(session => !session.archived && (session.activeTurnId || session.doing?.startsWith(messagesFor(workMessages, 'zh-CN').generatingPrefix)))
  if (!running.length) return null
  return messagesFor(workMessages, locale).runningNotice(item.title)
}

export function getQuickActions(item: WorkItemView): WorkQuickAction[] {
  const locate: WorkQuickAction[] = item.changeCount > 0 ? ['locate'] : []
  switch (item.status) {
    case 'todo': return [item.waitingSlotSince === null ? 'activate' : 'cancelQueue']
    case 'in_progress': return ['openSession', ...locate, 'recall']
    case 'in_review': return ['review', ...locate]
    case 'done': return [...locate, 'reopen']
  }
}

export function sortWorkItems(items: readonly WorkItemView[]): WorkItemView[] {
  return [...items].sort((a, b) => Number(b.pinned) - Number(a.pinned)
    || STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status)
    || b.statusChangedAt - a.statusChangedAt)
}

export type WorkTreeNode = { item: WorkItemView; children: WorkTreeNode[] }

export function buildWorkTree(items: readonly WorkItemView[], query = ''): WorkTreeNode[] {
  const sorted = sortWorkItems(items)
  const nodes = new Map(sorted.map(item => [itemKey(item), { item, children: [] } as WorkTreeNode]))
  const roots: WorkTreeNode[] = []
  for (const item of sorted) {
    const node = nodes.get(itemKey(item))!
    const parent = item.parentId ? nodes.get(itemKey({ spaceId: item.spaceId, workItemId: item.parentId })) : undefined
    if (parent) parent.children.push(node)
    else roots.push(node)
  }
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return roots
  function filter(nodes: WorkTreeNode[]): WorkTreeNode[] {
    return nodes.flatMap(node => {
      const children = filter(node.children)
      const matches = `${node.item.title}\n${node.item.workDir}`.toLocaleLowerCase().includes(needle)
      return matches || children.length ? [{ item: node.item, children }] : []
    })
  }
  return filter(roots)
}

const DAY = 24 * 60 * 60 * 1000

export function groupBoardItems(items: readonly WorkItemView[], now = Date.now()): Record<WorkStatus | 'olderDone' | 'pinned', WorkItemView[]> {
  const groups: Record<WorkStatus | 'olderDone' | 'pinned', WorkItemView[]> = {
    todo: [], in_progress: [], in_review: [], done: [], olderDone: [], pinned: [],
  }
  for (const item of sortWorkItems(items)) {
    if (item.pinned) groups.pinned.push(item)
    const group = item.status === 'done' && item.statusChangedAt < now - 7 * DAY ? 'olderDone' : item.status
    groups[group].push(item)
  }
  return groups
}

/** Collapse children of the same workspace separately in each column, without mixing statuses or projects. */
export function boardChildGroups(items: readonly WorkItemView[], expanded: ReadonlySet<string>) {
  const groups = new Map<string, { key: string; items: WorkItemView[]; hidden: number; collapsible: boolean }>()
  for (const item of items) {
    const key = `${item.spaceId}/${item.status}/${item.parentId ? `children/${item.parentId}` : `root/${item.workItemId}`}`
    let group = groups.get(key)
    if (!group) { group = { key, items: [], hidden: 0, collapsible: false }; groups.set(key, group) }
    group.items.push(item)
  }
  return [...groups.values()].map(group => {
    if (group.items.length <= 3) return group
    return { ...group, collapsible: true, items: expanded.has(group.key) ? group.items : group.items.slice(0, 3), hidden: expanded.has(group.key) ? 0 : group.items.length - 3 }
  })
}

export function getWorkActivity(item: WorkItemView): WorkActivity {
  if (item.failure && item.failure.reason !== 'turn_unreported') return 'error'
  return item.status === 'todo' || item.status === 'done' ? 'idle' : item.activity
}

export function workDirectoryLabel(path: string): string {
  return path.replaceAll('\\', '/').split('/').filter(Boolean).slice(-2).join('/')
}

export function relativeTime(timestamp: number | null, now = Date.now(), locale: Locale = 'zh-CN'): string {
  if (timestamp === null) return ''
  const t = messagesFor(workMessages, locale)
  const format = formatter(locale)
  const elapsed = Math.max(0, now - timestamp)
  if (elapsed < 60_000) return t.justNow
  if (elapsed < 3_600_000) return locale === 'zh-CN' ? t.minutesAgo(format.number(Math.floor(elapsed / 60_000))) : format.relativeTime(now - Math.floor(elapsed / 60_000) * 60_000, now)
  if (elapsed < DAY) return locale === 'zh-CN' ? t.hoursAgo(format.number(Math.floor(elapsed / 3_600_000))) : format.relativeTime(now - Math.floor(elapsed / 3_600_000) * 3_600_000, now)
  const date = new Date(timestamp)
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  if (date.getFullYear() === yesterday.getFullYear() && date.getMonth() === yesterday.getMonth() && date.getDate() === yesterday.getDate()) return t.yesterday
  return locale === 'zh-CN' ? t.monthDay(format.number(date.getMonth() + 1), format.number(date.getDate())) : format.dateTime(timestamp, { month: 'short', day: 'numeric' })
}

export function queuePosition(item: WorkItemView, slots: WorkSlotsView | null): number | null {
  if (item.waitingSlotSince === null || !slots) return null
  const index = slots.queue.findIndex(entry => entry.spaceId === item.spaceId && entry.workItemId === item.workItemId)
  return index < 0 ? null : index + 1
}

function itemKey(item: Pick<WorkItemView, 'spaceId' | 'workItemId'>): string {
  return `${item.spaceId}/${item.workItemId}`
}

export function mergeWorkItems(current: readonly WorkItemView[], incoming: readonly WorkItemView[]): WorkItemView[] {
  const merged = new Map(current.map(item => [itemKey(item), item]))
  for (const item of incoming) {
    const previous = merged.get(itemKey(item))
    if (!previous || item.revision > previous.revision) merged.set(itemKey(item), item)
  }
  return [...merged.values()]
}

export function mergeInboxGroups(current: readonly WorkInboxGroup[], incoming: readonly WorkInboxGroup[]): WorkInboxGroup[] {
  const groups = new Map(current.map(group => [group.spaceId, group]))
  for (const group of incoming) {
    const previous = groups.get(group.spaceId)
    const items = new Map(previous?.items.map(item => [item.workItemId, item]))
    for (const item of group.items) {
      const oldItem = items.get(item.workItemId)
      const messages = new Map(oldItem?.messages.map(message => [message.messageId, message]))
      for (const message of item.messages) messages.set(message.messageId, message)
      // Retained handled messages must still display the names of their associated nodes
      items.set(item.workItemId, { ...item, messages: [...messages.values()], nodeLabels: { ...oldItem?.nodeLabels, ...item.nodeLabels } })
    }
    groups.set(group.spaceId, { ...group, items: [...items.values()] })
  }
  return [...groups.values()]
}

export function workFailureText(failure: WorkFailure, locale: Locale = 'zh-CN'): string {
  const m = messagesFor(workMessages, locale)
  if (failure.reason === 'turn_unreported') {
    let detail: { unfinishedJobs?: unknown; reply?: unknown } = {}
    try { detail = JSON.parse(failure.detail ?? '{}') ?? {} } catch {}
    return [
      m.failureUnreported,
      typeof detail.unfinishedJobs === 'number' && detail.unfinishedJobs > 0 ? m.unfinishedJobs(formatter(locale).number(detail.unfinishedJobs)) : '',
      typeof detail.reply === 'string' && detail.reply ? m.childReply(detail.reply) : '',
    ].filter(Boolean).join('\n\n')
  }
  const labels: Record<WorkFailure['reason'], string> = {
    agent_start_failed: m.failureStart, ref_unresolvable: m.failureRefs, dispatch_rejected: m.failureRejected,
    dispatch_unknown: m.failureUnknown, turn_failed: m.failureTurn, runtime_exited: m.failureExit, runtime_restarted: m.failureRestart, turn_silent: m.failureSilent(failure.detail ?? '10'),
    turn_unreported: m.failureUnreported,
  }
  return `${labels[failure.reason]}${failure.detail && failure.reason !== 'turn_silent' ? ` · ${failure.detail}` : ''}`
}
