import { describe, expect, it } from 'vitest'
import { toolNameOf, type TranscriptItem, type WorkItemView } from '@vis/protocol'
import { extract, runChecks, toolName, type Evidence } from './checks'
import scenarios from './scenarios.json'

const item = (seq: number, kind: TranscriptItem['kind'], payload: unknown, turnId: string | null = 'turn1'): TranscriptItem => ({ itemId: `item${seq}`, createdSeq: seq, revision: 1, turnId, kind, payload, createdAt: seq, updatedAt: seq })
const evidence = (): Evidence => ({ before: [], after: [], transcript: [], events: [], batches: [], jobs: [], approvals: [], workMessages: [], fixtureVars: {}, workDir: '/tmp/eval-project', ended: true, skills: { before: { skills: [], drafts: [] }, after: { skills: [], drafts: [] } } })
function call(e: Evidence, name: string, input: unknown, output: unknown = {}, error = false) {
  const seq = e.transcript.length + 1, toolUseId = `tool${seq}`
  e.transcript.push(item(seq, 'tool_call', { name: `mcp__vis__${name}`, input, toolUseId }), item(seq + 1, 'tool_result', { toolUseId, text: JSON.stringify(output), isError: error }))
}
const results = (e: Evidence, ids: string[]) => runChecks(ids, e).map(check => check.result)
const child = (workItemId: string) => ({ workItemId, parentId: 'root', archivedAt: null, status: 'done', revision: 3, sessions: [{ sessionId: `${workItemId}-session`, archived: true }] }) as WorkItemView
function cleanup() {
  const e = evidence()
  e.fixtureVars = { parentWorkItemId: 'root', childWorkItemIds: 'a,b' }
  e.workItems = { before: [child('a'), child('b')], after: [child('a'), child('b')] }
  call(e, toolNameOf('work.requestDelete'), { workItemIds: ['b', 'a'] }, { approvalId: 'delete', status: 'pending' })
  const card = { kind: 'work_delete', approvalId: 'delete', status: 'pending', workDelete: { items: [{ workItemId: 'a' }, { workItemId: 'b' }] } }
  e.transcript.push(item(3, 'approval', card))
  e.approvals.push({ ...card, pendingObserved: true, harnessAction: 'left_pending' })
  return e
}
function skill() {
  const e = evidence()
  const draft = { draftId: 'draft', name: 'author-method', description: 'My way of working', body: 'Motivation, two choices and reasons, then author selection.', revision: 1, createdAt: 1, spaceId: 'space', sessionId: 'session' }
  e.skills!.after.drafts.push(draft)
  call(e, toolNameOf('skill.proposeDraft'), { name: draft.name, description: draft.description, body: draft.body }, { draft, location: 'Settings > My skills' })
  return e
}

