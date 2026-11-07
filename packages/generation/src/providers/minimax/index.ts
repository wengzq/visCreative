import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { MediaTools } from '@vis/assets'
import type { GenerationOperation, MediaKind } from '@vis/protocol'
import { z } from 'zod'
import { boundedBody, OutputSizeLimitError } from '../download'
import { containsKey, isObject as object, outputUrl, redact, providerEndpoint, providerPaths } from '../http'
import type { ProviderEntry } from '../registry'
import { stageSyncOutput } from '../sync'
import { ProviderError, type DownloadedOutput, type ProviderAdapter, type ProviderInputMetadata, type ProviderRequest, type ProviderTaskState } from '../types'
import { MINIMAX_IMAGE_MAX_OUTPUT_BYTES, MINIMAX_IMAGE_TIMEOUT_MS, MINIMAX_MAX_OUTPUT_BYTES, MINIMAX_MODELS, minimaxParamsSchema } from './models'
import { minimaxMime } from './media'

export const MINIMAX_ENDPOINTS = [
  { id: 'image', label: { zh: '图片生成', en: 'Image generation' }, path: '/v1/image_generation' },
  { id: 'video', label: { zh: '视频生成', en: 'Video generation' }, path: '/v2/video_generation' },
  { id: 'videoQuery', label: { zh: '视频任务查询', en: 'Video task query' }, path: '/v2/query/video_generation/{id}', requiredFor: ['video'] },
] as const

