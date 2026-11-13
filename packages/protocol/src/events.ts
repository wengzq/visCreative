import { z } from 'zod'
import { Id } from './common'
import { NodeView } from './canvas'
import { JobView } from './generation'
import { MediaTaskView } from './operations'
import { BatchView } from './batch'
import { SessionSummary } from './session'
import { WorkInboxCounts, WorkItemView, WorkSlotsView } from './work'

export const EVENT_TYPES = [
  'node.created',
  'node.updated',
  'node.deleted',
  'slot.revised',
  'session.created',
  'session.updated',
  'message.stateChanged',
  'turn.stateChanged',
  'transcript.itemUpserted',
  'job.stateChanged',
  'binding.stateChanged',
  'asset.versionAdded',
  'work.itemChanged',
  'work.messageAdded',
  'work.messageAcked',
  // 0021: local media task state changed; payload is MediaTaskView
  'mediaTask.stateChanged',
  // 0023: script batch state changed; payload is BatchView
  'scriptBatch.stateChanged',
  // 0027: library metadata of an asset changed; payload { assetId, revision }
  'asset.updated',
  // 0027: library session or organize runs changed; payload {}; clients reread library.state / library.runList
  'library.changed',
  // 0027 step b: payload { entityId, revision }
  'entity.created',
  'entity.updated',
  'entity.deleted',
  // 0027 step b: payload { proposalId, status }
  'entity.proposalChanged',
  // 0031: manuscript review states changed; payload { proposalId, slotId }
  'text.proposalChanged',
  // 0044: scene review states changed; payload { proposalId, slotId }
  'scene.proposalChanged',
] as const
export const EventType = z.enum(EVENT_TYPES)
export type EventType = z.infer<typeof EventType>

export const SpaceSnapshot = z.object({
  nodes: z.array(NodeView),
  sessions: z.array(SessionSummary),
  activeJobs: z.array(JobView),
  workItems: z.array(WorkItemView),
  // 0021: unfinished (queued, running) local media tasks
  activeMediaTasks: z.array(MediaTaskView).optional(),
  // 0023: batches not finished yet (pending_approval, running, paused)
  activeScriptBatches: z.array(BatchView).optional(),
})
export type SpaceSnapshot = z.infer<typeof SpaceSnapshot>

// Persistent events: duplicate delivery is allowed; clients deduplicate by seq.
export const SpaceEvent = z.object({
  seq: z.int().positive(),
  type: EventType,
  entityType: z.string(),
  entityId: Id,
  payload: z.unknown(),
})
export type SpaceEvent = z.infer<typeof SpaceEvent>

// Transient events: streamed text is not persisted and can be lost; session entries are authoritative for final content.
export const TransientEvent = z.object({
  kind: z.enum(['assistant_text', 'reasoning']).optional(),
  turnId: Id.optional(),
  sessionId: Id,
  itemId: Id,
  revision: z.int().nonnegative(),
  delta: z.string(),
})
export type TransientEvent = z.infer<typeof TransientEvent>

// Local task progress is transient; only status transitions belong in the durable event log.
export const MediaTaskProgress = z.strictObject({
  taskId: Id,
  progress: z.number().min(0).max(1),
})
export type MediaTaskProgress = z.infer<typeof MediaTaskProgress>

export const events = {
  subscribe: {
    params: z.object({ spaceId: Id, afterSeq: z.int().nonnegative().optional() }),
    result: z.discriminatedUnion('reset', [
      z.object({ reset: z.literal(true), snapshot: SpaceSnapshot, seq: z.int().nonnegative() }),
      z.object({ reset: z.literal(false) }),
    ]),
  },
} as const

export const NOTIFICATIONS = {
  'events.event': SpaceEvent,
  'events.transient': TransientEvent,
  'events.mediaProgress': MediaTaskProgress,
  // Global configuration changes only prompt rereading providers.list and are not stored in space events; reread on reconnect as well.
  'events.spacesChanged': z.strictObject({}),
  // 0027 step c: a series or its library changed; open projects reread series.entityList and their linked settings
  'events.seriesChanged': z.strictObject({ seriesId: Id }),
  'events.skillsChanged': z.strictObject({ seq: z.int().positive() }),
  'events.providersChanged': z.strictObject({}),
  // Cross-project global state (0009), pushed to all UI connections regardless of the current project; reread work.inbox / work.slots on reconnect.
  'events.workInboxChanged': WorkInboxCounts,
  'events.workSlotsChanged': WorkSlotsView,
} as const
