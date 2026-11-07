import { z } from 'zod'
import { Id, RequestId } from './common'
import { Episode, SeriesTarget, SpaceSeries } from './series'

/** Protocol major version; increment only for incompatible changes. Handshake mismatches are incompatible (RFC 0004 "Version compatibility"). */
export const PROTOCOL_VERSION = 1

export const Credential = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ui'), token: z.string().min(1) }),
  z.object({ kind: z.literal('agent'), token: z.string().min(1) }),
])
export type Credential = z.infer<typeof Credential>

export const CapabilitySummary = z.object({
  method: z.string(),
  command: z.string(),
  summary: z.string(),
})
export type CapabilitySummary = z.infer<typeof CapabilitySummary>

export const runtime = {
  hello: {
    params: z.object({ protocolVersion: z.int().positive(), credential: Credential }),
    result: z.object({ protocolVersion: z.int().positive(), studiodVersion: z.string(), runtimeEpoch: Id }),
  },
  activity: {
    params: z.object({}),
    result: z.object({ activeTurns: z.int().nonnegative(), activeJobs: z.int().nonnegative() }),
  },
  shutdown: {
    params: z.object({ reason: z.enum(['user_quit', 'upgrade']) }),
    result: z.object({ accepted: z.literal(true) }),
  },
} as const

export const capabilities = {
  list: {
    params: z.object({}),
    result: z.object({ capabilities: z.array(CapabilitySummary) }),
  },
  describe: {
    params: z.object({ method: z.string() }),
    result: z.object({
      method: z.string(),
      command: z.string(),
      summary: z.string(),
      description: z.string(),
      params: z.unknown(),   // JSON Schema
      result: z.unknown(),   // JSON Schema
    }),
  },
} as const

// Agent guides (RFC 0026): specialist instructions an agent reads on demand instead of carrying them every turn.
export const GuideTopic = z.enum(['script', 'timeline', 'code-render', 'media', 'generation', 'canvas', 'library', 'previz', 'writing'])
export type GuideTopic = z.infer<typeof GuideTopic>
export const GuideSummary = z.object({ topic: GuideTopic, title: z.string(), when: z.string() })
export type GuideSummary = z.infer<typeof GuideSummary>

export const guide = {
  get: {
    params: z.object({ topic: GuideTopic.optional() }),
    result: z.object({
      topics: z.array(GuideSummary),
      guide: z.object({ topic: GuideTopic, title: z.string(), body: z.string() }).optional(),
    }),
  },
} as const

// series (0027 step c): absent for standalone projects
export const SpaceSummary = z.object({ spaceId: Id, name: z.string(), rootPath: z.string(), createdAt: z.int(), series: SpaceSeries.optional(), skippedSkills: z.array(z.string()).optional() })
export type SpaceSummary = z.infer<typeof SpaceSummary>

export const space = {
  deletePlan: {
    params: z.object({ spaceId: Id }),
    result: z.object({ runningTurns: z.int().nonnegative(), unfinishedJobs: z.int().nonnegative(), workInProgress: z.int().nonnegative(), unresolvedMessages: z.int().nonnegative(), rootPath: z.string() }),
  },
  delete: {
    params: z.object({ requestId: RequestId, spaceId: Id }),
    result: z.object({ spaceId: Id, cancelledJobs: z.array(z.object({ jobId: Id, providerCancelled: z.boolean() })) }),
  },
  listDeleted: {
    params: z.object({}),
    result: z.object({ spaces: z.array(z.object({ spaceId: Id, name: z.string(), rootPath: z.string(), deletedAt: z.int(), rootPathExists: z.boolean(), canDeleteProjectDir: z.boolean(), canDeleteProjectDirReason: z.string().nullable(), purgeError: z.string().nullable() })) }),
  },
  diskUsage: {
    params: z.object({ spaceId: Id }),
    result: z.object({ dataBytes: z.number().nonnegative(), projectDirBytes: z.number().nonnegative().nullable() }),
  },
  restore: {
    params: z.object({ requestId: RequestId, spaceId: Id }),
    result: SpaceSummary,
  },
  purge: {
    params: z.object({ requestId: RequestId, spaceId: Id, deleteProjectDir: z.boolean().optional() }),
    result: z.object({ spaceId: Id, projectDirDeleted: z.boolean(), movedProjectDir: z.string().optional() }),
  },
  create: {
    // series / episode (0027 step c): create the project as an episode; episode defaults to the next free number
    params: z.object({ requestId: RequestId, name: z.string().trim().min(1).max(200), rootPath: z.string().min(1).optional(), series: SeriesTarget.optional(), episode: Episode.optional() }),
    result: SpaceSummary,
  },
  list: {
    params: z.object({}),
    result: z.object({ spaces: z.array(SpaceSummary), projectsDir: z.string() }),
  },
} as const

