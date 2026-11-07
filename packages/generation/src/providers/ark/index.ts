import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createFfmpegMedia, type MediaTools } from '@vis/assets'
import type { MediaKind } from '@vis/protocol'
import { z } from 'zod'
import { ProviderError } from '../types'
import type { ProviderAdapter, ProviderInput, ProviderInputMetadata, ProviderRequest } from '../types'
import { replaceRecord } from './persistence'
import { boundedBody } from '../download'
import { containsKey, isObject, outputUrl as validatedOutputUrl, providerPaths, redact } from '../http'

export const ARK_MAX_PROMPT_LENGTH = 3000
export const ARK_MAX_INPUT_BYTES = 10 * 1024 * 1024
export const ARK_MAX_OUTPUT_BYTES = 256 * 1024 * 1024
const ARK_MAX_AUDIO_BYTES = 15_000_000
const ARK_MAX_REQUEST_BYTES = 64_000_000

export const arkImageParamsSchema = z.object({
  size: z.string().regex(/^(?:[124]K|[1-9]\d{1,4}x[1-9]\d{1,4})$/).default('2K').describe('图片尺寸：1K、2K、4K 或宽x高').meta({ examples: ['1K', '2K', '4K'] }),
  n: z.int().min(1).max(4).default(1).describe('最多生成的图片数量，1–4'),
  watermark: z.boolean().default(false).describe('是否添加水印'),
})

export const arkVideoParamsSchema = z.object({
  n: z.literal(1).default(1).describe('每次生成一个视频'),
  ratio: z.enum(['16:9', '4:3', '1:1', '3:4', '9:16', '21:9', 'adaptive']).optional().describe('视频宽高比，留空使用模型默认值'),
  resolution: z.enum(['480p', '720p', '1080p', '4k']).optional().describe('视频分辨率，需所选模型支持'),
  duration: z.union([z.literal(-1), z.int().min(2).max(30)]).optional().describe('视频秒数；-1 由模型决定，需所选模型支持'),
  generateAudio: z.boolean().optional().describe('生成同步声音，需所选模型支持'),
  seed: z.int().min(-1).max(2147483647).optional().describe('随机种子，-1 表示随机'),
  cameraFixed: z.boolean().optional().describe('固定镜头，需所选模型支持'),
  imageMode: z.enum(['auto', 'first_frame', 'first_last', 'reference']).default('auto').describe('auto：单图首帧、多图参考；first_frame：一图首帧；first_last：两图首尾帧；reference：参考图'),
  watermark: z.boolean().default(false).describe('是否添加水印'),
})

// Narrow parameters using the Ark model capability table (docs checked in 2026-10); unregistered models and ep- endpoints use the generic ranges above.
// Keys are model names without date suffixes, e.g. doubao-seedance-2-0-fast-260128 -> doubao-seedance-2-0-fast.
const seedance2 = (resolutions: readonly [string, ...string[]]) => arkVideoParamsSchema.extend({
  resolution: z.enum(resolutions).optional().describe(`视频分辨率：${resolutions.join(' / ')}`),
  duration: z.int().min(4).max(15).optional().describe('视频秒数，4–15'),
})
const singleImage = arkImageParamsSchema.extend({ n: z.literal(1).default(1).describe('该模型每次只生成一张图片') })
const MODEL_PARAMS: Record<string, { kind: 'image' | 'video'; schema: z.ZodType<Record<string, unknown>> }> = {
  'doubao-seedance-2-0': { kind: 'video', schema: seedance2(['480p', '720p', '1080p', '4k']) },
  'doubao-seedance-2-0-fast': { kind: 'video', schema: seedance2(['480p', '720p']) },
  'doubao-seedance-2-0-mini': { kind: 'video', schema: seedance2(['480p', '720p']) },
  // pro / flash do not support image groups (sequential_image_generation)
  'doubao-seedream-5-0-pro': { kind: 'image', schema: singleImage },
  'doubao-seedream-5-0-flash': { kind: 'image', schema: singleImage },
}

