import { z } from 'zod'
import { Id, RequestId, Revision } from './common'
import { PrevizSceneRef } from './scene'
import { SCRIPT_LIMITS } from './script'

export const PREVIZ_LIMITS = { panels: SCRIPT_LIMITS.shots, note: SCRIPT_LIMITS.cell, durationSec: 3600 } as const
export const PrevizAspectRatio = z.enum(['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'])
export type PrevizAspectRatio = z.infer<typeof PrevizAspectRatio>

export const PrevizPanel = z.strictObject({
  id: Id,
  rev: Revision,
  underlay: Id.nullable(),
  sketch: Id.nullable(),
  image: Id.nullable(),
  note: z.string().max(PREVIZ_LIMITS.note),
  durationSec: z.number().positive().max(PREVIZ_LIMITS.durationSec).nullable(),
  shot: z.strictObject({ scriptNodeId: Id, shotId: Id }).nullable(),
  use: z.enum(['composition', 'frame']),
  frameRole: z.enum(['first', 'last']).nullable(),
  blockout: Id.nullable(),
  // 0037: optional so documents written before scene nodes stay valid.
  sceneRef: PrevizSceneRef.nullable().optional(),
})
export type PrevizPanel = z.infer<typeof PrevizPanel>

export const PrevizDoc = z.strictObject({
  version: z.literal(1),
  rev: Revision,
  aspectRatio: PrevizAspectRatio,
  panels: z.array(PrevizPanel).max(PREVIZ_LIMITS.panels),
}).superRefine((doc, ctx) => {
  const ids = new Set<string>()
  doc.panels.forEach((panel, index) => {
    if (ids.has(panel.id)) ctx.addIssue({ code: 'custom', path: ['panels', index, 'id'], message: 'Panel IDs must be unique' })
    ids.add(panel.id)
  })
})
export type PrevizDoc = z.infer<typeof PrevizDoc>

export const EMPTY_PREVIZ: PrevizDoc = { version: 1, rev: 0, aspectRatio: '16:9', panels: [] }
export function emptyPrevizPanel(id: string): PrevizPanel {
  return { id, rev: 0, underlay: null, sketch: null, image: null, note: '', durationSec: null, shot: null, use: 'composition', frameRole: null, blockout: null }
}

export const previz = {
  extractBlockout: {
    // fillDurations is the author's confirmed even split, valid only when no panel has a duration.
    params: z.strictObject({ requestId: RequestId, slotId: Id, expectedRevision: Revision, assetVersionId: Id, fillDurations: z.boolean().optional() }),
    result: z.object({
      revision: Revision,
      frames: z.array(z.object({ panelId: Id, atMs: z.int().nonnegative(), assetVersionId: Id })).max(PREVIZ_LIMITS.panels),
    }),
  },
} as const
