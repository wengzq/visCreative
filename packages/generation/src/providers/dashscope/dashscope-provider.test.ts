import { execFile } from 'node:child_process'
import { readFile, readdir, truncate, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { inspect, promisify } from 'node:util'
import { createAssetStore, createFfmpegMedia } from '@vis/assets'
import { openSpaceDb, spaceSchema } from '@vis/storage'
import { afterEach, describe, expect, it } from 'vitest'
import { createGenerationService } from '../../service'
import { providerContract } from '../contract'
import { createProviderTypeRegistry } from '../registry'
import { createDashScopeProvider, DASHSCOPE_REGIONS } from './index'
import { DASHSCOPE_MODELS, dashscopeParamsSchema } from './models'
import { dashscopeProviderType } from './type'
import { ALPHA_PNG, fakeDashScope, PNG, SECRET } from './testing/fake'

providerContract('DashScope async video', scenario => fakeDashScope(scenario, 'video'))
providerContract('DashScope async image', scenario => fakeDashScope(scenario, 'image'))

describe('DashScope adapter', () => {
  const fixtures: Awaited<ReturnType<typeof fakeDashScope>>[] = []
  async function setup(kind: 'image' | 'video' = 'video') {
    const fixture = await fakeDashScope('normal', kind)
    fixtures.push(fixture)
    return fixture
  }
  afterEach(async () => { await Promise.all(fixtures.splice(0).map(fixture => fixture.close())) })

  it('registers supported fixed hosts, region-bound key help and unverified models', () => {
    expect(createProviderTypeRegistry().get('dashscope')).toBe(dashscopeProviderType)
    expect(dashscopeProviderType).toMatchObject({ verified: false, allowCustomBaseUrl: true, needsKey: true, label: { zh: '阿里云百炼 (万相)', en: 'Alibaba Wan (DashScope)' } })
    expect(dashscopeProviderType.regions.map(region => region.id)).toEqual(['beijing', 'singapore'])
    expect(dashscopeProviderType.help.key.en).toContain('region-bound')
    expect(dashscopeProviderType.availability?.en).toContain('US and EU')
    expect(dashscopeProviderType.knownModels).toEqual(DASHSCOPE_MODELS.map(({ id, kind, label }) => ({ id, kind, label })))
  })

  it.each(DASHSCOPE_REGIONS)('routes submit, query and cancel to the $id host', async region => {
    const fixture = await setup()
    fixture.controls.status = 'PENDING'
    const adapter = createDashScopeProvider({ ...fixture.options, region: region.id, baseUrl: region.baseUrl })
    const { externalTaskId } = await adapter.submit(fixture.request, { idempotencyKey: region.id })
    await adapter.getTask(externalTaskId)
    expect(await adapter.cancel!(externalTaskId)).toEqual({ cancelled: true })
    expect(fixture.routedHosts).toEqual(Array(4).fill(new URL(region.baseUrl).origin))
    expect(fixture.requests.every(request => request.authenticated)).toBe(true)
    expect(fixture.requests[0]?.async).toBe(true)
    expect(adapter.pollIntervalMs).toBe(15_000)
    expect(adapter.findTaskByIdempotencyKey).toBeUndefined()
  })

  it('uses overridden submit and task paths', async () => {
    const fixture = await setup()
    const custom = 'https://gateway.invalid/gw'
    const base = DASHSCOPE_REGIONS[0].baseUrl
    const routed: string[] = []
    fixture.controls.status = 'PENDING'
    const adapter = createDashScopeProvider({ ...fixture.options, baseUrl: custom, endpoints: { image: '/gen', video: '/gen', task: '/jobs/{id}' }, fetch: (input, init) => {
      routed.push(String(input))
      const path = fixture.request.kind === 'image' ? '/services/aigc/image-generation/generation' : '/services/aigc/video-generation/video-synthesis'
      return fixture.options.fetch!(String(input).replace(`${custom}/gen`, `${base}${path}`).replace(`${custom}/jobs/`, `${base}/tasks/`), init)
    } })
    const { externalTaskId } = await adapter.submit(fixture.request, { idempotencyKey: 'custom-path' })
    await adapter.getTask(externalTaskId)
    expect(routed[0]).toBe(`${custom}/gen`)
    expect(routed.at(-1)).toMatch(/\/gw\/jobs\/[^/]+$/)
  })

  it('sends API calls and the key only to a custom endpoint', async () => {
    const fixture = await setup()
    const custom = 'https://gateway.invalid/dashscope/api/v1'
    const routed: string[] = []
    fixture.controls.status = 'PENDING'
    const adapter = createDashScopeProvider({ ...fixture.options, baseUrl: custom, fetch: (input, init) => {
      routed.push(String(input))
      return fixture.options.fetch!(String(input).replace(custom, DASHSCOPE_REGIONS[0].baseUrl), init)
    } })
    const { externalTaskId } = await adapter.submit(fixture.request, { idempotencyKey: 'custom-endpoint' })
    await adapter.getTask(externalTaskId)
    expect(routed.length).toBeGreaterThan(1)
    expect(routed.every(url => url.startsWith(`${custom}/`))).toBe(true)
    expect(fixture.requests.every(request => request.authenticated)).toBe(true)
    expect(fixture.requests[0]?.async).toBe(true)
  })

  it('rejects mismatched regions and unsafe URLs before reading a key', async () => {
    const fixture = await setup()
    for (const baseUrl of ['http://dashscope.aliyuncs.com/api/v1', 'https://key@dashscope.aliyuncs.com/api/v1', 'https://gateway.invalid/api/v1?ak=fake']) {
      expect(() => createDashScopeProvider({ ...fixture.options, baseUrl })).toThrow('valid endpoint')
    }
    expect(() => createDashScopeProvider({ ...fixture.options, region: 'singapore' })).toThrow('matching')
  })

  it.each(['video', 'image'] as const)('translates asynchronous %s generation without a client task ID', async kind => {
    const fixture = await setup(kind)
    await fixture.adapter.submit({ ...fixture.request, params: kind === 'video' ? { duration: 15, negative_prompt: 'rain' } : { n: 4, size: '4K' }, inputs: [{ type: 'text', text: 'At sunrise' }] }, { idempotencyKey: 'translate' })
    const request = fixture.requests[0]!
    expect(request.path).toBe(kind === 'video' ? '/api/v1/services/aigc/video-generation/video-synthesis' : '/api/v1/services/aigc/image-generation/generation')
    expect(request.async).toBe(true)
    expect(request.body).toMatchObject({ model: fixture.request.model, parameters: kind === 'video' ? { duration: 15, resolution: '1080P', ratio: '16:9' } : { n: 4, size: '4K' } })
    if (kind === 'video') {
      expect(request.body.input).toEqual({ prompt: `${fixture.request.prompt}\n\nAt sunrise`, negative_prompt: 'rain' })
      expect(request.body.parameters).not.toHaveProperty('n')
    } else expect(request.body.input).toEqual({ messages: [{ role: 'user', content: [{ text: `${fixture.request.prompt}\n\nAt sunrise` }] }] })
    expect(JSON.stringify(request.body)).not.toMatch(/translate|idempotency|external_task/)
  })

  it('translates image references, first/last frames and R2V first-frame references', async () => {
    const fixture = await setup('image')
    const path = join(fixture.dir, 'input.png')
    await writeFile(path, PNG)
    const input = { type: 'asset' as const, kind: 'image' as const, mime: 'image/png', path }
    const url = `data:image/png;base64,${PNG.toString('base64')}`
    await fixture.adapter.submit({ ...fixture.request, inputs: [input] }, { idempotencyKey: 'image' })
    expect(fixture.requests.at(-1)?.body.input).toEqual({ messages: [{ role: 'user', content: [{ image: url }, { text: fixture.request.prompt }] }] })
    for (const last of [false, true]) {
      await fixture.adapter.submit({ ...fixture.request, kind: 'video', model: 'wan2.7-i2v', frames: { first: input, ...(last ? { last: input } : {}) } }, { idempotencyKey: `frames-${last}` })
      expect(fixture.requests.at(-1)?.body.input).toEqual({ prompt: fixture.request.prompt, media: [{ type: 'first_frame', url }, ...(last ? [{ type: 'last_frame', url }] : [])] })
      expect(fixture.requests.at(-1)?.body.parameters).not.toHaveProperty('ratio')
    }
    await fixture.adapter.submit({ ...fixture.request, kind: 'video', model: 'wan2.7-r2v', params: { duration: 15 }, inputs: [input], frames: { first: input } }, { idempotencyKey: 'reference' })
    expect(fixture.requests.at(-1)?.body.input).toEqual({ prompt: fixture.request.prompt, media: [{ type: 'reference_image', url }, { type: 'first_frame', url }] })
    expect(fixture.requests.at(-1)?.body.parameters).toMatchObject({ duration: 15 })
  })

  it('validates model-specific parameters and capabilities including the image-only R2V maximum', async () => {
    const { adapter } = await setup()
    for (const id of ['wan2.7-t2v', 'wan2.7-i2v', 'wan2.7-r2v']) {
      expect(dashscopeParamsSchema('video', id).safeParse({ duration: 15 }).success).toBe(true)
      expect(dashscopeParamsSchema('video', id).safeParse({ duration: 16 }).success).toBe(false)
      expect(dashscopeParamsSchema('video', id).safeParse({ duration: 1 }).success).toBe(false)
      expect(dashscopeParamsSchema('video', id).safeParse({ duration: 2.5 }).success).toBe(false)
    }
    expect(dashscopeParamsSchema('image', 'wan2.7-image').safeParse({ size: '4K' }).success).toBe(false)
    expect(dashscopeParamsSchema('image', 'wan2.7-image-pro').safeParse({ size: '4K', n: 4 }).success).toBe(true)
    expect(dashscopeParamsSchema('image', 'wan2.7-image-pro').safeParse({ n: 5 }).success).toBe(false)
    expect(dashscopeParamsSchema('video', 'future-model').safeParse({}).success).toBe(false)
    expect(() => dashscopeParamsSchema('video', 'future-model').toJSONSchema()).not.toThrow()
    expect(adapter.frameModesFor!('video', 'wan2.7-i2v')).toEqual(['first', 'first_last'])
    expect(adapter.frameModesFor!('video', 'wan2.7-r2v')).toEqual(['first'])
    expect(adapter.referenceImageLimitFor!('video', 'wan2.7-r2v')).toBe(5)
    expect(adapter.operationsFor!('image', 'wan2.7-image-pro')).toEqual(['generate'])
    const image = { kind: 'image' as const, mime: 'image/png' }
    const validate = (model: string, inputs: Parameters<NonNullable<typeof adapter.validateInputs>>[2], params = {}) => adapter.validateInputs!('video', model, inputs, params, 'generate')
    expect(() => validate('wan2.7-r2v', Array(5).fill(image), { duration: 15 })).not.toThrow()
    expect(() => validate('wan2.7-r2v', [{ kind: 'video', mime: 'video/mp4' }], { duration: 10 })).toThrow('image inputs only')
    expect(() => validate('wan2.7-r2v', [])).toThrow('reference count')
    expect(() => validate('wan2.7-r2v', Array(6).fill(image))).toThrow('reference count')
    expect(() => validate('wan2.7-i2v', [image, image])).toThrow('first frame')
    expect(() => validate('wan2.7-t2v', [image])).toThrow('reference count')
    expect(() => validate('wan2.7-i2v', [{ ...image, frameRole: 'last' }])).toThrow('frame roles')
    expect(() => validate('wan2.7-t2v', [{ ...image, mime: 'image/svg+xml' }])).toThrow('SVG')
  })

  it('rejects input size, alpha, dimensions and invalid prompts before a paid create', async () => {
    const fixture = await setup('image')
    const path = join(fixture.dir, 'input.png')
    const input = { type: 'asset' as const, kind: 'image' as const, mime: 'image/png', path }
    await writeFile(path, ALPHA_PNG)
    await expect(fixture.adapter.submit({ ...fixture.request, inputs: [input] }, { idempotencyKey: 'alpha' })).rejects.toThrow('alpha')
    await truncate(path, 20_000_001)
    await expect(fixture.adapter.submit({ ...fixture.request, inputs: [input] }, { idempotencyKey: 'size' })).rejects.toMatchObject({ reason: 'generation.provider_input_too_large' })
    await writeFile(path, PNG)
    const adapter = createDashScopeProvider({ ...fixture.options, media: { ...fixture.options.media, probe: async () => ({ kind: 'image', mime: 'image/png', width: 100, height: 512 }) } })
    await expect(adapter.submit({ ...fixture.request, inputs: [input] }, { idempotencyKey: 'dimensions' })).rejects.toThrow('dimensions')
    await expect(fixture.adapter.submit({ ...fixture.request, prompt: 'x'.repeat(5001) }, { idempotencyKey: 'prompt' })).rejects.toThrow('5000')
    await expect(fixture.adapter.submit({ ...fixture.request, params: { size: '4K' }, inputs: [input] }, { idempotencyKey: '4k' })).rejects.toThrow('without references')
    expect(fixture.createCalls()).toBe(0)
  })

  it.each(['lost', 'malformed', 'secret-id', 'server'] as const)('never repeats a %s submit after restart', async scenario => {
    const fixture = scenario === 'lost' ? await fakeDashScope('lost') : await setup()
    if (scenario === 'lost') fixtures.push(fixture)
    if (scenario === 'malformed') fixture.controls.malformedCreate = true
    if (scenario === 'secret-id') fixture.controls.secretId = true
    if (scenario === 'server') { fixture.controls.createStatus = 503; fixture.controls.createCode = 'InternalError' }
    await expect(fixture.adapter.submit(fixture.request, { idempotencyKey: 'unknown' })).rejects.toMatchObject({ kind: 'timeout' })
    await expect(createDashScopeProvider(fixture.options).submit(fixture.request, { idempotencyKey: 'unknown' })).rejects.toMatchObject({ kind: 'timeout' })
    expect(fixture.createCalls()).toBe(1)
    for (const file of (await readdir(fixture.dir, { recursive: true })).filter(file => file.endsWith('task.json'))) expect(await readFile(join(fixture.dir, file), 'utf8')).not.toContain(SECRET)
  })

  it('deduplicates across instances and survives restart without another create', async () => {
    const fixture = await setup()
    const restarted = createDashScopeProvider(fixture.options)
    const [first, second] = await Promise.all([fixture.adapter.submit(fixture.request, { idempotencyKey: '../opaque-key' }), restarted.submit(fixture.request, { idempotencyKey: '../opaque-key' })])
    expect(first).toEqual(second)
    expect(await createDashScopeProvider(fixture.options).submit(fixture.request, { idempotencyKey: '../opaque-key' })).toEqual(first)
    expect(fixture.creates()).toBe(1)
  })

  it.each(['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'UNKNOWN', 'CANCELED'])('guards cancellation in %s state', async status => {
    const fixture = await setup()
    const { externalTaskId } = await fixture.adapter.submit(fixture.request, { idempotencyKey: 'cancel' })
    fixture.controls.status = status
    expect(await fixture.adapter.cancel!(externalTaskId)).toEqual({ cancelled: status === 'PENDING' || status === 'CANCELED' })
    expect(fixture.requests.filter(request => request.path.endsWith('/cancel'))).toHaveLength(status === 'PENDING' ? 1 : 0)
  })

  it.each(['refused', 'race', 'unconfirmed'])('does not claim cancellation when %s', async cancel => {
    const fixture = await setup()
    const { externalTaskId } = await fixture.adapter.submit(fixture.request, { idempotencyKey: 'cancel' })
    fixture.controls.status = 'PENDING'
    fixture.controls.cancel = cancel
    expect(await fixture.adapter.cancel!(externalTaskId)).toEqual({ cancelled: false })
  })

  it.each(['DataInspectionFailed', 'data_inspection_failed'])('preserves %s submit moderation without a repeated create', async code => {
    const fixture = await setup()
    fixture.controls.createStatus = 400
    fixture.controls.createCode = code
    for (const adapter of [fixture.adapter, createDashScopeProvider(fixture.options)]) await expect(adapter.submit(fixture.request, { idempotencyKey: 'blocked' })).rejects.toMatchObject({ kind: 'rejected', reason: 'generation.moderation_rejected' })
    expect(fixture.createCalls()).toBe(1)
  })

  it.each(['video', 'image'] as const)('maps task-level %s moderation, including partial task output', async kind => {
    const fixture = await setup(kind)
    const { externalTaskId } = await fixture.adapter.submit(fixture.request, { idempotencyKey: 'task-blocked' })
    fixture.controls.status = 'FAILED'
    fixture.controls.taskCode = 'DataInspectionFailed'
    fixture.controls.taskMessage = `Output data may contain inappropriate content. Authorization: Bearer ${SECRET}`
    const failed = await fixture.adapter.getTask(externalTaskId)
    expect(failed).toMatchObject({ state: 'failed', error: { code: 'provider_rejected', data: { reason: 'generation.moderation_rejected' } } })
    expect(inspect(failed)).not.toContain(SECRET)
    fixture.controls.status = 'SUCCEEDED'
    fixture.controls.taskCode = ''
    fixture.controls.partialModeration = true
    expect(await fixture.adapter.getTask(externalTaskId)).toMatchObject({ state: 'failed', error: { code: 'provider_rejected', data: { reason: 'generation.moderation_rejected' } } })
  })

  it.each(['expiry', 'moderation', 'success'] as const)('settles %s through the runner and downloads immediately on success', async scenario => {
    const fixture = await setup('image')
    const db = openSpaceDb(':memory:')
    let clock = 1_800_000_000_000
    const service = createGenerationService({
      db, assets: createAssetStore({ blobsDir: join(fixture.dir, 'blobs') }),
      delivery: { deliverOutput: () => ({ status: 'delivered', nodeId: 'node_x', slotId: 'slot_x', slotRevision: 1 }) },
      providers: [fixture.adapter], defaults: { image: { provider: fixture.adapter.id, model: fixture.request.model } },
      now: () => clock, pollIntervalMs: 1,
    })
    try {
      const { jobId } = service.submit({ sessionId: null, turnId: null, inputSnapshotId: null }, { requestId: scenario, kind: 'image', prompt: fixture.request.prompt })
      await service.pump()
      if (scenario === 'expiry') fixture.controls.status = 'UNKNOWN'
      if (scenario === 'moderation') { fixture.controls.status = 'FAILED'; fixture.controls.taskCode = 'DataInspectionFailed'; fixture.controls.taskMessage = 'Output blocked' }
      clock += 15_000
      await service.pump()
      expect(await service.get({ jobId })).toMatchObject({ status: scenario === 'expiry' ? 'unknown' : scenario === 'moderation' ? 'failed' : 'succeeded' })
      if (scenario === 'moderation') expect(await service.get({ jobId })).toMatchObject({ error: { code: 'provider_rejected', data: { reason: 'generation.moderation_rejected' } } })
      expect(fixture.creates()).toBe(1)
      expect(fixture.outputCalls()).toBe(scenario === 'success' ? 1 : 0)
      const attempt = db.select().from(spaceSchema.generationAttempts).get()!
      expect(await createDashScopeProvider(fixture.options).submit(fixture.request, { idempotencyKey: attempt.id })).toEqual({ externalTaskId: attempt.externalTaskId })
    } finally { await service.stop(); db.$client.close() }
  })

  it('maps UNKNOWN to missing/unknown and refuses malformed identity or unrecognized states', async () => {
    const fixture = await setup()
    const { externalTaskId } = await fixture.adapter.submit(fixture.request, { idempotencyKey: 'query' })
    fixture.controls.status = 'UNKNOWN'
    await expect(fixture.adapter.getTask(externalTaskId)).rejects.toMatchObject({ kind: 'not_found' })
    fixture.controls.wrongTaskId = true
    await expect(fixture.adapter.getTask(externalTaskId)).rejects.toMatchObject({ kind: 'transient' })
    fixture.controls.wrongTaskId = false
    fixture.controls.status = 'FUTURE_STATE'
    await expect(fixture.adapter.getTask(externalTaskId)).rejects.toMatchObject({ kind: 'transient' })
  })

  it.each(['missing', 'unreadable', 'newline'] as const)('rejects a %s key before saving an intent', async mode => {
    const fixture = await setup()
    const adapter = createDashScopeProvider({ ...fixture.options, getKey: async () => { if (mode === 'unreadable') throw new Error(SECRET); return mode === 'missing' ? undefined : `${SECRET}\n` } })
    const error = await adapter.submit(fixture.request, { idempotencyKey: 'preflight' }).catch(error => error)
    expect(error).toMatchObject({ kind: 'rejected' })
    expect(inspect(error)).not.toContain(SECRET)
    expect(await readdir(fixture.dir)).toEqual([])
    expect(fixture.createCalls()).toBe(0)
  })

  it('downloads without credentials and rejects mismatched bytes and expired URLs', async () => {
    const fixture = await setup('image')
    expect(await fixture.adapter.download(fixture.output)).toMatchObject({ mime: 'image/png', width: 512, height: 512 })
    expect(fixture.outputAuthenticated()).toBe(false)
    fixture.controls.outputBytes = Buffer.from('<html>not an image</html>')
    await expect(fixture.adapter.download(fixture.output)).rejects.toMatchObject({ kind: 'rejected', reason: 'generation.output_type_invalid' })
    fixture.controls.outputStatus = 403
    await expect(fixture.adapter.download(fixture.output)).rejects.toMatchObject({ kind: 'not_found' })
  })

  it('rejects an invalid media stream without exposing the probe error', async () => {
    const fixture = await setup('image')
    const adapter = createDashScopeProvider({ ...fixture.options, media: { ...fixture.options.media, probe: async () => { throw new Error(SECRET) } } })
    const error = await adapter.download(fixture.output).catch(error => error)
    expect(error).toMatchObject({ kind: 'rejected', reason: 'generation.output_type_invalid' })
    expect(inspect(error)).not.toContain(SECRET)
  })

  it('probes extensionless image references with real media tools', async () => {
    const fixture = await setup('image')
    const path = join(fixture.dir, 'a'.repeat(64))
    const png = join(fixture.dir, 'source.png')
    await promisify(execFile)('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=size=512x512', '-frames:v', '1', '-pix_fmt', 'rgb24', png])
    await writeFile(path, await readFile(png))
    const adapter = createDashScopeProvider({ ...fixture.options, media: createFfmpegMedia() })
    await adapter.submit({ ...fixture.request, inputs: [{ type: 'asset', kind: 'image', mime: 'image/png', path }] }, { idempotencyKey: 'real-probe' })
    expect(fixture.creates()).toBe(1)
  }, 30_000)
})
