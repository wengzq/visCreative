import type { z } from 'zod'
import { asset, assetLibrary, font, model } from './asset'
import { canvas, slot } from './canvas'
import { entity } from './entity'
import { series, seriesEntity, spaceSeries } from './series'
import { library } from './library'
import { events } from './events'
import { generation } from './generation'
import { media } from './operations'
import { scriptBatch } from './batch'
import { providers } from './providers'
import { capabilities, fs, guide, preferences, runtime, skill, space } from './runtime'
import { session } from './session'
import { agents } from './agents'
import { work } from './work'
import { previz } from './previz'
import { writing, text, seriesText } from './writing'

// Callers: ui is a UI connection; agent is a CLI carrying a runtime token (see RFC 0003 "Caller identity").
export type Caller = 'ui' | 'agent'

export type MethodSpec = {
  params: z.ZodType
  result: z.ZodType
  callers: readonly Caller[]
  summary: string
  description?: string
  command?: readonly string[]
  // Agent callers are also filtered by session role (0009); omitted means all roles are allowed.
}

const ui = ['ui'] as const
const agent = ['agent'] as const
const both = ['ui', 'agent'] as const

// 0027 step a: media library.
export const LIBRARY_METHODS = {
  'asset.versions': { ...assetLibrary.versions, callers: ui, summary: '读取素材的全部版本' },
  'asset.list': {
    ...assetLibrary.list,
    callers: both,
    command: ['asset', 'list'],
    summary: 'List the project media library',
    description: 'Page through this project\'s media (images, video and audio). Each item has its name, category, tags, latest version, the nodes that use it and the settings it belongs to. category: null means uncategorized (by effective category: the asset\'s own category, otherwise that of the newest node using it). labeled: false lists only assets never labeled; usage may be used or unused; unused derived assets (extracted frames and the like) appear only with usage: unused or a query. For Agents each item carries context (titles and generation prompts of the nodes using it): label from that first and open the asset.get path only when it is not enough. The first page carries facets (category and tag counts). limit defaults to 100, at most 200; page with nextCursor.',
  },
  'asset.update': {
    ...assetLibrary.update,
    callers: ui,
    summary: '修改素材名称、类别、标签或归档',
    description: '用户修改的字段记入 userFields，此后 Agent 打标不会覆盖。confirm: true 先写入同时提交的字段，再把三项标注都标为用户确认。须携带 expectedRevision，冲突返回 revision_conflict。',
  },
  'asset.label': {
    ...assetLibrary.label,
    callers: agent,
    command: ['asset', 'label'],
    summary: 'Name, categorize and tag media in batches',
    description: 'At most 50 items per call, written in one transaction. Names are short and human-readable, never file names or hashes; use the recommended categories given in the organize task (in the user\'s language); at most 10 tags of up to 20 characters each, such as subject, place or shot size. Fields the user edited are never overwritten and come back in skippedFields: do not retry or work around them. Pass the organize task\'s runId when it gives one, so the user can undo the whole run. requestId is required; retrying the same content returns the first result.',
  },
  'library.state': { ...library.state, callers: both, command: ['library', 'state'], summary: 'Read the asset library state', description: 'Returns the library session, the number of unlabeled assets (needsViewing counts those that need looking at) and the number of pending grouping proposals.' },
  'library.setSession': { ...library.setSession, callers: ui, summary: '设置资产库负责会话' },
  'library.runStart': { ...library.runStart, callers: ui, summary: '开始一轮资产整理' },
  'library.runList': { ...library.runList, callers: ui, summary: '列出最近的整理' },
  'library.runRevert': { ...library.runRevert, callers: ui, summary: '撤销一轮整理' },
} as const satisfies Record<string, MethodSpec>

