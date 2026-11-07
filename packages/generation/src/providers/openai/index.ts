import { readFile, stat } from 'node:fs/promises'
import type { GenerationOperation, MediaKind } from '@vis/protocol'
import { boundedBody, OutputSizeLimitError } from '../download'
import { isObject as object, providerPaths, redact } from '../http'
import { stageSyncOutput } from '../sync'
import { ProviderError, type ProviderAdapter, type ProviderInputMetadata, type ProviderRequest } from '../types'
import { imageOutput } from './image'
import { OPENAI_ENDPOINTS, OPENAI_MAX_INPUT_BYTES, OPENAI_MAX_OUTPUT_BYTES, OPENAI_REFERENCE_LIMIT, openaiParamsSchema } from './params'

export type OpenAIProviderOptions = {
  id: string
  baseUrl: string
  imageModels: readonly { id: string; label: string }[]
  endpoints?: Record<string, string> | undefined
  dataDir: string
  getKey(): Promise<string | undefined>
  fetch?: typeof globalThis.fetch
  timeoutMs?: number
  maxOutputBytes?: number
}

const mimeTypes = ['image/png', 'image/jpeg', 'image/webp']
const unknownResult = () => new ProviderError('timeout', 'OpenAI image generation result is unknown; not resubmitted')

function validateInputs(kind: MediaKind, _model: string, inputs: ProviderInputMetadata[], _params: Record<string, unknown>, operation: GenerationOperation) {
  if (kind !== 'image' || operation !== 'generate') throw new ProviderError('rejected', 'This service supports image generation only', 'generation.provider_input_unsupported')
  if (inputs.some(input => input.frameRole)) throw new ProviderError('rejected', 'Image generation does not support video frame inputs', 'generation.provider_input_unsupported')
  if (inputs.some(input => input.mime === 'image/svg+xml')) throw new ProviderError('rejected', 'Export SVG references as PNG before image generation', 'generation.svg_reference_unsupported')
  if (inputs.some(input => input.kind !== 'image' || !mimeTypes.includes(input.mime))) throw new ProviderError('rejected', 'Image references must be PNG, JPEG or WebP', 'generation.provider_input_unsupported')
  if (inputs.length > OPENAI_REFERENCE_LIMIT) throw new ProviderError('rejected', 'At most four image references are supported', 'generation.provider_input_unsupported')
}

function prepareRequest(request: ProviderRequest): ProviderRequest {
  const texts = request.inputs.flatMap(input => input.type === 'text' && input.text.trim() && input.text !== request.prompt ? [input.text] : [])
  return { ...request, prompt: [request.prompt, ...texts].filter(Boolean).join('\n\n'), inputs: request.inputs.filter(input => input.type === 'asset') }
}

