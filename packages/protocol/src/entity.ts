import { z } from 'zod'
import { Id, RequestId, Revision } from './common'

// 0027 step b: project-level settings (characters, scenes, props, styles). Reference images point to asset versions,
// never to canvas nodes, so a setting survives node deletion and can be copied to another project (step c).

export const ENTITY_LIMITS = { name: 60, description: 4000, refs: 4, proposalsPerCall: 20, members: 200 } as const

export const EntityKind = z.enum(['character', 'scene', 'prop', 'style'])
export type EntityKind = z.infer<typeof EntityKind>
export const EntityMemberRole = z.enum(['image', 'video', 'voice', 'other'])
export type EntityMemberRole = z.infer<typeof EntityMemberRole>

const Name = z.string().trim().min(1).max(ENTITY_LIMITS.name)
const Description = z.string().max(ENTITY_LIMITS.description)
// The first ref is the cover
const Refs = z.array(Id).max(ENTITY_LIMITS.refs)

export const EntityRef = z.object({
  assetVersionId: Id,
  // Canvas node the ref was picked from, for "show on canvas"; may be deleted since
  sourceNodeId: Id.optional(),
})
export type EntityRef = z.infer<typeof EntityRef>

export const EntityMember = z.object({ assetId: Id, role: EntityMemberRole })
export type EntityMember = z.infer<typeof EntityMember>

export const EntityView = z.object({
  id: Id,
  kind: EntityKind,
  name: z.string(),
  description: z.string(),
  refs: z.array(EntityRef),
  members: z.array(EntityMember),
  revision: Revision,
  createdAt: z.int(),
  updatedAt: z.int(),
  deletedAt: z.int().optional(),
  // Script nodes casting this setting and the number of shots referencing it
  usage: z.object({ scriptNodeIds: z.array(Id), shotCount: z.int().nonnegative() }),
  // Step c: present on settings linked to a series. revision is the pinned series revision; latestRevision the
  // series' newest one (newer means the card shows the update badge)
  series: z.object({ seriesEntityId: Id, revision: Revision, latestRevision: Revision, modifiedLocally: z.boolean() }).optional(),
})
export type EntityView = z.infer<typeof EntityView>

export const EntityProposalStatus = z.enum(['pending', 'accepted', 'rejected', 'superseded'])

export const EntityProposalInput = z.object({
  // Add to an existing setting; omitted means a new one
  entityId: Id.optional(),
  kind: EntityKind,
  name: Name,
  description: Description.optional(),
  members: z.array(EntityMember).min(1).max(ENTITY_LIMITS.members),
  // assetVersionIds among the members' image versions
  refs: Refs.optional(),
  reason: z.string().trim().min(1).max(200),
})
export type EntityProposalInput = z.infer<typeof EntityProposalInput>

export const EntityProposalView = EntityProposalInput.extend({
  proposalId: Id,
  runId: Id.optional(),
  sessionId: Id,
  status: EntityProposalStatus,
  // The target setting changed revision, or members were archived, after the proposal was made
  needsRecheck: z.boolean(),
  targetRevision: Revision.optional(),
  createdAt: z.int(),
  resolvedAt: z.int().optional(),
})
export type EntityProposalView = z.infer<typeof EntityProposalView>

export const entity = {
  list: {
    // spaceId lets the UI read another project's settings (the join-series checklist) without switching to it; agents always read their own.
    params: z.object({ spaceId: Id.optional(), kind: EntityKind.optional(), query: z.string().max(200).optional(), includeDeleted: z.boolean().default(false) }),
    result: z.object({ items: z.array(EntityView) }),
  },
  get: {
    params: z.object({ entityId: Id }),
    result: EntityView,
  },
  create: {
    params: z.object({
      requestId: RequestId, kind: EntityKind, name: Name, description: Description.optional(),
      refs: z.array(EntityRef).max(ENTITY_LIMITS.refs).optional(),
      members: z.array(EntityMember).max(ENTITY_LIMITS.members).optional(),
    }),
    result: EntityView,
  },
  update: {
    params: z.object({
      entityId: Id, expectedRevision: Revision, name: Name.optional(), description: Description.optional(),
      refs: z.array(EntityRef).max(ENTITY_LIMITS.refs).optional(),
      // Replaces the member list when given
      members: z.array(EntityMember).max(ENTITY_LIMITS.members).optional(),
    }),
    result: EntityView,
  },
  delete: {
    params: z.object({ entityId: Id, expectedRevision: Revision }),
    result: z.object({ entityId: Id, revision: Revision }),
  },
  propose: {
    params: z.object({ requestId: RequestId, runId: Id.optional(), proposals: z.array(EntityProposalInput).min(1).max(ENTITY_LIMITS.proposalsPerCall) }),
    result: z.object({ proposalIds: z.array(Id) }),
  },
  proposalList: {
    params: z.object({ status: EntityProposalStatus.default('pending') }),
    result: z.object({ items: z.array(EntityProposalView) }),
  },
  proposalResolve: {
    params: z.object({
      requestId: RequestId,
      proposalId: Id,
      accept: z.boolean(),
      // User edits applied on accept
      edits: z.object({ name: Name.optional(), description: Description.optional(), members: z.array(EntityMember).min(1).optional(), refs: Refs.optional() }).optional(),
    }),
    result: z.object({ proposal: EntityProposalView, entity: EntityView.optional() }),
  },
  // Removes the members added by the setting's latest accepted proposal
  unmerge: {
    params: z.object({ requestId: RequestId, entityId: Id, expectedRevision: Revision }),
    result: EntityView,
  },
} as const
