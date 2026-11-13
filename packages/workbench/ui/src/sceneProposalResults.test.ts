import { type SceneProposal, type TranscriptItem } from '@vis/protocol'
import { describe, expect, it } from 'vitest'
import { sceneProposalResults } from './SceneProposalCard'
import { workTranscript } from './workBlocks'

const proposal: SceneProposal = { proposalId: 'proposal', nodeId: 'scene', slotId: 'slot', baseRevision: 1, sessionId: 'session', summary: 'Lengthen scene', changes: [{ target: 'duration', base: 5, durationS: 8, changeId: 'duration', status: 'pending' }], status: 'open', createdAt: 1 }
const item = (itemId: string, kind: TranscriptItem['kind'], payload: unknown): TranscriptItem => ({ itemId, kind, payload, turnId: 'turn', revision: 1, createdAt: 1, updatedAt: 1, createdSeq: 1 })

describe('scene proposal receipts', () => {
  it('uses the last structured receipt despite truncated display text and places the card under the result', () => {
    const items = [item('call', 'tool_call', { tool: 'scene.propose' }), item('first', 'tool_result', { sceneProposal: proposal }), item('last', 'tool_result', { sceneProposal: proposal, text: '{truncated' }), item('reply', 'assistant_text', { text: 'Please review' })]
    expect([...sceneProposalResults(items).keys()]).toEqual(['last'])
    expect(workTranscript(items).map(group => group.kind)).toEqual(['work', 'sceneProposal', 'item'])
    expect(workTranscript(items)[1]).toEqual({ kind: 'sceneProposal', proposal })
  })
  it('ignores failed, malformed, unstructured and non-result receipts', () => {
    expect(sceneProposalResults([item('failed', 'tool_result', { isError: true, sceneProposal: proposal }), item('bad', 'tool_result', { sceneProposal: { summary: 'invalid' } }), item('text', 'tool_result', { text: JSON.stringify(proposal) }), item('assistant', 'assistant_text', { sceneProposal: proposal })]).size).toBe(0)
  })
})
