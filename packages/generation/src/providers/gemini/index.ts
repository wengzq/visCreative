import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { MediaTools } from '@vis/assets'
import type { GenerationOperation, MediaKind } from '@vis/protocol'
import { z } from 'zod'
import { boundedBody, OutputSizeLimitError } from '../download'
import { containsKey, isObject as object, providerEndpoint, providerPaths } from '../http'
import type { ProviderEntry } from '../registry'
import { stageSyncOutput } from '../sync'
import { ProviderError, type ProviderAdapter, type ProviderInputMetadata, type ProviderRequest, type ProviderTaskState } from '../types'
import { decodeBase64, IMAGE_MIMES, probeOutput, sniffMime } from './media'
import { GEMINI_BASE_URL, GEMINI_ENDPOINTS, GEMINI_MAX_IMAGE_BYTES, GEMINI_MAX_INPUT_BYTES, GEMINI_MAX_VIDEO_BYTES, geminiModel, geminiParamsSchema } from './models'

type Options = Omit<ProviderEntry, 'type'> & {
  dataDir: string
  getKey(): Promise<string | undefined>
  media: MediaTools
  fetch?: typeof globalThis.fetch
  timeoutMs?: number
  maxImageBytes?: number
  maxVideoBytes?: number
}
const hash = (key: string) => createHash('sha256').update(key).digest('hex')
const inflight = new Map<string, Promise<{ externalTaskId: string }>>()
const unknownResult = () => new ProviderError('timeout', 'Gemini submission result is unknown; not resubmitted')
const blockedCodes = new Set(['safety', 'recitation', 'prohibited_content', 'spii', 'blocklist', 'image_safety', 'image_prohibited_content', 'image_recitation', 'image_other', 'content_blocked', 'language'])
const blocked = (code: unknown) => typeof code === 'string' && blockedCodes.has(code.toLowerCase().split(/[/:#]/).at(-1) ?? '')
const safetyBlocked = (result: Record<string, unknown>) => blocked(object(result.error) ? result.error.code : undefined) ||
  (Array.isArray(result.errors) && result.errors.some(error => object(error) && blocked(error.code)))
const moderationFailure = () => ({
  state: 'failed' as const,
  error: { code: 'gemini_safety_blocked', message: 'Gemini blocked the generated output; billing cannot be confirmed', reason: 'generation.moderation_rejected' },
})
const endpointPath = (base: string) => new URL(base).pathname.replace(/\/$/, '')
const invalidFailure = () => ({ state: 'failed' as const, error: { code: 'gemini_output_invalid', message: 'Gemini completed the call but returned unusable output' } })

export function createGeminiProvider(opts: Options): ProviderAdapter {
  const baseUrl = providerEndpoint(opts.baseUrl, [{ id: 'global', baseUrl: GEMINI_BASE_URL }], opts.region, 'Gemini requires a valid endpoint matching the selected region')
  const endpoint = providerPaths(GEMINI_ENDPOINTS, opts.endpoints, 'Gemini endpoint paths are invalid')
  const fetcher = opts.fetch ?? globalThis.fetch
  const root = resolve(opts.dataDir, 'gemini', hash(opts.id))
  const directory = (key: string) => join(root, hash(key))
  const maxImageBytes = opts.maxImageBytes ?? GEMINI_MAX_IMAGE_BYTES
  const maxVideoBytes = opts.maxVideoBytes ?? GEMINI_MAX_VIDEO_BYTES
  const signalFor = (signal?: AbortSignal) => AbortSignal.any([AbortSignal.timeout(opts.timeoutMs ?? 300_000), ...(signal ? [signal] : [])])
  async function apiKey() {
    let key: string | undefined
    try { key = await opts.getKey() }
    catch { throw new ProviderError('rejected', 'Cannot read the generation service API key', 'generation.provider_key_unreadable') }
    if (!key?.trim() || /[^\x20-\x7e]/.test(key)) throw new ProviderError('rejected', 'Configure a valid Gemini API key first', 'generation.provider_auth_failed')
    return key.trim()
  }
  async function api(path: string, secret: string, options: { body?: unknown; signal?: AbortSignal | undefined; creating?: boolean; maxBytes?: number; interaction?: boolean } = {}) {
    let response: Response
    try {
      response = await fetcher(`${baseUrl}${path}`, {
        method: options.body === undefined ? 'GET' : 'POST', redirect: 'error', signal: signalFor(options.signal),
        headers: { 'x-goog-api-key': secret, 'Content-Type': 'application/json', ...(options.interaction ? { 'Api-Revision': '2026-05-20' } : {}) },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      })
    } catch { throw new ProviderError(options.creating ? 'timeout' : 'transient', 'Gemini request result cannot be confirmed') }
    if (response.status >= 500 || [408, 409, 499].includes(response.status)) {
      await response.body?.cancel().catch(() => {})
      throw new ProviderError(options.creating ? 'timeout' : 'transient', 'Gemini service result cannot be confirmed')
    }
    let result: unknown
    try { result = JSON.parse(Buffer.from(await boundedBody(response, response.ok ? options.maxBytes ?? 2 * 1024 * 1024 : 65_536)).toString('utf8')) }
    catch (error) {
      if (response.ok) {
        if (error instanceof OutputSizeLimitError) throw error
        throw new ProviderError(options.creating ? 'timeout' : 'transient', 'Gemini response cannot be confirmed')
      }
    }
    const error = object(result) && object(result.error) ? result.error : undefined
    if (!response.ok) {
      if (!options.creating && blocked(error?.code)) return { error }
      const reason = blocked(error?.code) ? 'generation.moderation_rejected'
        : response.status === 401 || response.status === 403 ? 'generation.provider_auth_failed'
          : response.status === 402 ? 'generation.provider_balance'
            : response.status === 413 ? 'generation.provider_request_too_large' : 'generation.provider_request_rejected'
      if (!options.creating && response.status === 404) throw new ProviderError('not_found', 'Gemini resource expired or does not exist')
      if (response.status === 429) throw new ProviderError('transient', 'Gemini request exceeded the rate or quota limit')
      throw new ProviderError('rejected', `Gemini request rejected (HTTP ${response.status})`, reason)
    }
    if (!object(result)) throw new ProviderError(options.creating ? 'timeout' : 'transient', 'Gemini response format cannot be confirmed')
    return result
  }
  function validateInputs(kind: MediaKind, model: string, inputs: ProviderInputMetadata[], _params: Record<string, unknown>, operation: GenerationOperation) {
    const entry = geminiModel(kind, model)
    if (!entry || operation !== 'generate') throw new ProviderError('rejected', 'Gemini model or operation is unsupported', 'generation.provider_input_unsupported')
    if (inputs.some(input => input.mime === 'image/svg+xml')) throw new ProviderError('rejected', 'Export SVG references as PNG first', 'generation.svg_reference_unsupported')
    if (inputs.some(input => input.kind !== 'image' || !IMAGE_MIMES.includes(input.mime))) throw new ProviderError('rejected', 'Gemini references must be PNG, JPEG or WebP images', 'generation.provider_input_unsupported')
    const frames = inputs.filter(input => input.frameRole)
    if (frames.length && (kind !== 'video' || frames.length !== inputs.length || frames.filter(input => input.frameRole === 'first').length !== 1 || frames.filter(input => input.frameRole === 'last').length > 1)) {
      throw new ProviderError('rejected', 'Gemini frames cannot be combined with references and require one first frame', 'generation.provider_input_unsupported')
    }
    if (inputs.length > entry.references) throw new ProviderError('rejected', 'Too many Gemini image references', 'generation.provider_input_unsupported')
  }
  function prepareRequest(req: ProviderRequest): ProviderRequest {
    const texts = req.inputs.flatMap(input => input.type === 'text' && input.text.trim() && input.text !== req.prompt ? [input.text] : [])
    return { ...req, prompt: [req.prompt, ...texts].filter(Boolean).join('\n\n'), inputs: req.inputs.filter(input => input.type === 'asset') }
  }
  async function bodyFor(original: ProviderRequest, signal?: AbortSignal) {
    const req = prepareRequest(original)
    const configured = req.kind === 'image' ? opts.imageModels : req.kind === 'video' ? opts.videoModels : []
    if (!configured.some(model => model.id === req.model) || !req.prompt.trim()) throw new ProviderError('rejected', 'Gemini requires a configured model and a prompt', 'generation.provider_input_unsupported')
    const parsed = geminiParamsSchema(req.kind, req.model).safeParse(req.params)
    if (!parsed.success) throw new ProviderError('rejected', 'Invalid Gemini generation parameters', 'generation.provider_input_unsupported')
    const inputs = req.frames ? [req.frames.first, ...(req.frames.last ? [req.frames.last] : [])] : req.inputs
    const metadata = req.frames ? [
      ...req.inputs.flatMap(input => input.type === 'asset' ? [input] : []),
      ...inputs.map((input, index) => ({ kind: input.type === 'asset' ? input.kind : 'image' as const, mime: input.type === 'asset' ? input.mime : '', frameRole: index === 0 ? 'first' as const : 'last' as const })),
    ] : inputs.flatMap(input => input.type === 'asset' ? [input] : [])
    validateInputs(req.kind, req.model, metadata, req.params, req.operation)
    const images: { mime: string; data: string }[] = []
    for (const input of inputs) {
      if (input.type !== 'asset') throw new ProviderError('rejected', 'Gemini frames require image assets', 'generation.provider_input_unsupported')
      try {
        const info = await stat(input.path)
        if (!info.isFile() || info.size > GEMINI_MAX_INPUT_BYTES) throw new ProviderError('rejected', 'Gemini reference exceeds the adapter size limit', 'generation.provider_input_too_large')
        const bytes = await readFile(input.path, { signal })
        if (bytes.length > GEMINI_MAX_INPUT_BYTES) throw new ProviderError('rejected', 'Gemini reference exceeds the adapter size limit', 'generation.provider_input_too_large')
        if (sniffMime(bytes) !== input.mime) throw new ProviderError('rejected', 'Gemini reference bytes do not match the MIME type', 'generation.provider_input_unsupported')
        await probeOutput(bytes, input.mime, root, opts.media)
        images.push({ mime: input.mime, data: bytes.toString('base64') })
      } catch (error) {
        if (error instanceof ProviderError) throw error
        throw new ProviderError('rejected', 'Cannot read Gemini reference image', 'generation.provider_input_unsupported')
      }
    }
    const params = parsed.data
    const body = req.kind === 'image' ? {
      contents: [{ role: 'user', parts: [{ text: req.prompt }, ...images.map(image => ({ inlineData: { mimeType: image.mime, data: image.data } }))] }],
      generationConfig: { responseModalities: ['TEXT', 'IMAGE'], ...(params.aspect_ratio || params.image_size ? { imageConfig: { ...(params.aspect_ratio ? { aspectRatio: params.aspect_ratio } : {}), ...(params.image_size ? { imageSize: params.image_size } : {}) } } : {}) },
    } : {
      model: req.model, background: true, store: true,
      input: [...images.map(image => ({ type: 'image', mime_type: image.mime, data: image.data })), { type: 'text', text: req.prompt }],
      response_format: { type: 'video', delivery: 'uri', ...params },
      ...(images.length ? { generation_config: { video_config: { task: req.frames ? 'image_to_video' : 'reference_to_video' } } } : {}),
    }
    if (Buffer.byteLength(JSON.stringify(body)) > 50 * 1024 * 1024) throw new ProviderError('rejected', 'Gemini request exceeds the adapter size limit', 'generation.provider_request_too_large')
    return { req, body }
  }
  const images = (secret: string) => stageSyncOutput({
    dataDir: opts.dataDir, providerId: `${opts.id}:gemini-image`, maxBytes: maxImageBytes, mimeTypes: IMAGE_MIMES,
    async call(original, { signal }) {
      const { req, body } = await bodyFor(original, signal)
      let result: Record<string, unknown>
      try { result = await api(endpoint('image', { model: req.model }), secret, { body, signal, creating: true, maxBytes: Math.ceil(maxImageBytes * 4 / 3) + 65_536 }) }
      catch (error) { if (error instanceof OutputSizeLimitError) return []; throw error }
      const feedback = object(result.promptFeedback) ? result.promptFeedback : undefined
      if (feedback?.blockReason && feedback.blockReason !== 'BLOCK_REASON_UNSPECIFIED') {
        // IMAGE_SAFETY explicitly describes generated candidates, even inside prompt feedback.
        if (feedback.blockReason === 'IMAGE_SAFETY') return moderationFailure()
        throw new ProviderError('rejected', 'Gemini blocked the prompt', 'generation.moderation_rejected')
      }
      if (!Array.isArray(result.candidates) || !result.candidates.length) return []
      if (result.candidates.some(candidate => object(candidate) && (blocked(candidate.finishReason) || (Array.isArray(candidate.safetyRatings) && candidate.safetyRatings.some(rating => object(rating) && rating.blocked === true))))) return moderationFailure()
      const outputs = []
      for (const candidate of result.candidates) {
        if (!object(candidate) || !object(candidate.content) || !Array.isArray(candidate.content.parts)) return []
        for (const part of candidate.content.parts) {
          if (!object(part) || part.thought === true || !object(part.inlineData)) continue
          const mime = part.inlineData.mimeType
          const data = decodeBase64(part.inlineData.data, maxImageBytes)
          if (typeof mime !== 'string' || !IMAGE_MIMES.includes(mime) || !data || data.includes(secret) || data.includes(encodeURIComponent(secret))) return []
          try { outputs.push(await probeOutput(data, mime, root, opts.media)) }
          catch { return [] }
        }
      }
      return outputs
    },
  })
  function videoStaging(result?: Record<string, unknown>, secret = '') {
    return stageSyncOutput({
      dataDir: opts.dataDir, providerId: `${opts.id}:gemini-video`, maxBytes: maxVideoBytes, mimeTypes: ['video/mp4'],
      async call() {
        if (!result) throw new ProviderError('timeout', 'Gemini video output is not staged')
        if (safetyBlocked(result)) return moderationFailure()
        if (result.status === 'failed' || result.status === 'incomplete') return { state: 'failed', error: { code: 'gemini_failed', message: 'Gemini generation failed; billing cannot be confirmed' } }
        const content = Array.isArray(result.steps) ? result.steps.flatMap(step => object(step) && step.type === 'model_output' && Array.isArray(step.content) ? step.content : []) : []
        const videos = content.filter(item => object(item) && item.type === 'video')
        if (content.some(item => object(item) && item.type === 'refusal')) return moderationFailure()
        if (!videos.length) return invalidFailure()
        const outputs = []
        for (const video of videos) {
          if (!object(video) || video.mime_type !== 'video/mp4') return invalidFailure()
          const data = decodeBase64(video.data, maxVideoBytes)
          // Polled results currently use inline data even when URI delivery was requested.
          if (!data && video.data === undefined && typeof video.uri === 'string') {
            const downloaded = await downloadUri(video.uri, secret)
            outputs.push(downloaded)
            continue
          }
          if (!data || data.includes(secret) || data.includes(encodeURIComponent(secret))) return invalidFailure()
          try { outputs.push(await probeOutput(data, 'video/mp4', root, opts.media)) }
          catch { return invalidFailure() }
        }
        return outputs
      },
    })
  }
  function interactionId(external: string, secret = '') {
    const id = external.startsWith('video:') ? external.slice(6) : ''
    if (!/^[A-Za-z0-9_-]{1,2048}$/.test(id) || (secret && containsKey(id, secret))) throw new ProviderError('not_found', 'Gemini interaction ID is invalid')
    return id
  }
  function fileId(value: string, secret: string) {
    let url: URL
    try { url = new URL(value) } catch { throw new ProviderError('rejected', 'Gemini file URI is invalid') }
    // A gateway may relay Google's file URI unchanged; the key still goes only to the configured host.
    const base = [baseUrl, GEMINI_BASE_URL].find(base => new URL(base).origin === url.origin && url.pathname.startsWith(`${endpointPath(base)}/files/`))
    const file = base ? /^\/files\/([A-Za-z0-9_-]+)(?::download)?$/.exec(url.pathname.slice(endpointPath(base).length)) : null
    if (!file || url.username || url.password || url.hash ||
      [...url.searchParams].some(([name, value]) => name !== 'alt' || value !== 'media') || containsKey(value, secret)) {
      throw new ProviderError('rejected', 'Gemini file URI is invalid')
    }
    return file[1]!
  }
  async function downloadUri(ref: string, secret: string, signal?: AbortSignal) {
    const id = fileId(ref, secret)
    const info = await api(endpoint('file', { id }), secret, { signal })
    if (info.state === 'FAILED') throw new ProviderError('rejected', 'Gemini video file processing failed', 'generation.output_type_invalid')
    if (info.state !== 'ACTIVE') throw new ProviderError('transient', 'Gemini video file is still processing')
    const url = new URL(`${baseUrl}${endpoint('fileDownload', { id })}`)
    url.searchParams.set('alt', 'media')
    let response: Response
    try { response = await fetcher(url.href, { headers: { 'x-goog-api-key': secret }, redirect: 'error', signal: signalFor(signal) }) }
    catch { throw new ProviderError('transient', 'Gemini file download could not be completed') }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      throw new ProviderError(response.status === 404 || response.status === 403 ? 'not_found' : 'transient', 'Gemini file expired or could not be downloaded')
    }
    if (response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'video/mp4') {
      await response.body?.cancel()
      throw new ProviderError('rejected', 'Gemini video MIME type is invalid', 'generation.output_type_invalid')
    }
    let data: Uint8Array
    try { data = await boundedBody(response, maxVideoBytes) }
    catch (error) { if (error instanceof ProviderError) throw error; throw new ProviderError('transient', 'Gemini file download was interrupted') }
    if (Buffer.from(data).includes(secret) || Buffer.from(data).includes(encodeURIComponent(secret))) throw new ProviderError('rejected', 'Gemini file contains invalid output')
    return probeOutput(data, 'video/mp4', root, opts.media)
  }
  async function submitVideo(original: ProviderRequest, key: string, secret: string, signal?: AbortSignal) {
    const dir = directory(key)
    const stored = join(dir, 'task.json')
    try {
      const record: unknown = JSON.parse(await readFile(stored, 'utf8'))
      if (!object(record) || typeof record.externalTaskId !== 'string') throw unknownResult()
      interactionId(record.externalTaskId, secret)
      return { externalTaskId: record.externalTaskId }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw unknownResult() }
    try {
      await stat(join(dir, 'intent'))
      throw unknownResult()
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw unknownResult() }
    const { body } = await bodyFor(original, signal)
    signal?.throwIfAborted()
    await mkdir(dir, { recursive: true, mode: 0o700 })
    try { await writeFile(join(dir, 'intent'), '', { flag: 'wx', mode: 0o600, flush: true }) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw unknownResult()
      throw new ProviderError('rejected', 'Cannot save Gemini submission intent')
    }
    let result: Record<string, unknown>
    try { result = await api(endpoint('video'), secret, { body, signal, creating: true, interaction: true }) }
    catch (error) {
      if (error instanceof ProviderError && ['rejected', 'transient'].includes(error.kind)) await rm(join(dir, 'intent'), { force: true })
      if (error instanceof OutputSizeLimitError) throw unknownResult()
      throw error
    }
    if (blocked(object(result.error) ? result.error.code : undefined)) throw unknownResult()
    if (typeof result.id !== 'string') throw unknownResult()
    const externalTaskId = `video:${result.id}`
    try {
      interactionId(externalTaskId, secret)
      await writeFile(stored, JSON.stringify({ externalTaskId }), { flag: 'wx', mode: 0o600, flush: true })
    } catch { throw unknownResult() }
    return { externalTaskId }
  }
  const dummy: ProviderRequest = { kind: 'video', model: 'gemini-omni-1.1-flash', operation: 'generate', prompt: '', params: {}, inputs: [] }
  return {
    id: opts.id, type: 'gemini',
    kinds: [...(opts.imageModels.length ? ['image' as const] : []), ...(opts.videoModels.length ? ['video' as const] : [])],
    models: [...opts.imageModels, ...opts.videoModels].map(model => model.id),
    defaultModels: { ...(opts.imageModels[0] ? { image: opts.imageModels[0].id } : {}), ...(opts.videoModels[0] ? { video: opts.videoModels[0].id } : {}) },
    paramsSchema: z.strictObject({}), paramsSchemaFor: geminiParamsSchema,
    operationsFor: (kind, model) => geminiModel(kind, model) ? ['generate'] : [],
    frameModesFor: (kind, model) => geminiModel(kind, model) && kind === 'video' ? ['first', 'first_last'] : [],
    referenceImageLimitFor: (kind, model) => geminiModel(kind, model)?.references ?? 0,
    validateInputs, prepareRequest,
    async submit(req, options) {
      options.signal?.throwIfAborted()
      const secret = await apiKey()
      if (req.kind === 'image') {
        const result = await images(secret).submit(req, options)
        return { externalTaskId: `image:${result.externalTaskId}` }
      }
      const path = directory(options.idempotencyKey)
      const existing = inflight.get(path)
      if (existing) return existing
      const pending = submitVideo(req, options.idempotencyKey, secret, options.signal).finally(() => inflight.delete(path))
      inflight.set(path, pending)
      return pending
    },
    async getTask(external, options): Promise<ProviderTaskState> {
      if (external.startsWith('image:')) {
        const state = await images('').getTask(external.slice(6), options)
        return state.state === 'succeeded' ? { ...state, outputs: state.outputs.map(output => ({ ...output, ref: `image:${output.ref}` })) } : state
      }
      const id = interactionId(external)
      const local = videoStaging()
      const localId = hash(external)
      try {
        const state = await local.getTask(localId)
        return state.state === 'succeeded' ? { ...state, outputs: state.outputs.map(output => ({ ...output, ref: `video-output:${output.ref}` })) } : state
      } catch (error) { if (!(error instanceof ProviderError) || error.kind !== 'not_found') throw error }
      const secret = await apiKey()
      interactionId(external, secret)
      const result = await api(endpoint('task', { id }), secret, { signal: options?.signal, maxBytes: Math.ceil(maxVideoBytes * 4 / 3) + 65_536, interaction: true })
      if (result.id !== id && !object(result.error)) throw new ProviderError('transient', 'Gemini interaction identity cannot be confirmed')
      if (result.status === 'cancelled') return { state: 'cancelled' }
      if (!['completed', 'failed', 'incomplete'].includes(String(result.status)) && !object(result.error)) return { state: 'running' }
      const staged = videoStaging(result, secret)
      await staged.submit(dummy, { idempotencyKey: external, ...(options?.signal ? { signal: options.signal } : {}) })
      const state = await staged.getTask(localId)
      return state.state === 'succeeded' ? { ...state, outputs: state.outputs.map(output => ({ ...output, ref: `video-output:${output.ref}` })) } : state
    },
    async cancel(external, options) {
      if (external.startsWith('image:') || !endpoint.configured('cancel')) return { cancelled: false }
      const secret = await apiKey()
      const id = interactionId(external, secret)
      await api(endpoint('cancel', { id }), secret, { body: {}, signal: options?.signal, interaction: true })
      // A successful cancel response is only an acknowledgement; read the resource again.
      const later = await api(endpoint('task', { id }), secret, { signal: options?.signal, interaction: true })
      return { cancelled: later.id === id && later.status === 'cancelled' }
    },
    async download(output, options) {
      if (output.ref.startsWith('image:')) return images('').download({ ...output, ref: output.ref.slice(6) }, options)
      if (output.ref.startsWith('video-output:')) return videoStaging().download({ ...output, ref: output.ref.slice(13) }, options)
      if (!Number.isInteger(output.outputIndex) || output.outputIndex < 0) throw new ProviderError('rejected', 'Invalid Gemini output index')
      return downloadUri(output.ref, await apiKey(), options?.signal)
    },
    async cleanup(options) {
      await images('').cleanup?.(options)
      try {
        const record: unknown = JSON.parse(await readFile(join(directory(options.idempotencyKey), 'task.json'), 'utf8'))
        if (object(record) && typeof record.externalTaskId === 'string') await videoStaging().cleanup?.({ ...options, idempotencyKey: record.externalTaskId })
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new ProviderError('transient', 'Cannot release staged Gemini output') }
    },
  }
}
