import { PlanPayload, type TranscriptItem } from '@vis/protocol'
import { describeError, formatter, messagesFor, type Locale } from '@vis/ui-kit'
import { sessionMessages } from './messages'

export function elapsedTime(milliseconds: number, locale: Locale = 'zh-CN'): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000))
  const m = messagesFor(sessionMessages, locale)
  const format = formatter(locale)
  return seconds < 60 ? m.elapsedSeconds(format.number(seconds)) : m.elapsedMinutes(format.number(Math.floor(seconds / 60)), format.number(seconds % 60).padStart(2, '0'))
}

export function planProgress(item: TranscriptItem | undefined, locale: Locale = 'zh-CN'): string | undefined {
  const plan = PlanPayload.safeParse(item?.payload)
  const format = formatter(locale)
  return plan.success ? messagesFor(sessionMessages, locale).planProgress(format.number(plan.data.entries.filter(entry => entry.status === 'completed').length), format.number(plan.data.entries.length)) : undefined
}

// Preserve original Agent capability descriptions; the UI uses a separate dictionary for tool names.
export function localizedToolLabel(name: string, locale: Locale = 'zh-CN'): string | undefined {
  const m = messagesFor(sessionMessages, locale)
  const key = `tool_${name.replace(/^(mcp__vis__|vis\.)/, '')}`
  const label = m[key as keyof typeof m]
  return typeof label === 'string' ? label : undefined
}

export function activityText(items: TranscriptItem[], turnId: string, locale: Locale = 'zh-CN'): string {
  const m = messagesFor(sessionMessages, locale)
  const current = items.filter(item => item.turnId === turnId)
  if (current.some(item => item.kind === 'approval' && (item.payload as { status?: string })?.status === 'pending')) return m.waitingConfirmation
  const last = current.findLast(item => item.kind !== 'plan')
  if (last?.kind === 'assistant_text') return m.replying
  if (last?.kind === 'tool_call') {
    const name = (last.payload as { name?: string })?.name ?? m.tool
    return m.usingTool(localizedToolLabel(name, locale) ?? name)
  }
  return m.thinkingActivity
}

export function transcriptNotice(payload: { code?: string; message?: string; reason?: string; params?: Record<string, string | number>; cause?: unknown } | null | undefined, locale: Locale = 'zh-CN'): string {
  const message = payload?.message ?? payload?.code ?? ''
  if (payload?.reason) {
    const params = payload.cause ? { ...payload.params, detail: describeError(payload.cause, locale) } : payload.params
    return describeError({ message, data: { reason: payload.reason, params } }, locale)
  }
  if (payload?.code === 'send_now_dispatch_unknown') return messagesFor(sessionMessages, locale).noticeSendNowUnknown
  if (payload?.code === 'agent_inactive') return messagesFor(sessionMessages, locale).noticeAgentInactive
  if (locale === 'en') {
    const m = messagesFor(sessionMessages, locale)
    const notices: Record<string, string> = {
      context_compacted: m.noticeCompacted,
      runtime_restarted: m.noticeRestarted,
      dispatch_unknown: m.noticeDispatchUnknown,
      dispatch_rejected: m.noticeDispatchRejected,
      sandbox_read_only: m.noticeSandbox,
    }
    if (payload?.code && notices[payload.code]) return notices[payload.code]!
  }
  return describeError({ message, data: payload }, locale)
}

export function reasoningActive(item: TranscriptItem, items: TranscriptItem[], turnId: string | null): boolean {
  return item.turnId === turnId && turnId !== null && !items.slice(items.indexOf(item) + 1).some(next => next.turnId === item.turnId)
}
