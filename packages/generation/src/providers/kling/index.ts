import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { MediaTools } from '@vis/assets'
import type { GenerationOperation, MediaKind } from '@vis/protocol'
import { z } from 'zod'
import { boundedBody } from '../download'
import { containsKey, isObject as object, outputUrl as validatedOutputUrl, redact, providerEndpoint, providerPaths } from '../http'
import type { ProviderEntry } from '../registry'
import { ProviderError, type ProviderAdapter, type ProviderInputMetadata, type ProviderRequest, type ProviderTaskState } from '../types'
import { KLING_MODELS, klingModel, klingParamsSchema } from './models'
import { sniffKlingMime } from './media'

export const KLING_ENDPOINTS = [
  { id: 'textToVideo', label: { zh: '文生视频', en: 'Text to video' }, path: '/text-to-video/{model}' },
  { id: 'imageToVideo', label: { zh: '图生视频', en: 'Image to video' }, path: '/image-to-video/{model}' },
  { id: 'omniVideo', label: { zh: '多模态视频', en: 'Omni video' }, path: '/omni-video/{model}' },
  { id: 'videoQuery', label: { zh: '视频任务查询', en: 'Video task query' }, path: '/tasks' },
  { id: 'image', label: { zh: '图片生成', en: 'Image generation' }, path: '/v1/images/omni-image' },
  { id: 'imageQuery', label: { zh: '图片任务查询', en: 'Image task query' }, path: '/v1/images/omni-image/{id}', requiredFor: ['image'] },
] as const

export const KLING_REGIONS = [
  { id: 'beijing', label: { zh: '北京', en: 'Beijing' }, baseUrl: 'https://api-beijing.klingai.com' },
  { id: 'singapore', label: { zh: '新加坡', en: 'Singapore' }, baseUrl: 'https://api-singapore.klingai.com' },
] as const
export const KLING_MAX_OUTPUT_BYTES = 256 * 1024 * 1024
const MAX_REQUEST_BYTES = 80 * 1024 * 1024
const inflight = new Map<string, Promise<{ externalTaskId: string }>>()
const record = z.object({ externalTaskId: z.string().regex(/^(?:video|image):[a-zA-Z0-9_-]{1,256}$/) })
const intentSchema = z.object({ kind: z.enum(['image', 'video']) })
type TaskId = z.infer<typeof record>
type Options = Omit<ProviderEntry, 'type'> & {
  dataDir: string
  getKey(): Promise<string | undefined>
  media: MediaTools
  fetch?: typeof globalThis.fetch
  timeoutMs?: number
}

// The account-wide custom ID must not expose arbitrary caller keys or include URL delimiters.
export const klingExternalId = (key: string) => createHash('sha256').update(key).digest('hex')
class CreateRejection extends ProviderError {}
function cleanId(value: unknown, secret: string): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,256}$/.test(value) || containsKey(value, secret)) {
    throw new ProviderError('timeout', 'Kling task ID cannot be confirmed')
  }
  return value
}
function outputUrl(value: unknown, secret: string): string {
  if (typeof value !== 'string' || containsKey(value, secret) || /authorization|bearer/i.test(value)) throw new ProviderError('rejected', 'Kling output URL is invalid')
  return validatedOutputUrl(value, 'Kling output URL is invalid')
}

