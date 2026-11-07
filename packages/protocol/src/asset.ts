import { z } from 'zod'
import { AssetKind, Id, MediaKind, RequestId, Revision } from './common'
import { FontRef } from './timeline'
import { SCRIPT_LIMITS } from './script'

export const AssetVersionView = z.object({
  assetVersionId: Id,
  assetId: Id,
  version: z.int().positive(),
  kind: AssetKind,
  mime: z.string(),
  displayName: z.string().optional(),
  width: z.int().optional(),
  height: z.int().optional(),
  durationMs: z.int().optional(),
  // 0024c: video frame rate when probed (e.g. 29.97); absent for images, audio and versions registered before 0024c
  fps: z.number().positive().optional(),
  // Probed alpha channel; absent for legacy versions or unprobed outputs.
  hasAlpha: z.boolean().optional(),
  // 0024d: family name read from a font asset's name table; ASS refers to fonts by this name
  fontFamily: z.string().optional(),
  // Controlled access URL issued by studiod
  url: z.string(),
  // Local file path, provided when the Agent and studiod share a machine, for direct use by image tools; url is a file:// URL that image tools do not recognize.
  path: z.string().optional(),
})
export type AssetVersionView = z.infer<typeof AssetVersionView>

// 0024d: a font usable by timeline text, built in or from this project
export const FontView = z.object({ font: FontRef, family: z.string(), label: z.string() })
export type FontView = z.infer<typeof FontView>

export const ExtractedFrameView = AssetVersionView.extend({ atMs: z.int().nonnegative() })
export type ExtractedFrameView = z.infer<typeof ExtractedFrameView>

// 0027: library metadata on assets. Category and tags are free text (0016 recommended values); user edits are
// recorded per field so an Agent labeling run never overwrites them.
export const LIBRARY_LIMITS = { label: 20, tags: 10, labelBatch: 50, page: 200, usageNodeIds: 20 } as const
const Label = z.string().trim().min(1).max(LIBRARY_LIMITS.label)
const DisplayName = z.string().trim().min(1).max(200)
export const AssetLabelField = z.enum(['displayName', 'category', 'tags'])
export type AssetLabelField = z.infer<typeof AssetLabelField>
export const AssetOrigin = z.enum(['import', 'generation', 'derived'])

export const LibraryAsset = z.object({
  assetId: Id,
  kind: MediaKind,
  origin: AssetOrigin,
  displayName: z.string().optional(),
  category: z.string().nullable(),
  // category, else the newest categorized live node using the asset, else the finished-cut category for timeline exports; never stored
  effectiveCategory: z.string().nullable(),
  tags: z.array(z.string()),
  archived: z.boolean(),
  revision: Revision,
  createdAt: z.int(),
  labeledBy: z.enum(['agent', 'user']).nullable(),
  userFields: z.array(AssetLabelField),
  latest: AssetVersionView,
  versionCount: z.int().positive(),
  usage: z.object({ count: z.int().nonnegative(), nodeIds: z.array(Id).max(LIBRARY_LIMITS.usageNodeIds) }),
  // Settings this asset belongs to (0027 step b); empty until then
  entityIds: z.array(Id).default([]),
  // Only for agent callers: enough to label without opening the canvas
  context: z.object({ nodeTitles: z.array(z.string()), prompt: z.string().optional() }).optional(),
})
export type LibraryAsset = z.infer<typeof LibraryAsset>

const Facet = z.object({ name: z.string().nullable(), count: z.int().nonnegative() })

export const assetLibrary = {
  versions: {
    params: z.object({ assetId: Id }),
    result: z.object({ versions: z.array(AssetVersionView) }),
  },
  list: {
    params: z.object({
      kind: MediaKind.optional(),
      // null selects uncategorized assets, by effective category
      category: z.string().nullable().optional(),
      tag: z.string().optional(),
      entityId: Id.optional(),
      query: z.string().max(200).optional(),
      usage: z.enum(['all', 'used', 'unused']).default('all'),
      labeled: z.boolean().optional(),
      archived: z.boolean().default(false),
      cursor: z.string().optional(),
      limit: z.int().min(1).max(LIBRARY_LIMITS.page).default(100),
    }),
    result: z.object({
      items: z.array(LibraryAsset),
      nextCursor: z.string().optional(),
      // First page only: counts under the same filters except category / tag
      facets: z.object({ categories: z.array(Facet), tags: z.array(Facet.extend({ name: z.string() })) }).optional(),
    }),
  },
  update: {
    params: z.object({
      assetId: Id,
      expectedRevision: Revision,
      displayName: DisplayName.nullable().optional(),
      category: Label.nullable().optional(),
      tags: z.array(Label).max(LIBRARY_LIMITS.tags).optional(),
      archived: z.boolean().optional(),
      // Apply supplied fields first, then mark every label field as user-confirmed in the same revision
      confirm: z.boolean().optional(),
    }),
    result: LibraryAsset,
  },
  label: {
    params: z.object({
      requestId: RequestId,
      runId: Id.optional(),
      items: z.array(z.object({
        assetId: Id,
        displayName: DisplayName.optional(),
        category: Label.optional(),
        tags: z.array(Label).max(LIBRARY_LIMITS.tags).optional(),
      })).min(1).max(LIBRARY_LIMITS.labelBatch),
    }),
    result: z.object({
      labeled: z.array(Id),
      skippedFields: z.array(z.object({ assetId: Id, fields: z.array(AssetLabelField) })),
    }),
  },
} as const

export const asset = {
  get: {
    params: z.object({ assetVersionId: Id }),
    result: AssetVersionView,
  },
  import: {
    params: z.object({ requestId: RequestId, path: z.string().min(1).describe('本机文件的绝对路径'), contentHash: z.string().regex(/^[a-f0-9]{64}$/).optional(), displayName: z.string().max(200).optional() }),
    result: AssetVersionView,
  },
  importFile: {
    params: z.object({ requestId: RequestId, path: z.string().min(1).describe('Absolute path within the session working directory or project assets directory'), displayName: z.string().max(200).optional() }),
    result: AssetVersionView,
  },
  extractFrames: {
    params: z.object({
      requestId: RequestId,
      assetVersionId: Id.describe('Video asset version'),
      count: z.int().min(1).max(16).optional().describe('Number of evenly spaced frames, default 6; cannot be combined with atMs'),
      atMs: z.array(z.int().nonnegative()).min(1).max(SCRIPT_LIMITS.shots).optional().describe('Explicit timestamps in milliseconds, in the desired output order; cannot be combined with count'),
    }).refine(p => p.count === undefined || p.atMs === undefined, { message: 'count and atMs are mutually exclusive' })
      .transform(p => p.atMs === undefined ? { ...p, count: p.count ?? 6 } : p),
    result: z.object({ durationMs: z.int().nonnegative(), frames: z.array(ExtractedFrameView) }),
  },
} as const

export const font = {
  list: {
    params: z.object({}),
    result: z.object({ fonts: z.array(FontView) }),
  },
} as const

export const model = {
  list: {
    params: z.object({}),
    result: z.object({ models: z.array(AssetVersionView) }),
  },
} as const
