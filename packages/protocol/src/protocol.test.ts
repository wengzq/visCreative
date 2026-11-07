import { describe, expect, it } from 'vitest'
import { SKILL_SOURCE_LIMITS } from './runtime'
import { METHODS, isMethodName } from './methods'
import { WorkMessageKind, WorkMessageFrom, WorkFailure, WorkSessionView } from './work'
import { NodeView } from './canvas'
import { ApprovalPayload, MessageRef, SessionSummary, TranscriptItem, UserMessagePayload } from './session'
import { NOTIFICATIONS } from './events'
import { ErrorData } from './rpc'
import { MediaTaskView, numberReferences } from './operations'
import { JobView } from './generation'
import { providers } from './providers'
import { ShotLink, ShotRole } from './script'
import { isMediaKind } from './common'

describe('protocol', () => {
  it('recognizes only image, video and audio as media, excluding font and model assets', () => {
    for (const kind of ['image', 'video', 'audio'] as const) expect(isMediaKind(kind)).toBe(true)
    for (const kind of ['font', 'model'] as const) expect(isMediaKind(kind)).toBe(false)
  })

  it('shares the skill source limits without changing manuscript limits', () => {
    expect(SKILL_SOURCE_LIMITS).toEqual({ maxArchiveBytes: 268435456, maxBytes: 536870912, maxFiles: 10000 })
    expect(Object.isFrozen(SKILL_SOURCE_LIMITS)).toBe(true)
  })
  it('preserves the detected ffmpeg version and requirement in localized export failures', () => {
    const error = { code: 'unavailable', reason: 'media.ffmpeg_version_unsupported', params: { version: '6.1.2', required: 7 } }
    expect(ErrorData.parse(error)).toEqual(error)
    expect(METHODS['media.process'].description).toContain('media.ffmpeg_version_unsupported')
  })
  it('contracts agent-requested work cleanup with unique bounded targets and explicit user approval', () => {
    const method = METHODS['work.requestDelete']
    expect(method.callers).toEqual(['agent'])
    expect(METHODS['work.delete'].callers).toEqual(['ui'])
    expect(METHODS['session.respondApproval'].callers).toEqual(['ui'])
    expect(method.params.parse({ requestId: 'r', workItemIds: ['a', 'b'] })).toEqual({ requestId: 'r', workItemIds: ['a', 'b'] })
    for (const workItemIds of [[], ['a', 'a'], Array.from({ length: 21 }, (_, index) => `w${index}`)]) expect(method.params.safeParse({ requestId: 'r', workItemIds }).success).toBe(false)
    for (const status of ['pending', 'approved', 'denied', 'expired']) expect(method.result.parse({ approvalId: 'a', status })).toEqual({ approvalId: 'a', status })
    const workDelete = { items: [{ workItemId: 'w', title: 'Drafts' }], runningTurns: 2, unfinishedJobs: 1, childrenTotal: 1, unresolvedMessages: 3, hasUnreviewedReport: true, expiresAt: 123 }
    const payload = { approvalId: 'a', kind: 'work_delete', status: 'pending', summary: 'Drafts', detail: '', workDelete }
    expect(ApprovalPayload.parse(payload)).toEqual(payload)
    for (const field of ['runningTurns', 'unfinishedJobs', 'childrenTotal', 'unresolvedMessages']) expect(ApprovalPayload.safeParse({ ...payload, workDelete: { ...workDelete, [field]: -1 } }).success).toBe(false)
  })
  it('retains persisted delivery state in refreshed user transcript payloads', () => {
    expect(UserMessagePayload.parse({ messageId: 'message', text: 'Keep this', refs: [], deliveryState: 'draft' }).deliveryState).toBe('draft')
    expect(UserMessagePayload.safeParse({ messageId: 'message', text: 'Keep this', refs: [], deliveryState: 'lost' }).success).toBe(false)
  })

  it('preserves structured system failures for localized work notifications', () => {
    const failure = { sessionId: 'session', turnId: 'turn', reason: 'dispatch_rejected', detail: 'Unavailable' }
    expect(WorkMessageKind.parse('failure')).toBe('failure')
    expect(WorkMessageFrom.parse({ kind: 'system', failure })).toEqual({ kind: 'system', failure })
    expect(WorkFailure.safeParse({ ...failure, reason: 'unknown' }).success).toBe(false)
    expect(WorkFailure.parse({ ...failure, reason: 'turn_silent' }).reason).toBe('turn_silent')
    expect(WorkFailure.parse({ ...failure, reason: 'turn_unreported' }).reason).toBe('turn_unreported')
    const session = { sessionId: 'session', agentKind: 'codex', title: 'Child', activeTurnId: 'turn', doing: null, lastActivityAt: 1, archived: false }
    expect(WorkSessionView.parse(session).silentSince).toBeNull()
    expect(WorkSessionView.parse({ ...session, silentSince: 10 }).silentSince).toBe(10)
    expect(WorkSessionView.safeParse({ ...session, silentSince: 1.5 }).success).toBe(false)
    expect(WorkMessageFrom.parse({ kind: 'system' })).toEqual({ kind: 'system' })
    expect(METHODS['work.reopen'].params.parse({ requestId: 'reopen', workItemId: 'work', resumeSessionId: 'session' })).toMatchObject({ resumeSessionId: 'session' })
    expect(METHODS['work.reopen'].callers).toEqual(['ui'])
  })

  it('exposes the previz guide and explicit batch composition and panel-frame estimates', () => {
    expect(METHODS['guide.get'].params.parse({ topic: 'previz' })).toEqual({ topic: 'previz' })
    const plan = {
      scriptNodeId: 'script', media: 'frames', shots: [{ shotId: 'shot', steps: [{ role: 'first', source: 'panel', status: 'skipped', nodeId: 'frame' }] }],
      estimate: { shots: 1, jobs: 0, billedJobs: 0, provider: 'mock', model: 'image', quotaRemaining: null,
        staleShots: 0, shotsMissingAssetImages: 0, shotsMissingFirstFrame: 0, shotsWithoutPrompt: 0,
        compositionRefsUsed: 1, panelFramesUsed: 1,
        compositionRefsDropped: [{ previzNodeId: 'previz', panelId: 'panel', panelNumber: 1, shotId: 'shot', reason: 'unsupported' }] },
    }
    expect(METHODS['script.batch.plan'].result.parse(plan)).toEqual(plan)
    expect(METHODS['script.batch.plan'].result.safeParse({ ...plan, estimate: { ...plan.estimate, compositionRefsUsed: -1 } }).success).toBe(false)
    expect(METHODS['script.batch.plan'].result.safeParse({ ...plan, estimate: { ...plan.estimate, compositionRefsDropped: [{ ...plan.estimate.compositionRefsDropped[0], reason: 'unknown' }] } }).success).toBe(false)
  })

  it('admits previz shot links without admitting them as batch step roles', () => {
    expect(ShotLink.parse({ scriptNodeId: 'script', shotId: 'shot', role: 'previz' }).role).toBe('previz')
    expect(ShotRole.options).toEqual(['first', 'last', 'video'])
    expect(ShotRole.safeParse('previz').success).toBe(false)
  })

  it('requires revision and idempotency for blockout extraction and keeps it for the user', () => {
    const method = METHODS['previz.extractBlockout']
    const params = { requestId: 'extract', slotId: 'previz-main', expectedRevision: 2, assetVersionId: 'video' }
    expect(method.callers).toEqual(['ui'])
    expect(method.params.parse(params)).toEqual(params)
    for (const key of ['requestId', 'expectedRevision']) {
      expect(method.params.safeParse(Object.fromEntries(Object.entries(params).filter(([field]) => field !== key))).success).toBe(false)
    }
    expect(method.params.safeParse({ ...params, doc: {} }).success).toBe(false)
    const result = { revision: 3, frames: [{ panelId: 'panel', atMs: 1250, assetVersionId: 'frame' }] }
    expect(method.result.parse(result)).toEqual(result)
  })

  it('adds explicit frame times while preserving the default count and rejecting combined selections', () => {
    const schema = METHODS['asset.extractFrames'].params
    const base = { requestId: 'frames', assetVersionId: 'video' }
    expect(schema.parse(base)).toEqual({ ...base, count: 6 })
    expect(schema.parse({ ...base, count: 3 })).toEqual({ ...base, count: 3 })
    expect(schema.parse({ ...base, atMs: [0, 1234] })).toEqual({ ...base, atMs: [0, 1234] })
    for (const selection of [{ count: 3, atMs: [0] }, { atMs: [] }, { atMs: [-1] }, { atMs: [0.5] }, { atMs: Array(201).fill(0) }]) {
      expect(schema.safeParse({ ...base, ...selection }).success).toBe(false)
    }
  })
  it('preserves optional generation error reasons and unavailable service diagnostics', () => {
    const error = { code: 'provider_rejected', message: 'Request rejected', data: { reason: 'generation.moderation_rejected', params: { category: 'image' } } }
    expect(JobView.shape.error.parse(error)).toEqual(error)
    expect(JobView.shape.error.parse({ code: 'old', message: 'Old job' })).toEqual({ code: 'old', message: 'Old job' })
    const catalog = { providerTypes: [], providers: [{ id: 'missing', type: 'example', label: 'Missing', available: false, unavailableReason: 'provider.settings_invalid', needsKey: true, hasKey: false, models: [] }], defaults: {}, unavailableDefaults: ['image'] }
    expect(providers.list.result.parse(catalog)).toMatchObject(catalog)
  })
  it('exposes complete asset version history to the UI without granting agent access', () => {
    const method = METHODS['asset.versions']
    expect(method.callers).toEqual(['ui'])
    expect(method.params.parse({ assetId: 'asset' })).toEqual({ assetId: 'asset' })
    expect(method.params.safeParse({}).success).toBe(false)
    expect(method.result.parse({ versions: [] })).toEqual({ versions: [] })
  })
  it('numbers unique media assets in input order and excludes text and empty inputs', () => {
    expect(numberReferences([
      { nodeId: 'prompt', kind: 'text', hasAsset: false }, { nodeId: 'empty', kind: 'image', hasAsset: false },
      { nodeId: 'b', kind: 'video', hasAsset: true }, { nodeId: 'b', kind: 'video', hasAsset: true },
      { nodeId: 'a', kind: 'audio', hasAsset: true },
    ])).toEqual([{ nodeId: 'b', kind: 'video', number: 1 }, { nodeId: 'a', kind: 'audio', number: 2 }])
  })

  it('validates transient media progress separately from durable task status events', () => {
    const schema = NOTIFICATIONS['events.mediaProgress']
    expect(schema.parse({ taskId: 'task', progress: 0.5 })).toEqual({ taskId: 'task', progress: 0.5 })
    for (const progress of [-0.1, 1.1, NaN]) expect(schema.safeParse({ taskId: 'task', progress }).success).toBe(false)
    expect(schema.safeParse({ taskId: 'task', progress: 0.5, status: 'running' }).success).toBe(false)
  })
  it('project deletion, restoration and permanent deletion need no revision; directory deletion must be explicitly selected', () => {
    const params = { requestId: 'r', spaceId: 's' }
    expect(METHODS['space.deletePlan'].params.parse({ spaceId: 's' })).toEqual({ spaceId: 's' })
    expect(METHODS['space.delete'].params.parse(params)).toEqual(params)
    expect(METHODS['space.restore'].params.parse(params)).toEqual(params)
    expect(METHODS['space.purge'].params.parse(params)).toEqual(params)
    expect(METHODS['space.purge'].params.parse({ ...params, deleteProjectDir: true })).toEqual({ ...params, deleteProjectDir: true })
    for (const method of ['space.delete', 'space.restore', 'space.purge'] as const) {
      expect(METHODS[method].params.shape).not.toHaveProperty('expectedRevision')
      expect(METHODS[method].params.safeParse({ spaceId: 's' }).success).toBe(false)
      expect(METHODS[method].params.safeParse({ requestId: '', spaceId: 's' }).success).toBe(false)
    }
    const plan = { runningTurns: 1, unfinishedJobs: 2, workInProgress: 3, unresolvedMessages: 4, rootPath: '/project' }
    expect(METHODS['space.deletePlan'].result.parse(plan)).toEqual(plan)
    for (const field of ['runningTurns', 'unfinishedJobs', 'workInProgress', 'unresolvedMessages']) {
      expect(METHODS['space.deletePlan'].result.safeParse({ ...plan, [field]: -1 }).success).toBe(false)
    }
    expect(METHODS['space.delete'].result.parse({ spaceId: 's', cancelledJobs: [{ jobId: 'j', providerCancelled: false }] })).toEqual({ spaceId: 's', cancelledJobs: [{ jobId: 'j', providerCancelled: false }] })
    expect(METHODS['space.purge'].result.parse({ spaceId: 's', projectDirDeleted: false, movedProjectDir: '/orphaned/s' })).toEqual({ spaceId: 's', projectDirDeleted: false, movedProjectDir: '/orphaned/s' })
  })

  it('recently deleted projects retain errors and directory safety information; missing directory sizes are null and project changes use transient notifications', () => {
    const deleted = { spaceId: 's', name: '海报', rootPath: '/project', deletedAt: 1, rootPathExists: false, canDeleteProjectDir: false, canDeleteProjectDirReason: '项目目录已不存在', purgeError: '文件被占用' }
    expect(METHODS['space.listDeleted'].result.parse({ spaces: [deleted] })).toEqual({ spaces: [deleted] })
    expect(METHODS['space.diskUsage'].result.parse({ dataBytes: 10, projectDirBytes: null })).toEqual({ dataBytes: 10, projectDirBytes: null })
    expect(METHODS['space.diskUsage'].result.safeParse({ dataBytes: -1, projectDirBytes: 0 }).success).toBe(false)
    expect(NOTIFICATIONS['events.spacesChanged'].parse({})).toEqual({})
    expect(NOTIFICATIONS['events.spacesChanged'].safeParse({ seq: 1 }).success).toBe(false)
  })

  it('UI language preferences are UI-only; errors can carry reason and parameters for translation (0018)', () => {
    for (const m of ['preferences.get', 'preferences.set'] as const) expect(METHODS[m].callers).toEqual(['ui'])
    const set = METHODS['preferences.set'].params
    expect(set.safeParse({ locale: 'en' }).success).toBe(true)
    expect(set.safeParse({ locale: null }).success).toBe(true)
    expect(set.safeParse({ locale: 'fr' }).success).toBe(false)
    expect(ErrorData.safeParse({ code: 'invalid_params', reason: 'skill.name_conflict', params: { name: '分镜', count: 2 } }).success).toBe(true)
    expect(ErrorData.safeParse({ code: 'invalid_params', reason: 'Skill Conflict' }).success).toBe(false)
  })

  it('author skill drafts are Agent-only and library decisions are UI-only (0033)', () => {
    expect(METHODS['skill.proposeDraft'].callers).toEqual(['agent'])
    for (const method of ['skill.libraryList', 'skill.libraryGet', 'skill.librarySave', 'skill.discardDraft', 'skill.use', 'skill.copyUpdate', 'skill.copyReset', 'skill.copyPublish', 'skill.setAutoAdd', 'skill.libraryDelete', 'skill.export', 'skill.importDrafts', 'skill.draftState'] as const) expect(METHODS[method].callers).toEqual(['ui'])
    const content = { name: 'my-method', description: 'My stated method', body: 'Keep my reasons.' }
    expect(METHODS['skill.proposeDraft'].params.safeParse({ requestId: 'r', ...content }).success).toBe(true)
    for (const name of ['../escape', '.hidden', 'a/b', 'a\\b', 'a:b', 'a<b', 'a>b', 'a"b', 'a|b', 'a?b', 'a*b', 'trail.', 'CON', 'nul.md', 'COM1', 'lpt9.txt', 'CONIN$', 'CONOUT$', 'CON .md', '']) expect(METHODS['skill.proposeDraft'].params.safeParse({ requestId: 'r', ...content, name }).success).toBe(false)
    for (const method of ['skill.copyUpdate', 'skill.copyReset', 'skill.copyPublish'] as const) {
      const params = { requestId: 'r', spaceId: 'p', path: '/project/skills/a/SKILL.md', expectedRevision: 1 }
      expect(METHODS[method].params.safeParse(params).success).toBe(false)
      expect(METHODS[method].params.safeParse({ ...params, expectedHash: 'a'.repeat(64) }).success).toBe(true)
    }
    expect(METHODS['skill.importDrafts'].params.safeParse({ requestId: 'i', files: [{ filename: 'archive.zip', content: 'bytes' }] }).success).toBe(false)
    const save = { requestId: 'save', ...content, expectedRevision: 1 }
    expect(METHODS['skill.librarySave'].params.safeParse(save).success).toBe(false)
    expect(METHODS['skill.librarySave'].params.safeParse({ ...save, draftId: 'd', skillId: 's' }).success).toBe(false)
    expect(METHODS['skill.librarySave'].params.safeParse({ ...save, draftId: 'd' }).success).toBe(true)
    expect(METHODS['skill.librarySave'].params.safeParse({ ...save, skillId: 's', expectedRevision: 0 }).success).toBe(false)
  })

  it('skill import and management are UI-only and staging requires exactly one source (0017)', () => {
    for (const m of ['skill.list', 'skill.stage', 'skill.import', 'skill.discard', 'skill.remove'] as const) expect(METHODS[m].callers).toEqual(['ui'])
    const stage = METHODS['skill.stage'].params
    expect(stage.safeParse({ path: '/tmp/a.zip' }).success).toBe(true)
    expect(stage.safeParse({ fromSpaceId: 's', names: ['分镜'] }).success).toBe(true)
    expect(stage.safeParse({}).success).toBe(false)
    expect(stage.safeParse({ fromSpaceId: 's' }).success).toBe(false)
    expect(stage.safeParse({ path: '/tmp/a.zip', fromSpaceId: 's', names: ['分镜'] }).success).toBe(false)
    expect(METHODS['skill.import'].params.safeParse({ stagingId: 'st', names: [] }).success).toBe(false)
    const candidate = { name: 'storyboard', description: '分镜', dir: 'storyboard', fileCount: 2, bytes: 10, executables: ['scripts/run.sh'], exists: false }
    expect(METHODS['skill.stage'].result.parse({ stagingId: 'st', source: '/tmp/a.zip', candidates: [candidate], skipped: [{ dir: 'broken', error: '缺少 SKILL.md' }] }).candidates).toEqual([candidate])
    const reveal = METHODS['fs.reveal'].params
    expect(reveal.safeParse({ spaceId: 's', skills: true }).success).toBe(true)
    expect(reveal.safeParse({ sessionId: 's', skills: true }).success).toBe(false)
  })

  it('only UI can respond to approvals; decisions are strictly validated and session entry payloads are supported', () => {
    const method = METHODS['session.respondApproval']
    expect(method.callers).toEqual(['ui'])
    const params = { requestId: 'r', approvalId: 'approval_1', decision: 'allow_once' }
    expect(method.params.safeParse(params).success).toBe(true)
    expect(method.params.safeParse({ ...params, decision: 'allow_everything' }).success).toBe(false)
    expect(method.params.safeParse({ ...params, sessionId: 'other' }).success).toBe(false)
    const payload = ApprovalPayload.parse({ approvalId: 'approval_1', kind: 'command', summary: '执行命令', detail: 'pwd', status: 'pending' })
    expect(ApprovalPayload.safeParse({ ...payload, mcpTool: { serverName: 'vis', toolName: 'canvas_get' } }).success).toBe(true)
    expect(ApprovalPayload.safeParse({ ...payload, mcpTool: { serverName: 'other', toolName: 'canvas_get' } }).success).toBe(false)
    expect(ApprovalPayload.safeParse({ ...payload, mcpTool: { serverName: 'vis', toolName: '' } }).success).toBe(false)
    expect(TranscriptItem.safeParse({ itemId: 'approval_1', createdSeq: 1, revision: 1, turnId: 't', kind: 'approval', payload, createdAt: 1, updatedAt: 1 }).success).toBe(true)
  })

  it('all five core interfaces are registered with callers matching 0003', () => {
    expect(METHODS['session.sendMessage'].callers).toEqual(['ui'])
    expect(METHODS['generation.submit'].callers).toEqual(['ui', 'agent'])
    expect(METHODS['generation.get'].callers).toEqual(['ui', 'agent'])
    expect(METHODS['canvas.apply'].callers).toEqual(['ui', 'agent'])
    expect(METHODS['events.subscribe'].callers).toEqual(['ui'])
    expect(isMethodName('canvas.apply')).toBe(true)
    expect(isMethodName('toString')).toBe(false)
  })

  it('pinnedRevision is provided only with the pinned policy', () => {
    const send = (ref: object) =>
      METHODS['session.sendMessage'].params.safeParse({ requestId: 'r', sessionId: 's', text: 'hi', refs: [ref] }).success
    expect(send({ nodeId: 'n', versionPolicy: 'latest-at-execution' })).toBe(true)
    expect(send({ nodeId: 'n', versionPolicy: 'pinned', pinnedRevision: 3 })).toBe(true)
    expect(send({ nodeId: 'n', versionPolicy: 'pinned' })).toBe(false)
    expect(send({ nodeId: 'n', versionPolicy: 'latest-at-execution', pinnedRevision: 3 })).toBe(false)
  })

  it('session naming distinguishes callers, trims whitespace and strictly limits Agent parameters', () => {
    const rename = METHODS['session.rename']
    const reset = METHODS['session.resetTitle']
    const set = METHODS['session.setTitle']
    expect(rename.callers).toEqual(['ui'])
    expect(reset.callers).toEqual(['ui'])
    expect(set.callers).toEqual(['agent'])
    expect(rename.params.parse({ requestId: 'r', sessionId: 's', title: '  海报  ' }).title).toBe('海报')
    expect(set.params.parse({ requestId: 'r', title: '  分镜  ' }).title).toBe('分镜')
    for (const [method, limit] of [[rename, 60], [set, 24]] as const) {
      const params = { requestId: 'r', title: '字'.repeat(limit), ...(method === rename ? { sessionId: 's' } : {}) }
      expect(method.params.safeParse(params).success).toBe(true)
      expect(method.params.safeParse({ ...params, title: `${params.title}字` }).success).toBe(false)
      expect(method.params.safeParse({ ...params, title: ' \n ' }).success).toBe(false)
    }
    expect(set.params.safeParse({ requestId: 'r', title: '分镜', sessionId: 'other' }).success).toBe(false)
    expect(set.params.safeParse({ requestId: 'r', title: '分镜', spaceId: 'other' }).success).toBe(false)
  })

  it('session model settings are UI-only, require explicit null defaults and preserve opaque Agent option values', () => {
    const options = METHODS['session.agentOptions']
    const set = METHODS['session.setAgentConfig']
    expect(options.callers).toEqual(['ui'])
    expect(set.callers).toEqual(['ui'])
    expect(options.params.parse({ sessionId: 's' })).toEqual({ sessionId: 's' })
    const params = { requestId: 'r', sessionId: 's', model: null, effort: null, serviceTier: null }
    expect(set.params.parse(params)).toEqual(params)
    expect(set.params.parse({ ...params, model: 'provider/model:opaque', effort: 'max' })).toMatchObject({ model: 'provider/model:opaque', effort: 'max' })
    for (const field of ['model', 'effort', 'serviceTier'] as const) {
      expect(set.params.safeParse({ ...params, [field]: undefined }).success).toBe(false)
      expect(set.params.safeParse({ ...params, [field]: '' }).success).toBe(false)
    }
    const models = [{ id: 'provider/model:opaque', label: '模型', isDefault: true, efforts: [], defaultEffort: null, serviceTiers: [{ id: 'fast', label: 'Fast' }] }]
    expect(options.result.parse({ models })).toEqual({ models })
    // Agents without speed tiers (dsh) parse to an empty list.
    expect(options.result.parse({ models: [{ ...models[0], serviceTiers: undefined }] }).models[0]!.serviceTiers).toEqual([])
    expect(options.result.safeParse({ models: [{ ...models[0], isDefault: undefined }] }).success).toBe(false)
    const config = METHODS['session.create'].result.shape.agentConfig
    expect(config.parse({ model: null, effort: null, serviceTier: 'fast' })).toEqual({ model: null, effort: null, serviceTier: 'fast' })
    // serviceTier was added later: old records with only model / effort receive null.
    expect(config.parse({ model: null, effort: null })).toEqual({ model: null, effort: null, serviceTier: null })
    // Pre-upgrade idempotent results and events lack agentConfig; fill defaults during parsing.
    expect(config.parse(undefined)).toEqual({ model: null, effort: null, serviceTier: null })
    expect(config.safeParse({ model: 1, effort: null }).success).toBe(false)
  })

  it('canvas.apply: content edits require expectedRevision, layout edits do not', () => {
    const apply = (op: object) => METHODS['canvas.apply'].params.safeParse({ requestId: 'r', ops: [op] }).success
    expect(apply({ op: 'slot.setText', slotId: 's', body: 'x', expectedRevision: 1 })).toBe(true)
    expect(apply({ op: 'slot.setText', slotId: 's', body: 'x' })).toBe(false)
    expect(apply({ op: 'node.layout', nodeId: 'n', x: 10 })).toBe(true)
    expect(apply({ op: 'node.create', tempId: 't', kind: 'text', x: 0, y: 0, w: 0, h: 10 })).toBe(false)
  })

  it('slot.history: both callers can read, with pagination defaults and limits', () => {
    const history = METHODS['slot.history']
    expect(history.callers).toEqual(['ui', 'agent'])
    expect(history.params.parse({ slotId: 's' })).toEqual({ slotId: 's', limit: 50 })
    expect(history.params.parse({ slotId: 's', limit: 200, beforeRevision: 5 })).toEqual({ slotId: 's', limit: 200, beforeRevision: 5 })
    for (const limit of [0, 201, 1.5]) expect(history.params.safeParse({ slotId: 's', limit }).success).toBe(false)
    expect(history.params.safeParse({ slotId: 's', beforeRevision: -1 }).success).toBe(false)
    expect(history.result.parse({ versions: [{ revision: 1, content: { type: 'empty' }, createdAt: 1, actor: 'user', isCurrent: true }], hasMore: false })).toMatchObject({ versions: [{ content: { type: 'empty' } }] })
  })

  it('generation.submit: each outputIndex can have only one target, with a 30-second wait limit', () => {
    const base = { requestId: 'r', kind: 'image', prompt: 'p' }
    const t = (outputIndex: number) => ({ outputIndex, kind: 'new_node' })
    expect(METHODS['generation.submit'].params.safeParse({ ...base, targets: [t(0), t(1)] }).success).toBe(true)
    expect(METHODS['generation.submit'].params.safeParse({ ...base, targets: [t(0), t(0)] }).success).toBe(false)
    expect(METHODS['generation.get'].params.safeParse({ jobId: 'j', waitMs: 30_001 }).success).toBe(false)
  })

  it('audio reuses media generation, asset and canvas contracts without requiring visual dimensions', () => {
    const submit = { requestId: 'r', kind: 'audio', prompt: '雨滴音效', inputs: [{ slotId: 'audio_slot', revision: 1 }] }
    expect(METHODS['generation.submit'].params.parse(submit)).toEqual(submit)
    const asset = { assetVersionId: 'audio_1', assetId: 'asset_1', version: 1, kind: 'audio', mime: 'audio/wav', durationMs: 2000, url: 'file:///audio.wav' }
    expect(METHODS['asset.get'].result.parse(asset)).toEqual(asset)
    expect(METHODS['canvas.apply'].params.safeParse({ requestId: 'r', ops: [{ op: 'node.create', tempId: 'audio', kind: 'audio', x: 0, y: 0, w: 360, h: 140, content: { assetVersionId: 'audio_1' } }] }).success).toBe(true)
    expect(NodeView.safeParse({ nodeId: 'audio', kind: 'audio', x: 0, y: 0, w: 360, h: 140, z: 1, layoutRevision: 1, slots: [{ slotId: 'audio_slot', slotKey: 'main', contentType: 'audio', revision: 1, content: { type: 'asset', assetVersionId: 'audio_1', mime: 'audio/wav' } }] }).success).toBe(true)
  })

  it('generation and regeneration remove overrideQuota so legacy parameters never reach implementations', () => {
    const submit = { requestId: 'r', kind: 'audio', prompt: '雨滴音效' }
    const regenerate = { requestId: 'r', jobId: 'job_1' }
    expect(METHODS['generation.submit'].params.shape).not.toHaveProperty('overrideQuota')
    expect(METHODS['generation.regenerate'].params.shape).not.toHaveProperty('overrideQuota')
    expect(METHODS['generation.submit'].params.parse({ ...submit, overrideQuota: true })).toEqual(submit)
    expect(METHODS['generation.regenerate'].params.parse({ ...regenerate, overrideQuota: true })).toEqual(regenerate)
  })

  it('canvas.apply: node reference inputs accept ID lists and replace-all operations require an explicit list', () => {
    const apply = (op: object) => METHODS['canvas.apply'].params.safeParse({ requestId: 'r', ops: [op] })
    const created = { op: 'node.create', tempId: 'target', kind: 'image', x: 0, y: 0, w: 320, h: 320, prompt: '', inputNodeIds: ['a'] }
    expect(apply(created).data?.ops[0]).toEqual(created)
    expect(apply({ op: 'node.setInputs', nodeId: 'target', inputNodeIds: [] }).success).toBe(true)
    expect(apply({ op: 'node.setInputs', nodeId: 'target' }).success).toBe(false)
    expect(apply({ ...created, inputNodeIds: [''] }).success).toBe(false)
    expect(apply({ op: 'node.setInputs', nodeId: 'target', inputNodeIds: [1] }).success).toBe(false)
    const node = { nodeId: 'target', kind: 'image', x: 0, y: 0, w: 320, h: 320, z: 1, layoutRevision: 1, slots: [] }
    expect(NodeView.parse(node)).not.toHaveProperty('inputs')
    expect(NodeView.parse({ ...node, inputs: ['a'] })).toHaveProperty('inputs', ['a'])
  })

  it('work item interfaces declare only callers; the server checks relationship permissions', () => {
    for (const m of ['work.deletePlan', 'work.delete', 'work.create', 'work.update', 'work.markRead', 'work.move', 'work.reopen', 'work.submitReview', 'work.inbox', 'work.slots', 'work.setSlotLimit', 'work.changes'] as const) expect(METHODS[m].callers).toEqual(['ui'])
    expect(METHODS['work.report'].callers).toEqual(['agent'])
    for (const m of ['work.dispatch', 'work.activate', 'work.recall', 'work.reply', 'work.review'] as const) {
      expect(METHODS[m].callers).toContain('agent')
      expect(METHODS[m]).not.toHaveProperty('agentRoles')
    }
    expect(METHODS['work.dispatch'].result.shape).not.toHaveProperty('role')
    expect(METHODS['work.dispatch'].result.shape).not.toHaveProperty('notice')
    for (const m of ['work.create', 'work.dispatch', 'work.update'] as const) expect(METHODS[m].params.shape).not.toHaveProperty('frame')
    expect(METHODS['work.list'].params.shape).not.toHaveProperty('includeArchived')
    const item = METHODS['work.get'].result.shape.item.shape
    expect(item).not.toHaveProperty('frameNodeId')
    expect(item).not.toHaveProperty('frameNodeCount')
    expect(item.changeCount.safeParse(0).success).toBe(true)
    expect(item.changeCount.safeParse(-1).success).toBe(false)
    expect(item.changeCount.safeParse(1.5).success).toBe(false)
    expect(item.lastChangeSeq.safeParse(null).success).toBe(true)
    expect(item.lastChangeSeq.safeParse(0).success).toBe(true)
    expect(item.lastChangeSeq.safeParse(-1).success).toBe(false)
    expect(item.lastChangeSeq.safeParse(1.5).success).toBe(false)
    expect(item.lastChangeSeq.safeParse(undefined).success).toBe(false)
  })

  it('deletion needs no revision; cross-project parameters and stop results pass the contract; deleted is not an executor report kind', () => {
    expect(METHODS['work.deletePlan'].params.parse({ spaceId: 's', workItemId: 'w' })).toEqual({ spaceId: 's', workItemId: 'w' })
    expect(METHODS['work.delete'].params.parse({ requestId: 'r', workItemId: 'w' })).toEqual({ requestId: 'r', workItemId: 'w' })
    expect(METHODS['work.delete'].params.shape).not.toHaveProperty('deleteCanvas')
    const plan = { runningTurns: 2, unfinishedJobs: 1, childrenTotal: 3, childrenInProgress: 1, unresolvedMessages: 1, hasUnreviewedReport: true, queued: false, workDir: '/work' }
    expect(METHODS['work.deletePlan'].result.parse(plan)).toEqual(plan)
    expect(METHODS['work.deletePlan'].result.safeParse({ ...plan, runningTurns: -1 }).success).toBe(false)
    const result = { workItemIds: ['w', 'child'], cancelledJobs: [{ jobId: 'job', providerCancelled: false }] }
    expect(METHODS['work.delete'].result.parse(result)).toEqual(result)
    expect(WorkMessageKind.parse('deleted')).toBe('deleted')
    expect(METHODS['work.report'].params.safeParse({ requestId: 'r', kind: 'deleted', body: 'x' }).success).toBe(false)
  })

  it('rejection feedback is optional in the contract (required for coordinators by the server), moves accept any status and slot limits distinguish global and project scopes', () => {
    const review = METHODS['work.review'].params
    expect(review.safeParse({ requestId: 'r', workItemId: 'w', decision: 'approve' }).success).toBe(true)
    expect(review.safeParse({ requestId: 'r', workItemId: 'w', decision: 'reject' }).success).toBe(true)
    expect(review.safeParse({ requestId: 'r', workItemId: 'w', decision: 'reject', feedback: '脸型不一致' }).success).toBe(true)
    const move = METHODS['work.move'].params
    for (const status of ['todo', 'in_progress', 'in_review', 'done']) expect(move.safeParse({ requestId: 'r', workItemId: 'w', status }).success).toBe(true)
    expect(move.safeParse({ requestId: 'r', workItemId: 'w', status: 'archived' }).success).toBe(false)
    const limit = METHODS['work.setSlotLimit'].params
    expect(limit.safeParse({ limit: 6 }).success).toBe(true)
    expect(limit.safeParse({ limit: null }).success).toBe(false)
    expect(limit.safeParse({ spaceId: 's', limit: null }).success).toBe(true)
    expect(limit.safeParse({ limit: 0 }).success).toBe(false)
    // Worker reports accept neither spaceId nor workItemId and affect only their own work item.
    const report = METHODS['work.report'].params
    expect(report.safeParse({ requestId: 'r', kind: 'question', body: '要哪种外套？' }).success).toBe(true)
    expect(report.safeParse({ requestId: 'r', kind: 'question', body: 'x', workItemId: 'w' }).success).toBe(false)
    expect(report.safeParse({ requestId: 'r', kind: 'reply', body: 'x' }).success).toBe(false)
  })

  it('0015: message references are either nodes or assets, legacy messages parse unchanged; approval modes and child reparenting are UI-only', () => {
    const node = { nodeId: 'n', versionPolicy: 'latest-at-execution' }
    expect(MessageRef.parse(node)).toEqual(node)
    expect(MessageRef.parse({ assetVersionId: 'av' })).toEqual({ assetVersionId: 'av' })
    expect(MessageRef.safeParse({}).success).toBe(false)
    expect(MessageRef.safeParse({ assetVersionId: '' }).success).toBe(false)
    const send = METHODS['session.sendMessage'].params
    expect(send.safeParse({ requestId: 'r', sessionId: 's', text: '看这张', refs: [node, { assetVersionId: 'av' }] }).success).toBe(true)
    const summary = { sessionId: 's', agentKind: 'codex', title: 't', workDir: '/w', workItemId: null, titleSource: 'default', queuePaused: false,
      activeTurnId: null, pendingApprovals: 0, createdAt: 1 }
    // Pre-upgrade results and events lack approvalMode; default to ask.
    const parsed = SessionSummary.safeParse(summary)
    expect(parsed.success).toBe(true)
    expect(parsed.data).not.toHaveProperty('approvalMode')
    expect(SessionSummary.parse({ ...summary, approvalMode: 'auto' }).approvalMode).toBe('auto')
    expect(SessionSummary.parse(summary).silentSince).toBeNull()
    expect(SessionSummary.parse({ ...summary, silentSince: 123 }).silentSince).toBe(123)
    expect(SessionSummary.safeParse({ ...summary, silentSince: 1.5 }).success).toBe(false)
    const mode = METHODS['session.setApprovalMode']
    expect(mode.callers).toEqual(['ui'])
    expect(mode.params.safeParse({ requestId: 'r', sessionId: 's', mode: 'auto' }).success).toBe(true)
    expect(mode.params.safeParse({ requestId: 'r', sessionId: 's', mode: 'all' }).success).toBe(false)
    expect(METHODS['session.clearQueue'].callers).toEqual(['ui'])
    expect(SessionSummary.parse({ ...summary, queuedMessageCount: 2 }).queuedMessageCount).toBe(2)
    expect(SessionSummary.safeParse({ ...summary, queuedMessageCount: -1 }).success).toBe(false)
    const reparent = METHODS['work.reparent']
    expect(reparent.callers).toEqual(['ui'])
    expect(reparent.params.safeParse({ requestId: 'r', workItemId: 'w', parentId: 'p' }).success).toBe(true)
    expect(reparent.params.safeParse({ requestId: 'r', workItemId: 'w', parentId: null }).success).toBe(true)
    expect(reparent.params.safeParse({ requestId: 'r', workItemId: 'w' }).success).toBe(false)
  })

  it('0032: send now is UI-only and targets a queued message in a session', () => {
    const method = METHODS['session.sendNow']
    expect(method.callers).toEqual(['ui'])
    expect(method.params.parse({ requestId: 'r', sessionId: 's', messageId: 'm' })).toEqual({ requestId: 'r', sessionId: 's', messageId: 'm' })
    expect(method.params.safeParse({ requestId: 'r', sessionId: 's' }).success).toBe(false)
    expect(method.params.safeParse({ requestId: 'r', sessionId: 's', messageId: '' }).success).toBe(false)
    expect(method.result.parse({ accepted: true })).toEqual({ accepted: true })
    expect(method.result.safeParse({ accepted: false }).success).toBe(false)
    const work = { messageId: 'm', text: 'Report', refs: [], workDeliveryId: 'batch' }
    expect(UserMessagePayload.parse(work)).toEqual(work)
    const task = { taskId: 'task', status: 'running', operation: 'video.trim', nodeId: 'node', slotId: 'slot', createdAt: 1 }
    expect(MediaTaskView.parse(task)).not.toHaveProperty('sessionId')
    expect(MediaTaskView.parse({ ...task, sessionId: 'owner' }).sessionId).toBe('owner')
  })

  it('0016: node creation may omit position for the server to choose; categories are free text, purpose and format have constrained values', () => {
    const apply = (op: object) => METHODS['canvas.apply'].params.safeParse({ requestId: 'r', ops: [op] })
    expect(apply({ op: 'node.create', tempId: 't', kind: 'text', content: { text: '分镜' }, category: '分镜', purpose: 'artifact', format: 'markdown' }).success).toBe(true)
    expect(apply({ op: 'node.create', tempId: 't', kind: 'text', category: '  ' }).success).toBe(false)
    expect(apply({ op: 'node.create', tempId: 't', kind: 'text', category: '一'.repeat(21) }).success).toBe(false)
    expect(apply({ op: 'node.create', tempId: 't', kind: 'text', w: 0 }).success).toBe(false)
    expect(apply({ op: 'node.setMeta', nodeId: 'n', category: null, purpose: 'working' }).success).toBe(true)
    expect(apply({ op: 'node.setMeta', nodeId: 'n', format: 'code' }).success).toBe(true)
    expect(apply({ op: 'node.setMeta', nodeId: 'n', purpose: 'chatter' }).success).toBe(false)
    const created = apply({ op: 'node.create', tempId: 't', kind: 'text', category: ' 人物 ' })
    expect(created.data?.ops[0]).toHaveProperty('category', '人物')
    // Legacy node views still parse without the three metadata fields.
    const node = { nodeId: 'n', kind: 'text', x: 0, y: 0, w: 320, h: 200, z: 1, layoutRevision: 1, slots: [] }
    expect(NodeView.safeParse(node).success).toBe(true)
    expect(NodeView.parse({ ...node, category: null, purpose: 'working', format: 'code' })).toMatchObject({ purpose: 'working', format: 'code' })
  })
})

