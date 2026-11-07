import { listCapabilities, toolNameOf, type MethodName, type TranscriptItem } from '@vis/protocol'
import { describe, expect, it } from 'vitest'
import { activityText, elapsedTime, localizedToolLabel, planProgress, reasoningActive, transcriptNotice } from './activity'

const item = (kind: TranscriptItem['kind'], payload: unknown = {}, turnId = 'turn'): TranscriptItem => ({
  itemId: kind, kind, payload, turnId, revision: 1, createdSeq: 1, createdAt: 0, updatedAt: 1500,
})

describe('Agent activity', () => {
  it('Derive copy only from the current turn; plans do not override activity, and approvals take priority', () => {
    for (const kind of ['user', 'reasoning', 'tool_result', 'notice'] as const) expect(activityText([item(kind)], 'turn')).toBe('正在思考…')
    expect(activityText([], 'turn')).toBe('正在思考…')
    expect(activityText([item('assistant_text', {}, 'old')], 'turn')).toBe('正在思考…')
    expect(activityText([item('assistant_text'), item('plan')], 'turn')).toBe('正在回复…')
    expect(activityText([item('tool_call', { name: 'vis.canvas_get' })], 'turn')).toBe('正在读取画布节点与槽位…')
    expect(activityText([item('tool_call', { name: 'custom' })], 'turn')).toBe('正在custom…')
    expect(activityText([item('approval', { status: 'pending' }), item('assistant_text')], 'turn')).toBe('等待你确认')
    expect(activityText([item('approval', { status: 'approved' }), item('assistant_text')], 'turn')).toBe('正在回复…')
  })

  it('Duration formatting and plan progress', () => {
    expect([0, 12000, 65000, -1].map(value => elapsedTime(value))).toEqual(['0s', '12s', '1m 05s', '0s'])
    expect(planProgress(item('plan', { entries: [{ text: '完成', status: 'completed' }, { text: '执行', status: 'in_progress' }, { text: '待办', status: 'pending' }] }))).toBe('计划 1/3')
    expect(planProgress(undefined)).toBeUndefined()
  })

  it('English activity, plans, and tool names use the UI dictionary; unknown tools retain their names', () => {
    expect(activityText([], 'turn', 'en')).toBe('Thinking…')
    expect(activityText([item('assistant_text')], 'turn', 'en')).toBe('Replying…')
    expect(activityText([item('approval', { status: 'pending' })], 'turn', 'en')).toBe('Waiting for your confirmation')
    expect(activityText([item('tool_call', { name: 'vis.canvas_get' })], 'turn', 'en')).toBe('Using Read canvas nodes and slots…')
    expect(activityText([item('tool_call', { name: 'custom' })], 'turn', 'en')).toBe('Using custom…')
    expect(activityText([item('tool_call')], 'turn', 'en')).toBe('Using tool…')
    expect(planProgress(item('plan', { entries: [{ text: '保留 Agent 内容', status: 'completed' }] }), 'en')).toBe('Plan 1/1')
    expect(elapsedTime(65000, 'en')).toBe('1m 05s')
    for (const capability of listCapabilities('agent')) {
      const name = toolNameOf(capability.method as MethodName)
      // The UI dictionary owns tool names; protocol summaries are Agent-facing English (RFC 0026).
      expect(localizedToolLabel(name)).toMatch(/[\p{Script=Han}]/u)
      expect(localizedToolLabel(`mcp__vis__${name}`, 'en')).toBeTruthy()
      expect(localizedToolLabel(`vis.${name}`, 'en')).not.toMatch(/[\p{Script=Han}]/u)
    }
    expect(localizedToolLabel('unknown', 'en')).toBeUndefined()
  })

  it('Backend notices preserve original Chinese; English uses notice type or error code', () => {
    // english-exempt: Chinese UI notice fixture verifies verbatim localized display.
    const compacted = { code: 'context_compacted', message: '上下文已压缩：Agent 不再记得完整的早期细节，必要时请重新说明关键设定' }
    expect(transcriptNotice(compacted)).toBe(compacted.message)
    expect(transcriptNotice(compacted, 'en')).toContain('Context compacted:')
    // english-exempt: Chinese backend notice fixture verifies error-code localization.
    expect(transcriptNotice({ code: 'revision_conflict', message: '内容已变化' }, 'en')).toBe('The content changed; refresh and try again')
    // english-exempt: Chinese unknown-error fixture verifies fallback display.
    expect(transcriptNotice({ code: 'agent_error', message: '网络出错' }, 'en')).toBe('Something went wrong')
    expect(transcriptNotice({ code: 'agent_error', message: 'Agent disconnected' }, 'en')).toBe('Agent disconnected')
    expect(transcriptNotice({}, 'en')).toBe('')
    expect(transcriptNotice(null, 'en')).toBe('')
  })

  it('Later entries in the same turn or turn completion collapse thinking; other turns have no effect', () => {
    const reasoning = item('reasoning')
    expect(reasoningActive(reasoning, [reasoning], 'turn')).toBe(true)
    expect(reasoningActive(reasoning, [reasoning, item('user', {}, 'other')], 'turn')).toBe(true)
    expect(reasoningActive(reasoning, [reasoning, item('plan')], 'turn')).toBe(false)
    expect(reasoningActive(reasoning, [reasoning], null)).toBe(false)
    expect(reasoningActive(reasoning, [reasoning], 'next')).toBe(false)
  })

  it('localizes failure notices and their structured causes in both languages', () => {
    const payload = {
      code: 'ref_unresolvable', reason: 'session.ref_unresolvable',
      message: 'Cannot resolve references: Referenced node demo has been deleted or does not exist',
      params: { detail: 'Referenced node demo has been deleted or does not exist' },
      cause: { message: 'Referenced node demo has been deleted or does not exist', data: { reason: 'session.ref_node_not_found', params: { nodeId: 'demo' } } },
    }
    expect(transcriptNotice(payload, 'zh-CN')).toBe('引用无法解析：引用的节点 demo 已删除或不存在')
    expect(transcriptNotice(payload, 'en')).toBe(payload.message)
  })
})

it('localizes uncertain interrupted delivery without claiming Send now paused the queue', () => {
  const notice = { code: 'send_now_dispatch_unknown', message: 'Fallback notice' }
  expect(transcriptNotice(notice, 'en')).toContain('selected queued message will be sent next')
  // english-exempt: Chinese UI copy assertion verifies the queue notice in its original locale.
  expect(transcriptNotice(notice, 'zh-CN')).toContain('优先发送')
})
