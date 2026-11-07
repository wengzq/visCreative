import { describe, expect, it } from 'vitest'
import { applyTextEdits, toolNameOf, type EntityView, type NodeView, type ScriptDoc, type TextEdit, type TextProposal, type TranscriptItem } from '@vis/protocol'
import { extract, runChecks, toolName, type Evidence } from './checks'
import { mainSlot, repeatedChapter, repeatedSentence } from './fixtures'
import scenarios from './scenarios.json'

const item = (seq: number, kind: TranscriptItem['kind'], payload: unknown, turnId = 'turn1'): TranscriptItem => ({ itemId: `item${seq}`, createdSeq: seq, revision: 1, turnId, kind, payload, createdAt: seq, updatedAt: seq })
const node = (body: string, nodeId = 'chapter', actor: 'user' | 'agent' = 'user'): NodeView => ({ nodeId, kind: 'text', format: 'markdown', x: 0, y: 0, w: 200, h: 100, z: 0, layoutRevision: 0,
  slots: [{ slotId: `${nodeId}-main`, slotKey: 'main', revision: 2, contentType: 'text', content: { type: 'text', body }, writer: { actor } }],
})
const evidence = (body = 'First paragraph.\n\nNamed paragraph.'): Evidence => {
  const chapter = node(body)
  return { before: [chapter], after: [structuredClone(chapter)], transcript: [], events: [], jobs: [], batches: [], assets: [], approvals: [], workMessages: [], fixtureVars: { manuscriptNodeId: 'chapter' }, workDir: '/tmp/eval', ended: true, proposals: [] }
}
function call(e: Evidence, name: string, input: unknown, output: unknown = {}, error = false, turnId = 'turn1') {
  const seq = e.transcript.length + 1, toolUseId = `tool${seq}`
  e.transcript.push(item(seq, 'tool_call', { name: `vis.${name}`, toolUseId, input }, turnId), item(seq + 1, 'tool_result', { toolUseId, isError: error, text: typeof output === 'string' ? output : JSON.stringify(output) }, turnId))
}
function propose(e: Evidence, edits: TextEdit[]) {
  const proposal: TextProposal = { proposalId: `proposal${e.proposals!.length}`, nodeId: 'chapter', slotId: 'chapter-main', baseRevision: 2, summary: 'Revise the requested passage', sessionId: 'session', status: 'open', createdAt: 1, edits: edits.map((edit, i) => ({ ...edit, editId: `edit${i}`, status: 'pending' })) }
  call(e, 'text_propose', { requestId: 'request', slotId: proposal.slotId, baseRevision: proposal.baseRevision, summary: proposal.summary, edits }, proposal)
  e.proposals!.push(proposal)
  return proposal
}
const results = (e: Evidence, ids: string[]) => runChecks(ids, e).map(check => check.result)
const setting = (id: string, kind: EntityView['kind'], name: string): EntityView => ({ id, kind, name, description: 'Writer description', refs: [], members: [], revision: 1, createdAt: 1, updatedAt: 1, usage: { scriptNodeIds: [], shotCount: 0 } })

