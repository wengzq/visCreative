import { z } from 'zod'
import type { MediaKind } from '@vis/protocol'

// Official documentation checked 2026-11-04:
// https://ai.google.dev/gemini-api/docs/image-generation
// https://ai.google.dev/gemini-api/docs/models/gemini-nano-banana-2.1
// https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-lite-image
// https://ai.google.dev/gemini-api/docs/omni
// https://ai.google.dev/api/generate-content
// https://ai.google.dev/api/interactions-api
// https://ai.google.dev/gemini-api/docs/background-execution
// Background execution is documented generally, but no image-specific guarantee was found.
// Keep images on the supported generateContent API and stage synchronous results.
// Reference counts are conservative adapter limits; Lite accepts only one.
// Lite is fixed at 1K; omit its resolution control rather than sending unsupported 2K/4K.
const aspectRatio = z.enum(['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9']).optional()
const image = z.strictObject({ aspect_ratio: aspectRatio, image_size: z.enum(['1K', '2K', '4K']).optional() })
const legacyImage = z.strictObject({ aspect_ratio: aspectRatio })
const video = z.strictObject({
  aspect_ratio: z.enum(['16:9', '9:16']).default('16:9'),
  resolution: z.enum(['360p', '720p', '1080p', '4k']).default('720p'),
})

export const GEMINI_MODELS = [
  { id: 'gemini-nano-banana-2.1', label: 'Nano Banana 2.1', kind: 'image', schema: image, references: 3 },
  { id: 'gemini-3.1-flash-lite-image', label: 'Nano Banana 2 Lite', kind: 'image', schema: legacyImage, references: 1 },
  { id: 'gemini-3.1-flash-image', label: 'Nano Banana 2', kind: 'image', schema: image, references: 3 },
  { id: 'gemini-3-pro-image', label: 'Nano Banana Pro', kind: 'image', schema: image, references: 3 },
  { id: 'gemini-2.5-flash-image', label: 'Nano Banana', kind: 'image', schema: legacyImage, references: 3 },
  { id: 'gemini-omni-1.1-flash', label: 'Gemini Omni 1.1 Flash', kind: 'video', schema: video, references: 3 },
] as const

export const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta'
export const GEMINI_ENDPOINTS = [
  { id: 'image', label: { zh: '图片生成', en: 'Image generation' }, path: '/models/{model}:generateContent' },
  { id: 'video', label: { zh: '视频生成', en: 'Video generation' }, path: '/interactions' },
  { id: 'task', label: { zh: '任务查询', en: 'Task query' }, path: '/interactions/{id}', requiredFor: ['video'] },
  { id: 'cancel', label: { zh: '任务取消', en: 'Task cancellation' }, path: '/interactions/{id}/cancel' },
  { id: 'file', label: { zh: '文件状态', en: 'File status' }, path: '/files/{id}', requiredFor: ['video'] },
  { id: 'fileDownload', label: { zh: '文件下载', en: 'File download' }, path: '/files/{id}:download', requiredFor: ['video'] },
] as const
export const GEMINI_MAX_INPUT_BYTES = 10 * 1024 * 1024
export const GEMINI_MAX_IMAGE_BYTES = 50 * 1024 * 1024
export const GEMINI_MAX_VIDEO_BYTES = 256 * 1024 * 1024

export function geminiModel(kind: MediaKind, model: string) {
  return GEMINI_MODELS.find(entry => entry.kind === kind && entry.id === model)
}

export function geminiParamsSchema(kind: MediaKind, model: string): z.ZodType<Record<string, unknown>> {
  return geminiModel(kind, model)?.schema ?? z.never()
}
