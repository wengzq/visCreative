import type { MediaKind } from '@vis/protocol'
import { z } from 'zod'
import { ProviderError } from '../types'

const imageMode = z.enum(['auto', 'first_frame', 'first_last', 'reference']).default('auto')
const video3 = z.strictObject({
  duration: z.int().min(3).max(15).default(5),
  aspect_ratio: z.enum(['16:9', '9:16', '1:1']).default('16:9'),
  resolution: z.enum(['720p', '1080p', '4k']).default('720p'),
  audio: z.enum(['native', 'off']).default('off'),
  // The current API documents true and accepts plain prompts; shot_type/multi_prompt belong to the legacy API.
  multi_shot: z.boolean().default(true),
  imageMode,
  n: z.literal(1).default(1),
})
const video4 = z.strictObject({
  duration: z.int().min(3).max(30).optional(),
  aspect_ratio: z.enum(['21:9', '16:9', '9:16', '1:1']).default('16:9'),
  resolution: z.enum(['720p', '1080p']).default('1080p'),
  imageMode,
  n: z.literal(1).default(1),
})
const image3 = z.strictObject({
  resolution: z.enum(['1k', '2k', '4k']).default('1k'),
  aspect_ratio: z.enum(['16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3', '21:9', 'auto']).default('auto'),
  n: z.int().min(1).max(4).default(1),
})

// Official docs checked 2026-11:
// https://kling.ai/document-api/api/video/3-0-omni/text-to-video (api-DMdB1qIu.js)
// https://kling.ai/document-api/api/video/3-0-omni/image-to-video (api-BY1CXeMH.js)
// https://kling.ai/document-api/api/video/3-0-omni/video-omni (api-Bbpu4g7H.js)
// https://kling.ai/document-api/api/video/4-0/text-to-video (api-CkPOmmnb.js)
// https://kling.ai/document-api/api/video/4-0/image-to-video (api-DzZlXDtw.js)
// https://kling.ai/document-api/api/video/4-0/video-omni (api-xzby8pT2.js)
// https://kling.ai/document-api/api/image/3-0-omni/image-omni (api-CUCmNDnV.js)
// Bundles are served under https://s15-kling.klingai.com/kos/s101/nlav112918/api-doc/assets/.
// Video IDs are the current path IDs; images still use the documented legacy model_name.
// 4.0 has native audio but documents no audio/multi_shot request controls: do not invent them.
// Duplicate external-id error codes, id length/charset limits and cross-region key portability remain undocumented.
// 1302/1303 are reconciled by the account-unique custom ID before allowing a retry.
export const KLING_MODELS = [
  { id: 'kling-3.0', label: 'Kling VIDEO 3.0', kind: 'video', schema: video3, references: 0, inputBytes: 50_000_000, promptLength: 3072 },
  { id: 'kling-3.0-omni', label: 'Kling VIDEO 3.0 Omni', kind: 'video', schema: video3, references: 7, inputBytes: 50_000_000, promptLength: 3072 },
  // A conservative 11,000-character cap also satisfies the documented mixed-language weighted limit.
  { id: 'kling-4.0', label: 'Kling VIDEO 4.0', kind: 'video', schema: video4, references: 10, inputBytes: 30_000_000, promptLength: 11000 },
  { id: 'kling-v3-omni', label: 'Kling IMAGE 3.0 Omni', kind: 'image', schema: image3, references: 10, inputBytes: 10_000_000, promptLength: 2500 },
] as const

export function klingModel(kind: MediaKind, model: string) {
  const entry = KLING_MODELS.find(entry => entry.kind === kind && entry.id === model)
  if (!entry) throw new ProviderError('rejected', 'Kling model is not supported for this media type', 'generation.kling_model_unsupported')
  return entry
}

export function klingParamsSchema(kind: MediaKind, model: string): z.ZodType<Record<string, unknown>> {
  // A user can configure an unknown ID. Keep catalog discovery readable while refusing unverified calls.
  return KLING_MODELS.find(entry => entry.kind === kind && entry.id === model)?.schema ?? z.never()
}
