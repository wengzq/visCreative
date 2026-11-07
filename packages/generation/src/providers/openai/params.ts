import { z } from 'zod'

export const OPENAI_MAX_INPUT_BYTES = 50_000_000
export const OPENAI_MAX_OUTPUT_BYTES = 50_000_000
export const OPENAI_REFERENCE_LIMIT = 4

// Docs checked 2026-11: https://developers.openai.com/api/docs/guides/image-generation
// Keep the four-image multipart example limit; the reference's 16-image limit describes JSON image references.
// Transparency on GPT Image 2 and resolutions above 2560x1440 are documented as preview/experimental.
export const OPENAI_MODELS = [
  'gpt-image-2.5-sunburst', 'gpt-image-2.5-sunburst-2026-09-08',
  'gpt-image-2.5-flare', 'gpt-image-2.5-flare-2026-09-08',
  'gpt-image-2', 'gpt-image-2-2026-04-21',
] as const

export const OPENAI_ENDPOINTS = [
  { id: 'generate', label: { zh: '图片生成', en: 'Image generation' }, path: '/images/generations' },
  { id: 'edit', label: { zh: '参考图生成', en: 'Generation with reference images' }, path: '/images/edits' },
] as const

function validSize(value: string) {
  if (value === 'auto') return true
  if (!/^[1-9]\d{2,3}x[1-9]\d{2,3}$/.test(value)) return false
  const [width, height] = value.split('x').map(Number) as [number, number]
  return width % 16 === 0 && height % 16 === 0 && Math.max(width, height) <= 3840 &&
    width / height >= 1 / 3 && width / height <= 3 &&
    width * height >= 655_360 && width * height <= 8_294_400
}

const base = z.object({
  size: z.string().refine(validSize, 'Invalid image dimensions').default('auto')
    .meta({ examples: ['auto', '1024x1024', '1536x1024', '1024x1536'] }),
  quality: z.enum(['low', 'medium', 'high', 'auto']).default('auto'),
  n: z.int().min(1).max(4).default(1),
  output_format: z.enum(['png', 'jpeg', 'webp']).default('png'),
  output_compression: z.int().min(0).max(100).optional(),
  background: z.enum(['transparent', 'opaque', 'auto']).default('auto'),
}).strict()

function constrain(schema: typeof base | ReturnType<typeof extended>) {
  return schema.superRefine((params, ctx) => {
    if (params.output_compression !== undefined && params.output_format === 'png') {
      ctx.addIssue({ code: 'custom', path: ['output_compression'], message: 'Compression requires JPEG or WebP output' })
    }
    if (params.background === 'transparent' && params.output_format === 'jpeg') {
      ctx.addIssue({ code: 'custom', path: ['background'], message: 'Transparency requires PNG or WebP output' })
    }
  })
}

function extended() { return base.extend({ quality: z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'auto']).default('auto') }) }
const standard = constrain(base)
const enhanced = constrain(extended())

export function openaiParamsSchema(model: string) {
  return /^gpt-image-2\.5-(?:sunburst|flare)(?:-2026-09-08)?$/.test(model) ? enhanced : standard
}
