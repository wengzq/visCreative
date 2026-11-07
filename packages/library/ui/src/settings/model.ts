import type { EntityKind, EntityMember, EntityProposalView, EntityView } from '@vis/protocol'

export const settingKinds = ['character', 'scene', 'prop', 'style'] as const

export function groupSettings(items: readonly EntityView[], query = ''): Record<EntityKind, EntityView[]> {
  const needle = query.trim().toLocaleLowerCase()
  return Object.fromEntries(settingKinds.map(kind => [kind, items.filter(item => item.kind === kind &&
    (!needle || `${item.name}\n${item.description}`.toLocaleLowerCase().includes(needle)))])) as Record<EntityKind, EntityView[]>
}

export type ProposalDraft = { name: string; members: EntityMember[]; refs: string[] }
export const proposalDraft = (proposal: EntityProposalView): ProposalDraft => ({
  name: proposal.name, members: proposal.members.map(member => ({ ...member })), refs: [...(proposal.refs ?? [])],
})

export function toggleProposalMember(draft: ProposalDraft, member: EntityMember, imageVersions: readonly string[]): ProposalDraft {
  const selected = draft.members.some(item => item.assetId === member.assetId)
  return {
    ...draft,
    members: selected ? draft.members.filter(item => item.assetId !== member.assetId) : [...draft.members, member],
    refs: selected ? draft.refs.filter(id => !imageVersions.includes(id)) : draft.refs,
  }
}

export function proposalChanged(proposal: EntityProposalView, draft: ProposalDraft): boolean {
  return draft.name.trim() !== proposal.name || JSON.stringify(draft.members) !== JSON.stringify(proposal.members) ||
    JSON.stringify(draft.refs) !== JSON.stringify(proposal.refs ?? [])
}

export const canAcceptProposal = (proposal: EntityProposalView, draft: ProposalDraft) =>
  !!draft.name.trim() && draft.members.length > 0 && (!proposal.needsRecheck || proposalChanged(proposal, draft))

export function duplicateSettingId(error: unknown): string | undefined {
  type Details = { reason?: string; params?: { entityId?: string } }
  const value = error as { details?: Details; data?: Details & { details?: Details } } | null
  const details = value?.details ?? value?.data?.details ?? value?.data
  return details?.reason === 'entity.name_taken' ? details.params?.entityId : undefined
}

export const revisionConflict = (error: unknown) => (error as { code?: string } | null)?.code === 'revision_conflict'

export function mergeSetting(items: readonly EntityView[], entity: EntityView): EntityView[] {
  if (entity.deletedAt) return items.filter(item => item.id !== entity.id)
  return items.some(item => item.id === entity.id)
    ? items.map(item => item.id === entity.id ? entity : item)
    : [...items, entity]
}

export function mergeMembers(existing: readonly EntityMember[], added: readonly EntityMember[]): EntityMember[] {
  const members = new Map(existing.map(member => [member.assetId, member]))
  for (const member of added) if (!members.has(member.assetId)) members.set(member.assetId, member)
  return [...members.values()]
}
