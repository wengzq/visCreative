import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { MediaTools } from '@vis/assets'
import type { GenerationOperation, MediaKind } from '@vis/protocol'
import { z } from 'zod'
import { boundedBody } from '../download'
import { containsKey, isObject as object, outputUrl, redact, providerEndpoint, providerPaths } from '../http'
import type { ProviderEntry } from '../registry'
import { ProviderError, type ProviderAdapter, type ProviderInputMetadata, type ProviderRequest, type ProviderTaskState } from '../types'
import { DASHSCOPE_MODELS, dashscopeModel, dashscopeParamsSchema } from './models'
import { pngHasAlpha, sniffDashScopeMime } from './media'

export const DASHSCOPE_ENDPOINTS = [
  { id: 'image', label: { zh: '图片生成', en: 'Image generation' }, path: '/services/aigc/image-generation/generation' },
  { id: 'video', label: { zh: '视频生成', en: 'Video generation' }, path: '/services/aigc/video-generation/video-synthesis' },
  { id: 'task', label: { zh: '任务查询', en: 'Task query' }, path: '/tasks/{id}', requiredFor: ['image', 'video'] },
  { id: 'cancel', label: { zh: '任务取消', en: 'Task cancellation' }, path: '/tasks/{id}/cancel' },
] as const

export const DASHSCOPE_REGIONS = [
  { id: 'beijing', label: { zh: '北京', en: 'Beijing' }, baseUrl: 'https://dashscope.aliyuncs.com/api/v1' },
  { id: 'singapore', label: { zh: '新加坡', en: 'Singapore' }, baseUrl: 'https://dashscope-intl.aliyuncs.com/api/v1' },
] as const
export const DASHSCOPE_MAX_OUTPUT_BYTES = 256 * 1024 * 1024
const MAX_INPUT_BYTES = 20_000_000
const MAX_REQUEST_BYTES = 250 * 1024 * 1024
const inflight = new Map<string, Promise<{ externalTaskId: string }>>()
const taskIdSchema = z.string().regex(/^(?:image|video):[a-zA-Z0-9_-]{1,256}$/)
const savedSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('submitting') }),
  z.object({ state: z.literal('accepted'), externalTaskId: taskIdSchema }),
  z.object({ state: z.literal('rejected'), reason: z.string(), message: z.string() }),
])
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
type Options = Omit<ProviderEntry, 'type'> & {
  dataDir: string
  getKey(): Promise<string | undefined>
  media: MediaTools
  fetch?: typeof globalThis.fetch
  timeoutMs?: number
}
class CreateRejection extends ProviderError {}
const moderation = (code: unknown) => code === 'DataInspectionFailed' || code === 'data_inspection_failed'
const unknownSubmit = () => new ProviderError('timeout', 'DashScope submission result is unknown; not resubmitted')

function prepareRequest(req: ProviderRequest): ProviderRequest {
  const texts = req.inputs.flatMap(input => input.type === 'text' && input.text.trim() && input.text !== req.prompt ? [input.text] : [])
  return { ...req, prompt: [req.prompt, ...texts].filter(Boolean).join('\n\n'), inputs: req.inputs.filter(input => input.type === 'asset') }
}