export const SkillOrigin = z.object({ skillId: Id, version: z.string().regex(/^[a-f0-9]{64}$/), contentHash: z.string().regex(/^[a-f0-9]{64}$/) })
export const SkillCopyState = SkillOrigin.extend({ currentHash: z.string().regex(/^[a-f0-9]{64}$/), edited: z.boolean(), newer: z.boolean(), missing: z.boolean() })
export type SkillCopyState = z.infer<typeof SkillCopyState>
export const SkillView = z.object({ name: z.string(), description: z.string(), path: z.string(), copy: SkillCopyState.optional() })
export type SkillView = z.infer<typeof SkillView>

export const fs = {
  pickDirectory: {
    params: z.object({ defaultPath: z.string().optional() }),
    result: z.object({ path: z.string().optional(), cancelled: z.boolean(), unsupported: z.boolean() }),
  },
  validateDirectory: {
    params: z.object({ path: z.string() }),
    result: z.object({ valid: z.boolean(), error: z.string().optional() }),
  },
  listSkills: {
    params: z.object({ spaceId: Id.optional() }),
    result: z.object({ skills: z.array(SkillView) }),
  },
  reveal: {
    params: z.object({ spaceId: Id.optional(), sessionId: Id.optional(), workItemId: Id.optional(), skills: z.literal(true).optional().describe('打开项目 skills 目录（0017）') })
      .refine(p => p.workItemId ? !p.sessionId : [p.spaceId, p.sessionId].filter(Boolean).length === 1, 'Exactly one target must be specified')
      .refine(p => !p.skills || (!p.sessionId && !p.workItemId), 'skills can only be specified with a project'),
    result: z.object({ ok: z.literal(true), path: z.string(), revealed: z.boolean() }),
  },
} as const

/** Unrecognized directories under project skills, or skipped directories in import sources (0017). */
export const SkillProblem = z.object({
  dir: z.string().describe('相对路径'),
  /** English fallback; the UI shows the localized `reason` when present */
  error: z.string(),
  reason: z.string().optional(),
  params: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
})
export type SkillProblem = z.infer<typeof SkillProblem>

/** A staged skill awaiting confirmation (0017). */
// Shared by folder staging and ZIP parsing; manuscript imports keep their own smaller limits.
export const SKILL_SOURCE_LIMITS = Object.freeze({
  maxArchiveBytes: 256 * 1024 ** 2,
  maxBytes: 512 * 1024 ** 2,
  maxFiles: 10000,
})

export const SkillCandidate = z.object({
  name: z.string(),
  description: z.string(),
  dir: z.string().describe('导入后在项目 skills 下的目录名'),
  fileCount: z.int().nonnegative(),
  bytes: z.int().nonnegative(),
  executables: z.array(z.string()).describe('脚本或带可执行位的文件相对路径，只用于提示'),
  exists: z.boolean().describe('项目里已有同名 skill 或同名目录'),
})
export type SkillCandidate = z.infer<typeof SkillCandidate>

