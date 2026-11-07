import { z } from 'zod'
import { Id, Revision } from './common'

// 0023: script nodes. One node holds the whole storyboard table; shots and assets carry their own revision so the
// user and an Agent can edit different rows at the same time.

export const SCRIPT_LIMITS = { shots: 200, assets: 100, cell: 4000, opsPerBatch: 200 } as const

const Cell = z.string().max(SCRIPT_LIMITS.cell)
const TempId = z.string().min(1).max(64)

export const ShotSource = z.strictObject({ nodeId: Id, quote: z.string().min(1).max(2_000_000) })
export type ShotSource = z.infer<typeof ShotSource>

export const ShotTransition = z.enum(['cut', 'continuous'])
export type ShotTransition = z.infer<typeof ShotTransition>
// agent: written by an Agent; edited: changed by the user (an Agent rewrite skips it unless asked); stale: the shot or
// an asset it uses changed after the prompts were written. Set by the server, never sent by callers.
export const PromptState = z.enum(['agent', 'edited', 'stale'])
export type PromptState = z.infer<typeof PromptState>
export const RowColor = z.enum(['red', 'yellow', 'green', 'blue', 'purple'])
export const ScriptAssetKind = z.enum(['character', 'scene', 'prop'])
export type ScriptAssetKind = z.infer<typeof ScriptAssetKind>

/** Editable shot fields. Asset references may name assets created earlier in the same batch by tempId. */
export const ShotFields = z.strictObject({
  source: ShotSource.nullable().optional(),
  durationSec: z.number().min(0.5).max(60).nullable().optional(),
  transition: ShotTransition.optional(),
  description: Cell.optional(),
  endState: Cell.nullable().optional(),
  shotSize: Cell.nullable().optional(),
  camera: Cell.nullable().optional(),
  dialogue: Cell.nullable().optional(),
  sound: Cell.nullable().optional(),
  sceneId: Id.nullable().optional(),
  characterIds: z.array(Id).max(SCRIPT_LIMITS.assets).optional(),
  propIds: z.array(Id).max(SCRIPT_LIMITS.assets).optional(),
  framePrompt: Cell.nullable().optional(),
  endFramePrompt: Cell.nullable().optional(),
  videoPrompt: Cell.nullable().optional(),
  color: RowColor.nullable().optional(),
})
export type ShotFields = z.infer<typeof ShotFields>

export const AssetFields = z.strictObject({
  name: z.string().trim().min(1).max(60).optional(),
  description: Cell.optional(),
  imageNodeId: Id.nullable().optional(),
})

export const Shot = z.object({
  id: Id,
  rev: Revision,
  source: ShotSource.nullable().optional(),
  durationSec: z.number().nullable().optional(),
  transition: ShotTransition,
  description: z.string(),
  endState: z.string().nullable().optional(),
  shotSize: z.string().nullable().optional(),
  camera: z.string().nullable().optional(),
  dialogue: z.string().nullable().optional(),
  sound: z.string().nullable().optional(),
  sceneId: Id.nullable().optional(),
  characterIds: z.array(Id),
  propIds: z.array(Id),
  framePrompt: z.string().nullable().optional(),
  endFramePrompt: z.string().nullable().optional(),
  videoPrompt: z.string().nullable().optional(),
  promptState: PromptState.nullable().optional(),
  color: RowColor.nullable().optional(),
})
export type Shot = z.infer<typeof Shot>

export const ScriptAsset = z.object({
  id: Id,
  rev: Revision,
  kind: ScriptAssetKind,
  name: z.string(),
  description: z.string(),
  imageNodeId: Id.nullable().optional(),
})
export type ScriptAsset = z.infer<typeof ScriptAsset>

export const ScriptDoc = z.object({
  version: z.literal(1),
  // Optional only for pre-0027 immutable history. Current documents always carry these fields.
  castIds: z.array(Id).max(SCRIPT_LIMITS.assets).optional(),
  styleId: Id.nullable().optional(),
  // Revision of document-level fields (style, sessionId)
  rev: Revision,
  style: z.string().nullable().optional(),
  // The session that owns this script; breakdown and prompt requests go there (0023 §4)
  sessionId: Id.nullable().optional(),
  shots: z.array(Shot),
  assets: z.array(ScriptAsset),
})
export type ScriptDoc = z.infer<typeof ScriptDoc>