export function createKlingProvider(opts: Options): ProviderAdapter {
  const baseUrl = providerEndpoint(opts.baseUrl, KLING_REGIONS, opts.region, 'Kling requires a valid endpoint matching the selected region')
  const endpoint = providerPaths(KLING_ENDPOINTS, opts.endpoints, 'Kling endpoint paths are invalid')
  const fetcher = opts.fetch ?? globalThis.fetch
  const root = resolve(opts.dataDir, 'kling', klingExternalId(`${opts.id}:${baseUrl}`))
  const directory = (key: string) => join(root, klingExternalId(key))
  const signalFor = (signal?: AbortSignal) => AbortSignal.any([AbortSignal.timeout(opts.timeoutMs ?? 120_000), ...(signal ? [signal] : [])])
  async function apiKey() {
    let key: string | undefined
    try { key = await opts.getKey() } catch { throw new ProviderError('rejected', 'Cannot read Kling API key', 'generation.provider_auth_failed') }
    if (!key?.trim()) throw new ProviderError('rejected', 'Configure a Kling API key first', 'generation.provider_auth_failed')
    return key.trim()
  }
  async function api(path: string, secret: string, body?: unknown, signal?: AbortSignal): Promise<Record<string, unknown> | null> {
    const creating = body !== undefined
    let response: Response
    let result: unknown
    try {
      response = await fetcher(`${baseUrl}${path}`, {
        method: creating ? 'POST' : 'GET', redirect: 'error', signal: signalFor(signal),
        headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
        ...(creating ? { body: JSON.stringify(body) } : {}),
      })
      result = JSON.parse(Buffer.from(await boundedBody(response, 2 * 1024 * 1024)).toString('utf8')) as unknown
    } catch { throw new ProviderError(creating ? 'timeout' : 'transient', 'Kling request result cannot be confirmed') }
    if (!object(result) || typeof result.code !== 'number') throw new ProviderError(creating ? 'timeout' : 'transient', 'Kling response format cannot be confirmed')
    if (!creating && response.status === 404 && result.code === 1203) return null
    if (!response.ok || result.code !== 0) {
      if (response.status >= 500) throw new ProviderError(creating ? 'timeout' : 'transient', 'Kling service result cannot be confirmed')
      const reason = result.code === 1301 ? 'generation.moderation_rejected'
        : [1101, 1102].includes(result.code) ? 'generation.provider_balance'
          : [1000, 1001, 1002, 1003, 1004, 1103].includes(result.code) || response.status === 401 ? 'generation.provider_auth_failed' : undefined
      if (creating && [1302, 1303].includes(result.code)) throw new CreateRejection('transient', 'Kling request exceeded the rate or concurrency limit')
      if (reason) throw new (creating ? CreateRejection : ProviderError)('rejected', `Kling request rejected (${result.code})`, reason)
      if (creating && ([1100, 1200, 1201, 1202, 1203, 1300, 1304].includes(result.code) || (response.status >= 400 && response.status < 500 && ![408, 429].includes(response.status)))) {
        throw new CreateRejection('rejected', `Kling request rejected (${result.code})`)
      }
      throw new ProviderError(creating ? 'timeout' : 'transient', 'Kling request result cannot be confirmed')
    }
    return result
  }
  async function stored(key: string): Promise<TaskId | null> {
    try { return record.parse(JSON.parse(await readFile(join(directory(key), 'task.json'), 'utf8'))) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw new ProviderError('timeout', 'Kling submission record cannot be read; not resubmitted')
    }
  }
  async function readIntent(key: string) {
    try { return intentSchema.parse(JSON.parse(await readFile(join(directory(key), 'intent'), 'utf8'))) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw new ProviderError('timeout', 'Kling submission intent cannot be read; not resubmitted')
    }
  }
  async function remoteLookup(key: string, kind: 'image' | 'video'): Promise<TaskId | null> {
    const secret = await apiKey()
    const externalId = klingExternalId(key)
    const response = await api(kind === 'video' ? `${endpoint('videoQuery')}?external_task_ids=${externalId}` : endpoint('imageQuery', { id: externalId }), secret)
    if (response === null) return null
    if (kind === 'video') {
      if (!Array.isArray(response.data)) throw new ProviderError('transient', 'Kling video lookup format cannot be confirmed')
      if (!response.data.length) return null
      if (response.data.length !== 1) throw new ProviderError('timeout', 'Kling custom task ID matched multiple tasks')
      const task: unknown = response.data[0]
      if (!object(task) || task.external_id !== externalId) throw new ProviderError('transient', 'Kling video lookup identity cannot be confirmed')
      return { externalTaskId: `video:${cleanId(task.id, secret)}` }
    }
    const task = response.data
    if (!object(task) || !object(task.task_info) || task.task_info.external_task_id !== externalId) throw new ProviderError('transient', 'Kling image lookup identity cannot be confirmed')
    return { externalTaskId: `image:${cleanId(task.task_id, secret)}` }
  }
  async function lookup(key: string): Promise<TaskId | null> {
    const saved = await stored(key)
    if (saved) return saved
    const intent = await readIntent(key)
    if (!intent) return null
    const found = await remoteLookup(key, intent.kind)
    if (found) return found
    // Neither expiry nor delayed indexing permits an intent that may have been paid to be submitted again.
    throw new ProviderError('timeout', 'Kling accepted task cannot be located; not resubmitted')
  }
  async function probeBytes(bytes: Uint8Array, mime: string) {
    await mkdir(root, { recursive: true, mode: 0o700 })
    const temp = await mkdtemp(join(root, 'probe-'))
    try {
      const file = join(temp, `media.${mime === 'video/mp4' ? 'mp4' : mime.split('/')[1]}`)
      await writeFile(file, bytes)
      return await opts.media.probe(file)
    } finally { await rm(temp, { recursive: true, force: true }) }
  }
  function validateInputs(kind: MediaKind, model: string, inputs: ProviderInputMetadata[], params: Record<string, unknown>, operation: GenerationOperation) {
    const capabilities = klingModel(kind, model)
    if (operation !== 'generate') throw new ProviderError('rejected', 'Kling supports generation only')
    if (inputs.some(input => input.mime === 'image/svg+xml')) throw new ProviderError('rejected', 'Export SVG inputs as PNG before using Kling', 'generation.svg_reference_unsupported')
    if (inputs.some(input => input.kind !== 'image' || !['image/png', 'image/jpeg'].includes(input.mime))) throw new ProviderError('rejected', 'Kling accepts PNG and JPEG image inputs only', 'generation.kling_input_invalid')
    if (inputs.some(input => input.frameRole) && inputs.some(input => !input.frameRole)) throw new ProviderError('rejected', 'Kling frames cannot be combined with reference inputs', 'generation.frames_reference_mix')
    const frameMode = inputs.some(input => input.frameRole) || params.imageMode === 'first_frame' || params.imageMode === 'first_last' || (params.imageMode !== 'reference' && inputs.length === 1 && kind === 'video')
    if (kind === 'image' && inputs.some(input => input.frameRole)) throw new ProviderError('rejected', 'Image generation does not support frames', 'generation.kling_input_invalid')
    if (frameMode && kind === 'video') {
      const expected = params.imageMode === 'first_last' || inputs.some(input => input.frameRole === 'last') ? 2 : 1
      if (inputs.length !== expected || (inputs.some(input => input.frameRole) && inputs.filter(input => input.frameRole === 'first').length !== 1)) throw new ProviderError('rejected', 'Kling frame count does not match the selected mode', 'generation.kling_input_invalid')
    } else if (inputs.length > capabilities.references || (params.imageMode === 'reference' && inputs.length === 0)) {
      throw new ProviderError('rejected', 'Kling reference image count is not supported by this model', 'generation.kling_input_invalid')
    }
  }
  function prepareRequest(req: ProviderRequest): ProviderRequest {
    const texts = req.inputs.flatMap(input => input.type === 'text' && input.text.trim() && input.text !== req.prompt ? [input.text] : [])
    return { ...req, prompt: [req.prompt, ...texts].filter(Boolean).join('\n\n'), inputs: req.inputs.filter(input => input.type === 'asset') }
  }
  async function bodyFor(original: ProviderRequest, externalId: string, signal?: AbortSignal) {
    const req = prepareRequest(original)
    const model = klingModel(req.kind, req.model)
    if (!(req.kind === 'image' ? opts.imageModels : opts.videoModels).some(entry => entry.id === req.model)) throw new ProviderError('rejected', 'Kling model is not configured')
    if (!req.prompt.trim() || Array.from(req.prompt).length > model.promptLength) throw new ProviderError('rejected', 'Kling prompt is empty or exceeds the model limit', 'generation.kling_prompt_invalid')
    const parsed = model.schema.safeParse(req.params)
    if (!parsed.success) throw new ProviderError('rejected', 'Invalid Kling generation parameters')
    const params: Record<string, unknown> = parsed.data
    const metadata = [
      ...req.inputs.flatMap(input => input.type === 'asset' ? [input] : []),
      ...(req.frames ? [
        { kind: 'image' as const, mime: req.frames.first.type === 'asset' ? req.frames.first.mime : '', frameRole: 'first' as const },
        ...(req.frames.last ? [{ kind: 'image' as const, mime: req.frames.last.type === 'asset' ? req.frames.last.mime : '', frameRole: 'last' as const }] : []),
      ] : []),
    ]
    validateInputs(req.kind, req.model, metadata, params, req.operation)
    const inputs = req.frames ? [req.frames.first, ...(req.frames.last ? [req.frames.last] : [])] : req.inputs
    const images: string[] = []
    let totalBytes = 0
    for (const input of inputs) {
      if (input.type !== 'asset') throw new ProviderError('rejected', 'Kling frame must be an image asset', 'generation.kling_input_invalid')
      try {
        const info = await stat(input.path)
        if (!info.isFile() || info.size > ('imageInputBytes' in model ? model.imageInputBytes : model.inputBytes) || totalBytes + info.size > 60_000_000) throw new ProviderError('rejected', 'Kling input image exceeds the size limit', 'generation.kling_input_size')
        const bytes = await readFile(input.path, signal ? { signal } : {})
        totalBytes += bytes.length
        if (bytes.length > ('imageInputBytes' in model ? model.imageInputBytes : model.inputBytes) || totalBytes > 60_000_000) throw new ProviderError('rejected', 'Kling input image exceeds the size limit', 'generation.kling_input_size')
        // Asset blobs have no extension; probe a correctly named copy using the pinned input MIME.
        if (sniffKlingMime(bytes) !== input.mime) throw new ProviderError('rejected', 'Kling input content does not match its MIME type', 'generation.kling_input_invalid')
        const infoMedia = await probeBytes(bytes, input.mime)
        if (!['image/png', 'image/jpeg'].includes(infoMedia.mime) || !infoMedia.width || !infoMedia.height || infoMedia.width < 300 || infoMedia.height < 300 || infoMedia.width / infoMedia.height < 0.4 || infoMedia.width / infoMedia.height > 2.5) {
          throw new ProviderError('rejected', 'Kling input dimensions or aspect ratio are invalid', 'generation.kling_input_invalid')
        }
        images.push(bytes.toString('base64'))
      } catch (error) {
        if (error instanceof ProviderError) throw error
        throw new ProviderError('rejected', 'Cannot read Kling input image', 'generation.kling_input_invalid')
      }
    }
    if (req.kind === 'image') return {
      path: endpoint('image'),
      body: { model_name: req.model, prompt: req.prompt, ...params, result_type: 'single', external_task_id: externalId, ...(images.length ? { image_list: images.map(image => ({ image })) } : {}) },
    }
    const firstLast = Boolean(req.frames?.last) || params.imageMode === 'first_last'
    const frames = Boolean(req.frames) || firstLast || params.imageMode === 'first_frame' || (params.imageMode === 'auto' && images.length === 1)
    const { imageMode: _mode, n: _count, ...settings } = params
    if (frames) delete settings.aspect_ratio
    const common = { settings, options: { external_task_id: externalId } }
    if (!images.length && req.model !== 'kling-3.0-omni') return { path: endpoint('textToVideo', { model: req.model }), body: { prompt: req.prompt, ...common } }
    return {
      path: endpoint(req.model === 'kling-3.0-omni' || !frames ? 'omniVideo' : 'imageToVideo', { model: req.model }),
      body: { contents: [{ type: 'prompt', text: req.prompt }, ...images.map((url, index) => ({ type: frames ? index === 0 ? 'first_frame' : 'last_frame' : 'refer_image', url, ...(!frames ? { id: `image_${index + 1}` } : {}) }))], ...common },
    }
  }
  async function submit(req: ProviderRequest, key: string, signal?: AbortSignal): Promise<TaskId> {
    signal?.throwIfAborted()
    const saved = await stored(key)
    if (saved) return saved
    if (await readIntent(key)) {
      const found = await lookup(key)
      if (found) return found
      throw new ProviderError('timeout', 'Kling submission result is unknown; not resubmitted')
    }
    const { path, body } = await bodyFor(req, klingExternalId(key), signal)
    if (Buffer.byteLength(JSON.stringify(body)) > MAX_REQUEST_BYTES) throw new ProviderError('rejected', 'Kling request exceeds the size limit', 'generation.kling_input_size')
    const secret = await apiKey()
    signal?.throwIfAborted()
    const dir = directory(key)
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 })
      await writeFile(join(dir, 'intent'), JSON.stringify({ kind: req.kind }), { flag: 'wx', mode: 0o600, flush: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        const found = await lookup(key)
        if (found) return found
        throw new ProviderError('timeout', 'Kling submission is already in progress')
      }
      throw new ProviderError('rejected', 'Cannot save Kling submission intent; request not submitted')
    }
    let task: TaskId
    try {
      const response = await api(path, secret, body, signal)
      if (!response || !object(response.data)) throw new ProviderError('timeout', 'Kling submission response cannot be confirmed')
      task = { externalTaskId: `${req.kind}:${cleanId(req.kind === 'image' ? response.data.task_id : response.data.id, secret)}` }
    } catch (error) {
      if (!(error instanceof CreateRejection)) throw error
      let found: TaskId | null
      try { found = await remoteLookup(key, intentSchema.parse({ kind: req.kind }).kind) }
      catch { throw new ProviderError('timeout', 'Kling create rejection could not be reconciled; not resubmitted') }
      if (!found) {
        // Account-unique custom IDs make rate-limit retries safe only after confirmed absence.
        try { await rm(join(dir, 'intent'), { force: true }) }
        catch { throw new ProviderError('timeout', 'Cannot release Kling submission intent; not resubmitted') }
        throw error
      }
      task = found
    }
    try { await writeFile(join(dir, 'task.json'), JSON.stringify(task), { flag: 'wx', mode: 0o600, flush: true }) }
    catch { throw new ProviderError('timeout', 'Cannot save Kling task ID; recover by custom task ID') }
    return task
  }
  async function getTask(externalTaskId: string, options?: { signal?: AbortSignal }): Promise<ProviderTaskState> {
    const matched = /^(video|image):([a-zA-Z0-9_-]{1,256})$/.exec(externalTaskId)
    if (!matched) throw new ProviderError('not_found', 'Kling task ID has no valid media prefix')
    const [, kind, id] = matched
    const secret = await apiKey()
    const response = await api(kind === 'video' ? `${endpoint('videoQuery')}?task_ids=${id}` : endpoint('imageQuery', { id: id! }), secret, undefined, options?.signal)
    if (!response) throw new ProviderError('not_found', 'Kling task does not exist')
    if (kind === 'video' && Array.isArray(response.data) && !response.data.length) throw new ProviderError('not_found', 'Kling task does not exist')
    const task: unknown = kind === 'video' && Array.isArray(response.data) && response.data.length === 1 ? response.data[0] : response.data
    if (!object(task) || (kind === 'image' ? task.task_id : task.id) !== id) throw new ProviderError('transient', 'Kling task response cannot be confirmed')
    const status = task.status ?? task.task_status
    if (status === 'submitted' || status === 'submit') return { state: 'pending' }
    if (status === 'failed') {
      const message = redact(typeof task.task_status_msg === 'string' ? task.task_status_msg : typeof task.message === 'string' ? task.message : 'Kling generation failed', secret).slice(0, 2000)
      return { state: 'failed', error: { code: /moderation|content.{0,12}(?:security|risk|policy)|sensitive|risk.control|\u5ba1\u6838|\u654f\u611f|\u8fdd\u89c4|\u98ce\u63a7/i.test(message) ? 'generation.moderation_rejected' : 'kling_failed', message } }
    }
    if (status === 'succeeded' || status === 'succeed') {
      const outputs = kind === 'image' && object(task.task_result) ? task.task_result.images : task.outputs
      if (!Array.isArray(outputs) || !outputs.length) throw new ProviderError('transient', 'Kling completed task has no confirmed outputs')
      if (outputs.some(value => !object(value))) throw new ProviderError('transient', 'Kling output format cannot be confirmed')
      const mediaOutputs = outputs.filter(value => object(value) && (kind === 'image' || value.type === 'video'))
      if (!mediaOutputs.length) throw new ProviderError('transient', 'Kling completed task has no media outputs')
      return { state: 'succeeded', outputs: mediaOutputs.map((value, outputIndex) => ({ outputIndex, ref: outputUrl((value as Record<string, unknown>).url, secret) })) }
    }
    return { state: 'running' }
  }
  return {
    id: opts.id, type: 'kling',
    kinds: [...(opts.videoModels.length ? ['video' as const] : []), ...(opts.imageModels.length ? ['image' as const] : [])],
    models: [...opts.videoModels, ...opts.imageModels].map(model => model.id),
    defaultModels: { ...(opts.videoModels[0] ? { video: opts.videoModels[0].id } : {}), ...(opts.imageModels[0] ? { image: opts.imageModels[0].id } : {}) },
    paramsSchema: z.strictObject({}), paramsSchemaFor: klingParamsSchema,
    operationsFor: (kind, model) => KLING_MODELS.some(entry => entry.kind === kind && entry.id === model) ? ['generate'] : [],
    frameModesFor: (kind, model) => KLING_MODELS.some(entry => entry.kind === kind && entry.id === model) && kind === 'video' ? ['first', 'first_last'] : [],
    referenceImageLimitFor: (kind, model) => KLING_MODELS.find(entry => entry.kind === kind && entry.id === model)?.references ?? 0,
    prepareRequest, validateInputs, getTask,
    findTaskByIdempotencyKey: lookup,
    submit(req, { idempotencyKey, signal }) {
      const path = directory(idempotencyKey)
      const existing = inflight.get(path)
      if (existing) return existing
      const promise = submit(req, idempotencyKey, signal).finally(() => inflight.delete(path))
      inflight.set(path, promise)
      return promise
    },
    async download(output, options) {
      if (!Number.isInteger(output.outputIndex) || output.outputIndex < 0) throw new ProviderError('rejected', 'Invalid Kling output index')
      const secret = await apiKey()
      const url = outputUrl(output.ref, secret)
      try {
        const response = await fetcher(url, { signal: signalFor(options?.signal), redirect: 'error' })
        if (!response.ok) throw new ProviderError(response.status === 404 || response.status === 403 ? 'not_found' : 'transient', 'Kling output download failed')
        const mime = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
        if (!mime || !['video/mp4', 'image/png', 'image/jpeg', 'image/webp'].includes(mime)) {
          await response.body?.cancel()
          throw new ProviderError('rejected', 'Kling output MIME type is invalid', 'generation.output_type_invalid')
        }
        const data = await boundedBody(response, KLING_MAX_OUTPUT_BYTES)
        if (sniffKlingMime(data) !== mime) throw new ProviderError('rejected', 'Kling output content does not match its MIME type', 'generation.output_type_invalid')
        try {
          const info = await probeBytes(data, mime)
          if (info.mime !== mime) throw new ProviderError('rejected', 'Kling output content does not match its MIME type', 'generation.output_type_invalid')
          return { data, mime, ...(info.width !== undefined ? { width: info.width } : {}), ...(info.height !== undefined ? { height: info.height } : {}), ...(info.durationMs !== undefined ? { durationMs: info.durationMs } : {}), ...(info.fps !== undefined ? { fps: info.fps } : {}) }
        } catch { throw new ProviderError('rejected', 'Kling output media could not be validated', 'generation.output_type_invalid') }
      } catch (error) {
        if (error instanceof ProviderError) throw error
        throw new ProviderError('transient', 'Kling output download could not be completed')
      }
    },
  }
}