it('validates the complete previz document and requires a revision for previz.set', async () => {
  const { CanvasNodeKind, CanvasOp, EMPTY_PREVIZ, emptyPrevizPanel, NodeKind, PrevizDoc, PREVIZ_LIMITS } = await import('./index')
  expect(NodeKind.parse('previz')).toBe('previz')
  expect(CanvasNodeKind.parse('previz')).toBe('previz')
  const panel = { ...emptyPrevizPanel('panel'), underlay: 'image', shot: { scriptNodeId: 'script', shotId: 'shot' }, use: 'frame' as const, frameRole: 'last' as const, blockout: 'blockout' }
  const doc = { ...EMPTY_PREVIZ, panels: [panel] }
  expect(PrevizDoc.parse(doc)).toEqual(doc)
  expect(CanvasOp.safeParse({ op: 'previz.set', slotId: 'main', doc }).success).toBe(false)
  expect(CanvasOp.parse({ op: 'previz.set', slotId: 'main', expectedRevision: 1, doc })).toMatchObject({ doc })
  for (const bad of [
    { ...doc, version: 2 }, { ...doc, rev: -1 }, { ...doc, aspectRatio: '2:1' },
    { ...doc, panels: [panel, panel] }, { ...doc, panels: [{ ...panel, durationSec: 0 }] },
    { ...doc, panels: [{ ...panel, note: 'x'.repeat(PREVIZ_LIMITS.note + 1) }] },
    { ...doc, panels: Array.from({ length: PREVIZ_LIMITS.panels + 1 }, (_, id) => ({ ...panel, id: String(id) })) },
  ]) expect(PrevizDoc.safeParse(bad).success).toBe(false)
})

