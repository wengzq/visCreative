import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createFfmpegMedia, type MediaTools } from '@vis/assets'
import type { MediaKind, ReferenceInputs } from '@vis/protocol'
import { z } from 'zod'
import { MAX_PRESIGN_SECONDS, ProviderError } from '../types'
import type { HostedInputs, ProviderAdapter, ProviderInput, ProviderInputMetadata, ProviderRequest } from '../types'
import { replaceRecord } from './persistence'
import { boundedBody } from '../download'
import { containsKey, isObject, outputUrl as validatedOutputUrl, providerPaths, redact } from '../http'
import { arkImageParamsSchema, arkParamsSchema, arkVideoParamsSchema } from './models'

export { arkImageParamsSchema, arkParamsSchema, arkVideoParamsSchema } from './models'

export const ARK_MAX_PROMPT_LENGTH = 3000
export const ARK_MAX_INPUT_BYTES = 10 * 1024 * 1024
export const ARK_MAX_OUTPUT_BYTES = 256 * 1024 * 1024
const ARK_MAX_AUDIO_BYTES = 15_000_000
const ARK_MAX_REQUEST_BYTES = 64_000_000

export const ARK_ENDPOINTS = [
  { id: 'image', label: { zh: '图片生成', en: 'Image generation' }, path: '/images/generations' },
  { id: 'task', label: { zh: '视频和音频提交', en: 'Video and audio submission' }, path: '/contents/generations/tasks' },
  { id: 'taskQuery', label: { zh: '任务查询和取消', en: 'Task query and cancellation' }, path: '/contents/generations/tasks/{id}', requiredFor: ['video', 'audio'] },
] as const

export type ArkProviderOptions = {
  id: string
  dataDir: string
  baseUrl: string
  imageModels: readonly { id: string; label: string }[]
  videoModels: readonly { id: string; label: string }[]
  audioModels?: readonly { id: string; label: string }[]
  endpoints?: Record<string, string> | undefined
  getKey: () => Promise<string | undefined>
  hosted?: HostedInputs
  media?: Pick<MediaTools, 'probe'>
  timeoutMs?: number
  fetch?: typeof globalThis.fetch
}

const imageOutputSchema = z.object({
  outputIndex: z.int().nonnegative(),
  url: z.string().min(1),
  size: z.string().optional(),
})
const recordSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('submitting'), referenceVideos: z.boolean().optional(), released: z.boolean().optional() }),
  z.object({ state: z.literal('image'), externalTaskId: z.string(), outputs: z.array(imageOutputSchema).min(1) }),
  z.object({ state: z.literal('video'), externalTaskId: z.string(), referenceVideos: z.boolean().optional(), released: z.boolean().optional() }),
  z.object({ state: z.literal('failed'), externalTaskId: z.string(), error: z.object({ code: z.string(), message: z.string() }) }),
])
type TaskRecord = z.infer<typeof recordSchema>
type SubmittedRecord = Exclude<TaskRecord, { state: 'submitting' }>

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Operation aborted', 'AbortError')
}

// Public query fields are not secrets; only signing material and host-known values need redaction.
function safeVendorText(value: string, key: string, secrets: readonly string[] = [], hosted?: HostedInputs): string {
  let safe = key ? redact(value, key) : value
  if (hosted) safe = hosted.redact(safe)
  for (const secret of secrets) if (secret) safe = safe.split(secret).join('[REDACTED]').split(encodeURIComponent(secret)).join('[REDACTED]')
  let decoded = safe
  try { decoded = decodeURIComponent(safe) } catch { /* Literal query markers still identify malformed signed URLs. */ }
  if (/\bx-tos-(?:signature|credential)=/i.test(decoded)) return 'Ark response contained sensitive URL information'
  return safe
}

function sensitiveResult(value: string, key: string, secrets: readonly string[] = [], hosted?: HostedInputs): boolean {
  return safeVendorText(value, key, secrets, hosted) !== value
}

function vendorError(value: unknown, key: string, fallbackCode: string, fallbackMessage: string, secrets: readonly string[] = [], hosted?: HostedInputs): { code: string; message: string } {
  return {
    code: safeVendorText(isObject(value) && typeof value.code === 'string' ? value.code : fallbackCode, key, secrets, hosted).slice(0, 200),
    message: safeVendorText(isObject(value) && typeof value.message === 'string' ? value.message : fallbackMessage, key, secrets, hosted).slice(0, 2000),
  }
}

class RateLimitedCreate extends ProviderError {}

function outputUrl(value: string): string {
  return validatedOutputUrl(value, 'Ark returned an invalid output URL')
}

