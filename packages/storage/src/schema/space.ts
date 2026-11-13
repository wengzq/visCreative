// space.db schema; see docs/rfc/0002-sqlite-storage.md. Run `pnpm --filter @vis/storage db:generate` after schema changes.
import { sql } from 'drizzle-orm'
import type { SceneChange, TextProposalEdit, PrevizDoc, SceneDoc, AssetLabelField, BatchView, EntityKind, EntityMemberRole, EntityProposalInput, EntityRef, FrameView, GenerationOperation, LocalOperation, MediaTaskView, NodeGeneration, ScriptDoc, ShotLink, ExportOf, TimelineDoc, WorkActor, WorkMessageFrom, WorkRefs } from '@vis/protocol'
import {
  type AnySQLiteColumn,
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'

// -- Sessions and runs ----------------------------------------------

export const workItems = sqliteTable('work_items', {
  id: text('id').primaryKey(),
  parentId: text('parent_id').references((): AnySQLiteColumn => workItems.id),
  title: text('title').notNull(),
  brief: text('brief').notNull().default(''),
  status: text('status', { enum: ['todo', 'in_progress', 'in_review', 'done'] }).notNull().default('todo'),
  pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
  reviewBy: text('review_by', { enum: ['user', 'parent'] }).notNull().default('user'),
  workDir: text('work_dir').notNull(),
  createdBy: text('created_by', { mode: 'json' }).$type<WorkActor>().notNull(),
  revision: integer('revision').notNull().default(1),
  activationSeq: integer('activation_seq'),
  unreportedBaselineSeq: integer('unreported_baseline_seq'),
  waitingSlotSince: integer('waiting_slot_since'),
  pendingFeedback: integer('pending_feedback', { mode: 'boolean' }).notNull().default(false),
  reviewReportId: text('review_report_id').references((): AnySQLiteColumn => workMessages.id, { onDelete: 'set null' }),
  agentKind: text('agent_kind'),
  statusChangedAt: integer('status_changed_at').notNull(),
  createdAt: integer('created_at').notNull(),
  archivedAt: integer('archived_at'),
}, t => [index('work_items_parent').on(t.parentId), index('work_items_waiting_slot').on(t.waitingSlotSince)])

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  agentKind: text('agent_kind').notNull(),
  title: text('title').notNull(),
  // shortcut: Nullable for legacy callers; make required once migration is complete. The session service always fills it in.
  workItemId: text('work_item_id').references(() => workItems.id),
  workDir: text('work_dir').notNull().default(''),
  titleSource: text('title_source', { enum: ['default', 'user', 'agent'] }).notNull().default('default'),
  agentResumeId: text('agent_resume_id'),
  providerLeafUuid: text('provider_leaf_uuid'),
  queuePaused: integer('queue_paused', { mode: 'boolean' }).notNull().default(false),
  // 0014: session-level model and reasoning effort; null uses Agent defaults.
  agentModel: text('agent_model'),
  reasoningEffort: text('reasoning_effort'),
  // Speed tier (e.g. Codex fast); null uses Agent defaults, 'default' forces standard speed.
  serviceTier: text('service_tier'),
  // 0015: session approval mode
  approvalMode: text('approval_mode', { enum: ['ask', 'auto'] }).notNull().default('ask'),
  createdAt: integer('created_at').notNull(),
  archivedAt: integer('archived_at'),
})

