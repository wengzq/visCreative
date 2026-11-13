import { execFile } from 'node:child_process'
import { mkdir, readFile, readdir, truncate, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { createAssetStore, createFfmpegMedia } from '@vis/assets'
import { openSpaceDb, spaceSchema } from '@vis/storage'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createGenerationService } from '../../service'
import { providerContract } from '../contract'
import { createProviderTypeRegistry } from '../registry'
import { createKlingProvider, klingExternalId, KLING_REGIONS } from './index'
import { KLING_MODELS, klingParamsSchema } from './models'
import { klingProviderType } from './type'
import { fakeKling, PNG, SECRET } from './testing/fake'
import { sniffKlingMime } from './media'

providerContract('Kling video', scenario => fakeKling(scenario, 'video'))
providerContract('Kling image', scenario => fakeKling(scenario, 'image'))

describe('Kling adapter', () => {
  const fixtures: Awaited<ReturnType<typeof fakeKling>>[] = []
  async function setup(kind: 'image' | 'video' = 'video') {
    const fixture = await fakeKling('normal', kind)
    fixtures.push(fixture)
    return fixture
  }
  afterEach(async () => { await Promise.all(fixtures.splice(0).map(fixture => fixture.close())) })

  async function writeIntent(fixture: Awaited<ReturnType<typeof fakeKling>>, key: string, kind: 'image' | 'video') {
    const dir = join(fixture.dir, 'kling', klingExternalId(`${fixture.options.id}:${fixture.options.baseUrl}`), klingExternalId(key))
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'intent'), JSON.stringify({ kind }))
    return dir
  }

  it('keeps Kling 4.0 image limits separate from the documented video file limit', () => {
    expect(KLING_MODELS.find(model => model.id === 'kling-4.0')).toMatchObject({ inputBytes: 300_000_000, imageInputBytes: 30_000_000 })
  })

  it('registers both hosts, confirmed models and an unverified descriptor', () => {
    const registry = createProviderTypeRegistry()
    expect(registry.get('kling')).toBe(klingProviderType)
    expect(registry.descriptors.find(type => type.type === 'kling')).toMatchObject({ needsKey: true, verified: false, allowCustomBaseUrl: true, kinds: ['video', 'image'] })
    expect(klingProviderType.regions.map(region => region.baseUrl)).toEqual(['https://api-beijing.klingai.com', 'https://api-singapore.klingai.com'])
    expect(klingProviderType.knownModels.map(({ id, label, kind }) => ({ id, label, kind }))).toEqual(KLING_MODELS.map(({ id, label, kind }) => ({ id, label, kind })))
  })

  it.each(KLING_REGIONS)('uses the $id endpoint and refuses unsafe endpoints', async region => {
    const fixture = await setup()
    await createKlingProvider({ ...fixture.options, baseUrl: region.baseUrl }).submit(fixture.request, { idempotencyKey: region.id })
    expect(fixture.requests[0]?.authenticated).toBe(true)
    for (const baseUrl of ['http://api-beijing.klingai.com', 'https://key@gateway.invalid', 'https://gateway.invalid?ak=fake']) {
      expect(() => createKlingProvider({ ...fixture.options, baseUrl })).toThrow('valid endpoint')
    }
    expect(() => createKlingProvider({ ...fixture.options, region: 'singapore', baseUrl: KLING_REGIONS[0].baseUrl })).toThrow('matching')
  })

  it('refuses an unset path that must carry the model before any request', async () => {
    const fixture = await setup()
    const adapter = createKlingProvider({ ...fixture.options, baseUrl: 'https://gateway.invalid/kling', endpoints: {} })
    await expect(adapter.submit(fixture.request, { idempotencyKey: 'no-model-path' })).rejects.toMatchObject({ kind: 'rejected', reason: 'generation.provider_endpoint_missing' })
    expect(fixture.requests).toHaveLength(0)
  })

  it('uses overridden paths and keeps adapter-owned query parameters', async () => {
    const fixture = await setup()
    const custom = 'https://gateway.invalid/kling'
    const routed: string[] = []
    const adapter = createKlingProvider({ ...fixture.options, baseUrl: custom, endpoints: { textToVideo: '/v3/video/{model}', omniVideo: '/v3/omni/{model}', videoQuery: '/v3/jobs' }, fetch: (input, init) => {
      routed.push(String(input))
      return fixture.options.fetch!(String(input).replace(`${custom}/v3/video/`, `${KLING_REGIONS[0].baseUrl}/text-to-video/`).replace(`${custom}/v3/omni/`, `${KLING_REGIONS[0].baseUrl}/omni-video/`).replace(`${custom}/v3/jobs`, `${KLING_REGIONS[0].baseUrl}/tasks`), init)
    } })
    const { externalTaskId } = await adapter.submit(fixture.request, { idempotencyKey: 'custom-path' })
    await adapter.getTask(externalTaskId)
    expect(routed[0]).toContain(`${custom}/v3/`)
    expect(routed.at(-1)).toMatch(/\/v3\/jobs\?task_ids=/)
  })

  it('sends API calls and the key only to a custom endpoint', async () => {
    const fixture = await setup()
    const custom = 'https://gateway.invalid/kling'
    const routed: string[] = []
    const adapter = createKlingProvider({ ...fixture.options, baseUrl: `${custom}/`, fetch: (input, init) => {
      routed.push(String(input))
      return fixture.options.fetch!(String(input).replace(custom, KLING_REGIONS[0].baseUrl), init)
    } })
    await adapter.submit(fixture.request, { idempotencyKey: 'custom-endpoint' })
    expect(routed.length).toBeGreaterThan(0)
    expect(routed.every(url => url.startsWith(`${custom}/`))).toBe(true)
    expect(fixture.requests[0]?.authenticated).toBe(true)
  })

  it.each([
    ['video', 'kling-3.0', { duration: 15, resolution: '4k', audio: 'native' }, { duration: 16 }],
    ['video', 'kling-3.0-omni', { duration: 3, audio: 'off' }, { audio: 'original' }],
    ['video', 'kling-4.0', { duration: 30, resolution: '1080p', aspect_ratio: '21:9' }, { audio: 'off' }],
    ['image', 'kling-v3-omni', { n: 9, resolution: '4k' }, { n: 10 }],
  ] as const)('validates parameters for %s %s', (kind, model, valid, invalid) => {
    const schema = klingParamsSchema(kind, model)
    expect(schema.safeParse(valid).success).toBe(true)
    expect(schema.safeParse(invalid).success).toBe(false)
    expect(schema.safeParse({ fps: 30 }).success).toBe(false)
    expect(schema.safeParse({ duration: 2 }).success).toBe(false)
  })

  it('rejects unconfirmed models and media kinds', () => {
    expect(klingParamsSchema('video', 'kling-v3').safeParse({}).success).toBe(false)
    expect(klingParamsSchema('audio', 'kling-3.0').safeParse({}).success).toBe(false)
    expect(klingParamsSchema('image', 'kling-4.0').safeParse({}).success).toBe(false)
    expect(() => klingParamsSchema('video', 'future-model').toJSONSchema()).not.toThrow()
  })

  it.each(['kling-3.0', 'kling-3.0-omni', 'kling-4.0'])('translates text generation for %s', async model => {
    const fixture = await setup()
    await fixture.adapter.submit({ ...fixture.request, model }, { idempotencyKey: model })
    const sent = fixture.requests[0]!
    expect(sent.path).toBe(model === 'kling-3.0-omni' ? '/omni-video/kling-3.0-omni' : `/text-to-video/${model}`)
    expect(sent.body.options).toEqual({ external_task_id: klingExternalId(model) })
    expect(sent.body).not.toHaveProperty('model_name')
    expect(sent.body.settings).not.toHaveProperty('imageMode')
    expect(sent.body.settings).not.toHaveProperty('n')
    if (model === 'kling-4.0') expect(sent.body.settings).toEqual({ resolution: '1080p', aspect_ratio: '16:9' })
    else expect(sent.body.settings).toMatchObject({ duration: 5, audio: 'off', multi_shot: true })
  })

  it.each(['kling-3.0', 'kling-3.0-omni'])('supports explicit single-shot prompts with the current %s API', async model => {
    const fixture = await setup()
    await fixture.adapter.submit({ ...fixture.request, model, params: { multi_shot: false } }, { idempotencyKey: 'single-shot' })
    expect(fixture.requests[0]?.body.settings).toMatchObject({ multi_shot: false })
    expect(JSON.stringify(fixture.requests[0]?.body)).not.toMatch(/shot_type|multi_prompt/)
  })

  it.each(['kling-3.0', 'kling-3.0-omni', 'kling-4.0'])('translates first and first/last frames for %s', async model => {
    const fixture = await setup()
    const path = join(fixture.dir, 'input.png')
    await writeFile(path, PNG)
    const input = { type: 'asset' as const, kind: 'image' as const, mime: 'image/png', path }
    for (const last of [false, true]) {
      await fixture.adapter.submit({ ...fixture.request, model, frames: { first: input, ...(last ? { last: input } : {}) } }, { idempotencyKey: `frame-${last}` })
      const sent = fixture.requests.at(-1)!
      expect(sent.path).toBe(model === 'kling-3.0-omni' ? '/omni-video/kling-3.0-omni' : `/image-to-video/${model}`)
      expect(sent.body.settings).not.toHaveProperty('aspect_ratio')
      expect(sent.body.contents).toEqual([{ type: 'prompt', text: fixture.request.prompt }, { type: 'first_frame', url: PNG.toString('base64') }, ...(last ? [{ type: 'last_frame', url: PNG.toString('base64') }] : [])])
    }
  })

  it('translates legacy image requests and Omni video references as bare base64', async () => {
    const fixture = await setup('image')
    const path = join(fixture.dir, 'input.png')
    await writeFile(path, PNG)
    const input = { type: 'asset' as const, kind: 'image' as const, mime: 'image/png', path }
    await fixture.adapter.submit({ ...fixture.request, inputs: [input], params: { n: 9 } }, { idempotencyKey: 'image' })
    expect(fixture.requests[0]).toMatchObject({ path: '/v1/images/omni-image', body: { model_name: 'kling-v3-omni', prompt: fixture.request.prompt, external_task_id: klingExternalId('image'), n: 9, result_type: 'single', image_list: [{ image: PNG.toString('base64') }] } })
    for (const model of ['kling-3.0-omni', 'kling-4.0']) {
      await fixture.adapter.submit({ ...fixture.request, kind: 'video', model, inputs: [input, input], params: { imageMode: 'reference' } }, { idempotencyKey: model })
      expect(fixture.requests.at(-1)?.path).toBe(`/omni-video/${model}`)
      expect(fixture.requests.at(-1)?.body.contents).toEqual([{ type: 'prompt', text: fixture.request.prompt }, { type: 'refer_image', url: PNG.toString('base64'), id: 'image_1' }, { type: 'refer_image', url: PNG.toString('base64'), id: 'image_2' }])
    }
  })

  it('rejects unsupported formats, reference counts, mixed frames and frame mismatches before create', async () => {
    const { adapter } = await setup()
    const input = { kind: 'image' as const, mime: 'image/png' }
    const validate = (inputs: Parameters<NonNullable<typeof adapter.validateInputs>>[2], params = {}, model = 'kling-3.0-omni') => adapter.validateInputs!('video', model, inputs, params, 'generate')
    expect(() => validate([{ ...input, mime: 'image/svg+xml' }])).toThrow('SVG')
    expect(() => validate([{ kind: 'video', mime: 'video/mp4' }])).toThrow('PNG and JPEG')
    expect(() => validate(Array(8).fill(input), { imageMode: 'reference' })).toThrow('count')
    expect(() => validate([input], { imageMode: 'reference' }, 'kling-3.0')).toThrow('count')
    expect(() => validate([{ ...input, frameRole: 'first' }, input])).toThrow('combined')
    expect(() => validate([input], { imageMode: 'first_last' })).toThrow('count')
    expect(() => validate([{ ...input, frameRole: 'last' }])).toThrow('count')
    expect(() => validate([], { imageMode: 'reference' })).toThrow('count')
    expect(adapter.frameModesFor!('video', 'kling-4.0')).toEqual(['first', 'first_last'])
    expect(adapter.referenceImageLimitFor!('image', 'kling-v3-omni')).toBe(10)
    expect(adapter.operationsFor!('video', 'kling-3.0')).toEqual(['generate'])
  })

  it('checks file sizes, dimensions and prompts before creating a task', async () => {
    const fixture = await setup('image')
    const path = join(fixture.dir, 'large.png')
    await writeFile(path, PNG)
    await truncate(path, 10_000_001)
    const input = { type: 'asset' as const, kind: 'image' as const, mime: 'image/png', path }
    await expect(fixture.adapter.submit({ ...fixture.request, inputs: [input] }, { idempotencyKey: 'size' })).rejects.toMatchObject({ reason: 'generation.kling_input_size' })
    await writeFile(path, PNG)
    const adapter = createKlingProvider({ ...fixture.options, media: { ...fixture.options.media, probe: async () => ({ kind: 'image', mime: 'image/png', width: 100, height: 100 }) } })
    await expect(adapter.submit({ ...fixture.request, inputs: [input] }, { idempotencyKey: 'dimensions' })).rejects.toMatchObject({ reason: 'generation.kling_input_invalid' })
    await expect(adapter.submit({ ...fixture.request, prompt: 'x'.repeat(2501) }, { idempotencyKey: 'prompt' })).rejects.toMatchObject({ reason: 'generation.kling_prompt_invalid' })
    expect(fixture.createCalls()).toBe(0)
  })

  it('probes extensionless asset blobs with the real media implementation', async () => {
    const fixture = await setup('image')
    const path = join(fixture.dir, 'a'.repeat(64))
    await promisify(execFile)('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=size=512x512', '-frames:v', '1', '-threads', '1', '-f', 'image2', '-vcodec', 'png', '-y', path], { windowsHide: true })
    const media = createFfmpegMedia()
    await expect(media.probe(path)).rejects.toMatchObject({ details: { reason: 'asset.unsupported_extension' } })
    const adapter = createKlingProvider({ ...fixture.options, media })
    const input = { type: 'asset' as const, kind: 'image' as const, mime: 'image/png', path }
    await adapter.submit({ ...fixture.request, inputs: [input] }, { idempotencyKey: 'blob-image' })
    await adapter.submit({ ...fixture.request, kind: 'video', model: 'kling-3.0', frames: { first: input } }, { idempotencyKey: 'blob-frame' })
    expect(fixture.createCalls()).toBe(2)
    expect(fixture.requests[0]?.body.image_list).toEqual([{ image: (await readFile(path)).toString('base64') }])
    expect((await readdir(join(fixture.dir, 'kling', klingExternalId(`${fixture.options.id}:${fixture.options.baseUrl}`)))).some(name => name.startsWith('probe-'))).toBe(false)
  })

  it.each(['image', 'video'] as const)('routes and maps all statuses after restart for %s', async kind => {
    const fixture = await setup(kind)
    const result = await fixture.adapter.submit(fixture.request, { idempotencyKey: 'status' })
    const adapter = createKlingProvider(fixture.options)
    expect(result.externalTaskId).toMatch(new RegExp(`^${kind}:`))
    for (const [status, state] of [['submitted', 'pending'], ['submit', 'pending'], ['processing', 'running'], ['future-status', 'running'], ['succeed', 'succeeded'], ['succeeded', 'succeeded'], ['failed', 'failed']]) {
      fixture.controls.status = status!
      expect(await adapter.getTask(result.externalTaskId)).toMatchObject({ state })
    }
    fixture.controls.message = `Content security policy: Authorization: Bearer ${SECRET}`
    expect(await adapter.getTask(result.externalTaskId)).toMatchObject({ error: { code: 'generation.moderation_rejected', message: expect.not.stringContaining(SECRET) } })
    fixture.controls.status = 'succeeded'
    expect(await adapter.getTask(result.externalTaskId)).toMatchObject({ outputs: kind === 'image' ? [{ outputIndex: 0 }, { outputIndex: 1 }] : [{ outputIndex: 0 }] })
    fixture.controls.secretUrl = true
    await expect(adapter.getTask(result.externalTaskId)).rejects.toMatchObject({ message: 'Kling output URL is invalid' })
    await expect(adapter.getTask('task-1')).rejects.toMatchObject({ kind: 'not_found' })
  })

  it.each([
    [1301, 400, 'rejected', 'generation.moderation_rejected'],
    [1101, 429, 'rejected', 'generation.provider_balance'],
    [1102, 429, 'rejected', 'generation.provider_balance'],
    [1000, 401, 'rejected', 'generation.provider_auth_failed'],
    [1001, 401, 'rejected', 'generation.provider_auth_failed'],
    [1002, 401, 'rejected', 'generation.provider_auth_failed'],
    [1003, 401, 'rejected', 'generation.provider_auth_failed'],
    [1004, 401, 'rejected', 'generation.provider_auth_failed'],
    [1103, 403, 'rejected', 'generation.provider_auth_failed'],
    [1302, 429, 'transient', undefined],
    [1303, 429, 'transient', undefined],
    [5000, 500, 'timeout', undefined],
    [9999, 400, 'rejected', undefined],
  ])('maps create code %s conservatively', async (code, http, kind, reason) => {
    const fixture = await setup()
    fixture.controls.createError = code as number
    fixture.controls.httpStatus = http as number
    await expect(fixture.adapter.submit(fixture.request, { idempotencyKey: 'error' })).rejects.toMatchObject({ kind, reason })
  })

  it.each(['image', 'video'] as const)('recovers duplicate IDs without parsing the Chinese message for %s', async kind => {
    const fixture = await setup(kind)
    fixture.controls.duplicateMessage = '自定义任务编号重复'
    fixture.tasks.push({ id: 'preexisting', external: klingExternalId('duplicate'), kind })
    const result = await fixture.adapter.submit(fixture.request, { idempotencyKey: 'duplicate' })
    expect(result).toEqual({ externalTaskId: `${kind}:preexisting` })
    expect(fixture.creates()).toBe(1)
    expect(fixture.createCalls()).toBe(1)
    expect(await fixture.adapter.findTaskByIdempotencyKey!('duplicate')).toEqual(result)
    expect(fixture.requests.filter(request => request.method === 'GET').map(request => request.path)).toEqual([kind === 'video' ? `/tasks?external_task_ids=${klingExternalId('duplicate')}` : `/v1/images/omni-image/${klingExternalId('duplicate')}`])
  })

  it.each(['image', 'video'] as const)('never interprets lookup errors or malformed responses as absence for %s', async kind => {
    const fixture = await setup(kind)
    expect(await fixture.adapter.findTaskByIdempotencyKey!('absent')).toBeNull()
    expect(fixture.requests).toHaveLength(0)
    await writeIntent(fixture, 'absent', kind)
    fixture.controls.queryError = kind
    await expect(fixture.adapter.findTaskByIdempotencyKey!('absent')).rejects.toMatchObject({ kind: 'transient' })
    fixture.controls.queryError = ''
    fixture.controls.malformedQuery = kind
    await expect(fixture.adapter.findTaskByIdempotencyKey!('absent')).rejects.toMatchObject({ kind: 'transient' })
    fixture.controls.malformedQuery = ''
    fixture.controls.dropQuery = kind
    await expect(fixture.adapter.findTaskByIdempotencyKey!('absent')).rejects.toMatchObject({ kind: 'transient' })
  })

  it('uses the intent kind even when the other endpoint denies access', async () => {
    const fixture = await setup()
    fixture.controls.queryError = 'image'
    fixture.controls.queryErrorCode = 1103
    await writeIntent(fixture, 'recover-video', 'video')
    fixture.tasks.push({ id: 'video-only', external: klingExternalId('recover-video'), kind: 'video' })
    expect(await fixture.adapter.findTaskByIdempotencyKey!('recover-video')).toEqual({ externalTaskId: 'video:video-only' })
    expect(fixture.requests).toHaveLength(1)
    expect(fixture.requests[0]?.path).toBe(`/tasks?external_task_ids=${klingExternalId('recover-video')}`)
  })

  it.each(['image', 'video'] as const)('returns the stored %s ID before consulting the network', async kind => {
    const fixture = await setup(kind)
    const result = await fixture.adapter.submit(fixture.request, { idempotencyKey: 'stored' })
    fixture.controls.hideTasks = true
    fixture.controls.queryError = kind
    fixture.requests.length = 0
    expect(await createKlingProvider(fixture.options).findTaskByIdempotencyKey!('stored')).toEqual(result)
    expect(fixture.requests).toHaveLength(0)
  })

  it('preserves unknown intents after absence and refuses legacy intents without a media kind', async () => {
    const fixture = await setup()
    const dir = await writeIntent(fixture, 'expired', 'video')
    fixture.controls.hideTasks = true
    await expect(fixture.adapter.findTaskByIdempotencyKey!('expired')).rejects.toMatchObject({ kind: 'timeout' })
    await writeFile(join(dir, 'intent'), '')
    fixture.requests.length = 0
    await expect(fixture.adapter.findTaskByIdempotencyKey!('expired')).rejects.toMatchObject({ kind: 'timeout' })
    expect(fixture.requests).toHaveLength(0)
  })

  it.each([1302, 1303])('retries code %s with the same external ID only after confirmed absence', async code => {
    const fixture = await setup()
    fixture.controls.createError = code
    fixture.controls.httpStatus = 429
    await expect(fixture.adapter.submit(fixture.request, { idempotencyKey: 'limited' })).rejects.toMatchObject({ kind: 'transient' })
    expect(await fixture.adapter.findTaskByIdempotencyKey!('limited')).toBeNull()
    fixture.controls.createError = 0
    await fixture.adapter.submit(fixture.request, { idempotencyKey: 'limited' })
    expect(fixture.creates()).toBe(1)
    expect(fixture.createCalls()).toBe(2)
    expect(fixture.requests.filter(request => request.method === 'POST').map(request => request.body.options)).toEqual([
      { external_task_id: klingExternalId('limited') }, { external_task_id: klingExternalId('limited') },
    ])
    expect(fixture.requests.filter(request => request.method === 'GET')).toHaveLength(1)
  })

  it.each(['image', 'video'] as const)('recovers an accepted %s task even when create returns 1303', async kind => {
    const fixture = await setup(kind)
    fixture.controls.createError = 1303
    fixture.controls.httpStatus = 429
    fixture.controls.acceptOnError = true
    const result = await fixture.adapter.submit(fixture.request, { idempotencyKey: 'accepted-limit' })
    expect(result.externalTaskId).toBe(`${kind}:task-1`)
    expect(await fixture.adapter.submit(fixture.request, { idempotencyKey: 'accepted-limit' })).toEqual(result)
    expect(fixture.createCalls()).toBe(1)
    expect(fixture.creates()).toBe(1)
  })

  it.each([1201, 1303, 9999])('keeps code %s unknown when reconciliation fails', async code => {
    const fixture = await setup()
    fixture.controls.createError = code
    fixture.controls.queryError = 'video'
    await expect(fixture.adapter.submit(fixture.request, { idempotencyKey: 'lookup-error' })).rejects.toMatchObject({ kind: 'timeout' })
    await expect(fixture.adapter.submit(fixture.request, { idempotencyKey: 'lookup-error' })).rejects.toBeInstanceOf(Error)
    expect(fixture.createCalls()).toBe(1)
  })

  it('does not repeat the runner preflight lookup during a fresh submit', async () => {
    const fixture = await setup()
    expect(await fixture.adapter.findTaskByIdempotencyKey!('fresh')).toBeNull()
    await fixture.adapter.submit(fixture.request, { idempotencyKey: 'fresh' })
    expect(fixture.requests.map(request => request.method)).toEqual(['POST'])
  })

  it.each(['array', 'object'] as const)('checks video task identity in the %s response shape', async shape => {
    const fixture = await setup()
    const result = await fixture.adapter.submit(fixture.request, { idempotencyKey: 'identity' })
    fixture.controls.videoTaskShape = shape
    expect(await fixture.adapter.getTask(result.externalTaskId)).toMatchObject({ state: 'succeeded' })
    fixture.controls.wrongTaskId = true
    await expect(fixture.adapter.getTask(result.externalTaskId)).rejects.toMatchObject({ kind: 'transient' })
    fixture.controls.hideTasks = true
    await expect(fixture.adapter.getTask(result.externalTaskId)).rejects.toMatchObject({ kind: 'not_found' })
  })

  it.each(['malformedCreate', 'secretId'] as const)('keeps unknown submissions durable after %s', async control => {
    const fixture = await setup()
    fixture.controls[control] = true
    await expect(fixture.adapter.submit(fixture.request, { idempotencyKey: 'unknown' })).rejects.toMatchObject({ kind: 'timeout' })
    fixture.controls.hideTasks = true
    const restarted = createKlingProvider(fixture.options)
    await expect(restarted.submit(fixture.request, { idempotencyKey: 'unknown' })).rejects.toMatchObject({ kind: 'timeout' })
    expect(fixture.createCalls()).toBe(1)
  })

  it('deduplicates across adapter instances and persists no secrets', async () => {
    const fixture = await setup()
    const restarted = createKlingProvider(fixture.options)
    const result = await Promise.all([fixture.adapter.submit(fixture.request, { idempotencyKey: '../opaque/key' }), restarted.submit(fixture.request, { idempotencyKey: '../opaque/key' })])
    expect(result[0]).toEqual(result[1])
    expect(await createKlingProvider(fixture.options).submit(fixture.request, { idempotencyKey: '../opaque/key' })).toEqual(result[0])
    expect(fixture.createCalls()).toBe(1)
    const files = await readdir(fixture.dir, { recursive: true })
    for (const file of files.filter(file => file.endsWith('task.json') || file.endsWith('intent'))) expect(await readFile(join(fixture.dir, file), 'utf8')).not.toContain(SECRET)
  })

  it('downloads without forwarding the API key', async () => {
    const fixture = await setup()
    expect(await fixture.adapter.download(fixture.output)).toMatchObject({ mime: 'image/png', width: 512, height: 512 })
    expect(fixture.outputAuthenticated()).toBe(false)
    expect(fixture.adapter.cancel).toBeUndefined()
  })

  it.each([
    ['image/jpeg', PNG],
    ['image/png', Buffer.from('<html>not an image</html>')],
    ['video/mp4', PNG],
  ])('rejects bytes that do not match %s before probing', async (mime, bytes) => {
    const fixture = await setup()
    fixture.controls.outputMime = mime as string
    fixture.controls.outputBytes = bytes as Buffer
    const probe = vi.fn(fixture.options.media.probe)
    const adapter = createKlingProvider({ ...fixture.options, media: { ...fixture.options.media, probe } })
    await expect(adapter.download(fixture.output)).rejects.toMatchObject({ kind: 'rejected', reason: 'generation.output_type_invalid' })
    expect(probe).not.toHaveBeenCalled()
  })

  it('rejects a probe failure instead of repeatedly downloading invalid media', async () => {
    const fixture = await setup()
    const adapter = createKlingProvider({ ...fixture.options, media: { ...fixture.options.media, probe: async () => { throw new Error('Invalid media') } } })
    await expect(adapter.download(fixture.output)).rejects.toMatchObject({ kind: 'rejected', reason: 'generation.output_type_invalid' })
  })

  it('sniffs supported signatures independently of extensions and rejects AVIF', async () => {
    const mp4 = await readFile(new URL('../mock/fixtures/sample.mp4', import.meta.url))
    expect(sniffKlingMime(PNG)).toBe('image/png')
    expect(sniffKlingMime(Uint8Array.from([255, 216, 255, 224]))).toBe('image/jpeg')
    expect(sniffKlingMime(Buffer.from('RIFF0000WEBP'))).toBe('image/webp')
    expect(sniffKlingMime(mp4)).toBe('video/mp4')
    const avif = Buffer.concat([Buffer.from([0, 0, 0, 20]), Buffer.from('ftypavif0000mif1')])
    expect(sniffKlingMime(avif)).toBeUndefined()
  })

  it.each(['rate-limit', 'invalid-output'] as const)('settles %s correctly through the runner', async scenario => {
    const fixture = await setup()
    if (scenario === 'rate-limit') {
      fixture.controls.createError = 1303
      fixture.controls.httpStatus = 429
      fixture.controls.status = 'processing'
    } else fixture.controls.outputBytes = Buffer.from('not media')
    const db = openSpaceDb(':memory:')
    let now = 1_800_000_000_000
    const service = createGenerationService({
      db, assets: createAssetStore({ blobsDir: join(fixture.dir, 'blobs') }),
      delivery: { deliverOutput: () => { throw new Error('This fixture cannot deliver outputs') } },
      providers: [fixture.adapter], defaults: { video: { provider: fixture.adapter.id, model: fixture.request.model } },
      now: () => now, pollIntervalMs: 1, maxRetries: 2,
    })
    try {
      const { jobId } = service.submit({ sessionId: null, turnId: null, inputSnapshotId: null }, { requestId: scenario, kind: 'video', prompt: fixture.request.prompt })
      await service.pump()
      fixture.controls.createError = 0
      for (let i = 0; i < 8; i++) { now += 60_000; await service.pump() }
      expect((await service.get({ jobId })).status).toBe(scenario === 'rate-limit' ? 'running' : 'unknown')
      expect(db.select().from(spaceSchema.generationAttempts).all()).toHaveLength(1)
      expect(fixture.creates()).toBe(1)
      if (scenario === 'rate-limit') {
        expect(fixture.createCalls()).toBe(2)
        const creates = fixture.requests.filter(request => request.method === 'POST')
        expect(creates[0]?.body.options).toEqual(creates[1]?.body.options)
      } else expect(fixture.outputCalls()).toBe(1)
    } finally { await service.stop(); db.$client.close() }
  })
})
