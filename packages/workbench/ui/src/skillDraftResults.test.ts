import { describe, expect, it } from 'vitest'
import type { SkillDraft, TranscriptItem } from '@vis/protocol'
import { skillDraftResults } from './SkillDraftCard'
import { workTranscript } from './workBlocks'

const draft: SkillDraft = { draftId: 'draft', revision: 1, name: 'My method', description: 'My reasons', body: 'My choices', spaceId: 'p', sessionId: 's', createdAt: 1 }
const item = (itemId: string, kind: TranscriptItem['kind'], payload: unknown): TranscriptItem => ({ itemId, revision: 1, turnId: 't', kind, payload, createdAt: 1, updatedAt: 1, createdSeq: 1 })
const receipt = (id: string) => item(id, 'tool_result', { text: JSON.stringify({ draft, location: 'Settings > My skills' }) })

describe('skill draft receipts', () => {
  it('derives one card from the last actual receipt and places it between work and the reply', () => {
    const items = [item('call', 'tool_call', { tool: 'skill.proposeDraft', input: { name: draft.name } }), receipt('first'), receipt('last'), item('reply', 'assistant_text', { text: 'Review your draft' })]
    expect([...skillDraftResults(items).keys()]).toEqual(['last'])
    expect(workTranscript(items).map(group => group.kind)).toEqual(['work', 'skillDraft', 'item'])
    expect(workTranscript(items)[1]).toEqual({ kind: 'skillDraft', draft: { draftId: draft.draftId, revision: draft.revision, name: draft.name, description: draft.description, spaceId: draft.spaceId, sessionId: draft.sessionId, createdAt: draft.createdAt } })
  })
  it('omits errors, malformed content and unrelated tool results', () => {
    expect(skillDraftResults([item('bad', 'tool_result', { text: '{' }), item('unrelated', 'tool_result', { text: JSON.stringify({ draft }) }), item('error', 'tool_result', { isError: true, text: JSON.stringify({ draft, location: 'Settings > My skills' }) })]).size).toBe(0)
  })
})