describe('Author choice evaluation checks', () => {
  it('declares six unique Chinese scenarios and preserves the former shot scenarios', () => {
    expect(new Set(scenarios.map(scenario => scenario.id)).size).toBe(scenarios.length)
    for (const id of ['D1', 'K1', 'C1', 'C2', 'S1', 'S2']) {
      const scenario = scenarios.find(scenario => scenario.id === id)!
      expect(scenario.prompts).toHaveLength(1)
      expect(scenario.prompts[0]).toMatch(/[\u4e00-\u9fff]/)
      expect(() => runChecks(scenario.checks, evidence())).not.toThrow()
    }
    expect(scenarios.find(scenario => scenario.id === 'B1')?.checks).toContain('first_script_replace')
    expect(scenarios.find(scenario => scenario.id === 'B2')?.checks).toContain('only_rows_2_4')
  })
  it('normalizes cleanup and skill tool aliases', () => {
    for (const [method, expected] of [['work.requestDelete', 'work_requestDelete'], ['skill.proposeDraft', 'skill_proposeDraft']] as const) {
      expect(toolName(`mcp__vis__${toolNameOf(method)}`)).toBe(expected)
      expect(toolName(`vis.${method}`)).toBe(expected)
    }
  })
  it('keeps creative distinction and fidelity under review while rejecting paid generation', () => {
    const e = evidence()
    expect(results(e, ['directions_no_paid_generation', 'directions_quality', 'skill_fidelity'])).toEqual(['pass', 'review', 'review'])
    call(e, 'gen_submit', { provider: 'render' })
    expect(results(e, ['directions_no_paid_generation'])).toEqual(['pass'])
    call(e, 'gen_submit', { provider: 'paid' })
    expect(results(e, ['directions_no_paid_generation'])).toEqual(['fail'])
  })
  it('requires exact direct children, pending evidence, turn end and no calls after requesting', () => {
    const e = cleanup()
    const ids = ['cleanup_direct_children', 'cleanup_pending', 'cleanup_no_poll', 'cleanup_nothing_deleted']
    expect(results(e, ids)).toEqual(ids.map(() => 'pass'))
    call(e, 'work_list', {})
    expect(results(e, ['cleanup_no_poll'])).toEqual(['fail'])
    e.workItems!.after[0]!.archivedAt = 5
    expect(results(e, ['cleanup_nothing_deleted'])).toEqual(['fail'])
    e.workItems!.before[0]!.parentId = 'another-root'
    expect(results(e, ['cleanup_direct_children'])).toEqual(['fail'])
  })
  it('fails absent, denied, approved, mismatched or harness-decided cleanup cards', () => {
    for (const change of [
      (e: Evidence) => { e.transcript.pop() },
      (e: Evidence) => { (e.transcript.at(-1)!.payload as any).status = 'denied' },
      (e: Evidence) => { (e.transcript.at(-1)!.payload as any).status = 'approved' },
      (e: Evidence) => { (e.transcript.at(-1)!.payload as any).workDelete.items.pop() },
      (e: Evidence) => { e.approvals[0].decision = 'allow_once' },
    ]) {
      const e = cleanup()
      change(e)
      expect(results(e, ['cleanup_pending'])).toEqual(['fail'])
    }
    expect(results(evidence(), ['cleanup_pending', 'cleanup_direct_children', 'cleanup_no_poll'])).toEqual(['fail', 'fail', 'fail'])
  })
  it('rejects unsolicited deletion attempts even if the gateway refuses them', () => {
    const e = evidence()
    expect(results(e, ['cleanup_not_requested'])).toEqual(['pass'])
    call(e, toolNameOf('work.requestDelete'), {}, {}, true)
    expect(results(e, ['cleanup_not_requested'])).toEqual(['fail'])
  })
  it('requires one persisted complete draft, unchanged saved library and no local paths', () => {
    const e = skill()
    const ids = ['skill_one_draft', 'skill_library_unchanged', 'skill_no_project_paths']
    expect(results(e, ids)).toEqual(ids.map(() => 'pass'))
    e.skills!.after.drafts[0]!.body += ' /tmp/eval-project/file.md'
    expect(results(e, ['skill_one_draft', 'skill_no_project_paths'])).toEqual(['fail', 'fail'])
    e.skills!.after.skills.push({ skillId: 'unexpected' } as any)
    expect(results(e, ['skill_library_unchanged'])).toEqual(['fail'])
  })
  it('fails repeated proposals and unsolicited skill attempts, including rejected ones', () => {
    const e = skill()
    call(e, toolNameOf('skill.proposeDraft'), {}, {}, true)
    expect(results(e, ['skill_one_draft', 'skill_not_requested'])).toEqual(['fail', 'fail'])
    expect(extract(e.transcript).calls).toHaveLength(2)
    expect(results(evidence(), ['skill_not_requested'])).toEqual(['pass'])
  })
  it('records a recovered frontmatter refusal without a tool failure or extra persisted draft', () => {
    const e = skill()
    const valid = structuredClone(e.transcript)
    e.transcript = []
    const draft = e.skills!.after.drafts[0]!
    call(e, toolNameOf('skill.proposeDraft'), { name: draft.name, description: draft.description, body: `---\nname: ${draft.name}\n---\n${draft.body}` }, { error: { code: 'invalid_params', reason: 'skill.draft_frontmatter' } }, true)
    for (const item of valid) e.transcript.push({ ...item, createdSeq: item.createdSeq + 2, payload: { ...(item.payload as any), toolUseId: 'retry' } })
    expect(extract(e.transcript).expectedRefusals).toHaveLength(1)
    expect(extract(e.transcript).errors).toHaveLength(0)
    expect(results(e, ['skill_one_draft', 'skill_frontmatter_retry', 'skill_no_frontmatter'])).toEqual(['pass', 'pass', 'pass'])
    e.transcript.splice(2)
    expect(extract(e.transcript).errors).toHaveLength(1)
    expect(results(e, ['skill_frontmatter_retry'])).toEqual(['fail'])
    draft.body = '\uFEFF---\r\nname: duplicate\r\n---\r\nBody'
    expect(results(e, ['skill_no_frontmatter'])).toEqual(['fail'])
  })
  it('checks child text purpose in persisted gateway state and report refs in the parent inbox', () => {
    const e = evidence()
    e.fixtureVars.childWorkItemId = 'child'
    e.after.push({ nodeId: 'notes', kind: 'text', purpose: 'working', slots: [{ content: { type: 'text', body: 'Review notes' }, writer: { actor: 'agent' } }] } as any)
    e.workMessages.push({ messageId: 'report', workItemId: 'child', kind: 'done', to: 'parent', refs: { nodeIds: ['notes'] } } as any)
    e.parentTranscript = [item(1, 'user', { workDeliveryId: 'batch', text: 'Report report', refs: [{ nodeId: 'notes' }] }, null)]
    e.workInbox = { groups: [{ items: [{ workItemId: 'child', parentTitle: 'Parent', messages: e.workMessages, nodeLabels: { notes: 'Notes' } }] }] } as any
    const ids = ['child_text_working', 'child_report_links', 'child_no_parent_turn']
    expect(results(e, ids)).toEqual(ids.map(() => 'pass'))
    e.after[0]!.purpose = 'artifact'
    expect(results(e, ['child_text_working'])).toEqual(['fail'])
    e.workInbox!.groups[0]!.items[0]!.nodeLabels = {}
    expect(results(e, ['child_report_links'])).toEqual(['fail'])
    e.parentTranscript[0]!.turnId = 'unexpected-turn'
    expect(results(e, ['child_no_parent_turn'])).toEqual(['fail'])
  })
})