function referenceLimitsFor(kind: MediaKind, model: string): ReferenceInputs {
  if (kind !== 'video') return { image: kind === 'image' ? 10 : 0 }
  const name = model.replace(/-\d{6}$/, '')
  const latest = name === 'doubao-seedance-2-5'
  if (!latest && !/^doubao-seedance-2-0(?:-fast|-mini)?$/.test(name)) return { image: 9 }
  const timed = { max: latest ? 10 : 3, minMs: 2000, maxMs: latest ? 30000 : 15000, totalMs: latest ? 30000 : 15000 }
  return { image: latest ? 30 : 9, video: { ...timed, requiresHosting: true }, audio: { ...timed }, ...(latest ? { total: 50 } : {}) }
}

function invalidInputs(message: string): never {
  throw new ProviderError('rejected', message, 'generation.invalid_params', { detail: message })
}

function validateArkInputs(kind: MediaKind, model: string, inputs: ProviderInputMetadata[], params: Record<string, unknown>, hosted?: HostedInputs): void {
  if (inputs.some(input => input.frameRole) && inputs.some(input => !input.frameRole)) throw new ProviderError('rejected', 'Ark frame inputs cannot be combined with media reference inputs', 'generation.frames_reference_mix')
  if (inputs.some(input => input.mime === 'image/svg+xml')) throw new ProviderError('rejected', 'SVG cannot be used as an Ark reference image; export it as PNG first', 'generation.svg_reference_unsupported')
  if (kind === 'audio') throw new ProviderError('rejected', 'The selected model does not yet support audio generation; use Mock music or Mock sound effects', 'generation.audio_generation_unsupported')
  const limits = referenceLimitsFor(kind, model)
  const references = inputs.filter(input => !input.frameRole)
  const video = references.filter(input => input.kind === 'video')
  const audio = references.filter(input => input.kind === 'audio')
  if (limits.total !== undefined && references.length > limits.total) invalidInputs(`Ark reference inputs allow at most ${limits.total} items`)
  if (references.filter(input => input.kind === 'image').length > limits.image) invalidInputs(`Ark reference images allow at most ${limits.image} images`)
  if (video.length && !limits.video) invalidInputs('The selected model does not support video references')
  if (video.length && limits.video?.requiresHosting && !hosted?.configured) throw new ProviderError('rejected', 'Configure Media hosting before using video references', 'generation.video_reference_hosting_required')
  if ((audio.length || video.length) && (params.imageMode === 'first_frame' || params.imageMode === 'first_last')) throw new ProviderError('rejected', 'Ark references cannot be combined with first-frame or first-and-last-frame modes', 'generation.frames_reference_mix')
  for (const [media, items] of [['video', video], ['audio', audio]] as const) {
    if (!items.length) continue
    const timed = limits[media]
    if (!timed) throw new ProviderError('rejected', 'The selected model does not yet support audio references', 'generation.audio_reference_unsupported')
    if (items.length > timed.max) throw new ProviderError('rejected', `${media === 'video' ? 'Video' : 'Audio'} references allow at most ${timed.max} clips`, `generation.${media}_reference_count`, { max: timed.max })
    if (items.some(input => input.durationMs !== undefined && (!Number.isFinite(input.durationMs) || input.durationMs < timed.minMs || input.durationMs > timed.maxMs))) {
      throw new ProviderError('rejected', `Each ${media} reference must be ${timed.minMs / 1000}-${timed.maxMs / 1000} seconds long`, `generation.${media}_reference_duration`, { minMs: timed.minMs, maxMs: timed.maxMs })
    }
    if (items.reduce((total, input) => total + (input.durationMs ?? 0), 0) > timed.totalMs) throw new ProviderError('rejected', `${media === 'video' ? 'Video' : 'Audio'} reference total duration cannot exceed ${timed.totalMs / 1000} seconds`, `generation.${media}_reference_total_duration`, { totalMs: timed.totalMs })
  }
  if (audio.some(input => !['audio/wav', 'audio/mpeg'].includes(input.mime))) throw new ProviderError('rejected', 'Audio references only support WAV or MP3', 'generation.audio_reference_format')
  if (audio.length && !model.replace(/-\d{6}$/, '').endsWith('2-5') && !references.some(input => input.kind === 'image' || input.kind === 'video')) throw new ProviderError('rejected', 'Audio references also require at least one reference image or video', 'generation.audio_reference_image_required')
  if (video.some(input => !['video/mp4', 'video/quicktime'].includes(input.mime))) throw new ProviderError('rejected', 'Video references only support MP4 or MOV', 'generation.video_reference_format')
  if (video.some(input => input.bytes !== undefined && (!Number.isFinite(input.bytes) || input.bytes < 0 || input.bytes > 200_000_000))) throw new ProviderError('rejected', 'Each video reference size cannot exceed 200 MB', 'generation.video_reference_size', { maxBytes: 200_000_000 })
  if (video.some(input => input.fps !== undefined && (!Number.isFinite(input.fps) || input.fps < 24 || input.fps > 60))) throw new ProviderError('rejected', 'Video references require 24-60 fps', 'generation.video_reference_fps', { minFps: 24, maxFps: 60 })
  if (video.some(input => {
    if (input.width === undefined || input.height === undefined) return false
    const aspect = input.width / input.height
    const pixels = input.width * input.height
    return !Number.isFinite(aspect) || !Number.isFinite(pixels) || input.width <= 0 || input.height <= 0 || aspect < 0.4 || aspect > 2.5 || pixels < 407696 || pixels > 8295044
  })) throw new ProviderError('rejected', 'Video reference aspect ratio or pixel count is outside the supported range', 'generation.video_reference_dimensions', { minAspect: 0.4, maxAspect: 2.5, minPixels: 407696, maxPixels: 8295044 })
}

