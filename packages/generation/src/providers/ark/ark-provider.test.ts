import type { IncomingMessage, ServerResponse } from 'node:http'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAssetStore } from '@vis/assets'
import { eq, openSpaceDb, spaceSchema as s } from '@vis/storage'
import { createGenerationService } from '../../service'
import { MAX_PRESIGN_SECONDS, ProviderError, referenceImageLimit } from '../types'
import { providerContract } from '../contract'
import type { HostedInputs, ProviderInputMetadata, ProviderOutputRef, ProviderRequest } from '../types'
import { arkProviderType } from './type'
import { ARK_MAX_INPUT_BYTES, ARK_MAX_PROMPT_LENGTH, arkImageParamsSchema, arkParamsSchema, arkVideoParamsSchema, createArkProvider } from './index'
import { createIsolatedHttpServer } from '../../../../../scripts/testing/isolated-http'

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
  const isolated = createIsolatedHttpServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const body = Buffer.concat(chunks).toString('utf8')
    const request = { method: req.method, path: req.url, headers: req.headers, body: body ? JSON.parse(body) as Record<string, unknown> : {} }
    requests.push(request)
    handler(request, res)
  })
  const { server } = isolated
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise<void>((resolve, reject) => {
    server.closeAllConnections()
    server.close(error => error ? reject(error) : resolve())
  }))
  const origin = isolated.baseUrl
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
  it('serializes model-specific image format and optimization plus task lifetime and last frame', async () => {
    const h = await setup((req, res) => json(res, req.path?.endsWith('/images/generations') ? { data: [{ url: 'https://output.invalid/a.png', size: '128x96' }] } : { id: 'video-copy' }))
    const model = 'doubao-seedream-5-0-pro'
    const image = createArkProvider({ ...h.options, imageModels: [{ id: model, label: model }] })
    await image.submit({ ...imageRequest, model, params: { size: '1.5K', outputFormat: 'png', optimizePromptMode: 'fast' } }, { idempotencyKey: 'image-copy' })
    expect(h.requests[0]?.body).toMatchObject({ size: '1.5K', output_format: 'png', optimize_prompt_options: { mode: 'fast' } })
    await h.provider.submit({ ...videoRequest, params: { returnLastFrame: true, executionExpiresAfter: 3600 } }, { idempotencyKey: 'video-copy' })
    expect(h.requests[1]?.body).toMatchObject({ return_last_frame: true, execution_expires_after: 3600 })
    expect(arkParamsSchema('image', 'doubao-seedream-5-0-flash').safeParse({ optimizePromptMode: 'fast' }).success).toBe(false)
    expect(arkVideoParamsSchema.safeParse({ executionExpiresAfter: 3599 }).success).toBe(false)
    for (const size of ['4K', '512x512', '8192x8192']) expect(arkParamsSchema('image', model).safeParse({ size }).success).toBe(false)
    expect(arkParamsSchema('image', model).safeParse({ size: '2048x1024' }).success).toBe(true)
    const videoModel = 'doubao-seedance-2-0'
    const video = createArkProvider({ ...h.options, videoModels: [{ id: videoModel, label: videoModel }] })
    await video.submit({ ...videoRequest, model: videoModel, params: { duration: 5, seed: 10, cameraFixed: true } }, { idempotencyKey: 'known-video-copy' })
    expect(h.requests[2]?.body).toMatchObject({ duration: 5, generate_audio: true })
    expect(h.requests[2]?.body).not.toHaveProperty('seed')
    expect(h.requests[2]?.body).not.toHaveProperty('camera_fixed')
    await video.submit({ ...videoRequest, model: videoModel, params: { duration: 5, generateAudio: false } }, { idempotencyKey: 'known-silent-video' })
    expect(h.requests[3]?.body).toMatchObject({ duration: 5, generate_audio: false })
  })
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
    const { provider, requests } = await setup((_req, res) => count++ < (status === 429 ? 2 : 1) ? json(res, body, status) : json(res, { data: [{ url: 'https://output.invalid/a.png' }] }))
    await errorOf(provider.submit(imageRequest, { idempotencyKey: 'retry' }), kind)
    await expect(provider.findTaskByIdempotencyKey!('retry')).resolves.toBeNull()
    await provider.submit(imageRequest, { idempotencyKey: 'retry' })
    expect(requests).toHaveLength(status === 429 ? 3 : 2)
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
    expect(routed).toEqual([`${options.baseUrl}jobs/cgt-1/status`])
    expect(() => createArkProvider({ ...options, endpoints: { taskQuery: '/jobs' } })).toThrow('endpoint paths')
  })
})