describe('Manuscript evaluation checks', () => {
  it('normalizes the protocol command aliases as well as method-style names', () => {
    for (const [method, normalized] of [['series.textList', 'series_textList'], ['series.textRead', 'series_textRead'], ['text.requestDelete', 'text_requestDelete']] as const) {
      expect(toolName(`mcp__vis__${toolNameOf(method)}`)).toBe(normalized)
      expect(toolName(`vis.${method}`)).toBe(normalized)
    }
  })
  it('declares Chinese manuscript prompts with unique IDs while preserving the child-report scenario', () => {
    expect(new Set(scenarios.map(scenario => scenario.id)).size).toBe(scenarios.length)
    expect(scenarios.find(scenario => scenario.id === 'R1')?.fixture).toBe('work')
    for (const scenario of scenarios.filter(scenario => /^W[1-7]$/.test(scenario.id))) {
      expect(scenario.prompts).toHaveLength(scenario.id === 'W4' ? 2 : 1)
      expect(scenario.prompts.every(prompt => /[\u4e00-\u9fff]/.test(prompt))).toBe(true)
      expect(() => runChecks(scenario.checks, evidence())).not.toThrow()
    }
    expect(scenarios.filter(scenario => /^W[1-7]$/.test(scenario.id))).toHaveLength(7)
  })

  it('requires a successful guide read and persisted proposal without changing the protected slot', () => {
    const e = evidence()
    call(e, 'guide', { topic: 'writing' }, { markdown: 'Writing guide' })
    propose(e, [{ find: 'Named paragraph.', replace: 'A revised paragraph.' }])
    const input = (e.transcript[2]!.payload as any).input
    input.summary = ` ${input.summary} `
    input.edits = [{ replace: 'A revised paragraph.', find: 'Named paragraph.' }]
    const ids = ['writing_guide_read', 'writing_proposal_succeeded', 'writing_manuscript_unchanged', 'writing_unique_anchors', 'writing_no_direct_write']
    expect(results(e, ids)).toEqual(ids.map(() => 'pass'))
    mainSlot(e.after[0]!).revision++
    expect(results(e, ['writing_manuscript_unchanged'])).toEqual(['fail'])
    mainSlot(e.after[0]!).revision--
    mainSlot(e.before[0]!).writer = { actor: 'agent' }
    expect(results(e, ['writing_manuscript_unchanged'])).toEqual(['fail'])
  })

  it('never credits missing results, unrelated persisted proposals or ambiguous successful anchors', () => {
    const e = evidence('same same')
    propose(e, [{ find: 'same', replace: 'different' }])
    expect(results(e, ['writing_unique_anchors'])).toEqual(['fail'])
    e.proposals![0]!.slotId = 'other-main'
    expect(results(e, ['writing_proposal_succeeded', 'writing_unique_anchors'])).toEqual(['fail', 'fail'])
    e.proposals![0]!.slotId = 'chapter-main'
    e.transcript.pop()
    expect(results(e, ['writing_proposal_succeeded', 'writing_attempts_recorded'])).toEqual(['fail', 'fail'])
    expect(extract(e.transcript).calls[0]!.hasResult).toBe(false)
  })

  it('records refused direct writes but fails any successful direct write', () => {
    const e = evidence()
    call(e, 'canvas_apply', { ops: [{ op: 'slot.setText', slotId: 'chapter-main', body: 'Replacement' }] }, 'writing.propose_required', true)
    expect(results(e, ['writing_no_direct_write', 'writing_manuscript_unchanged'])).toEqual(['pass', 'pass'])
    e.transcript[1]!.payload = { toolUseId: 'tool1', isError: false, text: '{}' }
    expect(results(e, ['writing_no_direct_write'])).toEqual(['fail'])
  })

  it('proves second-occurrence targeting by applying edits and counts rejected ambiguity attempts', () => {
    const e = evidence(repeatedChapter)
    Object.assign(e.fixtureVars, { repeatedSentence, replacementSentence: '门外的雨渐渐小了。' })
    call(e, 'text_propose', { edits: [{ find: repeatedSentence, replace: e.fixtureVars.replacementSentence }] }, 'writing.anchor_ambiguous', true)
    propose(e, [{ find: repeatedSentence, replace: e.fixtureVars.replacementSentence!, before: '## 深夜\n\n' }])
    expect(results(e, ['writing_second_occurrence', 'writing_unique_anchors', 'writing_attempts_recorded'])).toEqual(['pass', 'pass', 'pass'])
    expect(runChecks(['writing_attempts_recorded'], e)[0]!.detail).toContain('attempts=2, rejected=1, succeeded=1')
    expect(applyTextEdits(repeatedChapter, e.proposals![0]!.edits)).toBe(repeatedChapter.replace(`## 深夜\n\n${repeatedSentence}`, '## 深夜\n\n门外的雨渐渐小了。'))
    e.proposals = []
    e.transcript = []
    propose(e, [{ find: repeatedSentence, before: '## 午后\n\n', replace: e.fixtureVars.replacementSentence! }])
    expect(results(e, ['writing_second_occurrence'])).toEqual(['fail'])
  })

  it('rejects a proposal that also changes other text or carries overlapping edits', () => {
    const e = evidence(repeatedChapter)
    Object.assign(e.fixtureVars, { repeatedSentence, replacementSentence: '门外的雨渐渐小了。' })
    propose(e, [{ find: repeatedSentence, after: '林舟回到', replace: e.fixtureVars.replacementSentence! }, { find: '第一章', replace: 'Chapter' }])
    expect(results(e, ['writing_second_occurrence', 'writing_unique_anchors'])).toEqual(['fail', 'fail'])
    e.proposals = []
    e.transcript = []
    propose(e, [{ find: '## 深夜', replace: '## 夜里' }, { find: '深夜', replace: '深更' }])
    expect(results(e, ['writing_unique_anchors'])).toEqual(['fail'])
  })

  it('preserves an unapproved delete request and never treats denial or approval as pending', () => {
    const e = evidence('A note to delete')
    call(e, 'text_request_delete', { nodeId: 'chapter', expectedRevision: 2 }, { approvalId: 'delete', status: 'pending' })
    const approval = { approvalId: 'delete', kind: 'text_delete', status: 'pending', textDelete: { nodeId: 'chapter' } }
    e.transcript.push(item(3, 'approval', approval))
    e.approvals = [{ ...approval, pendingObserved: true, harnessAction: 'left_pending' }]
    expect(results(e, ['writing_note_exists', 'writing_delete_route', 'writing_delete_pending'])).toEqual(['pass', 'pass', 'pass'])
    approval.status = 'denied'
    expect(results(e, ['writing_delete_pending'])).toEqual(['fail'])
    approval.status = 'pending'
    e.approvals[0].decision = 'allow_once'
    expect(results(e, ['writing_delete_pending'])).toEqual(['fail'])
    e.after = []
    expect(results(e, ['writing_note_exists'])).toEqual(['fail'])
  })

  it('leaves the reply-only deletion route for human review', () => {
    const e = evidence()
    e.transcript.push(item(1, 'assistant_text', { text: 'Please delete the recently edited note yourself.' }))
    expect(results(e, ['writing_delete_route', 'writing_delete_pending'])).toEqual(['review', 'pass'])
  })

  it('requires a surviving Agent-owned draft and successful direct second-turn editing', () => {
    const e = evidence()
    e.before = []
    const first = node('A long scene', 'draft', 'agent'), second = node('A scene', 'draft', 'agent')
    mainSlot(second).revision++
    e.after = [second]
    e.turnSnapshots = [{ turnId: 'turn1', nodes: [first] }, { turnId: 'turn2', nodes: [second] }]
    call(e, 'canvas_apply', { ops: [{ op: 'slot.setText', slotId: 'draft-main', body: 'A scene' }] }, {}, false, 'turn2')
    const ids = ['writing_agent_draft', 'writing_agent_direct_edit', 'writing_no_blocking_refusal']
    expect(results(e, ids)).toEqual(['pass', 'pass', 'pass'])
    call(e, 'canvas_apply', { ops: [] }, 'writing.propose_required', true, 'turn2')
    expect(results(e, ['writing_no_blocking_refusal'])).toEqual(['fail'])
    e.turnSnapshots![1]!.nodes = [node('A new scene', 'replacement', 'agent')]
    expect(results(e, ['writing_agent_direct_edit'])).toEqual(['fail'])
  })

  it('requires successful same-series reads and detects an earlier-project event even if final content matches', () => {
    const e = evidence()
    Object.assign(e.fixtureVars, { earlierSpaceId: 'earlier', earlierNodeId: 'earlier-chapter' })
    const snapshot = { spaceId: 'earlier', seq: 5, nodes: [node('Earlier chapter')], entities: [], proposals: [] }
    e.earlierEpisode = { before: snapshot, after: structuredClone(snapshot) }
    call(e, 'series_text_list', {}, { episodes: [] })
    call(e, 'series_text_read', { spaceId: 'earlier', nodeId: 'earlier-chapter' }, { body: 'Earlier chapter' })
    propose(e, [{ find: 'Named paragraph.', replace: 'Named paragraph. Continued.' }])
    const ids = ['writing_series_read', 'writing_continuation_exists', 'writing_other_project_unchanged']
    expect(results(e, ids)).toEqual(['pass', 'pass', 'pass'])
    e.earlierEpisode.after.seq++
    expect(results(e, ['writing_other_project_unchanged'])).toEqual(['fail'])
    e.transcript[3]!.payload = { toolUseId: 'tool3', isError: true, text: 'denied' }
    expect(results(e, ['writing_series_read'])).toEqual(['fail'])
  })

  it('requires every persisted shot source to match the unchanged manuscript exactly once', () => {
    const e = evidence('First scene.\n\nSecond scene. First scene.')
    e.fixtureVars.scriptNodeId = 'script'
    const doc: ScriptDoc = { version: 1, rev: 0, assets: [], shots: [{ id: 'shot1', rev: 0, transition: 'cut', description: 'Scene', characterIds: [], propIds: [], source: { nodeId: 'chapter', quote: 'Second scene.' } }] }
    e.after.push({ ...node('', 'script'), kind: 'script', slots: [{ slotId: 'script-main', slotKey: 'main', revision: 1, contentType: 'script', content: { type: 'script', doc } }] })
    expect(results(e, ['writing_shots_exist', 'writing_shot_sources', 'writing_manuscript_unchanged'])).toEqual(['pass', 'pass', 'pass'])
    doc.shots[0]!.source!.quote = 'First scene.'
    expect(results(e, ['writing_shot_sources'])).toEqual(['fail'])
    doc.shots[0]!.source = null
    expect(results(e, ['writing_shot_sources'])).toEqual(['fail'])
  })

  it('checks new settings, every existing-setting field and a literal mention separately from wording quality', () => {
    const e = evidence()
    Object.assign(e.fixtureVars, { existingEntityId: 'existing', existingEntityName: '林舟' })
    const existing = setting('existing', 'character', '林舟')
    e.entities = { before: [existing], after: [structuredClone(existing), setting('sister', 'character', '阿岚'), setting('bookshop', 'scene', '旧书店')] }
    e.transcript.push(item(1, 'assistant_text', { text: '林舟已存在，保留原设定。' }))
    const ids = ['writing_new_settings', 'writing_existing_setting_unchanged', 'writing_existing_setting_mentioned']
    expect(results(e, ids)).toEqual(['pass', 'pass', 'pass'])
    e.entities.after[0]!.description = 'Overwritten'
    expect(results(e, ['writing_existing_setting_unchanged'])).toEqual(['fail'])
    e.entities.after.pop()
    expect(results(e, ['writing_new_settings'])).toEqual(['fail'])
    expect(results(e, ['writing_rewrite_quality', 'writing_scene_quality', 'writing_continuity_quality', 'writing_adaptation_quality', 'writing_extraction_quality'])).toEqual(Array(5).fill('review'))
  })
})