const CORE_METHODS = {
  'text.requestDelete': { ...text.requestDelete, callers: agent, command: ['text', 'request', 'delete'], summary: 'Request user approval to delete one manuscript node', description: 'Requires requestId and the current main slot expectedRevision. Creates a revision-pinned approval card; only a user click can authorize deletion, once. Denial, expiry or any text revision change leaves the node intact. Never retry deletion through canvas.apply to bypass approval.' },
  'text.propose': { ...text.propose, callers: agent, command: ['text', 'propose'], summary: 'Propose anchored manuscript edits for the writer to review', description: 'Read the writing guide first. Use the current main text slot revision as baseRevision. Each find, filtered by adjacent before/after context, must match exactly once; edits cannot overlap. Suggestions never change the manuscript. Requires requestId.' },
  'text.proposal.list': { ...text.proposalList, callers: both, command: ['text', 'proposals'], summary: 'List manuscript proposals and per-edit review states' },
  'text.proposal.resolve': { ...text.proposalResolve, callers: ui, summary: '接受或拒绝文稿修改建议' },
  'series.textList': { ...seriesText.list, callers: agent, command: ['series', 'text', 'list'], summary: 'List manuscript nodes of other episodes in this series in episode order', description: 'Read-only. Excludes working documents and code. Standalone projects return an empty list.' },
  'series.textRead': { ...seriesText.read, callers: agent, command: ['series', 'text', 'read'], summary: 'Read a manuscript from another project in the same series', description: 'Read-only. Projects outside this series, working documents and code are refused.' },
  'writing.split': { ...writing.split, callers: ui, summary: '按章节拆分为系列分集', description: '逐章创建项目并复制正文。requestId 固定本轮章节快照和选择，重试跳过已成功章节并返回逐章结果。原稿始终保留。' },
  'writing.importPreview': { ...writing.importPreview, callers: ui, summary: '预览文稿导入，不修改画布' },
  'agents.list': { ...agents.list, callers: ui, summary: '列出已注册的 Agent 及其可用状态' },
  'session.create': { ...session.create, callers: ui, summary: '创建会话' },
  'session.list': { ...session.list, callers: ui, summary: '列出会话' },
  'session.agentOptions': { ...session.agentOptions, callers: ui, summary: '列出会话可选的模型与思考强度' },
  'session.setAgentConfig': { ...session.setAgentConfig, callers: ui, summary: '设置会话的模型与思考强度' },
  'session.setApprovalMode': { ...session.setApprovalMode, callers: ui, summary: '设置会话的权限模式' },
  'session.rename': { ...session.rename, callers: ui, summary: '手动重命名会话' },
  'session.resetTitle': { ...session.resetTitle, callers: ui, summary: '恢复会话自动命名' },
  'session.setTitle': {
    ...session.setTitle,
    callers: agent,
    command: ['session', 'set', 'title'],
    summary: 'Set a short title for the current session',
    description: 'Names the session associated with the token for the current task. The trimmed title is 1–24 characters. Available only during an active turn; does not accept sessionId. If the user has named the session, returns applied: false, reason: user_named and the current title; preserve that title. An identical title causes no write or event. Requires requestId: identical retries return the first result; different content returns idempotency_conflict.',
  },
  'session.sendMessage': { ...session.sendMessage, callers: ui, summary: '发送消息' },
  'session.stop': { ...session.stop, callers: ui, summary: '停止回合' },
  'session.sendNow': { ...session.sendNow, callers: ui, summary: '停止当前回合并立即发送排队消息' },
  'session.respondApproval': { ...session.respondApproval, callers: ui, summary: '审批 Agent 操作' },
  'session.resumeQueue': { ...session.resumeQueue, callers: ui, summary: '恢复队列' },
  'session.clearQueue': { ...session.clearQueue, callers: ui, summary: '清空用户排队的消息' },
  'session.retryMessage': { ...session.retryMessage, callers: ui, summary: '重试消息' },
  'session.getTranscript': { ...session.getTranscript, callers: ui, summary: '读取会话记录' },
  'generation.submit': {
    ...generation.submit,
    callers: both,
    command: ['gen', 'submit'],
    summary: 'Submit image, video or audio generation',
    description: 'Agents and the UI can submit generation jobs in the current space and receive a queue receipt. Each input is { slotId, revision? } or { assetVersionId } (an asset version of this project); setting refs can be passed directly as asset-version inputs, and image numbers follow the combined input order. Inputs in the turn snapshot use snapshot revisions; other inputs are fixed to the specified revision or the current revision at submission, never refreshed during execution. Each outputIndex has at most one target. A target without expectedRevision uses its current revision; a new binding replaces the previous request’s eligibility for automatic writeback. Without targets, creates nodes beside the first input node, or in the results area if there are no inputs. Requires requestId: identical retries return the first result; different content returns idempotency_conflict. Use generation.get for execution and writeback results. operation defaults to generate, which requires a prompt. Other operations, such as image.upscale, process the first input and may omit the prompt. The chosen model has to list the operation in providers.list; unsupported operations are rejected before quota is reserved. New result nodes appear beside the source node.',
  },
  'generation.cancel': { ...generation.cancel, callers: both, command: ['gen', 'cancel'], summary: 'Cancel a generation job', description: 'Agents can cancel only jobs from their own session. Cancellation does not imply no charge: when providerCancelled is false, the external service may still charge.' },
  'generation.recheck': { ...generation.recheck, callers: both, command: ['gen', 'recheck'], summary: 'Recheck a generation job with an unknown result', description: 'Available only for unknown jobs with recheckable: true. Continues polling the original external job and writing back its results, without resubmitting or incurring new charges. Agents can act only on jobs from their own session.' },
  'generation.regenerate': { ...generation.regenerate, callers: ui, summary: '使用原输入和参数重新生成' },
  'generation.usage': { ...generation.usage, callers: ui, summary: '读取今日生成用量' },
  'generation.get': {
    ...generation.get,
    callers: both,
    command: ['gen', 'get'],
    summary: 'Read generation status and outputs',
    description: 'Reads job status, outputs and writeback results. waitMs waits for a status change, up to 30000 ms; call again to keep waiting. Disconnecting the tool does not cancel the job.',
  },
  'providers.list': {
    ...providers.list,
    callers: both,
    summary: 'List generation providers and models',
    description: 'Returns generation providers, model IDs and names, media types, parameter JSON Schemas with defaults, enums and descriptions, key configuration status and default models. Never returns keys. Read this before generation, and choose a configured provider and model for the media type rather than guessing model IDs. A model’s operations lists supported generation operations; when absent, only generate is supported.',
  },
  'providers.update': {
    ...providers.update,
    callers: ui,
    summary: '替换生成服务配置',
    description: '整体替换全局服务配置及默认模型，配置文件为事实来源。此接口不接受 requestId，不写空间幂等表；重复写入相同配置具有相同效果。密钥通过 providers.setKey 单独写入系统 Keychain。',
  },
  'providers.setKey': {
    ...providers.setKey,
    callers: ui,
    summary: '设置生成服务密钥',
    description: '仅界面可将密钥写入系统 Keychain；不接受 requestId，不经空间幂等表或日志持久化，不返回密钥。',
  },
  'providers.clearKey': {
    ...providers.clearKey,
    callers: ui,
    summary: '清除生成服务密钥',
    description: '仅界面可从系统 Keychain 清除密钥；不接受 requestId，不经空间幂等表，不返回密钥。',
  },
  'canvas.apply': {
    ...canvas.apply,
    callers: both,
    summary: 'Apply a batch of canvas changes',
    description: 'Executes canvas operations in one transaction: all succeed or none take effect. Read slots before content edits and supply expectedRevision; layout edits need no revision condition. Any revision conflict rejects the whole batch with revision_conflict and the conflicting slots’ current revisions. Within the batch, tempId refers to a newly created node and tempId:main to its slot. node.create.inputNodeIds and node.setInputs declare reference inputs for generation nodes or source nodes for an artifact, such as scripts, code, characters or scenes. These appear as canvas edges; inputs are deduplicated, exclude the node itself, refer to undeleted nodes, support earlier tempIds and require no expectedRevision. node.create may omit x, y, w and h: the server chooses a non-overlapping position and default dimensions for the type. Agent nodes with supplied positions that overlap existing nodes move to nearby free space; placements reports final positions. category is free text, such as character, scene, prop, shot or storyboard, for organizing the canvas. purpose: working marks working documents such as discussions, plans or drafts, hidden on the canvas by default; deliverables use the default artifact. format selects plain, markdown or code display for text nodes. node.setMeta updates these three fields. Deleting a node does not cancel generation jobs. A script node’s main slot holds a storyboard document: script.replace writes the whole document with expectedRevision, shots and assets reference each other by tempId, and the server assigns id and rev. script.patch edits rows; update and delete require that row’s current rev, and different rows do not conflict. Cells reference assets with {{asset:<asset id>}}. node.setMeta.shot associates a generation node with a shot. A timeline node’s main slot holds an editing document. node.create accepts content.timelineFrom: node IDs in the given order, placing videos and images in the video track and audio in the first audio track, with durations read by the server. An image entry may be {nodeId, durationMs} for a duration of 500–30000 ms, default 3000. timeline.set replaces the whole document with expectedRevision: read, modify, then write back. Clips lock media versions with source.nodeId and source.assetVersionId and can reference only this project’s assets. Limits are one video track and four audio tracks. Video clips are contiguous starting at 0, without gaps or overlaps; clips within an audio track do not overlap. The server synchronizes node input edges from clips. Requires requestId; identical retries return the first result.',
  },
  'canvas.undo': { ...canvas.undo, callers: ui, summary: '撤销画布操作', description: '撤销最近的用户画布批次，整步原子执行。内容被其他调用方修改或节点被删除时返回 revision_conflict，不跳过冲突条目。须携带 requestId。' },
  'canvas.redo': { ...canvas.redo, callers: ui, summary: '重做画布操作', description: '重做最近撤销的用户画布批次，新用户操作清空重做栈。冲突时整步拒绝。须携带 requestId。' },
  'canvas.get': {
    ...canvas.get,
    callers: both,
    summary: 'Read canvas nodes and slots',
    description: 'Reads the current canvas in the caller’s space, optionally filtered by nodeIds. Node inputs are returned only when undeleted reference inputs exist, in their configured order. Agents may use snapshot: "turn" for the fixed turn snapshot: content uses snapshot revisions, while layout and reference inputs use current values. Read the slot’s current revision before editing content.',
  },
  'asset.get': {
    ...asset.get,
    callers: both,
    summary: 'Read an asset version',
    description: 'Returns asset version metadata and a controlled access URL issued by the server for assetVersionId. Only assets in the caller’s space are accessible.',
  },
  'asset.import': {
    ...asset.import,
    callers: ui,
    summary: '导入本机文件为素材',
    description: '把本机的图片、视频或音频文件登记为空间素材，返回素材版本。不放上画布，需要时再用 canvas.apply 新建节点。须携带 requestId，同内容重试返回首次结果。',
  },
  'asset.importFile': {
    ...asset.importFile,
    callers: agent,
    command: ['asset', 'import', 'file'],
    summary: 'Import a working-directory file as an asset',
    description: 'Registers an image, video or audio file in the current session’s working directory or the project assets directory as a space asset. The path is absolute and stays within those directories after resolving symlinks. File size is limited to 2 GiB. Use canvas.apply to place the returned asset version on the canvas. Requires requestId; identical retries return the first result.',
  },
  'asset.extractFrames': {
    ...asset.extractFrames,
    callers: both,
    command: ['asset', 'frames'],
    summary: 'Extract video frames',
    description: 'Extracts count frames (default 6, at most 16) at evenly spaced segment midpoints, or at explicit atMs timestamps (at most 200). count and atMs are mutually exclusive. Timestamps must be before the video end. Registers image assets and returns timestamps and local paths. Does not place frames on the canvas. Requires requestId; identical retries return the first result.',
  },
  'previz.extractBlockout': { ...previz.extractBlockout, callers: ui, summary: '把白模画面写入画格' },
  'media.process': {
    ...media.process,
    callers: both,
    summary: 'Process node media locally: crop, split, trim, extract frames or audio, change speed, or export a timeline',
    description: 'Processes the asset in a node’s current slot locally with ffmpeg, without generation services or charges. image.crop, video.trim, audio.trim and audio.speed write a new version of the same node. image.gridSplit, video.frame, video.extractAudio and audio.split create nodes beside the source with input edges to it, leaving the source unchanged. timeline.export creates a video node from a timeline, or an audio node if it has only audio tracks. It exports the version identified by expectedRevision; later timeline edits cause no conflict. The new node’s exportOf records the source timeline and revision. Prefer this method for cropping, trimming and splitting instead of submitting generation jobs. Requires expectedRevision: read before writing. The revision is checked again at writeback; intervening node edits fail with revision_conflict. Returns a task, directly as succeeded if completed within waitMs; otherwise poll media.get. Each task is limited to 30 minutes. Requires requestId; identical retries return the same task. video.exportMov is UI-only, produces a temporary download without canvas changes, and is forbidden to Agents. Operation params: image.crop {x, y, w, h} in integer source pixels; image.gridSplit {rows, cols}, each 2–3; video.trim and audio.trim {startMs, endMs}; video.frame {atMs}; video.extractAudio {}; audio.split {pointsMs}, 1–20 strictly increasing cut points in milliseconds; audio.speed {rate}, one of 0.5, 0.75, 1.25, 1.5, 1.75, 2; timeline.export {}. Timeline export requires ffmpeg 7 or newer; a recognized older release fails the task with error.code media.ffmpeg_version_unsupported and a message naming the found version and requirement. Unrecognized build versions are allowed to run.',
  },
  'media.cancel': { ...media.cancel, callers: ui, summary: '取消本机 MOV 导出' },
  'media.dismiss': { ...media.dismiss, callers: ui, summary: '关闭本机 MOV 导出并移除文件' },
  'media.exportDownload': { ...media.exportDownload, callers: ui, summary: '读取已完成的本机 MOV 导出文件' },
  'media.get': {
    ...media.get,
    callers: both,
    summary: 'Read a local media processing task',
    description: 'Reads the status, progress and outputs of a media.process task. waitMs waits for a status change, up to 30000 ms; call again to keep waiting.',
  },
  'script.batch.plan': {
    ...scriptBatch.plan,
    callers: both,
    summary: 'Estimate a script generation batch',
    description: 'Read-only estimate of batch shot images (media: frames, including first frames and end frames for shots with endState) or videos (media: video). Returns job count, model, billing status, today’s quota use, and counts of shots with stale prompts, missing asset reference images or missing first frames. Creates no nodes and submits no jobs.',
  },
  'script.batch.start': {
    ...scriptBatch.start,
    callers: both,
    summary: 'Start a script generation batch',
    description: 'Generates shot images or videos from a storyboard as a server-managed batch that survives page closure and restarts. Agent requests enter pending_approval without submitting any jobs and must wait for user approval in the approval card. Rejection yields rejected; no response within 24 hours yields expired. No parameter bypasses approval. Approved batches count toward the daily total, but not the agent daily limit. Use script.batch.get to wait for results. By default, the first frame of a continuous shot references the previous shot’s frame image. Shots in strictShotIds instead wait for the previous shot’s video to finish and extract its last frame. Requires requestId; retries do not duplicate submissions or charges.',
  },
  'script.batch.get': {
    ...scriptBatch.get,
    callers: both,
    summary: 'Read a script generation batch',
    description: 'Reads batch status, each step’s status for each shot, and output nodes. waitMs waits for a status change, up to 30000 ms.',
  },
  'script.batch.list': { ...scriptBatch.list, callers: both, summary: 'List script generation batches', description: 'Lists batches in the project, optionally filtered by script node. activeOnly returns only unfinished batches.' },
  'script.batch.approve': { ...scriptBatch.approve, callers: ui, summary: '批准 Agent 发起的批量生成' },
  'script.batch.reject': { ...scriptBatch.reject, callers: ui, summary: '拒绝 Agent 发起的批量生成' },
  'script.batch.cancel': {
    ...scriptBatch.cancel,
    callers: both,
    summary: 'Cancel a script generation batch',
    description: 'Agents can cancel only batches started by their own session. Already submitted jobs follow normal cancellation rules. Cancellation does not imply no charge; report providerCancelled honestly.',
  },
  'script.batch.resume': { ...scriptBatch.resume, callers: ui, summary: '继续因额度暂停的批量生成' },
  'media.analyze': {
    ...media.analyze,
    callers: both,
    summary: 'Find silence in an audio asset',
    description: 'audio.silence detects silence in a node’s audio asset. Returns the total duration and silence midpoints in ascending order, usable as candidate cut points for media.process audio.split. Read-only: no canvas changes or charges.',
  },
  'media.preview': { ...media.preview, callers: ui, summary: '读取媒体波形、缩略图条和视频封面' },
  'font.list': {
    ...font.list,
    callers: both,
    command: ['font', 'list'],
    summary: 'List fonts available for timeline text',
    description: 'Returns built-in fonts and this project’s font assets. Use the returned font value ({ builtin } or { assetVersionId }) for timeline text style.font. Import project fonts from .ttf or .otf files with asset.importFile.',
  },
  'model.list': { ...model.list, callers: ui, summary: '列出项目中每个模型素材的最新版本' },
  'work.list': {
    ...work.list,
    callers: both,
    command: ['work', 'list'],
    summary: 'List work items',
    description: 'Lists project work items with status, session summaries, unread counts and unresolved message counts. Agents can see their own work item and direct children. scope: all and spaceId are UI-only.',
  },
  'work.inbox': { ...work.inbox, callers: ui, summary: '读取跨项目收件箱' },
  'work.get': {
    ...work.get,
    callers: both,
    command: ['work', 'get'],
    summary: 'Read work item details and message history',
    description: 'Without workItemId, reads the caller’s own work item. Agents can read their own work item and direct children. Messages paginate in reverse chronological order; beforeCreatedAt is an exclusive cursor.',
  },
  'work.create': { ...work.create, callers: ui, summary: '新建工作项' },
  'work.dispatch': {
    ...work.dispatch,
    callers: both,
    command: ['work', 'dispatch'],
    summary: 'Dispatch a child work item',
    description: 'Any session in a root work item can dispatch a child work item and agent session. Child reports are delivered automatically and wake a new turn, so polling is unnecessary. Child agents cannot see the parent’s chat history; include goals, reference node IDs, deliverables and acceptance criteria in brief. activate: true activates immediately. When global execution slots are full, queued: true leaves the item in todo awaiting a slot; do not retry. Only one level of dispatch is supported: child work items cannot dispatch children and should report to their parent. Requires requestId; identical retries return the first result.',
  },
  'work.activate': {
    ...work.activate,
    callers: both,
    command: ['work', 'activate'],
    summary: 'Activate a todo work item',
    description: 'Moves the caller’s own todo child work item to in_progress, creating a session and delivering brief if none exists. When slots are full, queued: true waits for a slot. An incompatible status returns invalid_transition with the current status. Requires requestId.',
  },
  'work.recall': {
    ...work.recall,
    callers: both,
    command: ['work', 'recall'],
    summary: 'Recall a work item',
    description: 'Stops the agent’s current turn and cancels unfinished generation jobs for the work item. When providerCancelled is false, the external service may still charge. Returns the item to todo, preserving outputs and history, and resolves outstanding questions. For a queued todo item, cancels its queue entry. Agents can recall only their own direct children. Requires requestId.',
  },
  'work.deletePlan': { ...work.deletePlan, callers: ui, summary: '读取删除工作项的影响' },
  'work.requestDelete': { ...work.requestDelete, callers: agent, command: ['work', 'request', 'delete'], summary: 'Request user approval to delete direct child work items', description: 'Only a root workspace with an active turn can request cleanup of 1 to 20 live direct children. Requires requestId and unique workItemIds. Creates one approval card with deletion consequences; only the user can approve once. Never initiate cleanup without the author asking. Tell the author a card is waiting, then end the turn without polling. Canvas content stays. Learn the outcome with work_list on a later turn.' },
  'work.delete': { ...work.delete, callers: ui, summary: '停止并删除工作项及其子项' },
  'work.move': { ...work.move, callers: ui, summary: '把工作项移到任意状态' },
  'work.reparent': { ...work.reparent, callers: ui, summary: '把工作项挪到另一个根工作项下或变回根' },
  'work.reopen': { ...work.reopen, callers: ui, summary: '重开已完成的工作项' },
  'work.submitReview': { ...work.submitReview, callers: ui, summary: '手动送审' },
  'work.report': {
    ...work.report,
    callers: agent,
    command: ['work', 'report'],
    summary: 'Report to the parent workspace and user',
    description: 'An agent with a parent reports progress on its own work item. done reports completion with output details and refs (node IDs), moves the item to in_review, then leaves the agent idle awaiting review. Use question, blocked or escalation when a decision is needed or progress is blocked; these also notify the user. Replies arrive as new messages, so do not poll while waiting. Reporting done on a parent whose children are not all done returns invalid_transition. Requires requestId.',
  },
  'work.reply': {
    ...work.reply,
    callers: both,
    command: ['work', 'reply'],
    summary: 'Reply to a work message',
    description: 'Acts only on the caller’s own child work items. With replyTo, answers a child’s question, blocked or escalation message. If the user has already replied, returns already_resolved with the first reply; avoid answering twice and send any follow-up without replyTo. Without replyTo, delivers a follow-up to the child’s main session. Requires requestId.',
  },
  'work.review': {
    ...work.review,
    callers: both,
    command: ['work', 'review'],
    summary: 'Review a work item awaiting review',
    description: 'Agents can review only their own child work items configured for parent review; otherwise returns forbidden. approve moves the item to done. reject requires feedback describing the changes needed, moves the item to in_progress and delivers feedback to the child’s main session. Requires requestId.',
  },
  'work.update': { ...work.update, callers: ui, summary: '编辑工作项' },
  'work.markRead': { ...work.markRead, callers: ui, summary: '标记工作项消息已读' },
  'work.changes': { ...work.changes, callers: ui, summary: '读取本轮激活以来的改动' },
  'work.slots': { ...work.slots, callers: ui, summary: '读取全局运行名额' },
  'work.setSlotLimit': { ...work.setSlotLimit, callers: ui, summary: '设置 同时运行上限' },
  'events.subscribe': { ...events.subscribe, callers: ui, summary: '订阅空间事件' },
  'space.deletePlan': { ...space.deletePlan, callers: ui, summary: '读取删除项目影响' },
  'space.delete': { ...space.delete, callers: ui, summary: '删除项目' },
  'space.listDeleted': { ...space.listDeleted, callers: ui, summary: '最近删除' },
  'space.diskUsage': { ...space.diskUsage, callers: ui, summary: '读取项目占用空间' },
  'space.restore': { ...space.restore, callers: ui, summary: '恢复项目' },
  'space.purge': { ...space.purge, callers: ui, summary: '永久删除项目' },
  'space.list': { ...space.list, callers: ui, summary: '列出空间' },
  'space.create': { ...space.create, callers: ui, summary: '创建项目空间' },
  'fs.pickDirectory': { ...fs.pickDirectory, callers: ui, summary: '选择本机目录' },
  'fs.validateDirectory': { ...fs.validateDirectory, callers: ui, summary: '检查已有目录' },
  'fs.listSkills': { ...fs.listSkills, callers: ui, summary: '列出项目技能' },
  'fs.reveal': { ...fs.reveal, callers: ui, summary: '在文件管理器显示目录或素材' },
  'preferences.get': { ...preferences.get, callers: ui, summary: '读取界面偏好' },
  'preferences.set': { ...preferences.set, callers: ui, summary: '设置界面偏好' },
  'skill.copyUpdate': { ...skill.copyUpdate, callers: ui, summary: '更新项目固定版本副本' },
  'skill.copyReset': { ...skill.copyReset, callers: ui, summary: '将项目副本重置到固定版本' },
  'skill.copyPublish': { ...skill.copyPublish, callers: ui, summary: '将项目副本发布为我的 Skill 新版本' },
  'skill.setAutoAdd': { ...skill.setAutoAdd, callers: ui, summary: '选择是否加入新项目' },
  'skill.libraryDelete': { ...skill.libraryDelete, callers: ui, summary: '从我的 Skill 删除' },
  'skill.export': { ...skill.export, callers: ui, summary: '导出 SKILL.md' },
  'skill.importDrafts': { ...skill.importDrafts, callers: ui, summary: '将 Markdown 导入为待审阅草稿' },
  'skill.draftState': { ...skill.draftState, callers: ui, summary: '读取 Skill 草稿当前状态' },
  'skill.proposeDraft': { ...skill.proposeDraft, callers: agent, summary: 'Draft a skill only when the author asks to save their method', description: 'Creates only a draft in Settings > My skills. Capture the author’s stated method and reasons in their words, without adding advice of your own; omit project paths or names they did not ask to retain. body is Markdown only, with no frontmatter: the library writes it from name and description. Tell the author where the draft is. Only the author can edit, save, discard or use it; Agents cannot write the library.' },
  'skill.libraryList': { ...skill.libraryList, callers: ui, summary: '列出我的 Skill 和草稿' },
  'skill.libraryGet': { ...skill.libraryGet, callers: ui, summary: '读取作者 Skill 以便编辑' },
  'skill.librarySave': { ...skill.librarySave, callers: ui, summary: '保存作者确认的不可变 Skill 版本' },
  'skill.discardDraft': { ...skill.discardDraft, callers: ui, summary: '丢弃 Skill 草稿' },
  'skill.use': { ...skill.use, callers: ui, summary: '将固定版本的 Skill 复制到项目，不覆盖已有内容' },
  'skill.list': { ...skill.list, callers: ui, summary: '列出项目 skill 与无法识别的目录' },
  'skill.stage': { ...skill.stage, callers: ui, summary: '把本机文件夹、压缩包或其他项目的 skill 放进暂存区' },
  'skill.import': { ...skill.import, callers: ui, summary: '把暂存的 skill 导入项目' },
  'skill.discard': { ...skill.discard, callers: ui, summary: '丢弃暂存的 skill' },
  'skill.remove': { ...skill.remove, callers: ui, summary: '从项目移除 skill' },
  // runtime.hello is handled separately during the handshake, bypassing caller-based dispatch (0004).
  'runtime.activity': { ...runtime.activity, callers: ui, summary: '查询运行中工作' },
  'runtime.shutdown': { ...runtime.shutdown, callers: ui, summary: '关闭运行时' },
  'capabilities.list': {
    ...capabilities.list,
    callers: agent,
    summary: 'List available capabilities',
    description: 'Lists methods, commands and summaries authorized for the current caller. Use capabilities.describe for parameters and return values.',
  },
  'capabilities.describe': {
    ...capabilities.describe,
    callers: agent,
    summary: 'Describe a capability and its parameters',
    description: 'Looks up a capability by protocol method name and returns its English description, command, and parameter and result JSON Schemas. Returns only methods authorized for the current caller.',
  },
  'guide.get': {
    ...guide.get,
    callers: agent,
    command: ['guide'],
    summary: 'Read a guide for specialist work',
    description: 'Returns the list of guides (topic, title, when to read it). With topic, also returns that guide as Markdown. Read the matching guide before the first write of that kind in a session: script documents, timelines, code-rendered video, local media processing, generation inputs, canvas nodes, previz panels, manuscript writing.',
  },
  'slot.history': {
    ...slot.history,
    callers: both,
    summary: 'Read slot revision history',
    description: 'Reads content revisions of an undeleted slot in the current space, newest revision first, including revisions that clear content. Only the UI may use includeDeleted: true for deleted nodes or slots; agents receive forbidden for true. limit defaults to 50, at most 200. beforeRevision is an exclusive cursor: pass the last revision on the page to read the next page; hasMore indicates older revisions. Generation provenance comes from the job that actually delivered the revision, using persisted prompts and parameters. Input nodes follow the job’s fixed input order, deduplicated and excluding the node itself. Restore historical content with canvas.apply and the current expectedRevision, producing a new revision.',
  },
} as const satisfies Record<string, MethodSpec>