it('exposes an image-only thumbnail preview separately from video posters', () => {
  expect(METHODS['media.preview'].params.parse({ assetVersionId: 'picture', kind: 'thumbnail' })).toEqual({ assetVersionId: 'picture', kind: 'thumbnail' })
  expect(METHODS['media.preview'].result.parse({ kind: 'thumbnail', width: 960, height: 540 })).toEqual({ kind: 'thumbnail', width: 960, height: 540 })
})

it('keeps manuscript import preview user-only and validates the preview contract', async () => {
  const { METHODS, WritingImportPreview } = await import('./index')
  expect(METHODS['writing.importPreview'].callers).toEqual(['ui'])
  expect(METHODS['writing.importPreview'].params.safeParse({ path: '' }).success).toBe(false)
  expect(WritingImportPreview.safeParse({ name: 'book.md', encoding: 'utf-8', body: '# Start', chapters: [{ title: 'Start', level: 1, from: 0, to: 7 }], words: 1 }).success).toBe(true)
  expect(WritingImportPreview.safeParse({ name: 'book.pdf', encoding: 'pdf', body: '', chapters: [], words: 0 }).success).toBe(false)
})


it('requires anchored manuscript edits, atomic user acceptance, and read-only series methods', async () => {
  const { textEditAnchor, applyTextEdits } = await import('./writing')
  const propose = METHODS['text.propose']
  const params = { requestId: 'r', slotId: 's', baseRevision: 2, summary: 'Tighten prose', edits: [{ find: '雾', replace: '薄雾' }] }
  expect(propose.params.parse(params)).toEqual(params)
  expect(propose.params.safeParse({ ...params, edits: [{ find: '', replace: 'x' }] }).success).toBe(false)
  expect(propose.params.safeParse({ ...params, baseRevision: -1 }).success).toBe(false)
  expect(propose.callers).toEqual(['agent'])
  expect(METHODS['text.proposal.resolve'].callers).toEqual(['ui'])
  const resolve = { requestId: 'r', slotId: 's', edits: [{ proposalId: 'p', editId: 'e' }] }
  expect(METHODS['text.proposal.resolve'].params.safeParse({ ...resolve, action: 'accept' }).success).toBe(false)
  expect(METHODS['text.proposal.resolve'].params.parse({ ...resolve, action: 'accept', expectedRevision: 2, body: '新正文' })).toHaveProperty('body', '新正文')
  expect(METHODS['text.proposal.resolve'].params.parse({ ...resolve, action: 'reject' })).toEqual({ ...resolve, action: 'reject' })
  for (const method of ['series.textList', 'series.textRead'] as const) expect(METHODS[method].callers).toEqual(['agent'])
  expect(textEditAnchor('雾。雾。', { find: '雾', replace: '' })).toBeNull()
  expect(textEditAnchor('雾。浓雾。', { find: '雾', before: '浓', after: '。', replace: '' })).toEqual({ from: 3, to: 4 })
  expect(textEditAnchor('aaa', { find: 'aa', replace: '' })).toBeNull()
  expect(applyTextEdits('林舟回家。', [{ find: '林舟', replace: '阿舟' }, { find: '回家', replace: '远行' }])).toBe('阿舟远行。')
  expect(applyTextEdits('林舟回家。', [{ find: '林舟', replace: '阿舟' }, { find: '舟回', replace: '' }])).toBeNull()
})