export function arkParamsSchema(kind: MediaKind, model: string): z.ZodType<Record<string, unknown>> {
  if (kind === 'audio') return z.object({})
  const known = MODEL_PARAMS[model.replace(/-\d{6}$/, '')]
  if (known?.kind === kind) return known.schema
  return kind === 'image' ? arkImageParamsSchema : arkVideoParamsSchema
}

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
  z.object({ state: z.literal('submitting') }),
  z.object({ state: z.literal('image'), externalTaskId: z.string(), outputs: z.array(imageOutputSchema).min(1) }),
  z.object({ state: z.literal('video'), externalTaskId: z.string() }),
  z.object({ state: z.literal('failed'), externalTaskId: z.string(), error: z.object({ code: z.string(), message: z.string() }) }),
])
type TaskRecord = z.infer<typeof recordSchema>
type SubmittedRecord = Exclude<TaskRecord, { state: 'submitting' }>

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Operation aborted', 'AbortError')
}

function vendorError(value: unknown, key: string, fallbackCode: string, fallbackMessage: string): { code: string; message: string } {
  return {
    code: redact(isObject(value) && typeof value.code === 'string' ? value.code : fallbackCode, key).slice(0, 200),
    message: redact(isObject(value) && typeof value.message === 'string' ? value.message : fallbackMessage, key).slice(0, 2000),
  }
}

function outputUrl(value: string): string {
  return validatedOutputUrl(value, 'Ark returned an invalid output URL')
}