export const workMessages = sqliteTable('work_messages', {
  id: text('id').primaryKey(),
  workItemId: text('work_item_id').notNull().references(() => workItems.id),
  kind: text('kind', { enum: ['brief', 'done', 'question', 'blocked', 'escalation', 'reply', 'review_feedback', 'recall', 'deleted', 'failure'] }).notNull(),
  from: text('from', { mode: 'json' }).$type<WorkMessageFrom>().notNull(),
  to: text('to', { enum: ['parent', 'child', 'user'] }).notNull(),
  body: text('body').notNull(),
  refs: text('refs', { mode: 'json' }).$type<WorkRefs>().notNull().default({}),
  replyTo: text('reply_to').references((): AnySQLiteColumn => workMessages.id),
  deliveryId: text('delivery_id'),
  resolvedBy: text('resolved_by').references((): AnySQLiteColumn => workMessages.id),
  redelivered: integer('redelivered', { mode: 'boolean' }).notNull().default(false),
  targetSessionId: text('target_session_id').references(() => sessions.id),
  createdAt: integer('created_at').notNull(),
  deliveredAt: integer('delivered_at'),
  ackedAt: integer('acked_at'),
  readAt: integer('read_at'),
}, t => [
  index('work_messages_item_created').on(t.workItemId, t.createdAt),
  index('work_messages_session_delivery').on(t.targetSessionId, t.deliveryId),
])

export const agentInstances = sqliteTable(
  'agent_instances',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull().references(() => sessions.id),
    status: text('status', { enum: ['starting', 'ready', 'exited'] }).notNull(),
    pid: integer('pid'),
    tokenHash: text('token_hash').notNull().unique(),
    startedAt: integer('started_at').notNull(),
    exitedAt: integer('exited_at'),
    exitReason: text('exit_reason'),
  },
  t => [
    // At most one active instance per session at a time.
    uniqueIndex('agent_instances_one_active')
      .on(t.sessionId)
      .where(sql`${t.status} IN ('starting', 'ready')`),
  ],
)

export const messages = sqliteTable(
  'messages',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull().references(() => sessions.id),
    text: text('text').notNull(),
    workDeliveryId: text('work_delivery_id'),
    skills: text('skills', { mode: 'json' }).$type<string[]>().notNull().default([]),
    deliveryState: text('delivery_state', {
      enum: ['draft', 'submitted', 'delivered', 'unknown', 'rejected', 'withdrawn'],
    }).notNull(),
    queueOrder: real('queue_order'),
    createdAt: integer('created_at').notNull(),
    submittedAt: integer('submitted_at'),
  },
  t => [index('messages_session_state').on(t.sessionId, t.deliveryState)],
)

export const messageRefs = sqliteTable(
  'message_refs',
  {
    messageId: text('message_id').notNull().references(() => messages.id),
    ordinal: integer('ordinal').notNull(),
    // Exactly one of node references and asset references (0015).
    nodeId: text('node_id'),
    assetVersionId: text('asset_version_id'),
    slotId: text('slot_id'),
    versionPolicy: text('version_policy', { enum: ['latest-at-execution', 'pinned'] }),
    pinnedRevision: integer('pinned_revision'),
  },
  t => [primaryKey({ columns: [t.messageId, t.ordinal] })],
)

export const turns = sqliteTable('turns', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull().references(() => sessions.id),
  messageId: text('message_id').notNull().unique().references(() => messages.id),
  instanceId: text('instance_id').references(() => agentInstances.id),
  inputSnapshotId: text('input_snapshot_id').references((): AnySQLiteColumn => inputSnapshots.id),
  status: text('status', { enum: ['running', 'waiting_user', 'completed', 'failed', 'interrupted'] }).notNull(),
  startedAt: integer('started_at'),
  endedAt: integer('ended_at'),
})