it('exposes revision-pinned manuscript deletion requests only to Agents', () => {
  expect(METHODS['text.requestDelete'].callers).toEqual(['agent'])
  expect(METHODS['text.requestDelete'].params.parse({ requestId: 'request', nodeId: 'chapter', expectedRevision: 3 })).toEqual({ requestId: 'request', nodeId: 'chapter', expectedRevision: 3 })
  expect(METHODS['text.requestDelete'].params.safeParse({ requestId: 'request', nodeId: 'chapter' }).success).toBe(false)
  expect(METHODS['session.respondApproval'].callers).toEqual(['ui'])
})


it('keeps old shots valid and supports quoted manuscript sources in script writes', async () => {
  const { Shot, ShotFields, ScriptDocInput } = await import('./script')
  const old = { id: 'shot', rev: 1, transition: 'cut', description: 'Dawn', characterIds: [], propIds: [] }
  expect(Shot.parse(old)).toEqual(old)
  const source = { nodeId: 'book', quote: 'Dawn over the river.' }
  expect(Shot.parse({ ...old, source }).source).toEqual(source)
  expect(ShotFields.parse({ source: null })).toEqual({ source: null })
  expect(ScriptDocInput.parse({ shots: [{ tempId: 's', description: 'Dawn', source }] }).shots[0]!.source).toEqual(source)
  expect(ShotFields.safeParse({ source: { nodeId: 'book', quote: '' } }).success).toBe(false)
})