/** Persist synchronous image results and video job IDs first; unknown submissions are queried, never regenerated. */
export function createArkProvider(opts: ArkProviderOptions): ProviderAdapter {
  const dir = join(opts.dataDir, 'ark')
  const baseUrl = opts.baseUrl.replace(/\/+$/, '')
  const endpoint = providerPaths(ARK_ENDPOINTS, opts.endpoints, 'Ark endpoint paths are invalid')
  const fetcher = opts.fetch ?? globalThis.fetch
  const media = opts.media ?? createFfmpegMedia()
  const timeoutMs = opts.timeoutMs ?? 120_000
  const inflight = new Map<string, Promise<{ externalTaskId: string }>>()
  const imagePrefix = 'ark-image:'

  function validateInputs(kind: MediaKind, model: string, inputs: ProviderInputMetadata[], params: Record<string, unknown>): void {
    validateArkInputs(kind, model, inputs, params, opts.hosted)
  }

  function fileOf(key: string): string {
    let encoded: string
    try { encoded = encodeURIComponent(key) } catch { throw new ProviderError('rejected', 'Invalid idempotency key') }
    if (!encoded || encoded.length > 200) throw new ProviderError('rejected', 'Invalid idempotency key')
    return join(dir, `${encoded}.json`)
  }

  async function readRecord(key: string): Promise<TaskRecord | null> {
    try {
      return recordSchema.parse(JSON.parse(await readFile(fileOf(key), 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw new ProviderError('timeout', 'Ark submission record cannot be confirmed; not resubmitted')
    }
  }

  function submitted(record: TaskRecord): { externalTaskId: string } {
    if (record.state === 'submitting') throw new ProviderError('timeout', 'Ark submission result is unknown; not resubmitted')
    return { externalTaskId: record.externalTaskId }
  }

  async function saveRecord(key: string, record: TaskRecord): Promise<void> {
    const temp = `${fileOf(key)}.${randomUUID()}.tmp`
    try {
      await writeFile(temp, JSON.stringify(record), { mode: 0o600, flush: true })
      await replaceRecord(temp, fileOf(key))
    } catch {
      throw new ProviderError('timeout', 'Ark responded but saving the submission record failed; not resubmitted')
    } finally {
      await rm(temp, { force: true }).catch(() => {})
    }
  }

  async function apiKey(): Promise<string> {
    let key: string | undefined
    try { key = await opts.getKey() } catch { throw new ProviderError('rejected', 'Cannot read Ark API Key') }
    if (!key?.trim() || /[\r\n]/.test(key)) throw new ProviderError('rejected', 'Configure Ark API Key first')
    return key.trim()
  }

  async function api(path: string, method: 'GET' | 'POST' | 'DELETE', key: string, body: unknown, signal?: AbortSignal, secrets: readonly string[] = []): Promise<Record<string, unknown>> {
    const requestSignal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])])
    let response: Response
    let result: unknown
    try {
      response = await fetcher(`${baseUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: requestSignal,
        redirect: 'error',
      })
      result = await response.json().catch(() => undefined)
    } catch {
      if (method !== 'POST') checkAbort(signal)
      throw new ProviderError(method === 'POST' ? 'timeout' : 'transient', method === 'POST' ? 'Ark submission result is unknown; not resubmitted' : 'Ark query temporarily failed')
    }
    if (!response.ok) {
      const error = vendorError(isObject(result) ? result.error : undefined, key, `HTTP_${response.status}`, `Ark request failed (HTTP ${response.status})`, secrets, opts.hosted)
      const message = `${error.code}: ${error.message}`
      if (method === 'GET' && response.status === 404) throw new ProviderError('not_found', message)
      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        throw new ProviderError('rejected', message, /moderation|sensitive|content.?filter|risk/i.test(error.code) ? 'generation.moderation_rejected' : undefined)
      }
      // Treat only known rate-limit codes as explicit rejection; 5xx requests may already have executed.
      const definiteReject = isObject(result) && isObject(result.error) && !result.id && !result.data && typeof result.error.code === 'string' &&
        response.status === 429 && /^(?:RateLimitExceeded(?:\.|$)|\w*RateLimitExceeded$|ServerOverloaded$|RequestBurstTooFast$|InflightBatchsizeExceeded$|QuotaExceeded(?:\.|$)|AccountQuotaExceeded$|SetLimitExceeded$)/.test(result.error.code)
      if (method === 'POST' && definiteReject) throw new RateLimitedCreate('transient', message)
      throw new ProviderError(method !== 'POST' ? 'transient' : 'timeout', message)
    }
    if (!isObject(result)) throw new ProviderError(method === 'POST' ? 'timeout' : 'transient', 'Ark response format cannot be confirmed')
    return result
  }

  function prepareRequest(req: ProviderRequest): ProviderRequest {
    const texts = req.inputs.filter((input): input is Extract<ProviderInput, { type: 'text' }> => input.type === 'text')
      .filter(input => input.text.trim() && input.text !== req.prompt).map(input => `参考：\n${input.text}`)
    const prompt = [req.prompt, ...texts].filter(Boolean).join('\n\n')
    return { ...req, prompt: Array.from(prompt).slice(0, ARK_MAX_PROMPT_LENGTH).join('').trimEnd(), inputs: req.inputs.filter(input => input.type === 'asset') }
  }

  async function inputImages(inputs: ProviderInput[], signal?: AbortSignal): Promise<string[]> {
    const images: string[] = []
    let bytes = 0
    for (const input of inputs) {
      if (input.type !== 'asset') continue
      if (input.kind === 'audio' || input.kind === 'video') continue
      if (input.kind !== 'image' || !/^image\/(?:png|jpeg|webp|gif|bmp|tiff)$/.test(input.mime)) {
        throw new ProviderError('rejected', 'Ark reference images require PNG, JPEG, WebP, GIF, BMP or TIFF')
      }
      try {
        const info = await stat(input.path)
        if (!info.isFile() || bytes + info.size > ARK_MAX_INPUT_BYTES) throw new ProviderError('rejected', 'Total Ark input image size cannot exceed 10 MiB')
        const data = await readFile(input.path, signal ? { signal } : {})
        bytes += data.length
        if (bytes > ARK_MAX_INPUT_BYTES) throw new ProviderError('rejected', 'Total Ark input image size cannot exceed 10 MiB')
        images.push(`data:${input.mime};base64,${data.toString('base64')}`)
      } catch (error) {
        checkAbort(signal)
        if (error instanceof ProviderError) throw error
        throw new ProviderError('rejected', 'Cannot read Ark input image')
      }
    }
    return images
  }

  async function inputAudio(req: ProviderRequest, signal?: AbortSignal): Promise<string[]> {
    const audio = req.inputs.filter((input): input is Extract<ProviderInput, { type: 'asset' }> => input.type === 'asset' && input.kind === 'audio')
    // Reject models, formats, and counts before reading files; read local files for duration only when probed metadata is missing.
    validateInputs(req.kind, req.model, req.inputs.flatMap(input => input.type === 'asset' ? [input] : []), req.params)
    const urls: string[] = []
    const metadata: ProviderInputMetadata[] = []
    for (const input of audio) {
      try {
        const info = await stat(input.path)
        if (!info.isFile() || info.size > ARK_MAX_AUDIO_BYTES) throw new ProviderError('rejected', 'Each audio reference size cannot exceed 15 MB')
        const durationMs = input.durationMs ?? (await media.probe(input.path)).durationMs
        if (durationMs === undefined) throw new ProviderError('rejected', 'Cannot read audio reference duration')
        metadata.push({ kind: 'audio', mime: input.mime, durationMs })
        const data = await readFile(input.path, signal ? { signal } : {})
        if (data.length > ARK_MAX_AUDIO_BYTES) throw new ProviderError('rejected', 'Each audio reference size cannot exceed 15 MB')
        urls.push(`data:audio/${input.mime === 'audio/mpeg' ? 'mp3' : 'wav'};base64,${data.toString('base64')}`)
      } catch (error) {
        checkAbort(signal)
        if (error instanceof ProviderError) throw error
        throw new ProviderError('rejected', 'Cannot read audio reference')
      }
    }
    validateInputs(req.kind, req.model, [...metadata, ...req.inputs.flatMap(input => input.type === 'asset' && input.kind !== 'audio' ? [input] : [])], req.params)
    return urls
  }

  async function videoMetadata(inputs: ProviderInput[], signal?: AbortSignal): Promise<ProviderInputMetadata[]> {
    const metadata: ProviderInputMetadata[] = []
    for (const input of inputs) {
      if (input.type !== 'asset') continue
      if (input.kind !== 'video' || [input.durationMs, input.width, input.height, input.fps, input.bytes].every(value => value !== undefined)) {
        metadata.push(input)
        continue
      }
      try {
        const info = await stat(input.path)
        const probed = await media.probe(input.path)
        if (!info.isFile()) throw new Error('Not a local file')
        metadata.push({ ...input, durationMs: input.durationMs ?? probed.durationMs ?? NaN, width: input.width ?? probed.width ?? NaN, height: input.height ?? probed.height ?? NaN, fps: input.fps ?? probed.fps ?? NaN, bytes: info.size })
      } catch {
        checkAbort(signal)
        throw new ProviderError('rejected', 'Cannot read reference video metadata')
      }
    }
    return metadata
  }

  async function submit(req: ProviderRequest, key: string, signal?: AbortSignal): Promise<{ externalTaskId: string }> {
    checkAbort(signal)
    const existing = await readRecord(key)
    if (existing) return submitted(existing)
    if (req.kind === 'audio') validateInputs(req.kind, req.model, [], req.params)
    const models = req.kind === 'image' ? opts.imageModels : opts.videoModels
    if (!models.some(model => model.id === req.model)) throw new ProviderError('rejected', 'Ark media type does not match the model')
    const prepared = prepareRequest(req)
    if (!prepared.prompt) throw new ProviderError('rejected', 'Ark requires a generation prompt')
    const videos = prepared.inputs.flatMap((input, ordinal) => input.type === 'asset' && input.kind === 'video' ? [{ input, ordinal }] : [])
    const expiry = typeof req.params.executionExpiresAfter === 'number' ? req.params.executionExpiresAfter : 21600
    if (videos.length && expiry + 3600 > MAX_PRESIGN_SECONDS) {
      const detail = 'Ark reference video expiry plus its fetch margin exceeds the media hosting link maximum'
      throw new ProviderError('rejected', detail, 'generation.invalid_params', { detail })
    }
    const parsed = arkParamsSchema(req.kind, req.model).safeParse(req.params)
    if (!parsed.success) throw new ProviderError('rejected', `Invalid Ark generation parameters: ${parsed.error.issues.map(issue => `${issue.path.join('.')} ${issue.message}`).join('; ')}`)
    validateInputs(req.kind, req.model, [
      ...prepared.inputs.flatMap(input => input.type === 'asset' ? [input] : []),
      ...(req.frames ? [
        { kind: 'image' as const, mime: req.frames.first.type === 'asset' ? req.frames.first.mime : '', frameRole: 'first' as const },
        ...(req.frames.last ? [{ kind: 'image' as const, mime: req.frames.last.type === 'asset' ? req.frames.last.mime : '', frameRole: 'last' as const }] : []),
      ] : []),
    ], req.params)
    if (prepared.inputs.some(input => input.type === 'asset' && input.kind === 'video')) validateInputs(req.kind, req.model, await videoMetadata(prepared.inputs, signal), parsed.data)
    const frameInputs = req.frames ? [req.frames.first, ...(req.frames.last ? [req.frames.last] : [])] : prepared.inputs
    const imageCount = frameInputs.filter(input => input.type === 'asset' && input.kind === 'image').length
    const imageMode = req.frames ? (req.frames.last ? 'first_last' : 'first_frame') : parsed.data.imageMode
    if (imageMode === 'first_frame' && imageCount !== 1) throw new ProviderError('rejected', 'First-frame mode requires exactly one image')
    if (imageMode === 'first_last' && imageCount !== 2) throw new ProviderError('rejected', 'First-and-last-frame mode requires exactly two images')
    const audio = await inputAudio(prepared, signal)
    const images = await inputImages(frameInputs, signal)
    const videoItems = videos.map(() => ({ type: 'video_url', video_url: { url: '' }, role: 'reference_video' }))
    const secrets: string[] = []
    let body: Record<string, unknown>
    if (req.kind === 'image') {
      const params = arkImageParamsSchema.parse(parsed.data)
      body = {
        model: req.model, prompt: prepared.prompt, size: params.size, watermark: params.watermark, response_format: 'url',
        ...(parsed.data.outputFormat ? { output_format: parsed.data.outputFormat } : {}),
        ...(parsed.data.optimizePromptMode ? { optimize_prompt_options: { mode: parsed.data.optimizePromptMode } } : {}),
        // Omit group-image fields for single images: models without group support (e.g. Seedream 5.0 flash) reject even disabled
        ...(params.n > 1 ? { sequential_image_generation: 'auto', sequential_image_generation_options: { max_images: params.n } } : {}),
        ...(images.length ? { image: images.length === 1 ? images[0] : images } : {}),
      }
    } else {
      const params = arkVideoParamsSchema.parse(parsed.data)
      if (req.frames) params.imageMode = req.frames.last ? 'first_last' : 'first_frame'
      if (params.imageMode === 'reference' && images.length === 0 && !audio.length && !videoItems.length) throw new ProviderError('rejected', 'Reference-image mode requires image inputs')
      const content: unknown[] = [{ type: 'text', text: prepared.prompt }]
      images.forEach((url, index) => content.push({
        type: 'image_url', image_url: { url },
        role: audio.length || videoItems.length ? 'reference_image' : params.imageMode === 'first_last' ? (index === 0 ? 'first_frame' : 'last_frame') : (params.imageMode === 'first_frame' || (params.imageMode === 'auto' && images.length === 1) ? 'first_frame' : 'reference_image'),
      }))
      content.push(...videoItems)
      audio.forEach(url => content.push({ type: 'audio_url', audio_url: { url }, role: 'reference_audio' }))
      body = { model: req.model, content, watermark: params.watermark, ...(videoItems.length ? { execution_expires_after: expiry } : {}) }
      if (req.model.replace(/-\d{6}$/, '') === 'doubao-seedance-2-5' && (audio.length || videoItems.length || (images.length && (params.imageMode === 'reference' || (params.imageMode === 'auto' && images.length > 1))))) body.omni_reference_task_type = 'reference'
      for (const [field, value] of Object.entries({ ratio: params.ratio, resolution: params.resolution, duration: params.duration, generate_audio: params.generateAudio, seed: params.seed, camera_fixed: params.cameraFixed, return_last_frame: params.returnLastFrame, execution_expires_after: params.executionExpiresAfter })) {
        if (value !== undefined) body[field] = value
      }
    }
    if (Buffer.byteLength(JSON.stringify(body)) > ARK_MAX_REQUEST_BYTES) throw new ProviderError('rejected', 'Ark request body size cannot exceed 64 MB')
    const secret = await apiKey()
    for (const [index, { input, ordinal }] of videos.entries()) {
      try {
        const url = await opts.hosted!.url({ path: input.path, mime: input.mime, key: `${key}:${ordinal}` }, expiry + 3600, signal)
        const parsedUrl = new URL(url)
        secrets.push(url)
        for (const [name, value] of parsedUrl.searchParams) if (/^x-tos-(?:signature|credential)$/i.test(name)) secrets.push(value)
        videoItems[index]!.video_url.url = url
      } catch (error) {
        // Hosting may have become unavailable; the bucket lifecycle remains the backstop when cleanup cannot run.
        try { await opts.hosted!.release(key) } catch { /* Cleanup must preserve the original upload failure. */ }
        checkAbort(signal)
        const reason = isObject(error) && isObject(error.details) ? error.details.reason : undefined
        if (reason === 'hosting.not_configured') throw new ProviderError('rejected', 'Configure Media hosting before using video references', 'generation.video_reference_hosting_required')
        throw new ProviderError('transient', 'Reference video upload temporarily failed', reason === 'hosting.upload_failed' || reason === 'hosting.store_failed' ? reason : undefined)
      }
    }
    if (Buffer.byteLength(JSON.stringify(body)) > ARK_MAX_REQUEST_BYTES) throw new ProviderError('rejected', 'Ark request body size cannot exceed 64 MB')
    checkAbort(signal)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    try {
      await writeFile(fileOf(key), JSON.stringify({ state: 'submitting', ...(videoItems.length ? { referenceVideos: true } : {}) }), { flag: 'wx', mode: 0o600, flush: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return submitted((await readRecord(key))!)
      throw new ProviderError('rejected', 'Cannot save Ark submission record; request not submitted')
    }
    let result: Record<string, unknown>
    try {
      try {
        result = await api(endpoint(req.kind === 'image' ? 'image' : 'task'), 'POST', secret, body, signal, secrets)
      } catch (error) {
        if (!(error instanceof RateLimitedCreate)) throw error
        // Only a definite rejection permits another POST; reuse the already uploaded clips and intent.
        checkAbort(signal)
        result = await api(endpoint(req.kind === 'image' ? 'image' : 'task'), 'POST', secret, body, signal, secrets)
      }
    } catch (error) {
      if (error instanceof ProviderError && (error.kind === 'rejected' || error.kind === 'transient')) await rm(fileOf(key), { force: true })
      throw error
    }
    let record: SubmittedRecord
    if (req.kind === 'image') {
      const outputs = Array.isArray(result.data) ? result.data.flatMap((value, outputIndex) => {
        if (isObject(value) && ['url', 'size'].some(field => typeof value[field] === 'string' && containsKey(value[field], secret))) {
          throw new ProviderError('timeout', 'Ark image results contain sensitive information; output URLs not saved')
        }
        const parsedOutput = imageOutputSchema.safeParse(isObject(value) ? { ...value, outputIndex } : value)
        return parsedOutput.success ? [parsedOutput.data] : []
      }) : []
      const externalTaskId = `${imagePrefix}${key}`
      if (!outputs.length && (Array.isArray(result.data) || isObject(result.error))) {
        const firstError = Array.isArray(result.data) ? result.data.find(value => isObject(value) && isObject(value.error)) : undefined
        record = { state: 'failed', externalTaskId, error: vendorError(result.error ?? (isObject(firstError) ? firstError.error : undefined), secret, 'no_output', 'Ark returned no usable images', secrets, opts.hosted) }
      } else if (outputs.length) record = { state: 'image', externalTaskId, outputs }
      else throw new ProviderError('timeout', 'Ark image results cannot be confirmed; not resubmitted')
    } else {
      if (typeof result.id !== 'string' || !result.id) throw new ProviderError('timeout', 'Ark video job ID cannot be confirmed; not resubmitted')
      if (sensitiveResult(result.id, secret, secrets, opts.hosted)) throw new ProviderError('timeout', 'Ark video job ID contains sensitive information; not saved')
      record = { state: 'video', externalTaskId: result.id, ...(videoItems.length ? { referenceVideos: true } : {}) }
    }
    await saveRecord(key, record)
    return { externalTaskId: record.externalTaskId }
  }

  return {
    id: opts.id,
    type: 'volcengine-ark',
    kinds: [...(opts.imageModels.length ? ['image' as const] : []), ...(opts.videoModels.length ? ['video' as const] : []), ...(opts.audioModels?.length ? ['audio' as const] : [])],
    models: [...opts.imageModels, ...opts.videoModels, ...(opts.audioModels ?? [])].map(model => model.id),
    frameModesFor: kind => kind === 'video' ? ['first', 'first_last'] : [],
    referenceLimitsFor,
    referenceLabelFor: (kind, model, reference) => {
      const family = model.replace(/-\d{6}$/, '')
      if (kind !== 'video' || !/^doubao-seedance-2-(?:0(?:-fast|-mini)?|5)$/.test(family)) return undefined
      const label = { image: '图片', video: '视频', audio: '音频' }[reference.kind]
      return `${family === 'doubao-seedance-2-5' ? '@' : ''}${label}${reference.number}`
    },
    referenceImageLimitFor: (kind, model) => referenceLimitsFor(kind, model).image,
    defaultModels: { ...(opts.imageModels[0] ? { image: opts.imageModels[0].id } : {}), ...(opts.videoModels[0] ? { video: opts.videoModels[0].id } : {}), ...(opts.audioModels?.[0] ? { audio: opts.audioModels[0].id } : {}) },
    paramsSchema: arkImageParamsSchema.extend({ ...arkVideoParamsSchema.shape, n: arkImageParamsSchema.shape.n }),
    paramsSchemas: { image: arkImageParamsSchema, video: arkVideoParamsSchema },
    paramsSchemaFor: arkParamsSchema,
    prepareRequest,
    validateInputs,
    submit(req, { idempotencyKey, signal }) {
      const pending = inflight.get(idempotencyKey)
      if (pending) return pending
      const promise = submit(req, idempotencyKey, signal).finally(() => inflight.delete(idempotencyKey))
      inflight.set(idempotencyKey, promise)
      return promise
    },
    async cleanup({ idempotencyKey }) {
      try {
        const record = await readRecord(idempotencyKey)
        // Without an intent, the bucket lifecycle rule covers the narrow upload-then-crash window.
        if (!record || !('referenceVideos' in record) || !record.referenceVideos || record.released || !opts.hosted) return
        await opts.hosted.release(idempotencyKey)
        await saveRecord(idempotencyKey, { ...record, released: true })
      } catch {
        // Settlement is already durable; lifecycle expiry remains the backstop if deletion fails.
        console.warn('Ark reference video cleanup temporarily failed')
      }
    },
    async findTaskByIdempotencyKey(key) {
      const record = await readRecord(key)
      return record ? submitted(record) : null
    },
    async cancel(externalTaskId, options) {
      if (externalTaskId.startsWith(imagePrefix)) return { cancelled: false }
      const secret = await apiKey()
      const path = endpoint('taskQuery', { id: externalTaskId })
      const task = await api(path, 'GET', secret, undefined, options?.signal)
      if (task.status === 'cancelled') return { cancelled: true }
      // Ark DELETE cancels only queued jobs; running jobs are unsupported, and completed jobs lose their records, which must not be reported as stopping generation.
      if (task.status !== 'queued') return { cancelled: false }
      await api(path, 'DELETE', secret, undefined, options?.signal)
      const after = await api(path, 'GET', secret, undefined, options?.signal)
      return { cancelled: after.status === 'cancelled' }
    },
    async getTask(externalTaskId, options) {
      checkAbort(options?.signal)
      if (externalTaskId.startsWith(imagePrefix)) {
        const record = await readRecord(externalTaskId.slice(imagePrefix.length))
        if (record?.state === 'failed') return { state: 'failed', error: vendorError(record.error, '', 'ark_image_failed', 'Ark image generation failed', [], opts.hosted) }
        if (!record || record.state !== 'image') throw new ProviderError('not_found', 'Ark image job does not exist')
        return { state: 'succeeded', outputs: record.outputs.map(output => ({ outputIndex: output.outputIndex, ref: externalTaskId })) }
      }
      const secret = await apiKey()
      const result = await api(endpoint('taskQuery', { id: externalTaskId }), 'GET', secret, undefined, options?.signal)
      if (result.status === 'queued') return { state: 'pending' }
      if (result.status === 'running') return { state: 'running' }
      if (result.status === 'succeeded' && isObject(result.content) && typeof result.content.video_url === 'string') {
        if (containsKey(result.content.video_url, secret)) throw new ProviderError('transient', 'Ark video output URL contains sensitive information; not saved')
        return { state: 'succeeded', outputs: [{ outputIndex: 0, ref: outputUrl(result.content.video_url) }] }
      }
      if (result.status === 'cancelled') return { state: 'cancelled' }
      if (['failed', 'expired'].includes(String(result.status))) {
        return { state: 'failed', error: vendorError(result.error, secret, `ark_${result.status}`, result.status === 'expired' ? 'Ark video generation timed out' : result.status === 'cancelled' ? 'Ark video job cancelled' : 'Ark video generation failed', [], opts.hosted) }
      }
      throw new ProviderError('transient', 'Ark video job status cannot be confirmed')
    },
    async download(output, options) {
      checkAbort(options?.signal)
      if (!Number.isInteger(output.outputIndex) || output.outputIndex < 0) throw new ProviderError('rejected', 'Invalid output index')
      let image: z.infer<typeof imageOutputSchema> | undefined
      if (output.ref.startsWith(imagePrefix)) {
        const record = await readRecord(output.ref.slice(imagePrefix.length))
        if (record?.state === 'failed') throw new ProviderError('rejected', safeVendorText(record.error.message, '', [], opts.hosted))
        if (!record || record.state !== 'image') throw new ProviderError('not_found', 'Ark image job does not exist')
        image = record.outputs.find(item => item.outputIndex === output.outputIndex)
        if (!image) throw new ProviderError('rejected', 'Output index out of range')
      } else if (output.outputIndex !== 0) throw new ProviderError('rejected', 'Output index out of range')
      let data: Uint8Array
      let mime = image ? 'image/jpeg' : 'video/mp4'
      const url = outputUrl(image?.url ?? output.ref)
      try {
        const response = await fetcher(url, { signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(options?.signal ? [options.signal] : [])]) })
        if (!response.ok) throw new ProviderError(response.status === 404 || response.status === 403 ? 'not_found' : 'transient', `Ark output download failed (HTTP ${response.status})`)
        const contentType = response.headers.get('content-type')?.split(';')[0]?.trim()
        if (contentType?.startsWith(image ? 'image/' : 'video/')) mime = contentType
        else if (contentType && contentType !== 'application/octet-stream') throw new ProviderError('rejected', 'Invalid Ark output type')
        data = await boundedBody(response, ARK_MAX_OUTPUT_BYTES)
      } catch (error) {
        checkAbort(options?.signal)
        if (error instanceof ProviderError) throw error
        throw new ProviderError('transient', 'Ark output download temporarily failed')
      }
      if (image) {
        const size = /^(\d+)x(\d+)$/.exec(image.size ?? '')
        return { data, mime, ...(size ? { width: Number(size[1]), height: Number(size[2]) } : {}) }
      }
      await mkdir(dir, { recursive: true, mode: 0o700 })
      const temp = await mkdtemp(join(dir, '.probe-'))
      try {
        const path = join(temp, 'video.mp4')
        await writeFile(path, data)
        const info = await media.probe(path)
        checkAbort(options?.signal)
        return { data, mime, ...(info.width !== undefined ? { width: info.width } : {}), ...(info.height !== undefined ? { height: info.height } : {}), ...(info.durationMs !== undefined ? { durationMs: info.durationMs } : {}), ...(info.fps !== undefined ? { fps: info.fps } : {}) }
      } catch {
        checkAbort(options?.signal)
        throw new ProviderError('transient', 'Cannot read Ark video metadata')
      } finally {
        await rm(temp, { recursive: true, force: true })
      }
    },
  }
}