export const transcriptEntries = sqliteTable(
  'transcript_entries',
  {
    sessionId: text('session_id').notNull().references(() => sessions.id),
    itemId: text('item_id').notNull(),
    // Initial creation sequence determines display order; content updates do not change position.
    createdSeq: integer('created_seq').notNull(),
    // Accept only higher revisions; discard late older revisions.
    revision: integer('revision').notNull(),
    turnId: text('turn_id').references(() => turns.id),
    kind: text('kind', { enum: ['user', 'assistant_text', 'reasoning', 'plan', 'tool_call', 'tool_result', 'notice', 'approval'] }).notNull(),
    payload: text('payload', { mode: 'json' }).notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  t => [primaryKey({ columns: [t.sessionId, t.itemId] }), unique().on(t.sessionId, t.createdSeq)],
)

// -- Canvas ---------------------------------------------------------

export const nodes = sqliteTable('nodes', {
  id: text('id').primaryKey(),
  kind: text('kind', { enum: ['image', 'video', 'audio', 'text', 'script', 'timeline', 'previz', 'scene', 'frame'] }).notNull(),
  x: real('x').notNull(),
  y: real('y').notNull(),
  w: real('w').notNull(),
  h: real('h').notNull(),
  z: real('z').notNull(),
  layoutRevision: integer('layout_revision').notNull().default(1),
  generation: text('generation', { mode: 'json' }).$type<NodeGeneration>(),
  shot: text('shot', { mode: 'json' }).$type<ShotLink>(),
  // 0024: set on nodes produced by timeline.export
  exportOf: text('export_of', { mode: 'json' }).$type<ExportOf>(),
  frame: text('frame', { mode: 'json' }).$type<FrameView>(),
  frameId: text('frame_id').references((): AnySQLiteColumn => nodes.id, { onDelete: 'set null' }),
  // 0016: free-text category, artifact or work document, text display format.
  category: text('category'),
  title: text('title'),
  purpose: text('purpose', { enum: ['artifact', 'working'] }).notNull().default('artifact'),
  format: text('format', { enum: ['plain', 'markdown', 'code'] }).notNull().default('plain'),
  createdAt: integer('created_at').notNull(),
  deletedAt: integer('deleted_at'),
})

export const nodeInputs = sqliteTable(
  'node_inputs',
  {
    nodeId: text('node_id').notNull().references(() => nodes.id),
    ordinal: integer('ordinal').notNull(),
    inputNodeId: text('input_node_id').notNull().references(() => nodes.id),
  },
  t => [primaryKey({ columns: [t.nodeId, t.ordinal] })],
)

export const slots = sqliteTable(
  'slots',
  {
    id: text('id').primaryKey(),
    nodeId: text('node_id').notNull().references(() => nodes.id),
    slotKey: text('slot_key').notNull(),
    contentType: text('content_type', { enum: ['image', 'video', 'audio', 'text', 'script', 'timeline', 'previz', 'scene'] }).notNull(),
    // 0 means an empty slot.
    currentRevision: integer('current_revision').notNull().default(0),
    // Currently accepted generation request, i.e. generationRequestId in 0001.
    acceptedBindingId: text('accepted_binding_id'),
    deletedAt: integer('deleted_at'),
  },
  t => [unique().on(t.nodeId, t.slotKey)],
)

// One row per slot content revision; text and media share this table.
export const slotRevisions = sqliteTable(
  'slot_revisions',
  {
    slotId: text('slot_id').notNull().references(() => slots.id),
    revision: integer('revision').notNull(),
    assetVersionId: text('asset_version_id').references((): AnySQLiteColumn => assetVersions.id),
    textBody: text('text_body'),
    scriptDoc: text('script_doc', { mode: 'json' }).$type<ScriptDoc>(),
    // 0024: the document of a timeline slot
    timelineDoc: text('timeline_doc', { mode: 'json' }).$type<TimelineDoc>(),
    previzDoc: text('previz_doc', { mode: 'json' }).$type<PrevizDoc>(),
    sceneDoc: text('scene_doc', { mode: 'json' }).$type<SceneDoc>(),
    operationId: text('operation_id').notNull().references((): AnySQLiteColumn => operations.id),
    createdAt: integer('created_at').notNull(),
  },
  t => [
    primaryKey({ columns: [t.slotId, t.revision] }),
    // Both null means "clear".
    check('slot_revisions_single_content', sql`${t.assetVersionId} IS NULL OR ${t.textBody} IS NULL`),
  ],
)

// -- Assets ---------------------------------------------------------

export const blobs = sqliteTable('blobs', {
  hash: text('hash').primaryKey(),
  byteSize: integer('byte_size').notNull(),
  createdAt: integer('created_at').notNull(),
})

export const assets = sqliteTable('assets', {
  id: text('id').primaryKey(),
  // font (0024d): referenced by timeline text, never placed on the canvas
  kind: text('kind', { enum: ['image', 'video', 'audio', 'font', 'model'] }).notNull(),
  // derived: processed from an existing asset, e.g. video frame extraction.
  origin: text('origin', { enum: ['import', 'generation', 'derived'] }).notNull(),
  displayName: text('display_name'),
  category: text('category'),
  archivedAt: integer('archived_at'),
  revision: integer('revision').notNull().default(1),
  labeledBy: text('labeled_by', { enum: ['agent', 'user'] }),
  userFields: text('user_fields', { mode: 'json' }).$type<AssetLabelField[]>().notNull().default([]),
  createdAt: integer('created_at').notNull(),
})

// -- Media library metadata and organize runs (0027 step a) ----------

export const assetTags = sqliteTable('asset_tags', {
  assetId: text('asset_id').notNull().references(() => assets.id),
  tag: text('tag').notNull(),
  normalized: text('normalized').notNull(),
}, t => [
  primaryKey({ columns: [t.assetId, t.tag] }),
  uniqueIndex('asset_tags_normalized').on(t.assetId, t.normalized),
  index('asset_tags_lookup').on(t.normalized),
])

export const libraryState = sqliteTable('library_state', {
  id: integer('id').primaryKey().default(1),
  sessionId: text('session_id').references(() => sessions.id),
}, t => [check('library_state_singleton', sql`${t.id} = 1`)])

export const libraryRuns = sqliteTable('library_runs', {
  id: text('id').primaryKey(),
  kind: text('kind', { enum: ['label', 'merge'] }).notNull(),
  sessionId: text('session_id').notNull().references(() => sessions.id),
  startedAt: integer('started_at').notNull(),
  revertedAt: integer('reverted_at'),
}, t => [index('library_runs_started').on(t.startedAt, t.id)])

export type LibraryLabelSnapshot = {
  displayName: string | null
  category: string | null
  tags: string[]
  labeledBy: 'agent' | 'user' | null
  userFields: AssetLabelField[]
}

export const libraryRunChanges = sqliteTable('library_run_changes', {
  runId: text('run_id').notNull().references(() => libraryRuns.id),
  assetId: text('asset_id').notNull().references(() => assets.id),
  before: text('before', { mode: 'json' }).$type<LibraryLabelSnapshot>().notNull(),
  after: text('after', { mode: 'json' }).$type<LibraryLabelSnapshot>().notNull(),
}, t => [primaryKey({ columns: [t.runId, t.assetId] })])

export const assetVersions = sqliteTable(
  'asset_versions',
  {
    id: text('id').primaryKey(),
    assetId: text('asset_id').notNull().references(() => assets.id),
    version: integer('version').notNull(),
    blobHash: text('blob_hash').notNull().references(() => blobs.hash),
    mime: text('mime').notNull(),
    width: integer('width'),
    height: integer('height'),
    durationMs: integer('duration_ms'),
    fps: real('fps'),
    hasAlpha: integer('has_alpha', { mode: 'boolean' }),
    // 0024d: family name from a font asset's name table
    fontFamily: text('font_family'),
    sourceJobId: text('source_job_id').references((): AnySQLiteColumn => generationJobs.id),
    createdAt: integer('created_at').notNull(),
  },
  t => [unique().on(t.assetId, t.version)],
)

// -- Project settings (0027 step b) ----------------------------------

export const entities = sqliteTable('entities', {
  id: text('id').primaryKey(),
  kind: text('kind').$type<EntityKind>().notNull(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  refs: text('refs', { mode: 'json' }).$type<EntityRef[]>().notNull().default([]),
  pendingSourceNodeId: text('pending_source_node_id'),
  revision: integer('revision').notNull().default(1),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  deletedAt: integer('deleted_at'),
  seriesEntityId: text('series_entity_id'),
  seriesRevision: integer('series_revision'),
  seriesBaseRevision: integer('series_base_revision'),
  seriesMemberAssetIds: text('series_member_asset_ids', { mode: 'json' }).$type<string[]>().notNull().default([]),
}, t => [uniqueIndex('entities_live_kind_name').on(t.kind, sql`lower(trim(${t.name}))`).where(sql`${t.deletedAt} IS NULL`)])

export const entityProposals = sqliteTable('entity_proposals', {
  id: text('id').primaryKey(),
  requestId: text('request_id').notNull(),
  sessionId: text('session_id').notNull().references(() => sessions.id),
  runId: text('run_id'),
  payload: text('payload', { mode: 'json' }).$type<EntityProposalInput>().notNull(),
  targetRevision: integer('target_revision'),
  resolvedEntityId: text('resolved_entity_id').references(() => entities.id),
  status: text('status', { enum: ['pending', 'accepted', 'rejected', 'superseded'] }).notNull(),
  createdAt: integer('created_at').notNull(),
  resolvedAt: integer('resolved_at'),
}, t => [index('entity_proposals_status').on(t.status)])

export const entityAssets = sqliteTable('entity_assets', {
  entityId: text('entity_id').notNull().references(() => entities.id),
  assetId: text('asset_id').notNull().references(() => assets.id),
  role: text('role').$type<EntityMemberRole>().notNull(),
  addedByProposalId: text('added_by_proposal_id').references(() => entityProposals.id),
}, t => [primaryKey({ columns: [t.entityId, t.assetId] }), index('entity_assets_asset').on(t.assetId)])

// -- Execution snapshots --------------------------------------------

export const inputSnapshots = sqliteTable('input_snapshots', {
  id: text('id').primaryKey(),
  turnId: text('turn_id').notNull().references((): AnySQLiteColumn => turns.id),
  createdAt: integer('created_at').notNull(),
})

// Store only pointers: slot_revisions and blobs are immutable.
export const snapshotItems = sqliteTable(
  'snapshot_items',
  {
    snapshotId: text('snapshot_id').notNull().references(() => inputSnapshots.id),
    ordinal: integer('ordinal').notNull(),
    nodeId: text('node_id').notNull(),
    slotId: text('slot_id').notNull(),
    slotRevision: integer('slot_revision').notNull(),
  },
  t => [
    primaryKey({ columns: [t.snapshotId, t.ordinal] }),
    foreignKey({ columns: [t.slotId, t.slotRevision], foreignColumns: [slotRevisions.slotId, slotRevisions.revision] }),
  ],
)

// -- Generation jobs and delivery -----------------------------------

export const generationJobs = sqliteTable('generation_jobs', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').references(() => sessions.id),
  turnId: text('turn_id').references(() => turns.id),
  inputSnapshotId: text('input_snapshot_id').references(() => inputSnapshots.id),
  kind: text('kind', { enum: ['image', 'video', 'audio'] }).notNull(),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  operation: text('operation').$type<GenerationOperation>().notNull().default('generate'),
  params: text('params', { mode: 'json' }).notNull(),
  status: text('status', {
    enum: ['queued', 'running', 'finalizing', 'succeeded', 'failed', 'unknown', 'cancelled'],
  }).notNull(),
  error: text('error', { mode: 'json' }),
  cancelRequestedAt: integer('cancel_requested_at'),
  providerCancelled: integer('provider_cancelled', { mode: 'boolean' }),
  quotaDate: text('quota_date'),
  queueReason: text('queue_reason', { enum: ['concurrency_limit'] }),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
})

export const mediaTasks = sqliteTable('media_tasks', {
  id: text('id').primaryKey(),
  requestId: text('request_id').notNull().unique(),
  status: text('status', { enum: ['queued', 'running', 'succeeded', 'failed'] }).notNull(),
  operation: text('operation').$type<LocalOperation>().notNull(),
  nodeId: text('node_id').notNull(),
  slotId: text('slot_id').notNull(),
  expectedRevision: integer('expected_revision').notNull(),
  sourceLayoutRevision: integer('source_layout_revision').notNull(),
  // 0024: null for timeline.export, which reads its sources from the timeline document
  sourceAssetVersionId: text('source_asset_version_id'),
  sessionId: text('session_id').references(() => sessions.id),
  params: text('params', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  assetVersionIds: text('asset_version_ids', { mode: 'json' }).$type<string[]>(),
  nodeIds: text('node_ids', { mode: 'json' }).$type<string[]>(),
  download: text('download', { mode: 'json' }).$type<MediaTaskView['download']>(),
  operationId: text('operation_id').references((): AnySQLiteColumn => operations.id),
  progress: real('progress'),
  error: text('error', { mode: 'json' }).$type<MediaTaskView['error']>(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, t => [index('media_tasks_status_created').on(t.status, t.createdAt)])

// Actual inputs used for this generation: snapshot inputs use snapshot revisions; other inputs are pinned at submission (0003).
export const jobInputs = sqliteTable(
  'job_inputs',
  {
    jobId: text('job_id').notNull().references(() => generationJobs.id),
    ordinal: integer('ordinal').notNull(),
    slotId: text('slot_id'),
    slotRevision: integer('slot_revision'),
    assetVersionId: text('asset_version_id').references(() => assetVersions.id),
    fromSnapshot: integer('from_snapshot', { mode: 'boolean' }).notNull(),
  },
  t => [
    primaryKey({ columns: [t.jobId, t.ordinal] }),
    foreignKey({ columns: [t.slotId, t.slotRevision], foreignColumns: [slotRevisions.slotId, slotRevisions.revision] }),
    check('job_inputs_one_source', sql`(${t.assetVersionId} IS NOT NULL AND ${t.slotId} IS NULL AND ${t.slotRevision} IS NULL) OR (${t.assetVersionId} IS NULL AND ${t.slotId} IS NOT NULL AND ${t.slotRevision} IS NOT NULL)`),
  ],
)

export const generationAttempts = sqliteTable(
  'generation_attempts',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id').notNull().references(() => generationJobs.id),
    attemptNo: integer('attempt_no').notNull(),
    // Allows querying after a timeout instead of resubmitting.
    externalTaskId: text('external_task_id'),
    status: text('status').notNull(),
    startedAt: integer('started_at').notNull(),
    endedAt: integer('ended_at'),
    error: text('error', { mode: 'json' }),
  },
  t => [unique().on(t.jobId, t.attemptNo)],
)

// Unique (job_id, output_index): duplicate notifications and recovery retries cannot register twice.
export const generationOutputs = sqliteTable(
  'generation_outputs',
  {
    jobId: text('job_id').notNull().references(() => generationJobs.id),
    outputIndex: integer('output_index').notNull(),
    assetVersionId: text('asset_version_id').notNull().references(() => assetVersions.id),
    createdAt: integer('created_at').notNull(),
  },
  t => [primaryKey({ columns: [t.jobId, t.outputIndex] })],
)

// Persist before executing generation; binding ID is generationRequestId in 0001.
export const deliveryBindings = sqliteTable(
  'delivery_bindings',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id').notNull().references(() => generationJobs.id),
    outputIndex: integer('output_index').notNull(),
    targetKind: text('target_kind', { enum: ['slot', 'new_node'] }).notNull(),
    nodeId: text('node_id'),
    slotId: text('slot_id'),
    expectedContentRevision: integer('expected_content_revision'),
    // Placement hint for new_node, e.g. { nearNodeId }.
    placement: text('placement', { mode: 'json' }),
    status: text('status', { enum: ['pending', 'delivered', 'conflict', 'target_missing', 'no_output'] }).notNull(),
    deliveredOperationId: text('delivered_operation_id').references((): AnySQLiteColumn => operations.id),
    createdNodeId: text('created_node_id').references(() => nodes.id),
  },
  t => [
    unique().on(t.jobId, t.outputIndex),
    check(
      'delivery_bindings_slot_target',
      sql`${t.targetKind} <> 'slot' OR (${t.nodeId} IS NOT NULL AND ${t.slotId} IS NOT NULL AND ${t.expectedContentRevision} IS NOT NULL)`,
    ),
  ],
)

// -- Operations, idempotency and events ------------------------------

export const operations = sqliteTable('operations', {
  id: text('id').primaryKey(),
  actorKind: text('actor_kind', { enum: ['user', 'agent', 'system'] }).notNull(),
  actorSessionId: text('actor_session_id').references(() => sessions.id),
  description: text('description'),
  createdAt: integer('created_at').notNull(),
})

export const idempotencyKeys = sqliteTable('idempotency_keys', {
  requestId: text('request_id').primaryKey(),
  method: text('method').notNull(),
  fingerprint: text('fingerprint').notNull(),
  result: text('result', { mode: 'json' }),
  createdAt: integer('created_at').notNull(),
})

export const contractMigrations = sqliteTable('contract_migrations', {
  id: text('id').primaryKey(),
  eventSeq: integer('event_seq').notNull(),
  idempotencyRowid: integer('idempotency_rowid').notNull(),
})

export const scriptBatches = sqliteTable('script_batches', {
  id: text('id').primaryKey(),
  view: text('view', { mode: 'json' }).$type<BatchView>().notNull(),
  execution: text('execution', { mode: 'json' }).$type<unknown>().notNull(),
  updatedAt: integer('updated_at').notNull(),
})

// Register in the same transaction as business changes; seq is the subscription cursor.
export const events = sqliteTable('events', {
  seq: integer('seq').primaryKey({ autoIncrement: true }),
  type: text('type').notNull(),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id').notNull(),
  payload: text('payload', { mode: 'json' }).notNull(),
  operationId: text('operation_id').references(() => operations.id),
  createdAt: integer('created_at').notNull(),
})

// One per user batch; inverse stores both the next inverse operation and conflict conditions.
export const undoEntries = sqliteTable('undo_entries', {
  id: text('id').notNull().unique(),
  operationId: text('operation_id').notNull().references(() => operations.id),
  seq: integer('seq').primaryKey({ autoIncrement: true }),
  state: text('state', { enum: ['done', 'undone'] }).notNull(),
  inverse: text('inverse', { mode: 'json' }).notNull(),
  createdAt: integer('created_at').notNull(),
})


// -- Manuscript suggestions (0031 step b) ----------------------------
export const textProposals = sqliteTable('text_proposals', {
  id: text('id').primaryKey(),
  slotId: text('slot_id').notNull().references(() => slots.id),
  sessionId: text('session_id').notNull().references(() => sessions.id),
  baseRevision: integer('base_revision').notNull(),
  summary: text('summary').notNull(),
  edits: text('edits', { mode: 'json' }).$type<TextProposalEdit[]>().notNull(),
  status: text('status', { enum: ['open', 'resolved'] }).notNull(),
  createdAt: integer('created_at').notNull(),
}, t => [index('text_proposals_slot_status').on(t.slotId, t.status)])


// -- Scene change proposals (0044) ----------------------------------
export const sceneProposals = sqliteTable('scene_proposals', {
  id: text('id').primaryKey(),
  slotId: text('slot_id').notNull().references(() => slots.id),
  sessionId: text('session_id').notNull().references(() => sessions.id),
  baseRevision: integer('base_revision').notNull(),
  summary: text('summary').notNull(),
  changes: text('changes', { mode: 'json' }).$type<SceneChange[]>().notNull(),
  status: text('status', { enum: ['open', 'resolved'] }).notNull(),
  createdAt: integer('created_at').notNull(),
}, t => [index('scene_proposals_slot_status').on(t.slotId, t.status), index('scene_proposals_status_slot').on(t.status, t.slotId)])