it('restricts episode splitting to the UI and validates chapter choices', async () => {
  const { METHODS } = await import('./methods')
  const spec = METHODS['writing.split']
  expect(spec.callers).toEqual(['ui'])
  const chapter = { from: 0, to: 20, name: 'Dawn', episode: 2 }
  const params = { requestId: 'split', nodeId: 'book', expectedRevision: 1, series: { name: 'Novel' }, chapters: [chapter] }
  expect(spec.params.parse(params)).toEqual(params)
  expect(spec.params.safeParse({ ...params, chapters: [chapter, { ...chapter, from: 20 }] }).success).toBe(false)
  expect(spec.params.safeParse({ ...params, chapters: [] }).success).toBe(false)
  expect(spec.params.parse({ ...params, chapters: Array.from({ length: 201 }, (_, index) => ({ ...chapter, from: index * 20, to: (index + 1) * 20, episode: index + 1 })) }).chapters).toHaveLength(201)
})


it('preserves alpha facts and defaults render video to opaque', async () => {
  const { AssetVersionView, RenderVideoParams, SlotContent } = await import('./index')
  expect(RenderVideoParams.parse({})).toEqual({ width: 1920, height: 1080, fps: 30, transparent: false })
  expect(RenderVideoParams.parse({ transparent: true }).transparent).toBe(true)
  expect(RenderVideoParams.safeParse({ transparent: 'true' }).success).toBe(false)
  const content = { type: 'asset', assetVersionId: 'alpha', mime: 'video/webm', hasAlpha: true }
  expect(SlotContent.parse(content)).toEqual(content)
  expect(AssetVersionView.parse({ assetVersionId: 'alpha', assetId: 'a', version: 1, kind: 'video', mime: 'video/webm', url: 'file:///alpha', hasAlpha: true }).hasAlpha).toBe(true)
})

it('contracts MOV as a UI-only download without making a canvas version', async () => {
  const { LOCAL_OPERATION_OUTPUT } = await import('./index')
  expect(LOCAL_OPERATION_OUTPUT['video.exportMov']).toBe('download')
  const params = { requestId: 'mov', operation: 'video.exportMov', nodeId: 'n', slotId: 's', expectedRevision: 1, params: {} }
  expect(METHODS['media.process'].params.parse(params)).toEqual(params)
  expect(METHODS['media.process'].params.safeParse({ ...params, params: { path: '/tmp/unsafe.mov' } }).success).toBe(false)
  for (const name of ['media.cancel', 'media.dismiss', 'media.exportDownload'] as const) {
    expect(METHODS[name].callers).toEqual(['ui'])
    expect(METHODS[name].params.safeParse({ taskId: 'task', path: '/tmp/unsafe.mov' }).success).toBe(false)
  }
  const task = { taskId: 't', operation: 'video.exportMov', status: 'succeeded', nodeId: 'n', slotId: 's', createdAt: 1, download: { filename: 'video.mov', byteSize: 123, expiresAt: 1000 } }
  expect(MediaTaskView.parse(task)).toEqual(task)
})
