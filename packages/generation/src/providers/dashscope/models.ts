import type { MediaKind } from '@vis/protocol'
import { z } from 'zod'
import { ProviderError } from '../types'

const seed = z.int().min(0).max(2147483647).optional()
const commonVideo = {
  duration: z.int().min(2).max(15).default(5),
  resolution: z.enum(['720P', '1080P']).default('1080P'),
  prompt_extend: z.boolean().default(true),
  watermark: z.boolean().default(false),
  negative_prompt: z.string().max(500).optional(),
  seed,
  n: z.literal(1).default(1),
}
const video = z.strictObject({ ...commonVideo, ratio: z.enum(['16:9', '9:16', '1:1', '4:3', '3:4']).default('16:9') })
const frames = z.strictObject(commonVideo)
const image = (pro: boolean) => z.strictObject({
  size: (pro ? z.enum(['1K', '2K', '4K']) : z.enum(['1K', '2K'])).default('2K'),
  n: z.int().min(1).max(4).default(1),
  watermark: z.boolean().default(false),
  seed,
})

// Official documentation checked 2026-11-04 (no authenticated calls):
// https://www.alibabacloud.com/help/en/model-studio/text-to-video-api-reference
// https://www.alibabacloud.com/help/en/model-studio/image-to-video-general-api-reference
// https://www.alibabacloud.com/help/en/model-studio/wan-video-to-video-api-reference
// https://www.alibabacloud.com/help/en/model-studio/wan-image-generation-and-editing-api-reference
// https://www.alibabacloud.com/help/en/model-studio/manage-asynchronous-tasks
// https://www.alibabacloud.com/help/en/model-studio/regions
// R2V allows 2–15 s with image references, 2–10 s with video references. This adapter accepts images only:
// the documented video/audio inputs require public URLs, whereas pinned assets are local files.
// Sequential image sets, custom sizes, video editing/continuation and voice references are not exposed.
export const DASHSCOPE_MODELS = [
  ...['wan2.7-t2v', 'wan2.7-t2v-2026-06-12'].map(id => ({ id, label: id, kind: 'video' as const, mode: 'text' as const, schema: video, references: 0 })),
  ...['wan2.7-i2v', 'wan2.7-i2v-2026-04-25'].map(id => ({ id, label: id, kind: 'video' as const, mode: 'frames' as const, schema: frames, references: 1 })),
  ...['wan2.7-r2v', 'wan2.7-r2v-2026-06-12'].map(id => ({ id, label: id, kind: 'video' as const, mode: 'reference' as const, schema: video, references: 5 })),
  ...['wan2.7-image', 'wan2.7-image-pro'].map(id => ({ id, label: id, kind: 'image' as const, mode: 'image' as const, schema: image(id.endsWith('-pro')), references: 9 })),
] as const

export function dashscopeModel(kind: MediaKind, id: string) {
  const model = DASHSCOPE_MODELS.find(model => model.kind === kind && model.id === id)
  if (!model) throw new ProviderError('rejected', 'DashScope model is not supported for this media type', 'generation.provider_input_unsupported')
  return model
}

export function dashscopeParamsSchema(kind: MediaKind, id: string): z.ZodType<Record<string, unknown>> {
  return DASHSCOPE_MODELS.find(model => model.kind === kind && model.id === id)?.schema ?? z.never()
}