function validateInputs(kind: MediaKind, id: string, inputs: ProviderInputMetadata[], params: Record<string, unknown>, operation: GenerationOperation) {
  const model = dashscopeModel(kind, id)
  if (operation !== 'generate') throw new ProviderError('rejected', 'DashScope supports generation only', 'generation.provider_input_unsupported')
  if (inputs.some(input => input.mime === 'image/svg+xml')) throw new ProviderError('rejected', 'Export SVG references as PNG before using DashScope', 'generation.svg_reference_unsupported')
  if (inputs.some(input => input.kind !== 'image' || !['image/png', 'image/jpeg', 'image/webp'].includes(input.mime))) throw new ProviderError('rejected', 'DashScope accepts PNG, JPEG and WebP image inputs only', 'generation.provider_input_unsupported')
  const frames = inputs.filter(input => input.frameRole)
  const references = inputs.filter(input => !input.frameRole)
  if (frames.length && (model.mode === 'text' || model.mode === 'image')) throw new ProviderError('rejected', 'This DashScope model does not support frames', 'generation.provider_input_unsupported')
  if (frames.length && (frames.filter(input => input.frameRole === 'first').length !== 1 || frames.filter(input => input.frameRole === 'last').length > (model.mode === 'frames' || model.mode === 'unified' ? 1 : 0))) throw new ProviderError('rejected', 'DashScope frame roles do not match the model', 'generation.provider_input_unsupported')
  if (model.mode === 'frames') {
    if (frames.length ? references.length > 0 : references.length !== 1) throw new ProviderError('rejected', 'DashScope image-to-video needs a first frame, with an optional last frame', 'generation.provider_input_unsupported')
  } else if (model.mode === 'unified' && frames.length && references.length) {
    throw new ProviderError('rejected', 'Wan3.0 cannot combine frames with reference images', 'generation.provider_input_unsupported')
  } else if (references.length > model.references || (model.mode === 'reference' && !references.length)) {
    throw new ProviderError('rejected', 'DashScope reference count does not match the model', 'generation.provider_input_unsupported')
  }
  const customPixels = typeof params.size === 'string' && params.size.includes('*') ? params.size.split('*').map(Number).reduce((width, height) => width * height) : undefined
  if (model.mode === 'image' && inputs.length && (params.size === '4K' || (customPixels !== undefined && customPixels > 2048 ** 2))) throw new ProviderError('rejected', 'DashScope output above 2K requires text-to-image without references', 'generation.provider_input_unsupported')
}

