import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtemp, readFile, readdir, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProviderError } from '../types'
import { providerContract } from '../contract'
import type { ProviderOutputRef, ProviderRequest } from '../types'
import { ARK_MAX_INPUT_BYTES, ARK_MAX_PROMPT_LENGTH, arkImageParamsSchema, arkParamsSchema, arkVideoParamsSchema, createArkProvider } from './index'

type Request = { method: string | undefined; path: string | undefined; headers: IncomingMessage['headers']; body: Record<string, unknown> }
const cleanups: (() => Promise<unknown>)[] = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})

function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

async function setup(handler: (req: Request, res: ServerResponse) => void = (_req, res) => json(res, { data: [{ url: 'https://output.invalid/a.png', size: '128x96' }] })) {
  const dir = await mkdtemp(join(tmpdir(), 'vis-ark-test-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const requests: Request[] = []
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const body = Buffer.concat(chunks).toString('utf8')
    const request = { method: req.method, path: req.url, headers: req.headers, body: body ? JSON.parse(body) as Record<string, unknown> : {} }
    requests.push(request)
    handler(request, res)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise<void>((resolve, reject) => {
    server.closeAllConnections()
    server.close(error => error ? reject(error) : resolve())
  }))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Test HTTP service has not started')
  const origin = `http://127.0.0.1:${address.port}`
  const getKey = vi.fn(async () => 'secret-do-not-expose')
  const options = { id: 'test-ark', dataDir: dir, baseUrl: `${origin}/api/v3/`, imageModels: [{ id: 'configured-image', label: '图片模型' }], videoModels: [{ id: 'configured-video', label: '视频模型' }], getKey }
  return { dir, requests, origin, getKey, options, provider: createArkProvider(options) }
}

const imageRequest: ProviderRequest = { operation: 'generate', kind: 'image', model: 'configured-image', prompt: '蓝色天空', params: {}, inputs: [] }
const videoRequest: ProviderRequest = { ...imageRequest, kind: 'video', model: 'configured-video' }

providerContract('Ark', async scenario => {
  let cancelled = false
  const test = await setup((req, res) => {
    if (req.path === '/output') {
      res.writeHead(200, { 'Content-Type': scenario === 'wrong-mime' ? 'text/html' : 'video/mp4', ...(scenario === 'oversized' ? { 'Content-Length': String(512 * 1024 * 1024) } : {}) })
      res.end('output')
    } else if (req.method === 'POST') {
      if (scenario === 'lost') res.destroy()
      else if (scenario === 'moderation') json(res, { error: { code: 'SensitiveContent', message: 'Content rejected by moderation' } }, 400)
      else if (scenario === 'secret-error') json(res, { error: { code: 'Denied', message: 'Authorization: Bearer secret-do-not-expose' } }, 400)
      else json(res, { id: 'contract-task' })
    } else if (req.method === 'DELETE') {
      cancelled = scenario === 'cancel-confirmed'
      json(res, {})
    } else json(res, { status: cancelled ? 'cancelled' : 'queued' })
  })
  return {
    adapter: test.provider, request: videoRequest, secret: 'secret-do-not-expose',
    creates: () => test.requests.filter(request => request.method === 'POST').length,
    recoversLost: false, output: { outputIndex: 0, ref: `${test.origin}/output` },
    async close() {},
  }
})

async function errorOf(promise: Promise<unknown>, kind: ProviderError['kind']): Promise<ProviderError> {
  const error = await promise.catch(error => error)
  expect(error).toBeInstanceOf(ProviderError)
  expect(error).toMatchObject({ kind })
  expect(String(error)).not.toContain('secret-do-not-expose')
  return error as ProviderError
}

async function outputsOf(provider: ReturnType<typeof createArkProvider>, externalTaskId: string): Promise<ProviderOutputRef[]> {
  const state = await provider.getTask(externalTaskId)
  if (state.state !== 'succeeded') throw new Error('Job should succeed')
  return state.outputs
}

describe('Ark provider', () => {
  it('validates frame metadata without relying on the provider type', async () => {
    const { provider, getKey } = await setup()
    const frame = { kind: 'image' as const, mime: 'image/png', frameRole: 'first' as const }
    expect(() => provider.validateInputs?.('video', 'configured-video', [frame, { kind: 'image', mime: 'image/png' }], {}, 'generate'))
      .toThrow(expect.objectContaining({ reason: 'generation.frames_reference_mix' }))
    expect(() => provider.validateInputs?.('video', 'configured-video', [frame], {}, 'generate')).not.toThrow()
    expect(getKey).not.toHaveBeenCalled()
  })
  it.each([false, true])('structured frames override imageMode and map first/last roles (last=%s)', async last => {
    const { provider, dir, requests } = await setup((_req, res) => json(res, { id: 'remote-frames' }))
    const path = join(dir, 'frame.png')
    await writeFile(path, 'image')
    const image = { type: 'asset' as const, kind: 'image' as const, mime: 'image/png', path }
    await provider.submit({ ...videoRequest, params: { imageMode: 'reference' }, frames: { first: image, ...(last ? { last: image } : {}) } }, { idempotencyKey: 'structured-frames' })
    expect((requests[0]!.body.content as { role?: string }[]).slice(1).map(item => item.role)).toEqual(last ? ['first_frame', 'last_frame'] : ['first_frame'])
    expect(provider.frameModesFor?.('video', 'configured-video')).toEqual(['first', 'first_last'])
  })

  it('rejects structured frame/reference mixing before reading media or requesting a key', async () => {
    const { provider, requests, getKey } = await setup()
    const image = { type: 'asset' as const, kind: 'image' as const, mime: 'image/png', path: '/not-read.png' }
    expect(await errorOf(provider.submit({ ...videoRequest, inputs: [image], frames: { first: image } }, { idempotencyKey: 'mixed-frames' }), 'rejected'))
      .toMatchObject({ reason: 'generation.frames_reference_mix' })
    expect(getKey).not.toHaveBeenCalled()
    expect(requests).toHaveLength(0)
  })
  it('models come entirely from configuration, with defaults and parameters by media type', async () => {
    const { provider, options } = await setup()
    expect(provider.id).toBe('test-ark')
    expect(provider.models).toEqual(['configured-image', 'configured-video'])
    expect(provider.defaultModels).toEqual({ image: 'configured-image', video: 'configured-video' })
    expect(arkImageParamsSchema.parse({})).toEqual({ size: '2K', n: 1, watermark: false })
    expect(arkVideoParamsSchema.parse({})).toEqual({ n: 1, imageMode: 'auto', watermark: false })
    expect(createArkProvider({ ...options, videoModels: [] }).kinds).toEqual(['image'])
    expect(provider.paramsSchemas?.image).toBe(arkImageParamsSchema)
    expect(provider.paramsSchemas?.video).toBe(arkVideoParamsSchema)
  })

  it('audio models can be configured; unsupported audio generation is rejected locally', async () => {
    const { options, requests, getKey } = await setup()
    const provider = createArkProvider({ ...options, audioModels: [{ id: 'seed-audio', label: '音频' }] })
    expect(provider.kinds).toContain('audio')
    expect(provider.models).toContain('seed-audio')
    expect(provider.defaultModels.audio).toBe('seed-audio')
    const error = await errorOf(provider.submit({ ...imageRequest, kind: 'audio', model: 'seed-audio' }, { idempotencyKey: 'audio-generation' }), 'rejected')
    expect(error.message).toContain('does not yet support audio generation')
    expect(requests).toHaveLength(0)
    expect(getKey).not.toHaveBeenCalled()
  })

  it.each(['image', 'video'] as const)('direct Ark %s generation also rejects SVG references before file reads and HTTP', async kind => {
    const { provider, requests, getKey } = await setup()
    const request: ProviderRequest = {
      ...(kind === 'image' ? imageRequest : videoRequest),
      inputs: [{ type: 'asset', kind: 'image', mime: 'image/svg+xml', path: '/not-read.svg' }],
    }
    const error = await errorOf(provider.submit(request, { idempotencyKey: 'svg-reference' }), 'rejected')
    expect(error.message).toBe('SVG cannot be used as an Ark reference image; export it as PNG first')
    expect(requests).toHaveLength(0)
    expect(getKey).not.toHaveBeenCalled()
    await expect(provider.findTaskByIdempotencyKey!('svg-reference')).resolves.toBeNull()
  })

  it.each(['doubao-seedance-2-0-260128', 'doubao-seedance-2-0-fast-260128', 'doubao-seedance-2-0-mini-260615'])('%s submits WAV/MP3 audio with reference roles and data URLs, switching auto images to reference images', async model => {
    const { options, dir, requests, getKey } = await setup((_req, res) => json(res, { id: 'remote-audio-video' }))
    const probe = vi.fn(async () => ({ kind: 'audio' as const, mime: 'audio/wav', durationMs: 2000 }))
    const provider = createArkProvider({ ...options, videoModels: [{ id: model, label: '视频' }], media: { probe } })
    const image = join(dir, 'reference.png')
    const wav = join(dir, 'reference.wav')
    const mp3 = join(dir, 'reference.mp3')
    await Promise.all([writeFile(image, 'image'), writeFile(wav, 'wav'), writeFile(mp3, 'mp3')])
    const inputs: ProviderRequest['inputs'] = [
      { type: 'asset', kind: 'image', mime: 'image/png', path: image },
      { type: 'asset', kind: 'audio', mime: 'audio/wav', path: wav },
      { type: 'asset', kind: 'audio', mime: 'audio/mpeg', path: mp3, durationMs: 13000 },
    ]
    const first = await provider.submit({ ...videoRequest, model, inputs }, { idempotencyKey: 'audio-reference' })
    expect(first).toEqual({ externalTaskId: 'remote-audio-video' })
    expect(probe).toHaveBeenCalledExactlyOnceWith(wav)
    expect(requests).toHaveLength(1)
    expect(requests[0]!.body.content).toEqual([
      { type: 'text', text: '蓝色天空' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${Buffer.from('image').toString('base64')}` }, role: 'reference_image' },
      { type: 'audio_url', audio_url: { url: `data:audio/wav;base64,${Buffer.from('wav').toString('base64')}` }, role: 'reference_audio' },
      { type: 'audio_url', audio_url: { url: `data:audio/mp3;base64,${Buffer.from('mp3').toString('base64')}` }, role: 'reference_audio' },
    ])
    expect(JSON.stringify(requests[0]!.body)).not.toContain(dir)
    expect(getKey).toHaveBeenCalledTimes(1)
    await expect(provider.submit({ ...videoRequest, model, inputs }, { idempotencyKey: 'audio-reference' })).resolves.toEqual(first)
    expect(requests).toHaveLength(1)
  })

  it('validates models, audio formats, counts, durations, image combinations, and exclusive image modes before HTTP', async () => {
    const { options, requests, getKey } = await setup()
    const model = 'doubao-seedance-2-0-260128'
    const provider = createArkProvider({ ...options, videoModels: [...options.videoModels, { id: model, label: '视频' }] })
    const audio = { type: 'asset' as const, kind: 'audio' as const, mime: 'audio/wav', path: '/not-read.wav', durationMs: 2000 }
    const image = { type: 'asset' as const, kind: 'image' as const, mime: 'image/png', path: '/not-read.png' }
    const cases: { request: ProviderRequest; message: string }[] = [
      { request: { ...videoRequest, inputs: [image, audio] }, message: 'The selected model does not yet support audio references' },
      { request: { ...imageRequest, inputs: [audio] }, message: 'The selected model does not yet support audio references' },
      { request: { ...videoRequest, model, inputs: [image, { ...audio, mime: 'audio/flac' }] }, message: 'only support WAV or MP3' },
      { request: { ...videoRequest, model, inputs: [image, ...Array.from({ length: 4 }, () => audio)] }, message: 'at most 3 clips' },
      ...[1999, 15001, NaN].map(durationMs => ({ request: { ...videoRequest, model, inputs: [image, { ...audio, durationMs }] }, message: 'Each audio reference must be 2-15 seconds long' })),
      { request: { ...videoRequest, model, inputs: [image, { ...audio, durationMs: 8000 }, { ...audio, durationMs: 8000 }] }, message: 'total duration cannot exceed 15 seconds' },
      { request: { ...videoRequest, model, inputs: [audio] }, message: 'at least one reference image' },
      ...['first_frame', 'first_last'].map(imageMode => ({ request: { ...videoRequest, model, inputs: [image, audio], params: { imageMode } }, message: 'cannot be combined with first-frame or first-and-last-frame modes' })),
    ]
    for (const [index, { request, message }] of cases.entries()) {
      const error = await errorOf(provider.submit(request, { idempotencyKey: `invalid-audio-${index}` }), 'rejected')
      expect(error.message).toContain(message)
    }
    expect(requests).toHaveLength(0)
    expect(getKey).not.toHaveBeenCalled()
  })

  it('audio references larger than 15 MB are rejected before content reads and HTTP', async () => {
    const { options, dir, requests, getKey } = await setup()
    const model = 'doubao-seedance-2-0-260128'
    const provider = createArkProvider({ ...options, videoModels: [{ id: model, label: '视频' }] })
    const path = join(dir, 'large.wav')
    await writeFile(path, '')
    await truncate(path, 15_000_001)
    const request: ProviderRequest = { ...videoRequest, model, inputs: [
      { type: 'asset', kind: 'image', mime: 'image/png', path: '/not-read.png' },
      { type: 'asset', kind: 'audio', mime: 'audio/wav', path, durationMs: 2000 },
    ] }
    const error = await errorOf(provider.submit(request, { idempotencyKey: 'large-audio' }), 'rejected')
    expect(error.message).toContain('cannot exceed 15 MB')
    expect(requests).toHaveLength(0)
    expect(getKey).not.toHaveBeenCalled()
  })

  it('synchronous image submission includes local data URIs and reference text; results and dimensions remain downloadable after restart', async () => {
    const bytes = Buffer.from('image bytes')
    const context = await setup((req, res) => {
      if (req.path === '/out.png') {
        res.writeHead(200, { 'Content-Type': 'image/png' })
        res.end(bytes)
      } else json(res, { data: [{ url: `${context.origin}/out.png`, size: '128x96' }, { url: `${context.origin}/out.png`, size: '64x32' }] })
    })
    const { provider, dir, requests, options } = context
    const path = join(dir, 'input.png')
    await writeFile(path, bytes)
    const request: ProviderRequest = { ...imageRequest, params: { n: 2, size: '1024x768', watermark: true }, inputs: [
      { type: 'text', text: '蓝色天空' }, { type: 'text', text: ' 蓝色天空 ' }, { type: 'text', text: '白色云朵' }, { type: 'text', text: '白色云朵' },
      { type: 'asset', kind: 'image', mime: 'image/png', path },
    ] }
    const prepared = provider.prepareRequest!(request)
    expect(prepared.prompt).toBe('蓝色天空\n\n参考：\n 蓝色天空 \n\n参考：\n白色云朵\n\n参考：\n白色云朵')
    expect(provider.prepareRequest!(prepared)).toEqual(prepared)
    const first = await provider.submit(prepared, { idempotencyKey: 'images' })
    expect(requests[0]).toMatchObject({ method: 'POST', path: '/api/v3/images/generations', headers: { authorization: 'Bearer secret-do-not-expose' }, body: {
      model: 'configured-image', prompt: prepared.prompt, image: `data:image/png;base64,${bytes.toString('base64')}`,
      size: '1024x768', watermark: true, response_format: 'url', sequential_image_generation: 'auto', sequential_image_generation_options: { max_images: 2 },
    } })
    expect(requests[0]!.body).not.toHaveProperty('n')
    const record = await readFile(join(dir, 'ark', 'images.json'), 'utf8')
    expect(record).not.toContain('secret-do-not-expose')
    expect(record).not.toContain(path)
    const restarted = createArkProvider(options)
    await expect(restarted.findTaskByIdempotencyKey!('images')).resolves.toEqual(first)
    await expect(restarted.submit(request, { idempotencyKey: 'images' })).resolves.toEqual(first)
    const outputs = await outputsOf(restarted, first.externalTaskId)
    expect(outputs).toEqual([{ outputIndex: 0, ref: first.externalTaskId }, { outputIndex: 1, ref: first.externalTaskId }])
    expect(await restarted.download(outputs[0]!)).toEqual({ data: new Uint8Array(bytes), mime: 'image/png', width: 128, height: 96 })
    expect(await restarted.download(outputs[1]!)).toEqual({ data: new Uint8Array(bytes), mime: 'image/png', width: 64, height: 32 })
    expect(requests).toHaveLength(3)
    expect(requests[1]!.headers).not.toHaveProperty('authorization')
  })

  it('narrows parameters by model capabilities: Seedance 2.0 fast/mini supports only 480p/720p and 4-15 seconds, Seedream 5.0 pro/flash outputs single images; unregistered models use generic ranges', () => {
    const fast = arkParamsSchema('video', 'doubao-seedance-2-0-fast-260128')
    expect(fast.safeParse({ resolution: '720p', duration: 12 }).success).toBe(true)
    expect(fast.safeParse({ resolution: '1080p' }).success).toBe(false)
    expect(fast.safeParse({ duration: 30 }).success).toBe(false)
    expect(arkParamsSchema('video', 'doubao-seedance-2-0-mini-260615').safeParse({ resolution: '1080p' }).success).toBe(false)
    expect(arkParamsSchema('video', 'doubao-seedance-2-0-260128').safeParse({ resolution: '4k', duration: 15 }).success).toBe(true)
    expect(arkParamsSchema('image', 'doubao-seedream-5-0-flash-260915').safeParse({ n: 2 }).success).toBe(false)
    expect(arkParamsSchema('image', 'doubao-seedream-5-0-pro-260628').parse({})).toMatchObject({ n: 1 })
    expect(arkParamsSchema('image', 'doubao-seedream-5-0-lite-260128')).toBe(arkImageParamsSchema)
    expect(arkParamsSchema('video', 'ep-20260101-abc')).toBe(arkVideoParamsSchema)
    // Do not apply the registry when media types differ
    expect(arkParamsSchema('image', 'doubao-seedance-2-0-fast-260128')).toBe(arkImageParamsSchema)
  })

  it('unsupported model parameters reject locally without requests and identify the field', async () => {
    const { options, requests } = await setup()
    const provider = createArkProvider({ ...options, videoModels: [{ id: 'doubao-seedance-2-0-fast-260128', label: 'fast' }] })
    const error = await errorOf(provider.submit({ ...videoRequest, model: 'doubao-seedance-2-0-fast-260128', params: { resolution: '1080p' } }, { idempotencyKey: 'fast-1080p' }), 'rejected')
    expect(error.message).toContain('resolution')
    expect(requests).toHaveLength(0)
    expect(provider.paramsSchemaFor!('video', 'doubao-seedance-2-0-fast-260128')).not.toBe(arkVideoParamsSchema)
  })

  it('concurrent calls with the same idempotency key send once; single images disable groups and watermarks by default', async () => {
    const { provider, requests } = await setup()
    const results = await Promise.all(Array.from({ length: 4 }, () => provider.submit(imageRequest, { idempotencyKey: 'same' })))
    expect(new Set(results.map(result => result.externalTaskId)).size).toBe(1)
    expect(requests).toHaveLength(1)
    expect(requests[0]!.body).toMatchObject({ watermark: false, size: '2K' })
    // Omit group-image fields for single images: models without group support, such as Seedream 5.0 flash, reject even disabled
    expect(requests[0]!.body).not.toHaveProperty('sequential_image_generation')
    expect(requests[0]!.body).not.toHaveProperty('sequential_image_generation_options')
  })

  it('simultaneous submissions from different instances with the same idempotency key do not incur duplicate charges', async () => {
    const { provider, requests, options } = await setup()
    const results = await Promise.allSettled([provider.submit(imageRequest, { idempotencyKey: 'shared' }), createArkProvider(options).submit(imageRequest, { idempotencyKey: 'shared' })])
    expect(requests).toHaveLength(1)
    expect(results).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'fulfilled' })]))
    const rejected = results.find(result => result.status === 'rejected')
    if (rejected?.status === 'rejected') expect(rejected.reason).toMatchObject({ kind: 'timeout' })
    await expect(createArkProvider(options).submit(imageRequest, { idempotencyKey: 'shared' })).resolves.toEqual({ externalTaskId: 'ark-image:shared' })
    expect(requests).toHaveLength(1)
  })

  it('truncates prompts by Unicode characters; request preparation leaves inputs unchanged and is repeatable', async () => {
    const { provider } = await setup()
    const request = { ...imageRequest, prompt: '😀'.repeat(ARK_MAX_PROMPT_LENGTH + 20), inputs: [{ type: 'text' as const, text: '参考内容' }] }
    const prepared = provider.prepareRequest!(request)
    expect(Array.from(prepared.prompt)).toHaveLength(ARK_MAX_PROMPT_LENGTH)
    expect(prepared.prompt.endsWith('😀')).toBe(true)
    expect(prepared.inputs).toEqual([])
    expect(request.inputs).toHaveLength(1)
    expect(provider.prepareRequest!(prepared)).toEqual(prepared)
    const boundary = provider.prepareRequest!({ ...imageRequest, prompt: `${'a'.repeat(ARK_MAX_PROMPT_LENGTH - 1)} b` })
    expect(provider.prepareRequest!(boundary)).toEqual(boundary)
  })

  it.each([
    { status: 401, body: { error: { code: 'Unauthorized', message: 'secret-do-not-expose' } }, kind: 'rejected' },
    { status: 400, body: { error: { code: 'BadRequest', message: 'secret-do-not-expose' } }, kind: 'rejected' },
    { status: 429, body: { error: { code: 'RateLimitExceeded.EndpointRPMExceeded', message: 'secret-do-not-expose' } }, kind: 'transient' },
  ] as const)('explicit HTTP $status rejection allows later retries with the same key without leaking secrets', async ({ status, body, kind }) => {
    let count = 0
    const { provider, requests } = await setup((_req, res) => count++ === 0 ? json(res, body, status) : json(res, { data: [{ url: 'https://output.invalid/a.png' }] }))
    await errorOf(provider.submit(imageRequest, { idempotencyKey: 'retry' }), kind)
    await expect(provider.findTaskByIdempotencyKey!('retry')).resolves.toBeNull()
    await provider.submit(imageRequest, { idempotencyKey: 'retry' })
    expect(requests).toHaveLength(2)
  })

  it.each(['network', 'timeout', 'malformed', 'server-without-error', 'server-with-id', 'generic-server-error', 'no-service-error'] as const)('%s submission results are unknown; restart only queries without resubmitting', async fault => {
    const { provider, requests, options } = await setup((_req, res) => {
      if (fault === 'network') res.destroy()
      else if (fault === 'timeout') return
      else if (fault === 'malformed') res.end('not-json secret-do-not-expose')
      else if (fault === 'server-with-id') json(res, { id: 'accepted', error: { code: 'error' } }, 503)
      else if (fault === 'generic-server-error') json(res, { error: { code: 'InternalServiceError', message: 'secret-do-not-expose' } }, 500)
      else if (fault === 'no-service-error') json(res, { error: { code: 'NoAvailableService', message: 'secret-do-not-expose' } }, 503)
      else res.writeHead(503).end('secret-do-not-expose')
    })
    const current = fault === 'timeout' ? createArkProvider({ ...options, timeoutMs: 30 }) : provider
    await errorOf(current.submit(imageRequest, { idempotencyKey: 'unknown' }), 'timeout')
    const restarted = createArkProvider(options)
    await errorOf(restarted.findTaskByIdempotencyKey!('unknown'), 'timeout')
    await errorOf(restarted.submit(imageRequest, { idempotencyKey: 'unknown' }), 'timeout')
    expect(requests).toHaveLength(1)
  })

  it('unreadable or missing keys send no requests and do not persist exception information', async () => {
    const { options, requests } = await setup()
    for (const getKey of [async () => undefined, async () => { throw new Error('secret-do-not-expose') }]) {
      const provider = createArkProvider({ ...options, getKey })
      await errorOf(provider.submit(imageRequest, { idempotencyKey: 'missing-key' }), 'rejected')
      await expect(provider.findTaskByIdempotencyKey!('missing-key')).resolves.toBeNull()
    }
    expect(requests).toHaveLength(0)
  })

  it('rejects video inputs, excessive images, and wrong models before HTTP requests', async () => {
    const { provider, dir, requests } = await setup()
    const path = join(dir, 'oversized.png')
    await writeFile(path, '')
    await truncate(path, ARK_MAX_INPUT_BYTES + 1)
    const requestsToReject: ProviderRequest[] = [
      { ...imageRequest, inputs: [{ type: 'asset', kind: 'video', mime: 'video/mp4', path: '/no-such-file' }] },
      { ...imageRequest, inputs: [{ type: 'asset', kind: 'image', mime: 'image/png', path }] },
      { ...imageRequest, model: 'configured-video' },
      { ...imageRequest, params: { n: 5 } },
      { ...videoRequest, params: { n: 2 } },
    ]
    for (const request of requestsToReject) await errorOf(provider.submit(request, { idempotencyKey: 'invalid' }), 'rejected')
    expect(requests).toHaveLength(0)
    await expect(provider.findTaskByIdempotencyKey!('invalid')).resolves.toBeNull()
  })

  it.each([
    { mode: 'auto', count: 0, roles: [] },
    { mode: 'auto', count: 1, roles: ['first_frame'] },
    { mode: 'auto', count: 2, roles: ['reference_image', 'reference_image'] },
    { mode: 'first_frame', count: 1, roles: ['first_frame'] },
    { mode: 'first_last', count: 2, roles: ['first_frame', 'last_frame'] },
    { mode: 'reference', count: 1, roles: ['reference_image'] },
  ] as const)('video imageMode=$mode with image count $count maps image roles and parameters correctly', async ({ mode, count, roles }) => {
    const { provider, dir, requests, options } = await setup((_req, res) => json(res, { id: 'remote-video' }))
    const path = join(dir, 'input.png')
    await writeFile(path, 'image')
    const inputs = Array.from({ length: count }, () => ({ type: 'asset' as const, kind: 'image' as const, mime: 'image/png', path }))
    const result = await provider.submit({ ...videoRequest, inputs, params: { imageMode: mode, ratio: '9:16', resolution: '720p', duration: 5, generateAudio: true, seed: 10, cameraFixed: false } }, { idempotencyKey: 'video' })
    expect(result.externalTaskId).toBe('remote-video')
    expect(requests[0]).toMatchObject({ method: 'POST', path: '/api/v3/contents/generations/tasks', body: {
      model: 'configured-video', ratio: '9:16', resolution: '720p', duration: 5, generate_audio: true, seed: 10, camera_fixed: false, watermark: false,
    } })
    const content = requests[0]!.body.content as { type: string; role?: string; image_url?: { url: string } }[]
    expect(content[0]).toEqual({ type: 'text', text: '蓝色天空' })
    expect(content.slice(1).map(item => item.role)).toEqual(roles)
    expect(content.slice(1).every(item => item.image_url?.url.startsWith('data:image/png;base64,'))).toBe(true)
    expect(requests[0]!.body).not.toHaveProperty('imageMode')
    await expect(createArkProvider(options).findTaskByIdempotencyKey!('video')).resolves.toEqual(result)
  })

  it.each([{ imageMode: 'first_frame' }, { imageMode: 'first_last' }, { imageMode: 'reference' }])('without images, rejects modes whose required counts are unmet: %j', async params => {
    const { provider, requests } = await setup()
    await errorOf(provider.submit({ ...videoRequest, params }, { idempotencyKey: 'invalid-mode' }), 'rejected')
    expect(requests).toHaveLength(0)
  })

  it.each([
    { status: 'queued', expected: { state: 'pending' } },
    { status: 'running', expected: { state: 'running' } },
    { status: 'succeeded', expected: { state: 'succeeded', outputs: [{ outputIndex: 0, ref: 'https://output.invalid/movie.mp4' }] } },
    { status: 'failed', expected: { state: 'failed', error: { code: 'ContentRejected' } } },
    { status: 'expired', expected: { state: 'failed', error: { code: 'ContentRejected' } } },
    { status: 'cancelled', expected: { state: 'cancelled' } },
  ])('queries video through the official API and maps $status', async ({ status, expected }) => {
    const { provider, requests } = await setup((_req, res) => json(res, { status, content: { video_url: 'https://output.invalid/movie.mp4' }, error: { code: 'ContentRejected', message: 'Invalid credential secret-do-not-expose' } }))
    const result = await provider.getTask('remote/id')
    expect(result).toMatchObject(expected)
    expect(JSON.stringify(result)).not.toContain('secret-do-not-expose')
    expect(requests[0]).toMatchObject({ method: 'GET', path: '/api/v3/contents/generations/tasks/remote%2Fid' })
  })

  it('cancels queued videos: GET confirms queued, then DELETE, then confirms cancelled', async () => {
    let cancelled = false
    const { provider, requests } = await setup((req, res) => {
      if (req.method === 'DELETE') { cancelled = true; json(res, {}) }
      else json(res, { status: cancelled ? 'cancelled' : 'queued' })
    })
    await expect(provider.cancel!('remote/id')).resolves.toEqual({ cancelled: true })
    expect(requests.map(req => [req.method, req.path])).toEqual([
      ['GET', '/api/v3/contents/generations/tasks/remote%2Fid'],
      ['DELETE', '/api/v3/contents/generations/tasks/remote%2Fid'],
      ['GET', '/api/v3/contents/generations/tasks/remote%2Fid'],
    ])
  })

  it.each(['running', 'succeeded', 'failed', 'expired'])('video status %s does not DELETE or treat record deletion as cancellation', async status => {
    const { provider, requests } = await setup((_req, res) => json(res, { status }))
    await expect(provider.cancel!('remote')).resolves.toEqual({ cancelled: false })
    expect(requests.map(req => req.method)).toEqual(['GET'])
  })

  it('synchronous images have no provider cancellation API', async () => {
    const { provider, requests } = await setup()
    await expect(provider.cancel!('ark-image:attempt')).resolves.toEqual({ cancelled: false })
    expect(requests).toHaveLength(0)
  })

  it('query 404 maps to not_found; abnormal states and unavailable queries map to transient', async () => {
    let count = 0
    const { provider } = await setup((_req, res) => {
      count++
      if (count === 1) json(res, { error: { code: 'NotFound' } }, 404)
      else if (count === 2) json(res, { status: 'unrecognized' })
      else res.destroy()
    })
    await errorOf(provider.getTask('missing'), 'not_found')
    await errorOf(provider.getTask('unknown-status'), 'transient')
    await errorOf(provider.getTask('network'), 'transient')
  })

  it('video outputs use existing media tools to probe dimensions and duration; probe temporary files are cleaned and downloads omit API keys', async () => {
    const bytes = Buffer.from('fake mp4')
    const { options, origin, requests, dir } = await setup((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'video/mp4' })
      res.end(bytes)
    })
    const probe = vi.fn(async (path: string) => {
      expect(await readFile(path)).toEqual(bytes)
      return { kind: 'video' as const, mime: 'video/mp4', width: 1920, height: 1080, durationMs: 5123, fps: 29.97 }
    })
    const provider = createArkProvider({ ...options, media: { probe } })
    await expect(provider.download({ outputIndex: 0, ref: `${origin}/output.mp4` })).resolves.toEqual({ data: new Uint8Array(bytes), mime: 'video/mp4', width: 1920, height: 1080, durationMs: 5123, fps: 29.97 })
    expect(probe).toHaveBeenCalledOnce()
    expect(await readdir(join(dir, 'ark'))).toEqual([])
    expect(requests[0]!.headers).not.toHaveProperty('authorization')
  })

  it('aborted requests send no HTTP; unknown image jobs and invalid output indices have explicit classifications', async () => {
    const { provider, requests } = await setup()
    const signal = AbortSignal.abort()
    await expect(provider.submit(imageRequest, { idempotencyKey: 'aborted', signal })).rejects.toMatchObject({ name: 'AbortError' })
    await expect(provider.getTask('remote', { signal })).rejects.toMatchObject({ name: 'AbortError' })
    await expect(provider.download({ outputIndex: 0, ref: 'https://output.invalid/a.mp4' }, { signal })).rejects.toMatchObject({ name: 'AbortError' })
    await errorOf(provider.getTask('ark-image:missing'), 'not_found')
    await errorOf(provider.download({ outputIndex: 0, ref: 'ark-image:missing' }), 'not_found')
    await errorOf(provider.download({ outputIndex: -1, ref: 'https://output.invalid/a.mp4' }), 'rejected')
    expect(requests).toHaveLength(0)
  })

  it('corrupt persisted records cannot be treated as missing and resubmitted', async () => {
    const { provider, dir, requests } = await setup()
    await provider.submit(imageRequest, { idempotencyKey: 'corrupt' })
    await writeFile(join(dir, 'ark', 'corrupt.json'), 'invalid-json')
    await errorOf(provider.findTaskByIdempotencyKey!('corrupt'), 'timeout')
    await errorOf(provider.submit(imageRequest, { idempotencyKey: 'corrupt' }), 'timeout')
    expect(requests).toHaveLength(1)
  })

  it.each([
    { response: { error: { code: 'ContentRejected', message: 'replace this image' } }, code: 'ContentRejected' },
    { response: { data: [{ error: { code: 'ImageRejected', message: 'image policy' } }] }, code: 'ImageRejected' },
    { response: { data: [] }, code: 'no_output' },
  ])('complete image failure is a recoverable terminal state rather than an unknown submission result: $code', async ({ response, code }) => {
    const { provider, requests, options } = await setup((_req, res) => json(res, response))
    const result = await provider.submit(imageRequest, { idempotencyKey: 'failed-image' })
    const restarted = createArkProvider(options)
    await expect(restarted.getTask(result.externalTaskId)).resolves.toMatchObject({ state: 'failed', error: { code } })
    await expect(restarted.submit(imageRequest, { idempotencyKey: 'failed-image' })).resolves.toEqual(result)
    expect(requests).toHaveLength(1)
  })

  it('partial image failures preserve original output indices for successful items', async () => {
    const { provider } = await setup((_req, res) => json(res, { data: [
      { error: { code: 'ContentRejected' } }, { url: 'https://output.invalid/b.png', size: '128x128' },
    ] }))
    const { externalTaskId } = await provider.submit({ ...imageRequest, params: { n: 2 } }, { idempotencyKey: 'partial' })
    expect(await outputsOf(provider, externalTaskId)).toEqual([{ outputIndex: 1, ref: externalTaskId }])
  })

  it('preserves upstream error codes and readable messages while removing keys, encoded keys, Bearer tokens, and authorization headers', async () => {
    const secret = 'secret/key+do-not-expose'
    const { options, dir } = await setup((_req, res) => json(res, { data: [{ error: {
      code: 'ContentRejected', message: `Fix image; key=${secret}; encoded=${encodeURIComponent(secret)}; Authorization: Bearer another-token; Bearer third-token`,
    } }] }))
    const provider = createArkProvider({ ...options, getKey: async () => secret })
    const { externalTaskId } = await provider.submit(imageRequest, { idempotencyKey: 'redact' })
    const result = await provider.getTask(externalTaskId)
    expect(result).toMatchObject({ state: 'failed', error: { code: 'ContentRejected', message: expect.stringContaining('Fix image') } })
    const artifacts = JSON.stringify(result) + await readFile(join(dir, 'ark', 'redact.json'), 'utf8')
    for (const token of [secret, encodeURIComponent(secret), 'another-token', 'third-token']) expect(artifacts).not.toContain(token)
    expect(artifacts).toContain('[REDACTED]')
  })

  it.each(['url', 'size', 'task-id', 'video-url'] as const)('upstream key echoes in $0 are neither returned nor persisted', async field => {
    const secret = 'secret-do-not-expose'
    const { options, dir } = await setup((_req, res) => {
      if (field === 'task-id') json(res, { id: `task-${secret}` })
      else if (field === 'video-url') json(res, { status: 'succeeded', content: { video_url: `https://output.invalid/${secret}.mp4` } })
      else json(res, { data: [{ url: field === 'url' ? `https://output.invalid/${secret}.png` : 'https://output.invalid/x.png', size: field === 'size' ? secret : '128x96' }] })
    })
    const provider = createArkProvider(options)
    if (field === 'video-url') await errorOf(provider.getTask('video'), 'transient')
    else await errorOf(provider.submit(field === 'task-id' ? videoRequest : imageRequest, { idempotencyKey: 'echo' }), 'timeout')
    const files = await readdir(join(dir, 'ark')).catch(() => [])
    for (const file of files) expect(await readFile(join(dir, 'ark', file), 'utf8')).not.toContain(secret)
  })

  it.each([{ kind: 'image', count: 11 }, { kind: 'video', count: 10 }] as const)('limits $kind local image input counts', async ({ kind, count }) => {
    const { provider, requests, dir } = await setup()
    const path = join(dir, 'input.png')
    await writeFile(path, 'image')
    const inputs = Array.from({ length: count }, () => ({ type: 'asset' as const, kind: 'image' as const, mime: 'image/png', path }))
    await errorOf(provider.submit({ ...(kind === 'image' ? imageRequest : videoRequest), inputs }, { idempotencyKey: 'too-many' }), 'rejected')
    expect(requests).toHaveLength(0)
  })
})

describe('Ark custom paths', () => {
  it('uses overridden submit and task paths', async () => {
    const { options } = await setup()
    const routed: string[] = []
    const provider = createArkProvider({ ...options, endpoints: { taskQuery: '/jobs/{id}/status' }, fetch: async input => {
      routed.push(String(input))
      return Response.json({ status: 'queued' })
    } })
    expect(await provider.getTask('cgt-1')).toEqual({ state: 'pending' })
    expect(new URL(routed[0]!).pathname).toBe('/api/v3/jobs/cgt-1/status')
    expect(() => createArkProvider({ ...options, endpoints: { taskQuery: '/jobs' } })).toThrow('endpoint paths')
  })
})