// 0027 step b: settings and merge proposals. Registered by the step b worker, as above.
export const ENTITY_METHODS = {
  'entity.list': {
    ...entity.list,
    callers: both,
    command: ['entity', 'list'],
    summary: 'List project settings (characters, scenes, props, styles)',
    description: 'Lists this project\'s settings with their description, reference images (asset versions), member media and the scripts that cast them. Pass a ref\'s assetVersionId as a generation.submit input to use it.',
  },
  'entity.get': { ...entity.get, callers: both, command: ['entity', 'get'], summary: 'Read one setting' },
  'entity.create': {
    ...entity.create,
    callers: both,
    command: ['entity', 'create'],
    summary: 'Create a setting',
    description: 'Names are unique within a kind, ignoring case and surrounding whitespace; a duplicate returns invalid_params (entity.name_taken) with the existing setting in params.entityId: use that one instead. At most 4 reference images, the first is the cover. requestId is required. Agents never pass members: propose grouping with entity.propose.',
  },
  'entity.update': {
    ...entity.update,
    callers: both,
    command: ['entity', 'update'],
    summary: 'Update a setting',
    description: 'Changes the name, description or reference images, which marks the prompts of shots casting it stale (members are changed by the user or through accepted proposals). expectedRevision is required; a conflict returns revision_conflict.',
  },
  'entity.delete': { ...entity.delete, callers: ui, summary: '删除设定' },
  'entity.propose': {
    ...entity.propose,
    callers: agent,
    command: ['entity', 'propose'],
    summary: 'Propose grouping media of one subject into a setting',
    description: 'Groups media showing the same character, scene or prop, or sharing one style, as a proposal for the user to accept; it never changes settings directly. entityId adds to an existing setting; omit it to propose a new one. Member roles are image, video, voice or other; refs pick up to 4 image versions from the members, the first is the cover. reason states the evidence in one sentence. A new proposal supersedes older pending ones touching the same media. At most 20 per call. Pass the organize task\'s runId when it gives one. requestId is required.',
  },
  'entity.proposalList': { ...entity.proposalList, callers: both, command: ['entity', 'proposals'], summary: 'List grouping proposals' },
  'entity.proposalResolve': { ...entity.proposalResolve, callers: ui, summary: '接受或拒绝归并建议' },
  'entity.unmerge': { ...entity.unmerge, callers: ui, summary: '取消最近一次归并' },
} as const satisfies Record<string, MethodSpec>

