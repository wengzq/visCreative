import { describe, expect, it } from 'vitest'
import type { EntityProposalView, EntityView } from '@vis/protocol'
import { canAcceptProposal, duplicateSettingId, groupSettings, proposalDraft, toggleProposalMember } from './model'

const proposal: EntityProposalView = {
  proposalId: 'proposal', kind: 'character', name: 'Hero', reason: 'Same costume', sessionId: 'session', status: 'pending',
  needsRecheck: false, createdAt: 1, refs: ['cover', 'second'],
  members: [{ assetId: 'one', role: 'image' }, { assetId: 'two', role: 'image' }, { assetId: 'audio', role: 'voice' }],
}

describe('merge proposal review', () => {
  it('unticks a member and removes all of its reference versions', () => {
    const draft = toggleProposalMember(proposalDraft(proposal), proposal.members[0]!, ['cover', 'old-cover'])
    expect(draft.members.map(member => member.assetId)).toEqual(['two', 'audio'])
    expect(draft.refs).toEqual(['second'])
    expect(proposal.members).toHaveLength(3)
    expect(toggleProposalMember(draft, proposal.members[0]!, ['cover']).members).toHaveLength(3)
  })

  it('requires an actual user edit when a proposal needs recheck', () => {
    const stale = { ...proposal, needsRecheck: true }
    const draft = proposalDraft(stale)
    expect(canAcceptProposal(stale, draft)).toBe(false)
    expect(canAcceptProposal(stale, { ...draft, name: '  Hero ' })).toBe(false)
    expect(canAcceptProposal(stale, { ...draft, name: 'Reviewed Hero' })).toBe(true)
    expect(canAcceptProposal(stale, { ...draft, refs: ['second', 'cover'] })).toBe(true)
    expect(canAcceptProposal(stale, { ...draft, members: draft.members.slice(1) })).toBe(true)
  })

  it('does not accept a blank name or an empty member selection', () => {
    const draft = proposalDraft(proposal)
    expect(canAcceptProposal(proposal, draft)).toBe(true)
    expect(canAcceptProposal(proposal, { ...draft, name: ' ' })).toBe(false)
    expect(canAcceptProposal(proposal, { ...draft, members: [] })).toBe(false)
  })
})

it('groups all four setting kinds and searches names and descriptions without changing their order', () => {
  const setting = (id: string, kind: EntityView['kind'], description = ''): EntityView => ({
    id, kind, name: id, description, refs: [], members: [], revision: 1, createdAt: 1, updatedAt: 1,
    usage: { scriptNodeIds: [], shotCount: 0 },
  })
  const items = [setting('Hero', 'character'), setting('Station', 'scene'), setting('Lens', 'style', 'Hero lighting'), setting('Coat', 'prop')]
  expect(Object.values(groupSettings(items)).map(group => group.length)).toEqual([1, 1, 1, 1])
  expect(groupSettings(items, ' hERO ').character.map(item => item.name)).toEqual(['Hero'])
  expect(groupSettings(items, ' hERO ').style.map(item => item.name)).toEqual(['Lens'])
  expect(groupSettings(items, 'absent').scene).toEqual([])
})

it('finds duplicate setting links in domain and RPC errors', () => {
  const details = { reason: 'entity.name_taken', params: { entityId: 'existing' } }
  expect(duplicateSettingId({ details })).toBe('existing')
  expect(duplicateSettingId({ data: { details } })).toBe('existing')
  expect(duplicateSettingId({ data: details })).toBe('existing')
  expect(duplicateSettingId(null)).toBeUndefined()
})