export const EMPTY_SCRIPT: ScriptDoc = { version: 1, rev: 0, castIds: [], styleId: null, style: null, sessionId: null, shots: [], assets: [] }

const ShotInsert = ShotFields.extend({ description: Cell })
const AssetInsert = AssetFields.extend({ kind: ScriptAssetKind, name: z.string().trim().min(1).max(60) })

// Rows are addressed by id, or by tempId when created earlier in the same batch. update/delete carry the row's rev;
// a mismatch rejects the whole batch with revision_conflict (rows other users touch are unaffected).
export const ScriptOp = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('shot.insert'), tempId: TempId, afterShotId: Id.nullable(), shot: ShotInsert }),
  z.strictObject({ kind: z.literal('shot.update'), shotId: Id, rev: Revision, fields: ShotFields }),
  z.strictObject({ kind: z.literal('shot.move'), shotId: Id, afterShotId: Id.nullable() }),
  z.strictObject({ kind: z.literal('shot.delete'), shotId: Id, rev: Revision }),
  z.strictObject({ kind: z.literal('asset.insert'), tempId: TempId, asset: AssetInsert }),
  z.strictObject({ kind: z.literal('asset.update'), assetId: Id, rev: Revision, fields: AssetFields }),
  // Deleting an asset also removes it from shots that use it; those shots get a new rev
  z.strictObject({ kind: z.literal('asset.delete'), assetId: Id, rev: Revision }),
  z.strictObject({ kind: z.literal('doc.set'), rev: Revision, fields: z.strictObject({ castIds: z.array(Id).max(SCRIPT_LIMITS.assets).optional(), styleId: Id.nullable().optional(), style: Cell.nullable().optional(), sessionId: Id.nullable().optional() }) }),
])
export type ScriptOp = z.infer<typeof ScriptOp>

/** Whole-document input for script.replace: the server assigns ids and revs; references use the tempIds given here */
export const ScriptDocInput = z.strictObject({
  castIds: z.array(Id).max(SCRIPT_LIMITS.assets).optional(),
  styleId: Id.nullable().optional(),
  style: Cell.nullable().optional(),
  sessionId: Id.nullable().optional(),
  shots: z.array(ShotInsert.extend({ tempId: TempId })).max(SCRIPT_LIMITS.shots),
  assets: z.array(AssetInsert.extend({ tempId: TempId })).max(SCRIPT_LIMITS.assets).default([]),
})
export type ScriptDocInput = z.infer<typeof ScriptDocInput>

export const ShotRole = z.enum(['first', 'last', 'video'])
export type ShotRole = z.infer<typeof ShotRole>
/** On a generated node: which shot of which script it belongs to (0023 §2) */
export const ShotLink = z.strictObject({ scriptNodeId: Id, shotId: Id, role: z.union([ShotRole, z.literal('previz')]) })
export type ShotLink = z.infer<typeof ShotLink>

// Asset references inside script cells (0023 §1): store the asset id; the UI shows the current name
export const ASSET_REF_PATTERN = /\{\{asset:([^{}\s]{1,64})\}\}/g
export function assetRef(assetId: string): string {
  return `{{asset:${assetId}}}`
}
/** Asset ids referenced in a cell, in order of appearance, deduplicated */
export function assetRefs(text: string): string[] {
  return [...new Set(Array.from(text.matchAll(ASSET_REF_PATTERN), match => match[1]!))]
}

/** Shot fields whose change makes written prompts stale (0023 §3) */
export const PROMPT_SOURCE_FIELDS = ['transition', 'description', 'endState', 'shotSize', 'camera', 'sceneId', 'characterIds', 'propIds'] as const satisfies readonly (keyof ShotFields)[]
export const PROMPT_FIELDS = ['framePrompt', 'endFramePrompt', 'videoPrompt'] as const satisfies readonly (keyof ShotFields)[]
