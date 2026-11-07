import type { MediaKind } from '@vis/protocol'
import { z } from 'zod'

export const MINIMAX_MAX_OUTPUT_BYTES = 256 * 1024 * 1024
export const MINIMAX_IMAGE_MAX_OUTPUT_BYTES = 50_000_000
// The current image reference does not publish a latency SLA. Leave ample time for synchronous generation.
export const MINIMAX_IMAGE_TIMEOUT_MS = 300_000
const ratio = z.enum(['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'])
const imageMode = z.enum(['auto', 'first_frame', 'first_last', 'reference']).default('auto')
const video = (model: string) => z.strictObject({
  duration: z.int().min(model === 'MiniMax-H3-Max' ? 5 : 4).max(15).default(5),
  resolution: model === 'MiniMax-H3' ? z.enum(['768P', '2K']).default('768P') : z.enum(['480P', '768P']).default('768P'),
  ratio: ratio.default('16:9'),
  imageMode,
  n: z.literal(1).default(1),
  ...(model === 'MiniMax-H3-Max' ? { prompt_expansion_mode: z.enum(['disabled', 'balanced', 'quality']).optional() } : {}),
})
const dimension = z.int().min(512).max(2048).multipleOf(8)
const image = z.strictObject({
  aspect_ratio: z.enum(['1:1', '16:9', '4:3', '3:2', '2:3', '3:4', '9:16', '21:9']).optional(),
  width: dimension.optional(), height: dimension.optional(),
  n: z.int().min(1).max(9).default(1),
  seed: z.int().optional(),
  prompt_optimizer: z.boolean().default(false),
}).superRefine((params, ctx) => {
  if ((params.width === undefined) !== (params.height === undefined)) ctx.addIssue({ code: 'custom', message: 'Width and height must be provided together' })
  if (params.aspect_ratio !== undefined && params.width !== undefined) ctx.addIssue({ code: 'custom', message: 'Choose dimensions or an aspect ratio' })
})

// Official documentation checked 2026-11-04:
// https://platform.minimax.cn/docs/api-reference/video-generation-v2-create.md (China host: api.minimax.cn)
// https://platform.minimax.io/docs/api-reference/video-generation-v2-create.md
// https://platform.minimax.io/docs/api-reference/video-generation-v2-query.md (refresh expired output URLs)
// https://platform.minimax.io/docs/api-reference/video-generation-v2-list.md (no client task ID filter)
// https://platform.minimax.io/docs/api-reference/video-generation-v2-delete.md (unsafe cancel/delete race)
// https://platform.minimax.io/docs/api-reference/image-generation-t2i.md
// https://platform.minimax.io/docs/api-reference/image-generation-i2i.md
// https://platform.minimax.io/docs/guides/image-generation.md (one character reference)
// https://platform.minimax.io/docs/api-reference/errorcode.md
// Expose image references and frames in this wave; video/audio references and HEIF inputs are not exposed.
export const MINIMAX_MODELS = [
  ...['MiniMax-H3', 'MiniMax-H3-Highspeed', 'MiniMax-H3-Lite', 'MiniMax-H3-Max'].map(id => ({ id, label: id, kind: 'video' as const, schema: video(id), references: 9, promptLength: 7000 })),
  { id: 'image-01', label: 'MiniMax Image 01', kind: 'image' as const, schema: image, references: 1, promptLength: 1500 },
]

export function minimaxParamsSchema(kind: MediaKind, model: string): z.ZodType<Record<string, unknown>> {
  return MINIMAX_MODELS.find(entry => entry.kind === kind && entry.id === model)?.schema ?? z.never()
}