/** Author-owned library content (0033). A name is also the project directory name. */
export const SkillContent = z.object({
  name: z.string().trim().min(1).max(64).refine(name => !name.startsWith('.') && !name.endsWith('.') && !/[\\/:<>"|?*\x00-\x1f\x7f-\x9f]/.test(name) && !/^(con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\s*\.|$)/i.test(name), 'Invalid skill directory name'),
  description: z.string().trim().min(1).max(4000),
  body: z.string().min(1).max(1024 * 1024),
})
export const LibrarySkill = z.object({
  skillId: Id, revision: z.int().positive(), version: z.string().regex(/^[a-f0-9]{64}$/), contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  name: z.string(), description: z.string(), createdAt: z.int(), updatedAt: z.int(), addToNewProjects: z.boolean().default(false),
})
export type LibrarySkill = z.infer<typeof LibrarySkill>
export const SkillDraft = SkillContent.extend({ draftId: Id, revision: z.int().positive(), createdAt: z.int(), spaceId: Id, sessionId: Id })
export type SkillDraft = z.infer<typeof SkillDraft>
// Adapters retain this structured receipt when the human-readable tool result is truncated.
export const SkillDraftReceipt = SkillDraft.omit({ body: true })
export type SkillDraftReceipt = z.infer<typeof SkillDraftReceipt>

const CopyMutation = z.object({ requestId: RequestId, spaceId: Id, path: z.string().min(1), expectedHash: z.string().regex(/^[a-f0-9]{64}$/) })

/** Project imports (0017) and the author library (0033); only draft proposals are Agent-callable. */
export const skill = {
  copyUpdate: { params: CopyMutation, result: SkillView },
  copyReset: { params: CopyMutation, result: SkillView },
  copyPublish: { params: CopyMutation.extend({ expectedRevision: z.int().positive() }), result: LibrarySkill },
  setAutoAdd: { params: z.object({ skillId: Id, expectedRevision: z.int().positive(), enabled: z.boolean() }), result: LibrarySkill },
  libraryDelete: { params: z.object({ skillId: Id, expectedRevision: z.int().positive() }), result: z.object({ ok: z.literal(true) }) },
  export: { params: z.object({ skillId: Id }), result: z.object({ filename: z.literal('SKILL.md'), content: z.string() }) },
  importDrafts: {
    params: z.object({ requestId: RequestId, files: z.array(z.object({ filename: z.string().regex(/\.md$/i), content: z.string().min(1).max(1024 * 1024 + 8192) })).min(1).max(100) }),
    result: z.object({ drafts: z.array(SkillDraft) }),
  },
  draftState: { params: z.object({ draftId: Id }), result: z.object({ status: z.enum(['draft', 'saved', 'discarded']), draft: SkillDraft.optional() }) },
  proposeDraft: {
    params: SkillContent.extend({ requestId: RequestId }),
    result: z.object({ draft: SkillDraft, location: z.literal('Settings > My skills') }),
  },
  libraryList: {
    params: z.object({}),
    result: z.object({ skills: z.array(LibrarySkill), drafts: z.array(SkillDraft) }),
  },
  libraryGet: {
    params: z.object({ skillId: Id }),
    result: LibrarySkill.extend({ body: z.string() }),
  },
  librarySave: {
    params: SkillContent.extend({ requestId: RequestId, draftId: Id.optional(), skillId: Id.optional(), expectedRevision: z.int().positive() })
      .refine(p => Number(Boolean(p.draftId)) + Number(Boolean(p.skillId)) === 1, 'Specify exactly one draft or skill'),
    result: LibrarySkill,
  },
  discardDraft: {
    params: z.object({ draftId: Id, expectedRevision: z.int().positive() }),
    result: z.object({ ok: z.literal(true) }),
  },
  use: {
    params: z.object({ requestId: RequestId, spaceId: Id, skillId: Id, version: z.string().regex(/^[a-f0-9]{64}$/) }),
    result: z.object({ skill: SkillView, origin: z.object({ skillId: Id, version: z.string(), contentHash: z.string() }) }),
  },
  list: {
    params: z.object({ spaceId: Id.optional() }),
    result: z.object({ skillsPath: z.string(), skills: z.array(SkillView), problems: z.array(SkillProblem) }),
  },
  stage: {
    params: z.object({
      spaceId: Id.optional(),
      path: z.string().min(1).optional().describe('本机文件夹或 .zip / .skill 压缩包的绝对路径'),
      fromSpaceId: Id.optional().describe('从另一个项目复制'),
      names: z.array(z.string().min(1)).min(1).optional().describe('配合 fromSpaceId，要复制的 skill 名称'),
    }).refine(p => p.path ? !p.fromSpaceId && !p.names : Boolean(p.fromSpaceId && p.names), 'Specify path, or both fromSpaceId and names'),
    result: z.object({ stagingId: Id, source: z.string(), candidates: z.array(SkillCandidate), skipped: z.array(SkillProblem) }),
  },
  import: {
    params: z.object({ spaceId: Id.optional(), stagingId: Id, names: z.array(z.string().min(1)).min(1), replace: z.boolean().optional().describe('同名时替换，旧的移到已移除目录') }),
    result: z.object({ imported: z.array(SkillView), replaced: z.array(z.string()) }),
  },
  discard: {
    params: z.object({ stagingId: Id }),
    result: z.object({ ok: z.literal(true) }),
  },
  remove: {
    params: z.object({ spaceId: Id.optional(), name: z.string().min(1) }),
    result: z.object({ ok: z.literal(true), removedPath: z.string().describe('旧目录移到的位置，可从这里找回') }),
  },
} as const

/** UI language (0018); null follows the browser. */
export const Locale = z.enum(['zh-CN', 'en'])
export type Locale = z.infer<typeof Locale>

/** UI preferences persisted across projects and browsers (0018), stored in app.db settings. */
export const preferences = {
  get: {
    params: z.object({}),
    result: z.object({ locale: Locale.nullable() }),
  },
  set: {
    params: z.object({ locale: Locale.nullable() }),
    result: z.object({ locale: Locale.nullable() }),
  },
} as const
