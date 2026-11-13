import { z } from 'zod'
import type { MediaKind } from '@vis/protocol'

export const arkImageParamsSchema = z.object({
  size: z.string().regex(/^(?:1\.5K|[1234]K|[1-9]\d{1,4}x[1-9]\d{1,4})$/).default('2K').describe('Image size: a model-supported resolution or width x height').meta({ 'x-vis-label': { zh: '尺寸', en: 'Size' }, 'x-vis-description': { zh: '图片尺寸：模型支持的分辨率或宽x高', en: 'Image size: a model-supported resolution or width x height' }, examples: ['1K', '2K', '4K'] }),
  n: z.int().min(1).max(4).default(1).describe('Maximum number of images to generate, 1–4').meta({ 'x-vis-label': { zh: '数量', en: 'Count' }, 'x-vis-description': { zh: '最多生成的图片数量，1–4', en: 'Maximum number of images to generate, 1–4' } }),
  watermark: z.boolean().default(false).describe('Whether to add a watermark').meta({ 'x-vis-label': { zh: '水印', en: 'Watermark' }, 'x-vis-description': { zh: '是否添加水印', en: 'Whether to add a watermark' } }),
})

export const arkVideoParamsSchema = z.object({
  n: z.literal(1).default(1).describe('Generate one video per request').meta({ 'x-vis-label': { zh: '数量', en: 'Count' }, 'x-vis-description': { zh: '每次生成一个视频', en: 'Generate one video per request' } }),
  ratio: z.enum(['16:9', '4:3', '1:1', '3:4', '9:16', '21:9', 'adaptive']).optional().describe('Video aspect ratio; leave empty to use the model default').meta({ 'x-vis-label': { zh: '画幅', en: 'Aspect ratio' }, 'x-vis-description': { zh: '视频宽高比，留空使用模型默认值', en: 'Video aspect ratio; leave empty to use the model default' }, 'x-vis-options': { adaptive: { zh: '自适应', en: 'Adaptive' } } }),
  resolution: z.enum(['480p', '720p', '1080p', '4k']).optional().describe('Video resolution; requires support from the selected model').meta({ 'x-vis-label': { zh: '分辨率', en: 'Resolution' }, 'x-vis-description': { zh: '视频分辨率，需所选模型支持', en: 'Video resolution; requires support from the selected model' } }),
  duration: z.union([z.literal(-1), z.int().min(2).max(30)]).optional().describe('Video duration in seconds; -1 lets the model decide. Requires support from the selected model').meta({ 'x-vis-label': { zh: '时长', en: 'Duration' }, 'x-vis-description': { zh: '视频秒数；-1 由模型决定，需所选模型支持', en: 'Video duration in seconds; -1 lets the model decide. Requires support from the selected model' } }),
  generateAudio: z.boolean().optional().describe('Generate synchronized audio; requires support from the selected model').meta({ 'x-vis-label': { zh: '生成音频', en: 'Generate audio' }, 'x-vis-description': { zh: '生成同步声音，需所选模型支持', en: 'Generate synchronized audio; requires support from the selected model' } }),
  seed: z.int().min(-1).max(2147483647).optional().describe('Random seed; -1 selects a random seed').meta({ 'x-vis-label': { zh: '随机种子', en: 'Seed' }, 'x-vis-description': { zh: '随机种子，-1 表示随机', en: 'Random seed; -1 selects a random seed' } }),
  cameraFixed: z.boolean().optional().describe('Fixed camera; requires support from the selected model').meta({ 'x-vis-label': { zh: '固定镜头', en: 'Fixed camera' }, 'x-vis-description': { zh: '固定镜头，需所选模型支持', en: 'Fixed camera; requires support from the selected model' } }),
  imageMode: z.enum(['auto', 'first_frame', 'first_last', 'reference']).default('auto').describe('auto: one image as the first frame, multiple images as references; first_frame: one first-frame image; first_last: first and last frames; reference: reference images').meta({ 'x-vis-label': { zh: '参考图片模式', en: 'Reference image mode' }, 'x-vis-description': { zh: 'auto：单图首帧、多图参考；first_frame：一图首帧；first_last：两图首尾帧；reference：参考图', en: 'auto: one image as the first frame, multiple images as references; first_frame: one first-frame image; first_last: first and last frames; reference: reference images' }, 'x-vis-options': { 'auto': { zh: '自动', en: 'Auto' }, 'first_frame': { zh: '首帧', en: 'First frame' }, 'first_last': { zh: '首尾帧', en: 'First and last frames' }, 'reference': { zh: '参考图', en: 'Reference images' } } }),
  watermark: z.boolean().default(false).describe('Whether to add a watermark').meta({ 'x-vis-label': { zh: '水印', en: 'Watermark' }, 'x-vis-description': { zh: '是否添加水印', en: 'Whether to add a watermark' } }),
  returnLastFrame: z.boolean().optional().meta({ 'x-vis-label': { zh: '返回尾帧', en: 'Return last frame' } }),
  executionExpiresAfter: z.int().min(3600).max(259200).optional().meta({ 'x-vis-label': { zh: '任务超时（秒）', en: 'Task timeout (seconds)' } }),
})

