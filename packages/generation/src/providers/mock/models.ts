import type { GenerationOperation } from '@vis/protocol'
import { z } from 'zod'
import type { OperationSpec } from '../types'

const scale = z.literal([2, 4]).default(2).meta({
  'x-vis-label': { zh: '放大倍率', en: 'Scale' },
  'x-vis-options': { 2: { zh: '2 倍', en: '2×' }, 4: { zh: '4 倍', en: '4×' } },
})

export const MOCK_OPERATION_SPECS = {
  'image.upscale': { paramsSchema: z.strictObject({ scale }), prompt: 'none' },
  'image.outpaint': {
    paramsSchema: z.strictObject({
      ratio: z.enum(['1:1', '4:3', '3:4', '16:9', '9:16']).default('16:9').meta({
        'x-vis-label': { zh: '画面比例', en: 'Aspect ratio' },
        'x-vis-description': { zh: '扩展后的画面比例', en: 'Aspect ratio after outpainting' },
      }),
    }),
    prompt: 'optional',
  },
  'image.matting': { paramsSchema: z.strictObject({}), prompt: 'none' },
  'image.multiview': {
    paramsSchema: z.strictObject({
      views: z.int().min(2).max(4).default(4).meta({ 'x-vis-label': { zh: '视角数量', en: 'Views' } }),
    }),
    prompt: 'none',
  },
  'video.upscale': { paramsSchema: z.strictObject({ scale }), prompt: 'none' },
  'video.removeSubtitles': { paramsSchema: z.strictObject({}), prompt: 'none' },
  'video.reshoot': {
    paramsSchema: z.strictObject({
      duration: z.int().min(1).max(10).default(5).describe('Reshoot duration in seconds, 1–10').meta({
        'x-vis-label': { zh: '时长', en: 'Duration' },
        'x-vis-description': { zh: '重拍秒数，1–10', en: 'Reshoot duration in seconds, 1–10' },
      }),
    }),
    prompt: 'required',
  },
} as const satisfies Record<Exclude<GenerationOperation, 'generate'>, OperationSpec>