export const MINIMAX_REGIONS = [
  { id: 'china', label: { zh: '中国', en: 'China' }, baseUrl: 'https://api.minimax.cn' },
  { id: 'international', label: { zh: '国际', en: 'International' }, baseUrl: 'https://api.minimax.io' },
] as const
export type MiniMaxOptions = Omit<ProviderEntry, 'type'> & {
  dataDir: string
  getKey(): Promise<string | undefined>
  media: MediaTools
  fetch?: typeof globalThis.fetch
  timeoutMs?: number
  maxOutputBytes?: number
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const inflight = new Map<string, Promise<{ externalTaskId: string }>>()
const imageMimes = ['image/png', 'image/jpeg', 'image/webp']
const unknown = () => new ProviderError('timeout', 'MiniMax submission result is unknown; not resubmitted')
class CreateRejection extends ProviderError {}
const moderation = (code: number) => [1026, 1027, 1046].includes(code)
const reasonFor = (code: number, status: number) => moderation(code) ? 'generation.moderation_rejected'
  : [1004, 2049].includes(code) || status === 401 ? 'generation.provider_auth_failed'
    : [1008, 2053].includes(code) || status === 402 ? 'generation.provider_balance'
      : status === 413 ? 'generation.provider_request_too_large' : 'generation.provider_request_rejected'

function validateInputs(kind: MediaKind, model: string, inputs: ProviderInputMetadata[], params: Record<string, unknown>, operation: GenerationOperation) {
  const entry = MINIMAX_MODELS.find(entry => entry.kind === kind && entry.id === model)
  if (!entry || operation !== 'generate') throw new ProviderError('rejected', 'Unsupported MiniMax model or operation', 'generation.provider_input_unsupported')
  const mimes = kind === 'image' ? ['image/png', 'image/jpeg'] : imageMimes
  if (inputs.some(input => input.mime === 'image/svg+xml')) throw new ProviderError('rejected', 'Export SVG references as PNG first', 'generation.svg_reference_unsupported')
  if (inputs.some(input => input.kind !== 'image' || !mimes.includes(input.mime))) throw new ProviderError('rejected', 'Unsupported MiniMax reference format', 'generation.provider_input_unsupported')
  const frames = inputs.filter(input => input.frameRole)
  if (kind === 'image') {
    if (frames.length || inputs.length > 1) throw new ProviderError('rejected', 'MiniMax images support one character reference and no frames', 'generation.provider_input_unsupported')
    return
  }
  if (frames.length && frames.length !== inputs.length) throw new ProviderError('rejected', 'Frames cannot be combined with references', 'generation.frames_reference_mix')
  const frameMode = frames.length || params.imageMode === 'first_frame' || params.imageMode === 'first_last' || (params.imageMode !== 'reference' && inputs.length === 1)
  if (frameMode) {
    const count = params.imageMode === 'first_last' || frames.some(input => input.frameRole === 'last') ? 2 : 1
    if (inputs.length !== count || (frames.length && frames.filter(input => input.frameRole === 'first').length !== 1)) throw new ProviderError('rejected', 'MiniMax frame count does not match the selected mode', 'generation.provider_input_unsupported')
  } else if (inputs.length > 9 || (params.imageMode === 'reference' && !inputs.length)) throw new ProviderError('rejected', 'MiniMax reference count is invalid', 'generation.provider_input_unsupported')
}
function prepareRequest(req: ProviderRequest): ProviderRequest {
  const texts = req.inputs.flatMap(input => input.type === 'text' && input.text.trim() && input.text !== req.prompt ? [input.text] : [])
  return { ...req, prompt: [req.prompt, ...texts].filter(Boolean).join('\n\n'), inputs: req.inputs.filter(input => input.type === 'asset') }
}

export function createMiniMaxProvider(opts: MiniMaxOptions): ProviderAdapter {
  const baseUrl = providerEndpoint(opts.baseUrl, MINIMAX_REGIONS, opts.region, 'MiniMax requires a valid endpoint matching the selected region')
  const endpoint = providerPaths(MINIMAX_ENDPOINTS, opts.endpoints, 'MiniMax endpoint paths are invalid')
  const fetcher = opts.fetch ?? globalThis.fetch
  const root = resolve(opts.dataDir, 'minimax', digest(`${opts.id}:${baseUrl}`))
  const directory = (key: string) => join(root, digest(key))
  const maxBytes = opts.maxOutputBytes ?? MINIMAX_MAX_OUTPUT_BYTES
  const signalFor = (signal?: AbortSignal) => AbortSignal.any([AbortSignal.timeout(opts.timeoutMs ?? MINIMAX_IMAGE_TIMEOUT_MS), ...(signal ? [signal] : [])])
  const urls = new Map<string, { url: string; at: number }>()
  async function apiKey() {
    let key: string | undefined
    try { key = await opts.getKey() } catch { throw new ProviderError('rejected', 'Cannot read the generation service API key', 'generation.provider_key_unreadable') }
    if (key && /[\r\n]/.test(key)) throw new ProviderError('rejected', 'Invalid API key characters', 'generation.provider_auth_failed')
    if (!key?.trim()) throw new ProviderError('rejected', 'Configure a MiniMax API key first', 'generation.provider_auth_failed')
    return key.trim()
  }
  async function probe(data: Uint8Array, mime: string): Promise<DownloadedOutput> {
    if (minimaxMime(data) !== mime) throw new ProviderError('rejected', 'MiniMax output bytes do not match the MIME type', 'generation.output_type_invalid')
    await mkdir(root, { recursive: true, mode: 0o700 })
    const dir = await mkdtemp(join(root, 'probe-'))
    try {
      const path = join(dir, `media.${mime === 'image/jpeg' ? 'jpg' : mime.split('/')[1]}`)
      await writeFile(path, data, { mode: 0o600 })
      const info = await opts.media.probe(path)
      if (info.mime !== mime || !info.width || !info.height) throw new Error('Invalid media')
      return { data, mime, width: info.width, height: info.height, ...(info.durationMs !== undefined ? { durationMs: info.durationMs } : {}), ...(info.fps !== undefined ? { fps: info.fps } : {}) }
    } catch { throw new ProviderError('rejected', 'MiniMax media could not be validated', 'generation.output_type_invalid') }
    finally { await rm(dir, { recursive: true, force: true }) }
  }
  async function api(path: string, secret: string, body?: unknown, signal?: AbortSignal, imageCount?: number): Promise<Record<string, unknown>> {
    const creating = body !== undefined
    const image = imageCount !== undefined
    let response: Response
    try {
      response = await fetcher(`${baseUrl}${path}`, { method: creating ? 'POST' : 'GET', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' }, ...(creating ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: signalFor(signal) })
    } catch { throw creating ? unknown() : new ProviderError('transient', 'MiniMax query could not be completed') }
    if (response.status >= 500 || response.status === 408) {
      await response.body?.cancel().catch(() => {})
      throw creating ? unknown() : new ProviderError('transient', 'MiniMax service result cannot be confirmed')
    }
    if (!creating && response.status === 404) {
      await response.body?.cancel().catch(() => {})
      throw new ProviderError('not_found', 'MiniMax task is missing or has expired')
    }
    let result: unknown
    try { result = JSON.parse(Buffer.from(await boundedBody(response, image && response.ok ? Math.ceil(Math.min(maxBytes, MINIMAX_IMAGE_MAX_OUTPUT_BYTES) * 4 / 3) * imageCount + 65_536 : 65_536)).toString('utf8')) }
    catch (error) {
      if (response.ok) {
        if (image && error instanceof OutputSizeLimitError) return { base_resp: { status_code: 0 } }
        throw creating ? unknown() : new ProviderError('transient', 'MiniMax response cannot be confirmed')
      }
    }
    const base = object(result) && object(result.base_resp) ? result.base_resp : undefined
    const detail = object(result) && object(result.error) ? result.error : undefined
    const code = typeof base?.status_code === 'number' ? base.status_code : Number(/\((\d+)\)\s*$/.exec(String(detail?.message ?? ''))?.[1] ?? 0)
    if (!response.ok || code !== 0 || detail) {
      if (code === 1027) {
        if (image) return { outputBlocked: true }
        throw unknown()
      }
      if ([1000, 1001, 1024, 1033, 2066].includes(code)) throw creating ? unknown() : new ProviderError('transient', 'MiniMax result cannot be confirmed')
      const ErrorType = creating ? CreateRejection : ProviderError
      if ([1002, 1045].includes(code) || response.status === 429) throw new ErrorType('transient', 'MiniMax rate limit reached')
      if ([1004, 1008, 1026, 1046, 2013, 2014, 2022, 2049, 2053, 2068, 2069].includes(code) || (response.status >= 400 && response.status < 500)) throw new ErrorType('rejected', 'MiniMax request was rejected', reasonFor(code, response.status))
      throw creating ? unknown() : new ProviderError('transient', 'MiniMax response cannot be confirmed')
    }
    if (!object(result) || (image && (!base || base.status_code !== 0))) throw creating ? unknown() : new ProviderError('transient', 'MiniMax response cannot be confirmed')
    return result
  }
  async function bodyFor(original: ProviderRequest, signal?: AbortSignal) {
    const req = prepareRequest(original)
    const entry = MINIMAX_MODELS.find(entry => entry.kind === req.kind && entry.id === req.model)
    if (!entry || !(req.kind === 'image' ? opts.imageModels : opts.videoModels).some(model => model.id === req.model)) throw new ProviderError('rejected', 'MiniMax model is not configured', 'generation.provider_input_unsupported')
    const parsed = minimaxParamsSchema(req.kind, req.model).safeParse(req.params)
    if (!parsed.success) throw new ProviderError('rejected', 'Invalid MiniMax parameters', 'generation.provider_input_unsupported')
    const params = parsed.data
    if (!req.prompt.trim() || Array.from(req.prompt).length > entry.promptLength) throw new ProviderError('rejected', 'MiniMax prompt is empty or too long', 'generation.provider_input_unsupported')
    const references = req.inputs.filter(input => input.type === 'asset')
    const frames = req.frames ? [req.frames.first, ...(req.frames.last ? [req.frames.last] : [])] : []
    validateInputs(req.kind, req.model, [...references, ...frames.map((input, index) => ({ kind: input.type === 'asset' ? input.kind : 'image' as const, mime: input.type === 'asset' ? input.mime : '', frameRole: index === 0 ? 'first' as const : 'last' as const }))], params, req.operation)
    const images: string[] = []
    for (const input of frames.length ? frames : references) {
      if (input.type !== 'asset') throw new ProviderError('rejected', 'MiniMax frames require image assets', 'generation.provider_input_unsupported')
      const limit = req.kind === 'image' ? 10_000_000 : 30_000_000
      try {
        const info = await stat(input.path)
        if (!info.isFile() || (req.kind === 'image' ? info.size >= limit : info.size > limit)) throw new ProviderError('rejected', 'MiniMax input exceeds the size limit', 'generation.provider_input_too_large')
        const data = await readFile(input.path, { signal })
        if (req.kind === 'image' ? data.length >= limit : data.length > limit) throw new ProviderError('rejected', 'MiniMax input exceeds the size limit', 'generation.provider_input_too_large')
        const infoMedia = await probe(data, input.mime)
        if (req.kind === 'video' && (infoMedia.width! < 256 || infoMedia.height! < 256 || infoMedia.width! > 5760 || infoMedia.height! > 5760 || infoMedia.width! / infoMedia.height! < 0.4 || infoMedia.width! / infoMedia.height! > 2.5)) throw new ProviderError('rejected', 'MiniMax input dimensions are unsupported', 'generation.provider_input_unsupported')
        images.push(`data:${input.mime};base64,${data.toString('base64')}`)
      } catch (error) {
        if (error instanceof ProviderError) throw error
        throw new ProviderError('rejected', 'Cannot read MiniMax input image', 'generation.provider_input_unsupported')
      }
    }
    if (req.kind === 'image') return { model: req.model, prompt: req.prompt, ...params, ...(!params.width && !params.aspect_ratio ? { aspect_ratio: '1:1' } : {}), response_format: 'base64', ...(images.length ? { subject_reference: [{ type: 'character', image_file: images[0] }] } : {}) }
    const { imageMode, n: _n, prompt_expansion_mode, ...settings } = params
    const frameMode = frames.length || imageMode === 'first_frame' || imageMode === 'first_last' || (imageMode !== 'reference' && images.length === 1)
    const content = [{ type: 'text', text: req.prompt }, ...images.map((url, index) => ({ type: 'image_url', image_url: { url }, role: frameMode ? index === 0 ? 'first_frame' : 'last_frame' : 'reference_image' }))]
    const body = { model: req.model, content, ...settings, ...(frameMode ? { ratio: 'adaptive' } : {}), ...(prompt_expansion_mode ? { extra: { prompt_expansion_mode } } : {}) }
    if (Buffer.byteLength(JSON.stringify(body)) > 64_000_000) throw new ProviderError('rejected', 'MiniMax request exceeds 64 MB', 'generation.provider_request_too_large')
    return body
  }
  const staging = (secret: string, body?: Record<string, unknown>) => stageSyncOutput({
    dataDir: opts.dataDir, providerId: `${opts.id}:minimax:${baseUrl}`, maxBytes: Math.min(maxBytes, MINIMAX_IMAGE_MAX_OUTPUT_BYTES), mimeTypes: imageMimes,
    async call(req, { signal }) {
      const result = await api(endpoint('image'), secret, body, signal, Number(body?.n ?? 1))
      if (result.outputBlocked || (object(result.metadata) && Number(result.metadata.failed_count) > 0)) return { state: 'failed', error: { code: 'minimax_output_blocked', message: 'MiniMax generated images were blocked by output moderation; billing cannot be confirmed', reason: 'generation.moderation_rejected' } }
      const images = object(result.data) ? result.data.image_base64 : undefined
      if (!Array.isArray(images) || !images.length || images.length > Number(body?.n ?? 1)) return []
      const outputs = []
      for (const image of images) {
        if (typeof image !== 'string' || !image.length || image.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(image)) return []
        const bytes = Buffer.from(image, 'base64')
        if (bytes.length > Math.min(maxBytes, MINIMAX_IMAGE_MAX_OUTPUT_BYTES) || bytes.includes(secret) || bytes.includes(encodeURIComponent(secret))) return []
        const mime = minimaxMime(bytes)
        if (!mime || !imageMimes.includes(mime)) return []
        try { outputs.push(await probe(bytes, mime)) } catch { return [] }
      }
      return outputs
    },
  })
  async function submitVideo(request: ProviderRequest, options: { idempotencyKey: string; signal?: AbortSignal }) {
    const dir = directory(options.idempotencyKey)
    try {
      const saved = JSON.parse(await readFile(join(dir, 'task.json'), 'utf8')) as unknown
      if (!object(saved) || typeof saved.externalTaskId !== 'string' || !/^video:[a-zA-Z0-9_-]{1,256}$/.test(saved.externalTaskId)) throw unknown()
      return { externalTaskId: saved.externalTaskId }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw unknown() }
    const secret = await apiKey()
    const body = await bodyFor(request, options.signal)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    try { await writeFile(join(dir, 'intent'), '', { flag: 'wx', mode: 0o600, flush: true }) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw unknown()
      throw new ProviderError('rejected', 'Cannot save MiniMax submission intent; request not submitted')
    }
    let result
    try { result = await api(endpoint('video'), secret, body, options.signal) }
    catch (error) {
      if (error instanceof CreateRejection) {
        try { await rm(join(dir, 'intent')) } catch { throw unknown() }
      }
      throw error
    }
    if (typeof result.task_id !== 'string' || !/^[a-zA-Z0-9_-]{1,256}$/.test(result.task_id) || containsKey(result.task_id, secret)) throw unknown()
    const saved = { externalTaskId: `video:${result.task_id}` }
    try { await writeFile(join(dir, 'task.json'), JSON.stringify(saved), { flag: 'wx', mode: 0o600, flush: true }) }
    catch { throw unknown() }
    return saved
  }
  async function videoTask(id: string, signal?: AbortSignal): Promise<ProviderTaskState> {
    const secret = await apiKey()
    const result = await api(endpoint('videoQuery', { id }), secret, undefined, signal)
    const task = result.task
    if (!object(task) || task.id !== id) throw new ProviderError('transient', 'MiniMax task identity cannot be confirmed')
    if (task.status === 'queued') return { state: 'pending' }
    if (task.status === 'running') return { state: 'running' }
    if (task.status === 'cancelled') return { state: 'cancelled' }
    if (task.status === 'failed') {
      const error = object(task.error) ? task.error : {}
      const code = Number(error.code)
      return { state: 'failed', error: { code: moderation(code) ? 'generation.moderation_rejected' : 'minimax_failed', message: redact(typeof error.message === 'string' ? error.message : 'MiniMax generation failed', secret).slice(0, 2000) } }
    }
    if (task.status !== 'succeeded') throw new ProviderError('transient', 'MiniMax task status cannot be confirmed')
    const url = object(task.content) ? task.content.url : undefined
    if (typeof url !== 'string' || containsKey(url, secret) || /authorization|bearer/i.test(url)) throw new ProviderError('rejected', 'MiniMax output URL is invalid')
    urls.set(id, { url: outputUrl(url, 'MiniMax output URL is invalid'), at: Date.now() })
    return { state: 'succeeded', outputs: [{ ref: `video:${id}`, outputIndex: 0 }] }
  }
  return {
    id: opts.id, type: 'minimax',
    kinds: [...(opts.videoModels.length ? ['video' as const] : []), ...(opts.imageModels.length ? ['image' as const] : [])],
    models: [...opts.videoModels, ...opts.imageModels].map(model => model.id),
    defaultModels: { ...(opts.videoModels[0] ? { video: opts.videoModels[0].id } : {}), ...(opts.imageModels[0] ? { image: opts.imageModels[0].id } : {}) },
    paramsSchema: z.strictObject({}), paramsSchemaFor: minimaxParamsSchema,
    operationsFor: (kind, model) => MINIMAX_MODELS.some(entry => entry.kind === kind && entry.id === model) ? ['generate'] : [],
    frameModesFor: (kind, model) => MINIMAX_MODELS.some(entry => entry.kind === kind && entry.id === model) && kind === 'video' ? ['first', 'first_last'] : [],
    referenceImageLimitFor: (kind, model) => MINIMAX_MODELS.find(entry => entry.kind === kind && entry.id === model)?.references ?? 0,
    prepareRequest, validateInputs,
    async submit(req, options) {
      options.signal?.throwIfAborted()
      if (req.kind === 'image') {
        const secret = await apiKey()
        const body = await bodyFor(req, options.signal)
        const result = await staging(secret, body).submit(req, options)
        return { externalTaskId: `image:${result.externalTaskId}` }
      }
      const key = directory(options.idempotencyKey)
      const existing = inflight.get(key)
      if (existing) return existing
      const pending = submitVideo(req, options).finally(() => inflight.delete(key))
      inflight.set(key, pending)
      return pending
    },
    async getTask(externalTaskId, options) {
      if (/^image:[a-f0-9]{64}$/.test(externalTaskId)) {
        const state = await staging('').getTask(externalTaskId.slice(6))
        return state.state === 'succeeded' ? { ...state, outputs: state.outputs.map(output => ({ ...output, ref: `image:${output.ref}` })) } : state
      }
      if (!/^video:[a-zA-Z0-9_-]{1,256}$/.test(externalTaskId)) throw new ProviderError('not_found', 'Invalid MiniMax task ID')
      return videoTask(externalTaskId.slice(6), options?.signal)
    },
    // DELETE chooses cancellation or deletion at execution time. A preceding GET cannot protect a paid output.
    // Omit cancel until MiniMax documents an atomic cancel-only operation or an expected-state condition.
    async download(output, options) {
      if (!Number.isInteger(output.outputIndex) || output.outputIndex < 0) throw new ProviderError('rejected', 'Invalid MiniMax output index')
      if (/^image:[a-f0-9]{64}$/.test(output.ref)) return staging('').download({ ...output, ref: output.ref.slice(6) })
      if (!/^video:[a-zA-Z0-9_-]{1,256}$/.test(output.ref) || output.outputIndex !== 0) throw new ProviderError('not_found', 'Invalid MiniMax output reference')
      const id = output.ref.slice(6)
      for (let attempt = 0; attempt < 2; attempt++) {
        const cached = urls.get(id)
        if (!cached || Date.now() - cached.at >= 55 * 60_000) {
          if ((await videoTask(id, options?.signal)).state !== 'succeeded') throw new ProviderError('transient', 'MiniMax output is not available yet')
        }
        let response: Response
        try { response = await fetcher(urls.get(id)!.url, { redirect: 'error', signal: signalFor(options?.signal) }) }
        catch { throw new ProviderError('transient', 'MiniMax output download could not be completed') }
        if ([401, 403, 404, 410].includes(response.status)) {
          await response.body?.cancel().catch(() => {})
          urls.delete(id)
          if (!attempt) continue
          throw new ProviderError('not_found', 'MiniMax output URL expired or output is unavailable after refresh')
        }
        if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new ProviderError('transient', 'MiniMax output download failed') }
        const mime = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
        if (mime !== 'video/mp4') { await response.body?.cancel().catch(() => {}); throw new ProviderError('rejected', 'MiniMax output MIME type is invalid', 'generation.output_type_invalid') }
        try { return await probe(await boundedBody(response, maxBytes), mime) }
        catch (error) {
          if (error instanceof ProviderError) throw error
          throw new ProviderError('transient', 'MiniMax output download could not be completed')
        }
      }
      throw new ProviderError('not_found', 'MiniMax output is unavailable')
    },
    cleanup: options => staging('').cleanup!(options),
  }
}