describe('Ark video references', () => {
  const models = ['doubao-seedance-2-0-260128', 'doubao-seedance-2-0-fast-260128', 'doubao-seedance-2-0-mini-260615', 'doubao-seedance-2-5-260628']
  const video = { type: 'asset' as const, kind: 'video' as const, mime: 'video/mp4', path: '/pinned.mp4', durationMs: 3000, width: 1280, height: 720, fps: 30, bytes: 1000 }
  const signed = 'https://bucket.example.invalid/clip.mp4?X-Tos-Credential=private-access-id%2Fscope&X-Tos-Signature=private-signature'
  function hosting(): HostedInputs {
    return { configured: true, url: vi.fn(async () => signed), release: vi.fn(async () => {}), redact: vi.fn((text: string) => text.replaceAll('private-access-id', '[REDACTED]').replaceAll('private-signature', '[REDACTED]')) }
  }

  it.each(models)('%s resolves node markers to exact per-type labels in the content order sent over HTTP', async model => {
    const h = await setup((_req, res) => json(res, { id: 'mixed-task' }))
    const db = openSpaceDb(':memory:')
    const assets = createAssetStore({ blobsDir: join(h.dir, 'blobs') })
    const paths: string[] = []
    for (const [id, kind] of [['image', 'image'], ['video-a', 'video'], ['video-b', 'video']] as const) {
      const staged = await assets.stageBytes(Buffer.from(id))
      const { assetVersionId } = assets.registerVersion(db, { staged, kind, mime: kind === 'image' ? 'image/png' : 'video/mp4', origin: 'import', ...(kind === 'video' ? { durationMs: 3000, width: 1280, height: 720, fps: 30 } : {}) })
      paths.push(assets.blobPath(staged.hash))
      db.insert(s.operations).values({ id: `op-${id}`, actorKind: 'user', createdAt: 1 }).run()
      db.insert(s.nodes).values({ id, kind, x: 0, y: 0, w: 100, h: 100, z: 1, createdAt: 1 }).run()
      db.insert(s.slots).values({ id, nodeId: id, slotKey: 'main', contentType: kind, currentRevision: 1 }).run()
      db.insert(s.slotRevisions).values({ slotId: id, revision: 1, assetVersionId, operationId: `op-${id}`, createdAt: 1 }).run()
    }
    const hosted = hosting()
    vi.mocked(hosted.url).mockImplementation(async input => `https://bucket.example.invalid/${input.path === paths[2] ? 'first' : 'second'}.mp4`)
    const provider = createArkProvider({ ...h.options, hosted, videoModels: [{ id: model, label: model }] })
    const service = createGenerationService({ db, assets, providers: [provider], defaults: { video: { provider: provider.id, model } },
      delivery: { deliverOutput() { throw new Error('This test only submits a task') } },
    })
    try {
      const prompt = 'Use {{ref:video-a}} with {{ref:image}}, then {{ref:video-b}} and {{ref:video-a}}'
      const { jobId } = service.submit({ sessionId: null, turnId: null, inputSnapshotId: null }, {
        requestId: 'mixed-labels', kind: 'video', prompt, inputs: ['video-b', 'image', 'video-a'].map(slotId => ({ slotId })),
      })
      await service.pump()
      const prefix = model.includes('2-5') ? '@' : ''
      const expected = `Use ${prefix}视频2 with ${prefix}图片1, then ${prefix}视频1 and ${prefix}视频2`
      expect(h.requests).toHaveLength(1)
      expect(h.requests[0]!.body.content).toEqual([
        { type: 'text', text: expected },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${Buffer.from('image').toString('base64')}` }, role: 'reference_image' },
        { type: 'video_url', video_url: { url: 'https://bucket.example.invalid/first.mp4' }, role: 'reference_video' },
        { type: 'video_url', video_url: { url: 'https://bucket.example.invalid/second.mp4' }, role: 'reference_video' },
      ])
      expect(vi.mocked(hosted.url).mock.calls.map(([input]) => input.path)).toEqual([paths[2], paths[1]])
      expect(db.select().from(s.generationJobs).where(eq(s.generationJobs.id, jobId)).get()!.params).toMatchObject({ prompt, resolvedPrompt: expected, actualPrompt: expected })
    } finally { await service.stop(); db.$client.close() }
  })

  it('uses documented audio labels too and leaves unknown Ark models on the legacy format', async () => {
    const { provider } = await setup()
    for (const model of models) {
      expect(provider.referenceLabelFor?.('video', model, { kind: 'audio', number: 2 })).toBe(`${model.includes('2-5') ? '@' : ''}音频2`)
    }
    expect(provider.referenceLabelFor?.('video', 'custom-endpoint', { kind: 'video', number: 1 })).toBeUndefined()
    expect(provider.referenceLabelFor?.('image', 'doubao-seedream-5-0-pro', { kind: 'image', number: 1 })).toBeUndefined()
  })

  it.each([undefined, false])('requires configured hosting before any file read or key lookup (%s)', async configured => {
    const h = await setup()
    const model = models[0]!
    const hosted = configured === undefined ? undefined : { ...hosting(), configured }
    const provider = createArkProvider({ ...h.options, videoModels: [{ id: model, label: model }], ...(hosted ? { hosted } : {}) })
    expect(() => provider.validateInputs?.('video', model, [video], {}, 'generate')).toThrow(expect.objectContaining({ kind: 'rejected', reason: 'generation.video_reference_hosting_required' }))
    await expect(provider.submit({ ...videoRequest, model, inputs: [video] }, { idempotencyKey: 'no-hosting' })).rejects.toMatchObject({ kind: 'rejected', reason: 'generation.video_reference_hosting_required' })
    expect(h.getKey).not.toHaveBeenCalled()
    expect(h.requests).toHaveLength(0)
    await expect(provider.findTaskByIdempotencyKey!('no-hosting')).resolves.toBeNull()
  })

  it.each(models)('%s declares and validates every reference limit before upload', async model => {
    const h = await setup()
    const hosted = hosting()
    const provider = createArkProvider({ ...h.options, hosted, videoModels: [{ id: model, label: model }] })
    const latest = model.includes('2-5')
    const max = latest ? 10 : 3
    const maxMs = latest ? 30000 : 15000
    const image = { kind: 'image' as const, mime: 'image/png' }
    const audio = { kind: 'audio' as const, mime: 'audio/wav', durationMs: 2000 }
    const limits = { max, minMs: 2000, maxMs, totalMs: maxMs }
    expect(provider.referenceLimitsFor?.('video', model)).toEqual({ image: latest ? 30 : 9, video: { ...limits, requiresHosting: true }, audio: limits, ...(latest ? { total: 50 } : {}) })
    const cases: { inputs: ProviderInputMetadata[]; reason: string; params?: Record<string, number>; requestParams?: Record<string, unknown> }[] = [
      { inputs: Array.from({ length: max + 1 }, () => video), reason: 'generation.video_reference_count', params: { max } },
      ...[1999, maxMs + 1, NaN].map(durationMs => ({ inputs: [{ ...video, durationMs }], reason: 'generation.video_reference_duration', params: { minMs: 2000, maxMs } })),
      { inputs: [{ ...video, durationMs: maxMs }, video], reason: 'generation.video_reference_total_duration', params: { totalMs: maxMs } },
      { inputs: [{ ...video, mime: 'video/webm' }], reason: 'generation.video_reference_format' },
      { inputs: [{ ...video, bytes: 200_000_001 }], reason: 'generation.video_reference_size', params: { maxBytes: 200_000_000 } },
      ...[23.99, 60.01, NaN].map(fps => ({ inputs: [{ ...video, fps }], reason: 'generation.video_reference_fps', params: { minFps: 24, maxFps: 60 } })),
      ...[{ width: 300, height: 1000 }, { width: 3000, height: 1000 }, { width: 600, height: 600 }, { width: 3000, height: 3000 }, { width: NaN }].map(size => ({ inputs: [{ ...video, ...size }], reason: 'generation.video_reference_dimensions', params: { minAspect: 0.4, maxAspect: 2.5, minPixels: 407696, maxPixels: 8295044 } })),
      { inputs: [image, ...Array.from({ length: max + 1 }, () => audio)], reason: 'generation.audio_reference_count', params: { max } },
      { inputs: [image, { ...audio, durationMs: maxMs + 1 }], reason: 'generation.audio_reference_duration', params: { minMs: 2000, maxMs } },
      { inputs: [image, { ...audio, durationMs: maxMs }, audio], reason: 'generation.audio_reference_total_duration', params: { totalMs: maxMs } },
      { inputs: [image, video], requestParams: { imageMode: 'first_frame' }, reason: 'generation.frames_reference_mix' },
      { inputs: [{ ...image, frameRole: 'first' }, video], reason: 'generation.frames_reference_mix' },
      { inputs: Array.from({ length: latest ? 31 : 10 }, () => image), reason: 'generation.invalid_params' },
      ...(latest ? [{ inputs: [...Array.from({ length: 31 }, () => image), ...Array.from({ length: 10 }, () => ({ ...video, durationMs: 2000 })), ...Array.from({ length: 10 }, () => audio)], reason: 'generation.invalid_params' }] : []),
    ]
    for (const test of cases) {
      expect(() => provider.validateInputs?.('video', model, test.inputs, test.requestParams ?? {}, 'generate')).toThrow(expect.objectContaining({ kind: 'rejected', reason: test.reason, ...(test.params ? { params: test.params } : {}) }))
    }
    if (latest) expect(() => provider.validateInputs?.('video', model, [...Array.from({ length: 30 }, () => image), ...Array.from({ length: 11 }, () => video), ...Array.from({ length: 10 }, () => audio)], {}, 'generate')).toThrow(expect.objectContaining({ params: { detail: 'Ark reference inputs allow at most 50 items' } }))
    expect(() => provider.validateInputs?.('video', model, [...Array.from({ length: latest ? 30 : 9 }, () => image), ...Array.from({ length: max }, () => ({ ...video, durationMs: 2000 })), ...Array.from({ length: max }, () => audio)], {}, 'generate')).not.toThrow()
    for (const input of [{ ...video, mime: 'video/quicktime' }, { ...video, fps: 24 }, { ...video, fps: 60 }, { ...video, bytes: 200_000_000 }, { ...video, width: 640, height: 1600 }, { ...video, width: 1600, height: 640 }, { ...video, width: 638, height: 640 }, { ...video, width: 2880, height: 2880 }]) expect(() => provider.validateInputs?.('video', model, [input], {}, 'generate')).not.toThrow()
    if (latest) expect(() => provider.validateInputs?.('video', model, [audio], {}, 'generate')).not.toThrow()
    else expect(() => provider.validateInputs?.('video', model, [audio], {}, 'generate')).toThrow(expect.objectContaining({ reason: 'generation.audio_reference_image_required' }))
    expect(hosted.url).not.toHaveBeenCalled()
    expect(h.getKey).not.toHaveBeenCalled()
  })

  it.each([undefined, 3600])('uploads before intent and sends reference roles with expiry %s and deterministic input ordinals', async executionExpiresAfter => {
    let intentPresent = false
    const h = await setup((_req, res) => {
      intentPresent = existsSync(join(h.dir, 'ark', `${key}.json`))
      json(res, { id: 'hosted-task' })
    })
    const hosted = hosting()
    const model = models[3]!
    const provider = createArkProvider({ ...h.options, hosted, videoModels: [{ id: model, label: model }] })
    const path = join(h.dir, 'reference.png')
    await writeFile(path, 'image')
    const key = `hosted-${executionExpiresAfter ?? 'default'}`
    const order: string[] = []
    vi.mocked(hosted.url).mockImplementation(async () => {
      await expect(readFile(join(h.dir, 'ark', `${key}.json`))).rejects.toMatchObject({ code: 'ENOENT' })
      expect(h.requests).toHaveLength(0)
      order.push('upload')
      return signed
    })
    await provider.submit({ ...videoRequest, model, params: { executionExpiresAfter }, inputs: [{ type: 'asset', kind: 'image', mime: 'image/png', path }, video] }, { idempotencyKey: key })
    expect(hosted.url).toHaveBeenCalledWith({ path: video.path, mime: video.mime, key: `${key}:1` }, (executionExpiresAfter ?? 21600) + 3600, undefined)
    expect(order).toEqual(['upload'])
    expect(intentPresent).toBe(true)
    expect(h.requests[0]!.body).toMatchObject({ execution_expires_after: executionExpiresAfter ?? 21600, omni_reference_task_type: 'reference', content: [{ type: 'text' }, { role: 'reference_image' }, { type: 'video_url', video_url: { url: signed }, role: 'reference_video' }] })
    const record = await readFile(join(h.dir, 'ark', `${key}.json`), 'utf8')
    expect(record).not.toContain('https:')
    expect(record).not.toContain('private-')
    const restarted = createArkProvider({ ...h.options, hosted })
    await restarted.cleanup!({ idempotencyKey: key, status: 'succeeded' })
    await restarted.cleanup!({ idempotencyKey: key, status: 'succeeded' })
    expect(hosted.release).toHaveBeenCalledTimes(1)
    expect(hosted.release).toHaveBeenCalledWith(key)
    await expect(restarted.findTaskByIdempotencyKey!(key)).resolves.toEqual({ externalTaskId: 'hosted-task' })
  })

  it.each([
    ['hosting.not_configured', 'rejected', 'generation.video_reference_hosting_required'],
    ['hosting.store_failed', 'transient', 'hosting.store_failed'],
    ['hosting.upload_failed', 'transient', 'hosting.upload_failed'],
  ] as const)('preserves the retry policy and localized reason for %s upload failures', async (reason, kind, expectedReason) => {
    const h = await setup()
    const hosted = hosting()
    vi.mocked(hosted.url).mockRejectedValue(Object.assign(new Error('Private hosting diagnostic'), { details: { reason } }))
    const model = models[0]!
    const provider = createArkProvider({ ...h.options, hosted, videoModels: [{ id: model, label: model }] })
    const key = `reason-${reason}`
    await expect(provider.submit({ ...videoRequest, model, inputs: [video] }, { idempotencyKey: key })).rejects.toMatchObject({ kind, reason: expectedReason })
    expect(hosted.url).toHaveBeenCalledTimes(1)
    expect(h.requests).toHaveLength(0)
    await expect(provider.findTaskByIdempotencyKey!(key)).resolves.toBeNull()
  })

  it('releases earlier uploads best-effort when a later reference upload fails', async () => {
    const h = await setup()
    const hosted = hosting()
    vi.mocked(hosted.url).mockResolvedValueOnce(signed).mockRejectedValueOnce(Object.assign(new Error('Private diagnostic'), { details: { reason: 'hosting.upload_failed' } }))
    vi.mocked(hosted.release).mockRejectedValueOnce(new Error('Private cleanup diagnostic'))
    const model = models[0]!
    const provider = createArkProvider({ ...h.options, hosted, videoModels: [{ id: model, label: model }] })
    await expect(provider.submit({ ...videoRequest, model, inputs: [video, video] }, { idempotencyKey: 'partial-upload' })).rejects.toMatchObject({ kind: 'transient', reason: 'hosting.upload_failed' })
    expect(hosted.url).toHaveBeenCalledTimes(2)
    expect(hosted.release).toHaveBeenCalledExactlyOnceWith('partial-upload')
    expect(h.requests).toHaveLength(0)
    await expect(provider.findTaskByIdempotencyKey!('partial-upload')).resolves.toBeNull()
  })

  it('rejects a reference link lifetime beyond the hosting maximum before calling url', async () => {
    const h = await setup()
    const hosted = hosting()
    const model = models[0]!
    const provider = createArkProvider({ ...h.options, hosted, videoModels: [{ id: model, label: model }] })
    await expect(provider.submit({ ...videoRequest, model, params: { executionExpiresAfter: MAX_PRESIGN_SECONDS }, inputs: [video] }, { idempotencyKey: 'invalid-hosting-ttl' })).rejects.toMatchObject({ kind: 'rejected', reason: 'generation.invalid_params', params: { detail: expect.any(String) } })
    expect(hosted.url).not.toHaveBeenCalled()
    expect(h.requests).toHaveLength(0)
  })

  it.each(models)('bounds %s execution expiry plus its fetch margin within the shared presign maximum', async model => {
    const h = await setup()
    const provider = createArkProvider({ ...h.options, hosted: hosting(), videoModels: [{ id: model, label: model }] })
    const schema = provider.paramsSchemaFor!('video', model).toJSONSchema({ io: 'input' }) as { properties: Record<string, { maximum?: number }> }
    const maximum = schema.properties.executionExpiresAfter!.maximum
    expect(typeof maximum).toBe('number')
    expect(maximum! + 3600).toBeLessThanOrEqual(MAX_PRESIGN_SECONDS)
  })

  it('upload failure is transient without an intent or paid POST and never exposes the upload error', async () => {
    const h = await setup()
    const hosted = hosting()
    vi.mocked(hosted.url).mockRejectedValue(new Error(signed))
    const model = models[0]!
    const provider = createArkProvider({ ...h.options, hosted, videoModels: [{ id: model, label: model }] })
    const error = await errorOf(provider.submit({ ...videoRequest, model, inputs: [video] }, { idempotencyKey: 'upload-failed' }), 'transient')
    expect(String(error)).not.toContain('https:')
    expect(String(error)).not.toContain('private-')
    await expect(provider.findTaskByIdempotencyKey!('upload-failed')).resolves.toBeNull()
    expect(h.requests).toHaveLength(0)
    await createArkProvider({ ...h.options, hosted }).cleanup!({ idempotencyKey: 'upload-failed', status: 'failed' })
    expect(hosted.release).toHaveBeenCalledExactlyOnceWith('upload-failed')
  })

  it('redacts echoed signed URLs and query values, rejects sensitive task IDs and logs cleanup failures safely', async () => {
    let echo = signed
    const h = await setup((_req, res) => json(res, { error: { code: 'InvalidReference', message: echo } }, 400))
    const hosted = hosting()
    const model = models[0]!
    const provider = createArkProvider({ ...h.options, hosted, videoModels: [{ id: model, label: model }] })
    for (const [index, value] of [signed, new URL(signed).search, 'private-signature', 'private-access-id'].entries()) {
      echo = value
      const error = await errorOf(provider.submit({ ...videoRequest, model, inputs: [video] }, { idempotencyKey: `redact-${index}` }), 'rejected')
      expect(String(error)).not.toContain('private-')
      expect(String(error)).not.toContain('https:')
    }
    const logs = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const success = await setup((_req, res) => json(res, { id: 'cleanup-task' }))
      const accepted = createArkProvider({ ...success.options, hosted, videoModels: [{ id: model, label: model }] })
      await accepted.submit({ ...videoRequest, model, inputs: [video] }, { idempotencyKey: 'cleanup' })
      vi.mocked(hosted.release).mockRejectedValue(new Error(signed))
      await expect(createArkProvider({ ...success.options, hosted }).cleanup!({ idempotencyKey: 'cleanup', status: 'failed' })).resolves.toBeUndefined()
      expect(logs).toHaveBeenCalled()
      expect(JSON.stringify(logs.mock.calls)).not.toContain('private-')
      expect(JSON.stringify(logs.mock.calls)).not.toContain('https:')
    } finally { logs.mockRestore() }
  })

  it('keeps the per-model image limit hook ahead of its compatibility fallback', async () => {
    const { provider } = await setup()
    provider.referenceImageLimitFor = () => 1
    expect(referenceImageLimit(provider, 'video', models[3]!)).toBe(30)
    expect(referenceImageLimit(provider, 'image', 'configured-image')).toBe(10)
    delete provider.referenceLimitsFor
    expect(referenceImageLimit(provider, 'image', 'configured-image')).toBe(1)
    delete provider.referenceImageLimitFor
    expect(referenceImageLimit(provider, 'image', 'configured-image')).toBe(Infinity)
  })

  it.each(['audio', 'image'] as const)('forces the 2.5 reference task type for %s references without video hosting', async kind => {
    const h = await setup((_req, res) => json(res, { id: 'reference-task' }))
    const model = models[3]!
    const provider = createArkProvider({ ...h.options, videoModels: [{ id: model, label: model }] })
    const path = join(h.dir, kind === 'audio' ? 'reference.wav' : 'reference.png')
    await writeFile(path, 'local input')
    await provider.submit({ ...videoRequest, model, params: { imageMode: 'reference' }, inputs: [{ type: 'asset', kind, mime: kind === 'audio' ? 'audio/wav' : 'image/png', path, ...(kind === 'audio' ? { durationMs: 30000 } : {}) }] }, { idempotencyKey: kind })
    expect(h.requests[0]!.body).toMatchObject({ omni_reference_task_type: 'reference', content: [{ type: 'text' }, { role: kind === 'audio' ? 'reference_audio' : 'reference_image' }] })
    expect(h.requests[0]!.body).not.toHaveProperty('execution_expires_after')
  })

  it('does not save a vendor task ID containing a hosted URL, signature or access key ID', async () => {
    let id = signed
    const h = await setup((_req, res) => json(res, { id }))
    const model = models[0]!
    const provider = createArkProvider({ ...h.options, hosted: hosting(), videoModels: [{ id: model, label: model }] })
    for (const [index, value] of [signed, encodeURIComponent(signed), 'private-signature', 'private-access-id'].entries()) {
      id = value
      const key = `sensitive-id-${index}`
      const error = await errorOf(provider.submit({ ...videoRequest, model, inputs: [video] }, { idempotencyKey: key }), 'timeout')
      expect(String(error)).not.toContain('private-')
      const record = await readFile(join(h.dir, 'ark', `${key}.json`), 'utf8')
      expect(record).toBe(JSON.stringify({ state: 'submitting', referenceVideos: true }))
      const hosted = hosting()
      await createArkProvider({ ...h.options, hosted }).cleanup!({ idempotencyKey: key, status: 'failed' })
      expect(hosted.release).toHaveBeenCalledWith(key)
    }
  })

  it('redacts URL and query echoes from vendor failures after restart', async () => {
    let echo = signed
    const h = await setup((_req, res) => json(res, { status: 'failed', error: { code: 'InvalidReference', message: echo } }))
    const restarted = createArkProvider(h.options)
    for (const value of [signed, encodeURIComponent(signed), new URL(signed).search]) {
      echo = value
      const state = await restarted.getTask('remote-video')
      expect(state).toMatchObject({ state: 'failed' })
      expect(JSON.stringify(state)).not.toContain('private-')
      expect(JSON.stringify(state)).not.toContain('https:')
    }
  })

  it('probes missing video metadata and validates it before uploading', async () => {
    const h = await setup()
    const hosted = hosting()
    const model = models[0]!
    const path = join(h.dir, 'reference.mp4')
    await writeFile(path, 'video')
    const probe = vi.fn(async () => ({ kind: 'video' as const, mime: 'video/mp4', width: 1280, height: 720, fps: 12, durationMs: 3000 }))
    const provider = createArkProvider({ ...h.options, hosted, media: { probe }, videoModels: [{ id: model, label: model }] })
    await expect(provider.submit({ ...videoRequest, model, inputs: [{ type: 'asset', kind: 'video', mime: 'video/mp4', path }] }, { idempotencyKey: 'missing-metadata' })).rejects.toMatchObject({ reason: 'generation.video_reference_fps' })
    expect(probe).toHaveBeenCalledWith(path)
    expect(hosted.url).not.toHaveBeenCalled()
    expect(h.requests).toHaveLength(0)
    await expect(provider.findTaskByIdempotencyKey!('missing-metadata')).resolves.toBeNull()
  })

  it('accepts public URL query values in task IDs and preserves ordinary vendor text', async () => {
    let fail = false
    const h = await setup((_req, res) => fail ? json(res, { error: { code: 'InvalidRequest', message: 'Invalid host header' } }, 400) : json(res, { id: 'task-25200-TOS4-HMAC-SHA256-host' }))
    const hosted = hosting()
    const url = new URL(signed)
    url.searchParams.set('X-Tos-Expires', '25200')
    url.searchParams.set('X-Tos-SignedHeaders', 'host')
    url.searchParams.set('X-Tos-Algorithm', 'TOS4-HMAC-SHA256')
    vi.mocked(hosted.url).mockResolvedValue(url.href)
    const model = models[0]!
    const provider = createArkProvider({ ...h.options, hosted, videoModels: [{ id: model, label: model }] })
    await expect(provider.submit({ ...videoRequest, model, inputs: [video] }, { idempotencyKey: 'public-query' })).resolves.toEqual({ externalTaskId: 'task-25200-TOS4-HMAC-SHA256-host' })
    fail = true
    const error = await errorOf(provider.submit({ ...videoRequest, model, inputs: [video] }, { idempotencyKey: 'host-header' }), 'rejected')
    expect(error.message).toBe('InvalidRequest: Invalid host header')
  })

  it.each(['task', 'http', 'image'] as const)('uses host redaction for vendor %s errors after restart', async mode => {
    const echo = 'Reference rejected for isolated-access-id'
    const h = await setup((_req, res) => json(res, mode === 'image' ? { error: { code: 'Rejected', message: echo } } : { status: 'failed', error: { code: 'Rejected', message: echo } }, mode === 'http' ? 400 : 200))
    const hosted = hosting()
    vi.mocked(hosted.redact).mockImplementation(text => text.replaceAll('isolated-access-id', '[REDACTED]'))
    const provider = createArkProvider({ ...h.options, hosted })
    const state = mode === 'http'
      ? await errorOf(provider.getTask('remote-task'), 'rejected')
      : mode === 'image'
        ? await provider.getTask((await provider.submit(imageRequest, { idempotencyKey: 'image-redaction' })).externalTaskId)
        : await provider.getTask('remote-task')
    const message = state instanceof Error ? state.message : JSON.stringify(state)
    expect(message).not.toContain('isolated-access-id')
    expect(hosted.redact).toHaveBeenCalledWith(expect.stringContaining('isolated-access-id'))
    expect(message).toContain('Reference rejected')
  })

  it('keeps ordinary documentation URLs in image moderation errors', async () => {
    const message = 'Read https://docs.example.invalid/policy before retrying'
    const h = await setup((_req, res) => json(res, { error: { code: 'SensitiveContent', message } }, 400))
    const error = await errorOf(h.provider.submit(imageRequest, { idempotencyKey: 'docs-link' }), 'rejected')
    expect(error.message).toBe(`SensitiveContent: ${message}`)
    expect(error.reason).toBe('generation.moderation_rejected')
  })

  it('rejects missing API keys before uploading a video', async () => {
    const h = await setup()
    const hosted = hosting()
    const model = models[0]!
    const provider = createArkProvider({ ...h.options, hosted, getKey: async () => undefined, videoModels: [{ id: model, label: model }] })
    await expect(provider.submit({ ...videoRequest, model, inputs: [video] }, { idempotencyKey: 'key-before-upload' })).rejects.toMatchObject({ kind: 'rejected', message: 'Configure Ark API Key first' })
    expect(hosted.url).not.toHaveBeenCalled()
    expect(h.requests).toHaveLength(0)
  })

  it('checks frame counts before reading local images', async () => {
    const h = await setup()
    const image = { type: 'asset' as const, kind: 'image' as const, mime: 'image/png', path: '/not-read.png' }
    await expect(h.provider.submit({ ...videoRequest, inputs: [image, image], params: { imageMode: 'first_frame' } }, { idempotencyKey: 'invalid-frame-count' })).rejects.toMatchObject({ message: 'First-frame mode requires exactly one image' })
    expect(h.getKey).not.toHaveBeenCalled()
  })

  it('checks the inline body estimate before uploading videos', async () => {
    const h = await setup()
    const imagePath = join(h.dir, 'large.png')
    const audioPath = join(h.dir, 'large.wav')
    await writeFile(imagePath, '')
    await writeFile(audioPath, '')
    await truncate(imagePath, 4 * 1024 * 1024)
    await truncate(audioPath, 15_000_000)
    const hosted = hosting()
    const model = models[0]!
    const provider = createArkProvider({ ...h.options, hosted, videoModels: [{ id: model, label: model }] })
    const audio = { type: 'asset' as const, kind: 'audio' as const, mime: 'audio/wav', path: audioPath, durationMs: 2000 }
    await expect(provider.submit({ ...videoRequest, model, inputs: [{ type: 'asset', kind: 'image', mime: 'image/png', path: imagePath }, audio, audio, audio, video] }, { idempotencyKey: 'body-before-upload' })).rejects.toMatchObject({ message: 'Ark request body size cannot exceed 64 MB' })
    expect(hosted.url).not.toHaveBeenCalled()
    expect(h.getKey).not.toHaveBeenCalled()
    expect(h.requests).toHaveLength(0)
  })

  it('reuses hosted video URLs during a definite 429 POST retry', async () => {
    let posts = 0
    const h = await setup((_req, res) => posts++ === 0 ? json(res, { error: { code: 'RateLimitExceeded.EndpointRPMExceeded', message: 'Try again' } }, 429) : json(res, { id: 'retried-task' }))
    const hosted = hosting()
    const model = models[0]!
    const provider = createArkProvider({ ...h.options, hosted, videoModels: [{ id: model, label: model }] })
    await expect(provider.submit({ ...videoRequest, model, inputs: [video] }, { idempotencyKey: 'retry-upload-once' })).resolves.toEqual({ externalTaskId: 'retried-task' })
    expect(hosted.url).toHaveBeenCalledTimes(1)
    expect(h.requests).toHaveLength(2)
    expect(h.requests[1]!.body).toEqual(h.requests[0]!.body)
  })

  it('releases unknown submissions once across restart and leaves image jobs alone', async () => {
    const h = await setup((req, res) => req.path?.includes('/images/') ? json(res, { data: [{ url: 'https://output.invalid/a.png' }] }) : res.destroy())
    const hosted = hosting()
    const model = models[0]!
    const options = { ...h.options, hosted, videoModels: [{ id: model, label: model }] }
    const provider = createArkProvider(options)
    await errorOf(provider.submit({ ...videoRequest, model, inputs: [video] }, { idempotencyKey: 'unknown-release' }), 'timeout')
    await createArkProvider(options).cleanup!({ idempotencyKey: 'unknown-release', status: 'unknown' })
    expect(hosted.release).toHaveBeenCalledTimes(1)
    expect(JSON.parse(await readFile(join(h.dir, 'ark', 'unknown-release.json'), 'utf8'))).toEqual({ state: 'submitting', referenceVideos: true, released: true })
    await createArkProvider(options).cleanup!({ idempotencyKey: 'unknown-release', status: 'unknown' })
    expect(hosted.release).toHaveBeenCalledTimes(1)
    await provider.submit(imageRequest, { idempotencyKey: 'image-cleanup' })
    await provider.cleanup!({ idempotencyKey: 'image-cleanup', status: 'succeeded' })
    await provider.cleanup!({ idempotencyKey: 'no-record', status: 'failed' })
    expect(hosted.release).toHaveBeenCalledTimes(1)
  })

  it('registers Seedance 2.5 parameters with its supported duration, resolution and defaults', () => {
    expect(arkProviderType.knownModels.map(model => model.id)).toEqual(models)
    const schema = arkParamsSchema('video', models[3]!)
    expect(schema.parse({})).toMatchObject({ generateAudio: true })
    for (const duration of [-1, 4, 30]) for (const resolution of ['480p', '720p', '1080p']) expect(schema.safeParse({ duration, resolution }).success).toBe(true)
    for (const duration of [0, 3, 31]) expect(schema.safeParse({ duration }).success).toBe(false)
    expect(schema.safeParse({ resolution: '4k' }).success).toBe(false)
    const json = schema.toJSONSchema({ io: 'input' })
    expect(json.properties).not.toHaveProperty('seed')
    expect(json.properties).not.toHaveProperty('cameraFixed')
    expect(json.properties).toHaveProperty('returnLastFrame')
    expect(json.properties).toHaveProperty('executionExpiresAfter')
  })
})