// 0027 step c: series. Defined by the coordinator; the backend worker registers it into METHODS with its handlers.
// Publishing, updating, resetting and series membership are UI-only because they reach every episode (RFC 0027 §3.6).
export const SERIES_METHODS = {
  'series.list': { ...series.list, callers: ui, summary: '列出系列' },
  'series.create': { ...series.create, callers: ui, summary: '新建系列' },
  'series.rename': { ...series.rename, callers: ui, summary: '重命名系列' },
  'series.delete': { ...series.delete, callers: ui, summary: '删除系列' },
  'series.mediaGet': { ...series.mediaGet, callers: ui, summary: '读取系列参考素材' },
  'space.setSeries': { ...spaceSeries.setSeries, callers: ui, summary: '加入或离开系列' },
  'series.entityList': {
    ...series.entityList,
    callers: both,
    command: ['series', 'list'],
    summary: 'List settings shared by this project\'s series',
    description: 'Lists the settings of the series this project belongs to, each with its latest revision and, when this project already uses it, the linked project setting and the pinned revision. series is null for a standalone project. Use entity.link to bring one into this project instead of creating a duplicate.',
  },
  'entity.link': {
    ...seriesEntity.link,
    callers: both,
    command: ['entity', 'link'],
    summary: 'Use a series setting in this project',
    description: 'Copies the latest revision of a series setting into this project as a linked setting pinned to that revision; later series changes reach it only when the user updates it. If this project already has a setting of the same kind and name, it returns invalid_params (entity.name_taken) with both ids: tell the user, who decides in the library panel. replaceEntityId is reserved for the user. requestId is required.',
  },
  'entity.seriesDiff': { ...seriesEntity.diff, callers: ui, summary: '比较设定与系列版本' },
  'entity.updateFromSeries': { ...seriesEntity.updateFromSeries, callers: ui, summary: '从系列更新设定' },
  'entity.publish': { ...seriesEntity.publish, callers: ui, summary: '发布设定到系列' },
  'entity.resetToSeries': { ...seriesEntity.resetToSeries, callers: ui, summary: '还原为系列版本' },
} as const satisfies Record<string, MethodSpec>

export const METHODS = { ...LIBRARY_METHODS, ...CORE_METHODS, ...ENTITY_METHODS, ...SERIES_METHODS } as const satisfies Record<string, MethodSpec>

export type MethodName = keyof typeof METHODS
export type MethodParams<M extends MethodName> = z.infer<(typeof METHODS)[M]['params']>
export type MethodResult<M extends MethodName> = z.infer<(typeof METHODS)[M]['result']>

export function isMethodName(name: string): name is MethodName {
  return Object.hasOwn(METHODS, name)
}
