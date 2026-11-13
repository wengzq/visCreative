import type { AgentModelOption, AgentView, WorkSessionView } from '@vis/protocol'
import { expect, it } from 'vitest'
import { workSessionLabel } from './sessionLabels'

const session = (id: string, config: Partial<WorkSessionView['agentConfig']> = {}): WorkSessionView => ({ sessionId: id, agentKind: 'codex', title: id, activeTurnId: null, silentSince: null, doing: null, lastActivityAt: null, archived: false, agentConfig: { model: null, effort: null, serviceTier: null, ...config } })
const agents = [{ kind: 'codex', label: 'Codex' }] as AgentView[]
const models: AgentModelOption[] = [{ id: 'opaque:default', label: 'Catalog model', isDefault: true, efforts: [{ id: 'xhigh', label: 'Extra high' }], defaultEffort: 'xhigh', serviceTiers: [{ id: 'fast', label: 'Fast' }] }]

it.each(['en', 'zh-CN'] as const)('keeps indexed Agent names separate from configuration in %s', locale => {
  const sessions = [session('first'), session('second', { model: 'opaque:default', effort: 'xhigh' })]
  const label = workSessionLabel(sessions[1]!, sessions, agents, locale, { codex: models })
  expect(label).toEqual({ agentName: 'Codex 2', configLabel: 'Catalog model · Extra high', label: 'Codex 2 · Catalog model · Extra high' })
  expect(workSessionLabel(sessions[0]!, sessions, agents, locale, { codex: models }).configLabel).toBe('')
})

it.each(['en', 'zh-CN'] as const)('shows effort-only and tier-only settings with localized default model copy in %s', locale => {
  const effort = session('effort', { effort: 'xhigh' })
  const tier = session('tier', { serviceTier: 'default' })
  const defaultModel = locale === 'en' ? 'Default model' : '默认模型'
  const standard = locale === 'en' ? 'Standard speed' : '标准速度'
  expect(workSessionLabel(effort, [effort], agents, locale, {}).configLabel).toBe(`${defaultModel} · xhigh`)
  expect(workSessionLabel(tier, [tier], agents, locale, {}).configLabel).toBe(`${defaultModel} · ${standard}`)
  expect(workSessionLabel(effort, [effort], agents, locale, { codex: models }).configLabel).toBe('Catalog model · Extra high')
  expect(workSessionLabel(session('fast', { serviceTier: 'fast' }), [], agents, locale, { codex: models }).configLabel).toBe('Catalog model · Fast')
})
