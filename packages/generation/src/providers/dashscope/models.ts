import type { MediaKind } from '@vis/protocol'
import { z } from 'zod'
import { ProviderError } from '../types'

const seed = z.int().min(0).max(2147483647).optional().meta({ 'x-vis-label': { zh: '随机种子', en: 'Seed' } })
const commonVideo = {
  duration: z.int().min(2).max(15).default(5).meta({ 'x-vis-label': { zh: '时长', en: 'Duration' } }),
  resolution: z.enum(['720P', '1080P']).default('1080P').meta({ 'x-vis-label': { zh: '分辨率', en: 'Resolution' } }),
  prompt_extend: z.boolean().default(true).meta({ 'x-vis-label': { zh: '扩展提示词', en: 'Extend prompt' } }),
  watermark: z.boolean().default(false).meta({ 'x-vis-label': { zh: '水印', en: 'Watermark' } }),
  negative_prompt: z.string().max(500).optional().meta({ 'x-vis-label': { zh: '反向提示词', en: 'Negative prompt' } }),
  seed,
  n: z.literal(1).default(1).meta({ 'x-vis-label': { zh: '数量', en: 'Count' } }),
}
const video = z.strictObject({
  ...commonVideo,
  ratio: z.enum(['16:9', '9:16', '1:1', '4:3', '3:4']).default('16:9').meta({ 'x-vis-label': { zh: '画幅', en: 'Aspect ratio' } }),
})
const frames = z.strictObject(commonVideo)
// Wan3.0 takes text, frames or references in one model. Duration -1 (model picks) is left out so the billed length stays known.
const wan3 = z.strictObject({
  duration: z.int().min(2).max(30).default(5).meta({ 'x-vis-label': { zh: '时长', en: 'Duration' } }),
  resolution: z.enum(['480P', '720P', '1080P']).default('1080P').meta({ 'x-vis-label': { zh: '分辨率', en: 'Resolution' } }),
  ratio: z.enum(['adaptive', '21:9', '16:9', '4:3', '1:1', '3:4', '9:16']).default('adaptive').meta({ 'x-vis-label': { zh: '画幅', en: 'Aspect ratio' }, 'x-vis-options': { adaptive: { zh: '自适应', en: 'Adaptive' } } }),
  audio: z.boolean().default(true).meta({ 'x-vis-label': { zh: '生成音频', en: 'Generate audio' } }),
  prompt_extend: z.boolean().default(true).meta({ 'x-vis-label': { zh: '扩展提示词', en: 'Extend prompt' } }),
  watermark: z.boolean().default(false).meta({ 'x-vis-label': { zh: '水印', en: 'Watermark' } }),
  seed: z.int().min(-1).max(2147483647).optional().meta({ 'x-vis-label': { zh: '随机种子', en: 'Seed' } }),
  n: z.literal(1).default(1).meta({ 'x-vis-label': { zh: '数量', en: 'Count' } }),
})
const image = (pro: boolean) => z.strictObject({
  size: z.string().refine(value => {
    if ((pro ? ['1K', '2K', '4K'] : ['1K', '2K']).includes(value)) return true
    if (!/^[1-9]\d{1,4}\*[1-9]\d{1,4}$/.test(value)) return false
    const [width, height] = value.split('*').map(Number) as [number, number]
    return width * height >= 768 * 768 && width * height <= (pro ? 4096 : 2048) ** 2 && width / height >= 1 / 8 && width / height <= 8
  }, 'Invalid Wan image dimensions').default('2K').describe('Image resolution or width*height; custom sizes must meet the model pixel and aspect-ratio limits').meta({
    'x-vis-label': { zh: '尺寸', en: 'Size' },
    'x-vis-description': { zh: '分辨率档位或宽*高；自定义尺寸须满足模型的总像素与宽高比限制', en: 'Resolution or width*height; custom sizes must meet the model pixel and aspect-ratio limits' },
    examples: pro ? ['1K', '2K', '4K'] : ['1K', '2K'],
  }),
  n: z.int().min(1).max(4).default(1).meta({ 'x-vis-label': { zh: '数量', en: 'Count' } }),
  watermark: z.boolean().default(false).meta({ 'x-vis-label': { zh: '水印', en: 'Watermark' } }),
  seed,
  thinking_mode: z.boolean().default(true).meta({ 'x-vis-label': { zh: '思考模式', en: 'Thinking mode' } }),
})

// Official documentation checked 2026-11-04 (no authenticated calls):
// https://www.alibabacloud.com/help/en/model-studio/text-to-video-api-reference
// https://www.alibabacloud.com/help/en/model-studio/image-to-video-general-api-reference
// https://www.alibabacloud.com/help/en/model-studio/wan-video-to-video-api-reference
// https://www.alibabacloud.com/help/en/model-studio/wan-image-generation-and-editing-api-reference
// Rechecked 2026-11-08: expose image thinking_mode with its true default (effective for text-only, non-sequential output).
// Wan3.0 also accepts seed=-1. Custom image dimensions use width*height, 1:8–8:1, and 768²–2048² pixels (4096² for pro text-only).
// Sequential sets and color_palette remain out: unknown count and object arrays.
// https://www.alibabacloud.com/help/en/model-studio/manage-asynchronous-tasks
// https://www.alibabacloud.com/help/en/model-studio/regions
// R2V outputs allow 2–15 s with image references, 2–10 s with video references; input clips allow 1–30 s. This adapter accepts images only:
// the documented video/audio inputs require public URLs, whereas pinned assets are local files.
// Sequential image sets, custom sizes, video editing/continuation and voice references are not exposed.
// Wan3.0, checked 2026-11-08 (no authenticated calls):
// https://www.alibabacloud.com/help/en/model-studio/wan3-video-generation-api-reference
// Served only from workspace hosts ({WorkspaceId}.<region>.maas.aliyuncs.com), entered as a custom URL.
// Frames and references cannot be mixed; up to 10 reference images. Video, audio, file and link inputs are not exposed.
export const DASHSCOPE_MODELS = [
  ...['wan2.7-t2v', 'wan2.7-t2v-2026-06-12'].map(id => ({ id, label: id, kind: 'video' as const, mode: 'text' as const, schema: video, references: 0 })),
  ...['wan2.7-i2v', 'wan2.7-i2v-2026-04-25'].map(id => ({ id, label: id, kind: 'video' as const, mode: 'frames' as const, schema: frames, references: 1 })),
  ...['wan2.7-r2v', 'wan2.7-r2v-2026-06-12'].map(id => ({ id, label: id, kind: 'video' as const, mode: 'reference' as const, schema: video, references: 5 })),
  ...['wan3.0-video', 'wan3.0-video-prime'].map(id => ({ id, label: id, kind: 'video' as const, mode: 'unified' as const, schema: wan3, references: 10 })),
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