// Official documentation checked 2026-11-08:
// https://www.volcengine.com/docs/82379/1541523 (image output_format and optimize_prompt_options.mode)
// https://www.volcengine.com/docs/82379/1520757 (return_last_frame and execution_expires_after)
// Seedream 5.0 pro/flash adds 1.5K and caps at 2K; Seedance 2.0 does not document seed/camera_fixed.
// Unregistered models and ep- endpoints use generic ranges; model-specific image fields stay in registered schemas.
// Keys are model names without date suffixes, e.g. doubao-seedance-2-0-fast-260128 -> doubao-seedance-2-0-fast.
const seedance2 = (resolutions: readonly [string, ...string[]]) => arkVideoParamsSchema.omit({ seed: true, cameraFixed: true }).extend({
  generateAudio: arkVideoParamsSchema.shape.generateAudio.default(true),
  resolution: z.enum(resolutions).optional().describe(`Video resolution: ${resolutions.join(' / ')}`).meta({ 'x-vis-label': { zh: '分辨率', en: 'Resolution' }, 'x-vis-description': { zh: `视频分辨率：${resolutions.join(' / ')}`, en: `Video resolution: ${resolutions.join(' / ')}` } }),
  duration: z.int().min(4).max(15).optional().describe('Video duration in seconds, 4–15').meta({ 'x-vis-label': { zh: '时长', en: 'Duration' }, 'x-vis-description': { zh: '视频秒数，4–15', en: 'Video duration in seconds, 4–15' } }),
})
const singleImage = arkImageParamsSchema.extend({
  size: z.string().refine(value => {
    if (['1K', '1.5K', '2K'].includes(value)) return true
    if (!/^[1-9]\d{1,4}x[1-9]\d{1,4}$/.test(value)) return false
    const [width, height] = value.split('x').map(Number) as [number, number]
    return width * height >= 921600 && width * height <= 4624220 && width / height >= 1 / 16 && width / height <= 16
  }, 'Invalid Seedream 5.0 image dimensions').default('2K').describe('Seedream 5.0 pro/flash: 1K, 1.5K, 2K, or 921600–4624220 pixels at aspect ratio 1:16–16:1').meta({
    'x-vis-label': { zh: '尺寸', en: 'Size' },
    'x-vis-description': { zh: '1K、1.5K、2K 或自定义宽x高；总像素 921600–4624220，宽高比 1:16–16:1', en: '1K, 1.5K, 2K, or width x height; 921600–4624220 pixels, aspect ratio 1:16–16:1' },
    examples: ['1K', '1.5K', '2K'],
  }),
  outputFormat: z.enum(['png', 'jpeg']).optional().meta({ 'x-vis-label': { zh: '输出格式', en: 'Output format' } }),
  optimizePromptMode: z.enum(['standard', 'fast']).optional().meta({ 'x-vis-label': { zh: '提示词优化模式', en: 'Prompt optimization mode' }, 'x-vis-options': { standard: { zh: '标准', en: 'Standard' }, fast: { zh: '快速', en: 'Fast' } } }),
  n: z.literal(1).default(1).describe('This model generates one image per request').meta({ 'x-vis-label': { zh: '数量', en: 'Count' }, 'x-vis-description': { zh: '该模型每次只生成一张图片', en: 'This model generates one image per request' } }),
})
export const ARK_MODEL_PARAMS: Record<string, { kind: 'image' | 'video'; schema: z.ZodType<Record<string, unknown>> }> = {
  'doubao-seedance-2-0': { kind: 'video', schema: seedance2(['480p', '720p', '1080p', '4k']) },
  'doubao-seedance-2-0-fast': { kind: 'video', schema: seedance2(['480p', '720p']) },
  'doubao-seedance-2-0-mini': { kind: 'video', schema: seedance2(['480p', '720p']) },
  'doubao-seedance-2-5': { kind: 'video', schema: seedance2(['480p', '720p', '1080p']).extend({
    duration: z.union([z.literal(-1), z.int().min(4).max(30)]).optional().describe('Video duration in seconds, 4–30; -1 lets the model decide').meta({ 'x-vis-label': { zh: '时长', en: 'Duration' }, 'x-vis-description': { zh: '视频秒数，4–30；-1 由模型决定', en: 'Video duration in seconds, 4–30; -1 lets the model decide' } }),
  }) },
  // pro / flash do not support image groups (sequential_image_generation)
  'doubao-seedream-5-0-pro': { kind: 'image', schema: singleImage },
  'doubao-seedream-5-0-flash': { kind: 'image', schema: singleImage.extend({
    optimizePromptMode: z.literal('standard').optional().meta({ 'x-vis-label': { zh: '提示词优化模式', en: 'Prompt optimization mode' }, 'x-vis-options': { 'standard': { zh: '标准', en: 'Standard' } } }),
  }) },
}

export function arkParamsSchema(kind: MediaKind, model: string): z.ZodType<Record<string, unknown>> {
  if (kind === 'audio') return z.object({})
  const known = ARK_MODEL_PARAMS[model.replace(/-\d{6}$/, '')]
  if (known?.kind === kind) return known.schema
  return kind === 'image' ? arkImageParamsSchema : arkVideoParamsSchema
}