export function createDashScopeProvider(opts: Options): ProviderAdapter {
  const baseUrl = providerEndpoint(opts.baseUrl, DASHSCOPE_REGIONS, opts.region, 'DashScope requires a valid endpoint matching the selected region')
  const endpoint = providerPaths(DASHSCOPE_ENDPOINTS, opts.endpoints, 'DashScope endpoint paths are invalid')
  const fetcher = opts.fetch ?? globalThis.fetch
  const root = resolve(opts.dataDir, 'dashscope', hash(`${opts.id}:${baseUrl}`))
  const directory = (key: string) => join(root, hash(key))
  const signalFor = (signal?: AbortSignal) => AbortSignal.any([AbortSignal.timeout(opts.timeoutMs ?? 120_000), ...(signal ? [signal] : [])])
  async function apiKey() {
    let key: string | undefined
    try { key = await opts.getKey() } catch { throw new ProviderError('rejected', 'Cannot read the DashScope API key', 'generation.provider_key_unreadable') }
    if (key && /[\r\n]/.test(key)) throw new ProviderError('rejected', 'DashScope API key contains invalid characters', 'generation.provider_auth_failed')
    if (!key?.trim()) throw new ProviderError('rejected', 'Configure a DashScope API key first', 'generation.provider_auth_failed')
    return key.trim()
  }
  async function api(path: string, secret: string, options: { body?: unknown; cancel?: boolean; signal?: AbortSignal | undefined } = {}): Promise<unknown> {
    const creating = options.body !== undefined
    let response: Response
    try {
      response = await fetcher(`${baseUrl}${path}`, {
        method: creating || options.cancel ? 'POST' : 'GET', redirect: 'error', signal: signalFor(options.signal),
        headers: { Authorization: `Bearer ${secret}`, ...(creating ? { 'Content-Type': 'application/json', 'X-DashScope-Async': 'enable' } : {}) },
        ...(creating ? { body: JSON.stringify(options.body) } : {}),
      })
    } catch { throw new ProviderError(creating ? 'timeout' : 'transient', 'DashScope request result cannot be confirmed') }
    let result: unknown
    try { result = JSON.parse(Buffer.from(await boundedBody(response, 2 * 1024 * 1024)).toString('utf8')) }
    catch {
      if (response.ok || response.status >= 500 || response.status === 408) throw new ProviderError(creating ? 'timeout' : 'transient', 'DashScope response cannot be confirmed')
    }
    if (!response.ok || (object(result) && typeof result.code === 'string' && result.code.length)) {
      if (response.status >= 500 || response.status === 408) throw new ProviderError(creating ? 'timeout' : 'transient', 'DashScope service result cannot be confirmed')
      const code = object(result) ? result.code : undefined
      if (!creating && response.status === 404) throw new ProviderError('not_found', 'DashScope task does not exist or has expired')
      const reason = moderation(code) ? 'generation.moderation_rejected'
        : response.status === 401 || code === 'InvalidApiKey' ? 'generation.provider_auth_failed'
          : ['Arrearage', 'InsufficientBalance', 'AllocationQuota.FreeTierOnly'].includes(String(code)) ? 'generation.provider_balance'
            : response.status === 413 ? 'generation.provider_request_too_large' : 'generation.provider_request_rejected'
      // No client task ID exists. Only explicit 4xx responses establish rejection; ambiguous errors retain the intent.
      if (creating && (response.status < 400 || response.status >= 500)) throw unknownSubmit()
      throw new (creating ? CreateRejection : ProviderError)('rejected', 'DashScope request rejected', reason)
    }
    return result
  }
  async function stored(key: string) {
    try { return savedSchema.parse(JSON.parse(await readFile(join(directory(key), 'task.json'), 'utf8'))) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw unknownSubmit()
    }
  }
  function existing(saved: z.infer<typeof savedSchema>): { externalTaskId: string } {
    if (saved.state === 'accepted') return { externalTaskId: saved.externalTaskId }
    if (saved.state === 'rejected') throw new ProviderError('rejected', saved.message, saved.reason)
    throw unknownSubmit()
  }
  async function probeBytes(data: Uint8Array, mime: string) {
    await mkdir(root, { recursive: true, mode: 0o700 })
    const dir = await mkdtemp(join(root, 'probe-'))
    try {
      const file = join(dir, `media.${mime === 'video/mp4' ? 'mp4' : mime.split('/')[1]}`)
      await writeFile(file, data)
      return await opts.media.probe(file)
    } finally { await rm(dir, { recursive: true, force: true }) }
  }
  async function bodyFor(original: ProviderRequest, signal?: AbortSignal) {
    const req = prepareRequest(original)
    const model = dashscopeModel(req.kind, req.model)
    if (!(req.kind === 'image' ? opts.imageModels : opts.videoModels).some(model => model.id === req.model)) throw new ProviderError('rejected', 'DashScope model is not configured', 'generation.provider_input_unsupported')
    // Wan3.0 documents 20,000 characters and truncates beyond it; earlier models stop at 5000
    const promptLimit = model.mode === 'unified' ? 20_000 : 5000
    if (!req.prompt.trim() || Array.from(req.prompt).length > promptLimit) throw new ProviderError('rejected', `DashScope prompt must contain 1 to ${promptLimit} characters`, 'generation.provider_input_unsupported')
    const parsed = model.schema.safeParse(req.params)
    if (!parsed.success) throw new ProviderError('rejected', 'Invalid DashScope parameters', 'generation.provider_input_unsupported')
    const params: Record<string, unknown> = parsed.data
    const inputs = [
      ...req.inputs.map(input => ({ input, role: undefined as 'first' | 'last' | undefined })),
      ...(req.frames ? [{ input: req.frames.first, role: 'first' as const }, ...(req.frames.last ? [{ input: req.frames.last, role: 'last' as const }] : [])] : []),
    ]
    validateInputs(req.kind, req.model, inputs.map(({ input, role }) => ({ kind: input.type === 'asset' ? input.kind : 'image', mime: input.type === 'asset' ? input.mime : '', ...(role ? { frameRole: role } : {}) })), params, req.operation)
    const images: { url: string; type: string }[] = []
    for (const { input, role } of inputs) {
      if (input.type !== 'asset') throw new ProviderError('rejected', 'DashScope requires image assets', 'generation.provider_input_unsupported')
      try {
        const info = await stat(input.path)
        if (!info.isFile() || info.size > MAX_INPUT_BYTES) throw new ProviderError('rejected', 'DashScope input exceeds 20 MB', 'generation.provider_input_too_large')
        const bytes = await readFile(input.path, { signal })
        if (bytes.length > MAX_INPUT_BYTES) throw new ProviderError('rejected', 'DashScope input exceeds 20 MB', 'generation.provider_input_too_large')
        if (sniffDashScopeMime(bytes) !== input.mime || (input.mime === 'image/png' && pngHasAlpha(bytes))) throw new ProviderError('rejected', 'DashScope input format is invalid or has a PNG alpha channel', 'generation.provider_input_unsupported')
        const media = await probeBytes(bytes, input.mime)
        if (media.mime !== input.mime || !media.width || !media.height || media.width < 240 || media.height < 240 || media.width > 8000 || media.height > 8000 || media.width / media.height < 1 / 8 || media.width / media.height > 8) throw new ProviderError('rejected', 'DashScope input dimensions are invalid', 'generation.provider_input_unsupported')
        images.push({ url: `data:${input.mime};base64,${bytes.toString('base64')}`, type: role ? `${role}_frame` : model.mode === 'frames' ? 'first_frame' : 'reference_image' })
      } catch (error) {
        if (error instanceof ProviderError) throw error
        throw new ProviderError('rejected', 'Cannot read DashScope input image', 'generation.provider_input_unsupported')
      }
    }
    if (req.kind === 'image') return {
      path: endpoint('image'),
      body: { model: req.model, input: { messages: [{ role: 'user', content: [...images.map(({ url }) => ({ image: url })), { text: req.prompt }] }] }, parameters: params },
    }
    const { n: _n, negative_prompt, ...parameters } = params
    // Wan2.7 frame models take the ratio from the frame; Wan3.0 accepts one with frames (adaptive by default)
    if (req.frames && model.mode !== 'unified') delete parameters.ratio
    return {
      path: endpoint('video'),
      body: { model: req.model, input: { prompt: req.prompt, ...(negative_prompt !== undefined ? { negative_prompt } : {}), ...(images.length ? { media: images } : {}) }, parameters },
    }
  }
  async function submit(request: ProviderRequest, key: string, signal?: AbortSignal) {
    signal?.throwIfAborted()
    const saved = await stored(key)
    if (saved) return existing(saved)
    const secret = await apiKey()
    const { path, body } = await bodyFor(request, signal)
    if (Buffer.byteLength(JSON.stringify(body)) > MAX_REQUEST_BYTES) throw new ProviderError('rejected', 'DashScope request exceeds the size limit', 'generation.provider_request_too_large')
    signal?.throwIfAborted()
    const file = join(directory(key), 'task.json')
    try {
      await mkdir(directory(key), { recursive: true, mode: 0o700 })
      await writeFile(file, JSON.stringify({ state: 'submitting' }), { flag: 'wx', mode: 0o600, flush: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        const saved = await stored(key)
        if (saved) return existing(saved)
        throw unknownSubmit()
      }
      throw new ProviderError('rejected', 'Cannot save DashScope submission intent; request not submitted')
    }
    let externalTaskId: string
    try {
      const result = await api(path, secret, { body, signal })
      const id = object(result) && object(result.output) ? result.output.task_id : undefined
      if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,256}$/.test(id) || containsKey(id, secret)) throw unknownSubmit()
      externalTaskId = `${request.kind}:${id}`
    } catch (error) {
      if (error instanceof CreateRejection) {
        try { await writeFile(file, JSON.stringify({ state: 'rejected', reason: error.reason, message: error.message }), { mode: 0o600, flush: true }) }
        catch { throw unknownSubmit() }
      }
      throw error
    }
    try { await writeFile(file, JSON.stringify({ state: 'accepted', externalTaskId }), { mode: 0o600, flush: true }) }
    catch { throw unknownSubmit() }
    return { externalTaskId }
  }
  function parseId(externalTaskId: string) {
    if (!taskIdSchema.safeParse(externalTaskId).success) throw new ProviderError('not_found', 'DashScope task ID is invalid')
    const [kind, id] = externalTaskId.split(':') as ['image' | 'video', string]
    return { kind, id }
  }
  async function task(id: string, secret: string, signal?: AbortSignal) {
    const result = await api(endpoint('task', { id }), secret, { signal })
    if (!object(result) || !object(result.output) || result.output.task_id !== id || typeof result.output.task_status !== 'string') throw new ProviderError('transient', 'DashScope task response cannot be confirmed')
    return result.output
  }
  function safeUrl(value: unknown, secret: string) {
    if (typeof value !== 'string' || containsKey(value, secret) || /authorization|bearer/i.test(value)) throw new ProviderError('rejected', 'DashScope output URL is invalid', 'generation.output_type_invalid')
    return outputUrl(value, 'DashScope output URL is invalid')
  }
  function failed(output: Record<string, unknown>, secret: string) {
    const blocked = moderation(output.code)
    return {
      state: 'failed' as const,
      error: {
        code: blocked ? 'provider_rejected' : 'dashscope_failed',
        message: redact(typeof output.message === 'string' ? output.message : 'DashScope generation failed', secret).slice(0, 2000),
        ...(blocked ? { data: { reason: 'generation.moderation_rejected' } } : {}),
      },
    }
  }
  return {
    id: opts.id, type: 'dashscope', pollIntervalMs: 15_000,
    kinds: [...(opts.imageModels.length ? ['image' as const] : []), ...(opts.videoModels.length ? ['video' as const] : [])],
    models: [...opts.imageModels, ...opts.videoModels].map(model => model.id),
    defaultModels: { ...(opts.imageModels[0] ? { image: opts.imageModels[0].id } : {}), ...(opts.videoModels[0] ? { video: opts.videoModels[0].id } : {}) },
    paramsSchema: z.strictObject({}), paramsSchemaFor: dashscopeParamsSchema,
    operationsFor: (kind, id) => DASHSCOPE_MODELS.some(model => model.kind === kind && model.id === id) ? ['generate'] : [],
    frameModesFor: (kind, id) => {
      const mode = DASHSCOPE_MODELS.find(model => model.kind === kind && model.id === id)?.mode
      return mode === 'frames' || mode === 'unified' ? ['first', 'first_last'] : mode === 'reference' ? ['first'] : []
    },
    referenceImageLimitFor: (kind, id) => DASHSCOPE_MODELS.find(model => model.kind === kind && model.id === id)?.references ?? 0,
    validateInputs, prepareRequest,
    submit(request, { idempotencyKey, signal }) {
      const path = directory(idempotencyKey)
      const pending = inflight.get(path)
      if (pending) return pending
      const promise = submit(request, idempotencyKey, signal).finally(() => inflight.delete(path))
      inflight.set(path, promise)
      return promise
    },
    async getTask(externalTaskId, options): Promise<ProviderTaskState> {
      const { kind, id } = parseId(externalTaskId)
      const secret = await apiKey()
      const output = await task(id, secret, options?.signal)
      if (output.task_status === 'UNKNOWN') throw new ProviderError('not_found', 'DashScope task is unknown or expired; not resubmitted')
      if (output.task_status === 'PENDING') return { state: 'pending' }
      if (output.task_status === 'RUNNING') return { state: 'running' }
      if (output.task_status === 'CANCELED') return { state: 'cancelled' }
      if (output.task_status === 'FAILED') return failed(output, secret)
      if (output.task_status !== 'SUCCEEDED') throw new ProviderError('transient', 'DashScope task status cannot be confirmed')
      if (moderation(output.code)) return failed(output, secret)
      // The generic task API can include partial failures. A blocked subtask must not be silently delivered.
      if (Array.isArray(output.results)) {
        const blocked = output.results.find(value => object(value) && moderation(value.code))
        if (object(blocked)) return failed(blocked, secret)
      }
      const urls: unknown[] = kind === 'video' ? [output.video_url] : []
      if (kind === 'image' && Array.isArray(output.choices)) {
        for (const choice of output.choices) {
          if (!object(choice) || !object(choice.message) || !Array.isArray(choice.message.content)) throw new ProviderError('transient', 'DashScope image output format cannot be confirmed')
          for (const content of choice.message.content) {
            if (object(content) && content.type === 'image') urls.push(content.image)
          }
        }
      }
      if (!urls.length) throw new ProviderError('transient', 'DashScope completed task has no confirmed outputs')
      const outputs = urls.map((url, outputIndex) => ({ outputIndex, ref: safeUrl(url, secret) }))
      // Wan video tasks report the prompt-extended text they actually rendered (RFC 0039 §2). The runner trims and caps it.
      const revised = kind === 'video' && typeof output.actual_prompt === 'string' ? redact(output.actual_prompt, secret).trim() : ''
      return { state: 'succeeded', outputs, ...(revised ? { revisedPrompt: revised } : {}) }
    },
    async cancel(externalTaskId, options) {
      const { id } = parseId(externalTaskId)
      const secret = await apiKey()
      try {
        const current = await task(id, secret, options?.signal)
        if (current.task_status === 'CANCELED') return { cancelled: true }
        if (current.task_status !== 'PENDING') return { cancelled: false }
        const result = await api(endpoint('cancel', { id }), secret, { cancel: true, signal: options?.signal })
        // The documented successful response is a JSON request-ID string, not a task object.
        if (typeof result === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(result) && !containsKey(result, secret)) return { cancelled: true }
        if (object(result) && object(result.output) && result.output.task_id === id && result.output.task_status === 'CANCELED') return { cancelled: true }
        return { cancelled: (await task(id, secret, options?.signal)).task_status === 'CANCELED' }
      } catch { return { cancelled: false } }
    },
    async download(output, options) {
      if (!Number.isInteger(output.outputIndex) || output.outputIndex < 0) throw new ProviderError('rejected', 'Invalid DashScope output index')
      const secret = await apiKey()
      const url = safeUrl(output.ref, secret)
      try {
        const response = await fetcher(url, { redirect: 'error', signal: signalFor(options?.signal) })
        if (!response.ok) {
          await response.body?.cancel()
          throw new ProviderError([403, 404, 410].includes(response.status) ? 'not_found' : 'transient', 'DashScope output download failed or URL expired')
        }
        const mime = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
        if (!mime || !['image/png', 'video/mp4'].includes(mime)) {
          await response.body?.cancel()
          throw new ProviderError('rejected', 'DashScope output MIME type is invalid', 'generation.output_type_invalid')
        }
        const data = await boundedBody(response, DASHSCOPE_MAX_OUTPUT_BYTES)
        if (sniffDashScopeMime(data) !== mime) throw new ProviderError('rejected', 'DashScope output bytes do not match the MIME type', 'generation.output_type_invalid')
        let info
        try { info = await probeBytes(data, mime) }
        catch { throw new ProviderError('rejected', 'DashScope output media could not be validated', 'generation.output_type_invalid') }
        if (info.mime !== mime || !info.width || !info.height) throw new ProviderError('rejected', 'DashScope output media is invalid', 'generation.output_type_invalid')
        return { data, mime, width: info.width, height: info.height, ...(info.durationMs !== undefined ? { durationMs: info.durationMs } : {}), ...(info.fps !== undefined ? { fps: info.fps } : {}) }
      } catch (error) {
        if (error instanceof ProviderError) throw error
        throw new ProviderError('transient', 'DashScope output download could not be completed')
      }
    },
  }
}