export function createOpenAIProvider(opts: OpenAIProviderOptions): ProviderAdapter {
  const baseUrl = opts.baseUrl.replace(/\/+$/, '')
  const endpoint = providerPaths(OPENAI_ENDPOINTS, opts.endpoints, 'OpenAI endpoint paths are invalid')
  const fetcher = opts.fetch ?? globalThis.fetch
  const maxBytes = opts.maxOutputBytes ?? OPENAI_MAX_OUTPUT_BYTES
  // Each submission captures its own validated key; concurrent calls cannot overwrite one another's credentials.
  const staging = (secret: string) => stageSyncOutput({
    dataDir: opts.dataDir, providerId: opts.id, maxBytes, mimeTypes,
    async call(request, { idempotencyKey, signal }) {
      const req = prepareRequest(request)
      validateInputs(req.kind, req.model, req.inputs.flatMap(input => input.type === 'asset' ? [input] : []), req.params, req.operation)
      if (req.frames) throw new ProviderError('rejected', 'Image generation does not support video frame inputs', 'generation.provider_input_unsupported')
      if (!opts.imageModels.some(model => model.id === req.model)) throw new ProviderError('rejected', 'The selected image model is not configured', 'generation.provider_input_unsupported')
      if (!req.prompt.trim()) throw new ProviderError('rejected', 'Image generation requires a prompt', 'generation.provider_input_unsupported')
      const parsed = openaiParamsSchema(req.model).safeParse(req.params)
      if (!parsed.success) throw new ProviderError('rejected', 'Invalid image generation parameters', 'generation.provider_input_unsupported')
      const fields = { model: req.model, prompt: req.prompt, ...parsed.data }
      let body: string | FormData = JSON.stringify(fields)
      const images = req.inputs.filter(input => input.type === 'asset')
      if (images.length) {
        const form = new FormData()
        for (const [name, value] of Object.entries(fields)) if (value !== undefined) form.append(name, String(value))
        for (const [index, input] of images.entries()) {
          try {
            const info = await stat(input.path)
            if (!info.isFile() || info.size >= OPENAI_MAX_INPUT_BYTES) throw new ProviderError('rejected', 'Each image reference must be under 50 MB', 'generation.provider_input_too_large')
            const bytes = await readFile(input.path, { signal })
            if (bytes.length >= OPENAI_MAX_INPUT_BYTES) throw new ProviderError('rejected', 'Each image reference must be under 50 MB', 'generation.provider_input_too_large')
            const image = imageOutput(bytes)
            if (!image || image.mime !== input.mime) throw new ProviderError('rejected', 'Image reference bytes do not match the declared format', 'generation.provider_input_unsupported')
            form.append('image[]', new Blob([bytes], { type: image.mime }), `reference-${index}.${image.mime === 'image/jpeg' ? 'jpg' : image.mime.slice(6)}`)
          } catch (error) {
            if (error instanceof ProviderError) throw error
            throw new ProviderError('rejected', 'Cannot read image reference', 'generation.provider_input_unsupported')
          }
        }
        body = form
      }
      let response: Response
      let result: unknown
      try {
        response = await fetcher(`${baseUrl}${endpoint(images.length ? 'edit' : 'generate')}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${secret}`, 'X-Client-Request-Id': idempotencyKey, ...(typeof body === 'string' ? { 'Content-Type': 'application/json' } : {}) },
          body, redirect: 'error',
          signal: AbortSignal.any([AbortSignal.timeout(opts.timeoutMs ?? 300_000), ...(signal ? [signal] : [])]),
        })
      } catch { throw unknownResult() }
      if (!response.ok && (response.status < 400 || response.status >= 500)) {
        await response.body?.cancel().catch(() => {})
        throw unknownResult()
      }
      if (response.ok || /\bapplication\/(?:[\w.-]+\+)?json\b/i.test(response.headers.get('content-type') ?? '')) {
        try {
          // Bound the complete JSON envelope before base64 decoding; neither error bodies nor usage are persisted.
          const bytes = await boundedBody(response, response.ok ? Math.ceil(maxBytes * 4 / 3) * parsed.data.n + 65_536 : 65_536)
          result = JSON.parse(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8'))
        } catch (error) {
          if (response.ok) {
            if (error instanceof OutputSizeLimitError) return []
            throw unknownResult()
          }
          // A known 4xx rejection remains known even if its optional diagnostic body cannot be read.
        }
      } else await response.body?.cancel().catch(() => {})
      const error = object(result) && object(result.error) ? result.error : undefined
      const message = redact(typeof error?.message === 'string' ? error.message : `Image generation request failed (HTTP ${response.status})`, secret).slice(0, 2000)
      if (response.status === 401) throw new ProviderError('rejected', message, 'generation.provider_auth_failed')
      if (error?.code === 'moderation_blocked') {
        const stage = object(error.moderation_details) ? error.moderation_details.moderation_stage : undefined
        if (stage === 'input') throw new ProviderError('rejected', 'The request was blocked by input moderation', 'generation.moderation_rejected')
        return {
          state: 'failed',
          error: {
            code: 'moderation_blocked', reason: 'generation.moderation_rejected',
            message: stage === 'output' ? 'The image was generated and then blocked by output moderation' : 'Image generation was blocked by moderation after it may have run; billing cannot be confirmed',
          },
        }
      }
      if (!response.ok) {
        // Docs checked 2026-11: the error guide also names explicit credit, spend and usage limit codes.
        if (['insufficient_quota', 'credit_balance_exhausted', 'organization_spend_limit_exceeded', 'project_spend_limit_exceeded', 'organization_usage_limit_exceeded'].includes(String(error?.code))) {
          throw new ProviderError('rejected', message, 'generation.provider_balance')
        }
        if (response.status === 403 && /verif/i.test(message)) throw new ProviderError('rejected', message, 'generation.provider_verification_required')
        if (response.status === 413) throw new ProviderError('rejected', message, 'generation.provider_request_too_large')
        if (response.status === 429) throw new ProviderError('transient', message)
        if (response.status >= 400 && response.status < 500) throw new ProviderError('rejected', message, 'generation.provider_request_rejected')
        throw unknownResult()
      }
      if (!object(result) || !Array.isArray(result.data) || !result.data.length || result.data.length > parsed.data.n) return []
      const outputs = []
      for (const item of result.data) {
        if (!object(item) || typeof item.b64_json !== 'string' || !item.b64_json.length ||
          item.b64_json.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(item.b64_json)) return []
        const data = Buffer.from(item.b64_json, 'base64')
        if (data.includes(secret) || data.includes(encodeURIComponent(secret))) return []
        // A completed call with invalid media must become a durable failed task, not a retryable rejection.
        if (data.length > maxBytes) return []
        const output = imageOutput(data)
        if (!output) return []
        outputs.push(output)
      }
      return outputs
    },
  })
  return {
    id: opts.id, type: 'openai', kinds: ['image'], models: opts.imageModels.map(model => model.id),
    defaultModels: opts.imageModels[0] ? { image: opts.imageModels[0].id } : {},
    paramsSchema: openaiParamsSchema('gpt-image-2'),
    paramsSchemaFor: (_kind, model) => openaiParamsSchema(model),
    operationsFor: kind => kind === 'image' ? ['generate'] : [],
    frameModesFor: () => [],
    referenceImageLimitFor: () => OPENAI_REFERENCE_LIMIT,
    validateInputs, prepareRequest,
    ...staging(''),
    async submit(request, options) {
      options.signal?.throwIfAborted()
      let key: string | undefined
      try { key = await opts.getKey() }
      catch { throw new ProviderError('rejected', 'Cannot read the generation service API key', 'generation.provider_key_unreadable') }
      if (key && /[\r\n]/.test(key)) throw new ProviderError('rejected', 'The generation service API key contains invalid characters', 'generation.provider_auth_failed')
      const secret = key?.trim()
      if (!secret) throw new ProviderError('rejected', 'Configure an API key for this service first', 'generation.provider_auth_failed')
      return staging(secret).submit(request, options)
    },
  }
}