function validateInputs(kind: MediaKind, model: string, inputs: ProviderInputMetadata[], params: Record<string, unknown>): void {
  if (inputs.some(input => input.frameRole) && inputs.some(input => !input.frameRole)) throw new ProviderError('rejected', 'Ark frame inputs cannot be combined with media reference inputs', 'generation.frames_reference_mix')
  if (inputs.some(input => input.mime === 'image/svg+xml')) throw new ProviderError('rejected', 'SVG cannot be used as an Ark reference image; export it as PNG first', 'generation.svg_reference_unsupported')
  if (kind === 'audio') throw new ProviderError('rejected', 'The selected model does not yet support audio generation; use Mock music or Mock sound effects', 'generation.audio_generation_unsupported')
  const audio = inputs.filter(input => input.kind === 'audio')
  if (!audio.length) return
  if (kind !== 'video' || !/^doubao-seedance-2-0(?:-fast|-mini)?$/.test(model.replace(/-\d{6}$/, ''))) {
    throw new ProviderError('rejected', 'The selected model does not yet support audio references', 'generation.audio_reference_unsupported')
  }
  if (audio.some(input => !['audio/wav', 'audio/mpeg'].includes(input.mime))) throw new ProviderError('rejected', 'Audio references only support WAV or MP3', 'generation.audio_reference_format')
  if (audio.length > 3) throw new ProviderError('rejected', 'Audio references allow at most 3 clips', 'generation.audio_reference_count')
  if (audio.some(input => input.durationMs !== undefined && (!Number.isFinite(input.durationMs) || input.durationMs < 2000 || input.durationMs > 15000))) {
    throw new ProviderError('rejected', 'Each audio reference must be 2-15 seconds long', 'generation.audio_reference_duration')
  }
  if (audio.reduce((total, input) => total + (input.durationMs ?? 0), 0) > 15000) throw new ProviderError('rejected', 'Audio reference total duration cannot exceed 15 seconds', 'generation.audio_reference_total_duration')
  if (!inputs.some(input => input.kind === 'image')) throw new ProviderError('rejected', 'Audio references also require at least one reference image', 'generation.audio_reference_image_required')
  if (params.imageMode === 'first_frame' || params.imageMode === 'first_last') throw new ProviderError('rejected', 'Audio references cannot be combined with first-frame or first-and-last-frame modes; use auto or reference-image mode', 'generation.audio_reference_mode')
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

  async function saveRecord(key: string, record: SubmittedRecord): Promise<void> {
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

  async function api(path: string, method: 'GET' | 'POST' | 'DELETE', key: string, body: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> {
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
      const error = vendorError(isObject(result) ? result.error : undefined, key, `HTTP_${response.status}`, `Ark request failed (HTTP ${response.status})`)
      const message = `${error.code}: ${error.message}`
      if (method === 'GET' && response.status === 404) throw new ProviderError('not_found', message)
      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        throw new ProviderError('rejected', message, /moderation|sensitive|content.?filter|risk/i.test(error.code) ? 'generation.moderation_rejected' : undefined)
      }
      // Treat only known rate-limit codes as explicit rejection; 5xx requests may already have executed.
      const definiteReject = isObject(result) && isObject(result.error) && !result.id && !result.data && typeof result.error.code === 'string' &&
        response.status === 429 && /^(?:RateLimitExceeded(?:\.|$)|\w*RateLimitExceeded$|ServerOverloaded$|RequestBurstTooFast$|InflightBatchsizeExceeded$|QuotaExceeded(?:\.|$)|AccountQuotaExceeded$|SetLimitExceeded$)/.test(result.error.code)
      throw new ProviderError(method !== 'POST' || definiteReject ? 'transient' : 'timeout', message)
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
      if (input.kind === 'audio') continue
      if (input.kind !== 'image' || !/^image\/(?:png|jpeg|webp|gif|bmp|tiff)$/.test(input.mime)) {
        throw new ProviderError('rejected', 'Ark supports only local image inputs; video inputs are not yet supported')
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

  async function submit(req: ProviderRequest, key: string, signal?: AbortSignal): Promise<{ externalTaskId: string }> {
    checkAbort(signal)
    const existing = await readRecord(key)
    if (existing) return submitted(existing)
    if (req.kind === 'audio') validateInputs(req.kind, req.model, [], req.params)
    const models = req.kind === 'image' ? opts.imageModels : opts.videoModels
    if (!models.some(model => model.id === req.model)) throw new ProviderError('rejected', 'Ark media type does not match the model')
    const prepared = prepareRequest(req)
    if (!prepared.prompt) throw new ProviderError('rejected', 'Ark requires a generation prompt')
    const parsed = arkParamsSchema(req.kind, req.model).safeParse(req.params)
    if (!parsed.success) throw new ProviderError('rejected', `Invalid Ark generation parameters: ${parsed.error.issues.map(issue => `${issue.path.join('.')} ${issue.message}`).join('; ')}`)
    validateInputs(req.kind, req.model, [
      ...prepared.inputs.flatMap(input => input.type === 'asset' ? [input] : []),
      ...(req.frames ? [
        { kind: 'image' as const, mime: req.frames.first.type === 'asset' ? req.frames.first.mime : '', frameRole: 'first' as const },
        ...(req.frames.last ? [{ kind: 'image' as const, mime: req.frames.last.type === 'asset' ? req.frames.last.mime : '', frameRole: 'last' as const }] : []),
      ] : []),
    ], req.params)
    const audio = await inputAudio(prepared, signal)
    const images = await inputImages(req.frames ? [req.frames.first, ...(req.frames.last ? [req.frames.last] : [])] : prepared.inputs, signal)
    // shortcut: conservatively allow up to 10 reference images for images and 9 for videos; relax separately once model capability metadata is available.
    if (images.length > (req.kind === 'image' ? 10 : 9)) throw new ProviderError('rejected', 'Too many Ark input images: at most 10 for image generation and 9 for video')
    let body: Record<string, unknown>
    if (req.kind === 'image') {
      const params = arkImageParamsSchema.parse(parsed.data)
      body = {
        model: req.model, prompt: prepared.prompt, size: params.size, watermark: params.watermark, response_format: 'url',
        // Omit group-image fields for single images: models without group support (e.g. Seedream 5.0 flash) reject even disabled
        ...(params.n > 1 ? { sequential_image_generation: 'auto', sequential_image_generation_options: { max_images: params.n } } : {}),
        ...(images.length ? { image: images.length === 1 ? images[0] : images } : {}),
      }
    } else {
      const params = arkVideoParamsSchema.parse(parsed.data)
      if (req.frames) params.imageMode = req.frames.last ? 'first_last' : 'first_frame'
      if (params.imageMode === 'first_frame' && images.length !== 1) throw new ProviderError('rejected', 'First-frame mode requires exactly one image')
      if (params.imageMode === 'first_last' && images.length !== 2) throw new ProviderError('rejected', 'First-and-last-frame mode requires exactly two images')
      if (params.imageMode === 'reference' && images.length === 0) throw new ProviderError('rejected', 'Reference-image mode requires image inputs')
      const content: unknown[] = [{ type: 'text', text: prepared.prompt }]
      images.forEach((url, index) => content.push({
        type: 'image_url', image_url: { url },
        role: audio.length ? 'reference_image' : params.imageMode === 'first_last' ? (index === 0 ? 'first_frame' : 'last_frame') : (params.imageMode === 'first_frame' || (params.imageMode === 'auto' && images.length === 1) ? 'first_frame' : 'reference_image'),
      }))
      audio.forEach(url => content.push({ type: 'audio_url', audio_url: { url }, role: 'reference_audio' }))
      body = { model: req.model, content, watermark: params.watermark }
      for (const [field, value] of Object.entries({ ratio: params.ratio, resolution: params.resolution, duration: params.duration, generate_audio: params.generateAudio, seed: params.seed, camera_fixed: params.cameraFixed })) {
        if (value !== undefined) body[field] = value
      }
    }
    if (Buffer.byteLength(JSON.stringify(body)) > ARK_MAX_REQUEST_BYTES) throw new ProviderError('rejected', 'Ark request body size cannot exceed 64 MB')
    const secret = await apiKey()
    checkAbort(signal)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    try {
      await writeFile(fileOf(key), JSON.stringify({ state: 'submitting' }), { flag: 'wx', mode: 0o600, flush: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return submitted((await readRecord(key))!)
      throw new ProviderError('rejected', 'Cannot save Ark submission record; request not submitted')
    }
    let result: Record<string, unknown>
    try {
      result = await api(endpoint(req.kind === 'image' ? 'image' : 'task'), 'POST', secret, body, signal)
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
        record = { state: 'failed', externalTaskId, error: vendorError(result.error ?? (isObject(firstError) ? firstError.error : undefined), secret, 'no_output', 'Ark returned no usable images') }
      } else if (outputs.length) record = { state: 'image', externalTaskId, outputs }
      else throw new ProviderError('timeout', 'Ark image results cannot be confirmed; not resubmitted')
    } else {
      if (typeof result.id !== 'string' || !result.id) throw new ProviderError('timeout', 'Ark video job ID cannot be confirmed; not resubmitted')
      if (containsKey(result.id, secret)) throw new ProviderError('timeout', 'Ark video job ID contains sensitive information; not saved')
      record = { state: 'video', externalTaskId: result.id }
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
    referenceImageLimitFor: kind => kind === 'image' ? 10 : 9,
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
        if (record?.state === 'failed') return { state: 'failed', error: record.error }
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
        return { state: 'failed', error: vendorError(result.error, secret, `ark_${result.status}`, result.status === 'expired' ? 'Ark video generation timed out' : result.status === 'cancelled' ? 'Ark video job cancelled' : 'Ark video generation failed') }
      }
      throw new ProviderError('transient', 'Ark video job status cannot be confirmed')
    },
    async download(output, options) {
      checkAbort(options?.signal)
      if (!Number.isInteger(output.outputIndex) || output.outputIndex < 0) throw new ProviderError('rejected', 'Invalid output index')
      let image: z.infer<typeof imageOutputSchema> | undefined
      if (output.ref.startsWith(imagePrefix)) {
        const record = await readRecord(output.ref.slice(imagePrefix.length))
        if (record?.state === 'failed') throw new ProviderError('rejected', record.error.message)
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
