import { createHash } from 'node:crypto'
import { readFile, readdir, truncate, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createAssetStore } from '@vis/assets'
import { openSpaceDb, spaceSchema } from '@vis/storage'
import { afterEach, describe, expect, it } from 'vitest'
import { createGenerationService } from '../../service'
import { providerContract } from '../contract'
import { createProviderTypeRegistry } from '../registry'
import { createMiniMaxProvider, MINIMAX_REGIONS } from './index'
import { MINIMAX_IMAGE_TIMEOUT_MS, MINIMAX_MODELS, minimaxParamsSchema } from './models'
import { minimaxProviderType } from './type'
import { fakeMiniMax, PNG, SECRET } from './testing/fake'

providerContract('MiniMax v2 video', async scenario => {
  const h = await fakeMiniMax(scenario)
  const output = { ref: 'video:task-1', outputIndex: 0 }
  return { ...h, output }
})
providerContract('MiniMax synchronous image', async scenario => {
  const h = await fakeMiniMax(['wrong-mime', 'oversized'].includes(scenario) ? 'normal' : scenario, 'image')
  let output = { ref: 'unused', outputIndex: 0 }
  if (scenario === 'wrong-mime' || scenario === 'oversized') {
    const { externalTaskId } = await h.adapter.submit(h.request, { idempotencyKey: 'unsafe' })
    output = { ref: externalTaskId, outputIndex: 0 }
    const providerId = `${h.options.id}:minimax:${h.options.baseUrl}`
    const dir = join(h.dir, 'generation-sync', createHash('sha256').update(providerId).digest('hex'), externalTaskId.slice(6))
    if (scenario === 'oversized') await writeFile(join(dir, '0.bin'), Buffer.alloc(4097))
    else {
      const record = JSON.parse(await readFile(join(dir, 'task.json'), 'utf8'))
      record.outputs[0].mime = 'text/html'
      await writeFile(join(dir, 'task.json'), JSON.stringify(record))
    }
  }
  return { ...h, output }
})

describe('MiniMax adapter', () => {
  const fixtures: Awaited<ReturnType<typeof fakeMiniMax>>[] = []
  async function setup(kind: 'image' | 'video' = 'video') { const fixture = await fakeMiniMax('normal', kind); fixtures.push(fixture); return fixture }
  afterEach(async () => { await Promise.all(fixtures.splice(0).map(fixture => fixture.close())) })

  it('registers official regional hosts, models and the unverified descriptor', () => {
    const registry = createProviderTypeRegistry()
    expect(registry.get('minimax')).toBe(minimaxProviderType)
    expect(registry.descriptors.find(type => type.type === 'minimax')).toMatchObject({ label: { zh: 'MiniMax 海螺', en: 'MiniMax Hailuo' }, verified: false, needsKey: true, kinds: ['video', 'image'], allowCustomBaseUrl: true })
    expect(minimaxProviderType.availability?.en).toContain('has not been verified against the real API')
    expect(minimaxProviderType.regions.map(region => region.baseUrl)).toEqual(['https://api.minimax.cn', 'https://api.minimax.io'])
    expect(minimaxProviderType.knownModels).toEqual(MINIMAX_MODELS.map(({ id, label, kind }) => ({ id, label, kind })))
    expect(MINIMAX_IMAGE_TIMEOUT_MS).toBe(300_000)
  })
  it.each(MINIMAX_REGIONS)('routes both media kinds to the $id host', async region => {
    const h = await setup()
    const adapter = createMiniMaxProvider({ ...h.options, region: region.id, baseUrl: region.baseUrl })
    await adapter.submit(h.request, { idempotencyKey: 'video' })
    await adapter.submit({ ...h.request, kind: 'image', model: 'image-01' }, { idempotencyKey: 'image' })
    expect(h.hosts).toEqual([region.baseUrl, region.baseUrl])
    expect(h.requests.every(request => request.authenticated)).toBe(true)
  })
  it('uses overridden paths and keeps the image response rules', async () => {
    const h = await setup()
    const custom = 'https://gateway.invalid/gw'
    const base = MINIMAX_REGIONS[0].baseUrl
    const routed: string[] = []
    const adapter = createMiniMaxProvider({ ...h.options, baseUrl: custom, endpoints: { image: '/img', video: '/vid', videoQuery: '/jobs/{id}' }, fetch: (input, init) => {
      routed.push(String(input))
      return h.options.fetch!(String(input).replace(`${custom}/img`, `${base}/v1/image_generation`).replace(`${custom}/vid`, `${base}/v2/video_generation`).replace(`${custom}/jobs/`, `${base}/v2/query/video_generation/`), init)
    } })
    const { externalTaskId } = await adapter.submit(h.request, { idempotencyKey: 'custom-video' })
    await adapter.getTask(externalTaskId)
    const image = await adapter.submit({ ...h.request, kind: 'image', model: 'image-01' }, { idempotencyKey: 'custom-image' })
    expect(routed[0]).toBe(`${custom}/vid`)
    expect(routed[1]).toMatch(/\/gw\/jobs\/[^/]+$/)
    expect(routed[2]).toBe(`${custom}/img`)
    expect((await adapter.getTask(image.externalTaskId)).state).toBe('succeeded')
  })

  it('sends API calls and the key only to a custom endpoint', async () => {
    const h = await setup()
    const custom = 'https://gateway.invalid/minimax'
    const routed: string[] = []
    const adapter = createMiniMaxProvider({ ...h.options, baseUrl: custom, fetch: (input, init) => {
      routed.push(String(input))
      return h.options.fetch!(String(input).replace(custom, MINIMAX_REGIONS[0].baseUrl), init)
    } })
    await adapter.submit(h.request, { idempotencyKey: 'custom-endpoint' })
    expect(routed.length).toBeGreaterThan(0)
    expect(routed.every(url => url.startsWith(`${custom}/`))).toBe(true)
    expect(h.requests.every(request => request.authenticated)).toBe(true)
  })
  it.each(['http://api.minimax.cn', 'https://key@api.minimax.cn', 'https://gateway.invalid?ak=fake'])('refuses unsafe endpoint %s', async baseUrl => {
    const h = await setup()
    expect(() => createMiniMaxProvider({ ...h.options, baseUrl })).toThrow('valid endpoint')
    expect(h.creates()).toBe(0)
  })
  it('refuses a mismatched region and host', async () => {
    const h = await setup()
    expect(() => createMiniMaxProvider({ ...h.options, region: 'international' })).toThrow('matching')
  })
  it.each(['queued', 'running', 'succeeded', 'failed', 'cancelled'])('never sends DELETE when locally cancelling a %s task', async status => {
    const h = await setup()
    const result = await h.adapter.submit(h.request, { idempotencyKey: status })
    h.controls.status = status
    await h.adapter.getTask(result.externalTaskId)
    expect(h.adapter.cancel).toBeUndefined()
    expect((await h.adapter.cancel?.(result.externalTaskId))?.cancelled ?? false).toBe(false)
    expect(h.requests.some(request => request.method === 'DELETE')).toBe(false)
  })
  it.each(MINIMAX_MODELS.filter(model => model.kind === 'video'))('uses v2 content and settings for $id', async ({ id }) => {
    const h = await setup()
    await h.adapter.submit({ ...h.request, model: id, params: { duration: 15 } }, { idempotencyKey: id })
    expect(h.requests[0]).toMatchObject({ path: '/v2/video_generation', method: 'POST', body: { model: id, content: [{ type: 'text', text: h.request.prompt }], resolution: '768P', duration: 15, ratio: '16:9' } })
    expect(h.requests[0]?.body).not.toHaveProperty('external_task_id')
    expect(h.requests[0]?.body).not.toHaveProperty('imageMode')
    expect(h.adapter.findTaskByIdempotencyKey).toBeUndefined()
  })
  it('translates first and last frames and reference images', async () => {
    const h = await setup()
    const path = join(h.dir, 'a'.repeat(64))
    await writeFile(path, PNG)
    const input = { type: 'asset' as const, kind: 'image' as const, mime: 'image/png', path }
    await h.adapter.submit({ ...h.request, frames: { first: input, last: input } }, { idempotencyKey: 'frames' })
    expect(h.requests[0]?.body).toMatchObject({ ratio: 'adaptive', content: [{ type: 'text' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG.toString('base64')}` }, role: 'first_frame' }, { type: 'image_url', role: 'last_frame' }] })
    await h.adapter.submit({ ...h.request, inputs: [input, input], params: { imageMode: 'reference' } }, { idempotencyKey: 'reference' })
    expect(h.requests[1]?.body).toMatchObject({ ratio: '16:9', content: [{ type: 'text' }, { role: 'reference_image' }, { role: 'reference_image' }] })
    expect(h.adapter.frameModesFor?.('video', 'MiniMax-H3')).toEqual(['first', 'first_last'])
    expect(h.adapter.referenceImageLimitFor?.('video', 'MiniMax-H3')).toBe(9)
  })
  it('synchronously stages image outputs and sends one character reference with base64 format', async () => {
    const h = await setup('image')
    const path = join(h.dir, 'input.png')
    await writeFile(path, PNG)
    const result = await h.adapter.submit({ ...h.request, inputs: [{ type: 'text', text: 'Use bright light' }, { type: 'asset', kind: 'image', mime: 'image/png', path }], params: { n: 2, width: 1024, height: 512, seed: 12 } }, { idempotencyKey: 'sync' })
    expect(h.requests[0]).toMatchObject({ path: '/v1/image_generation', body: { model: 'image-01', prompt: `${h.request.prompt}\n\nUse bright light`, n: 2, width: 1024, height: 512, seed: 12, response_format: 'base64', subject_reference: [{ type: 'character', image_file: `data:image/png;base64,${PNG.toString('base64')}` }] } })
    expect(h.requests[0]?.body).not.toHaveProperty('aspect_ratio')
    const state = await createMiniMaxProvider(h.options).getTask(result.externalTaskId)
    expect(state.state).toBe('succeeded')
    if (state.state !== 'succeeded') throw new Error('Expected synchronous success')
    expect(state.outputs).toHaveLength(2)
    for (const output of state.outputs) expect(await h.adapter.download(output)).toMatchObject({ mime: 'image/png', data: new Uint8Array(PNG) })
    await h.adapter.cleanup!({ idempotencyKey: 'sync', status: 'succeeded' })
    expect(await h.adapter.submit(h.request, { idempotencyKey: 'sync' })).toEqual(result)
    expect(h.creates()).toBe(1)
    expect((await readdir(h.dir, { recursive: true })).some(file => file.endsWith('.bin'))).toBe(false)
  })
  it.each(['image', 'video'] as const)('never repeats a lost %s response after restart', async kind => {
    const h = await fakeMiniMax('lost', kind)
    fixtures.push(h)
    await expect(h.adapter.submit(h.request, { idempotencyKey: 'lost' })).rejects.toMatchObject({ kind: 'timeout' })
    await expect(createMiniMaxProvider(h.options).submit(h.request, { idempotencyKey: 'lost' })).rejects.toMatchObject({ kind: 'timeout' })
    expect(h.creates()).toBe(1)
  })
  it.each(['malformed', 'truncated', 'secretId'] as const)('keeps ambiguous video submit %s unknown', async control => {
    const h = await setup()
    h.controls[control] = true
    await expect(h.adapter.submit(h.request, { idempotencyKey: control })).rejects.toMatchObject({ kind: 'timeout' })
    await expect(createMiniMaxProvider(h.options).submit(h.request, { idempotencyKey: control })).rejects.toMatchObject({ kind: 'timeout' })
    expect(h.creates()).toBe(1)
  })
  it.each(['invalidImage', 'outputModeration'] as const)('durably settles completed image %s without another call', async control => {
    const h = await setup('image')
    h.controls[control] = true
    const result = await h.adapter.submit(h.request, { idempotencyKey: control })
    expect(await h.adapter.getTask(result.externalTaskId)).toMatchObject({ state: 'failed', error: { code: control === 'invalidImage' ? 'sync_output_invalid' : 'minimax_output_blocked' } })
    expect(await createMiniMaxProvider(h.options).submit(h.request, { idempotencyKey: control })).toEqual(result)
    expect(h.creates()).toBe(1)
  })
  it('refreshes an expired video URL once without creating another task or forwarding the key', async () => {
    const h = await setup()
    const result = await h.adapter.submit(h.request, { idempotencyKey: 'url' })
    const state = await h.adapter.getTask(result.externalTaskId)
    if (state.state !== 'succeeded') throw new Error('Expected video success')
    h.controls.expired = 1
    expect(await h.adapter.download(state.outputs[0]!)).toMatchObject({ mime: 'video/mp4' })
    expect(h.outputCalls()).toBe(2)
    expect(h.controls.queryCount).toBe(2)
    expect(h.requests.filter(request => request.path.startsWith('/output')).map(request => request.path)).toEqual(['/output?revision=1', '/output?revision=2'])
    expect(h.outputAuthenticated()).toBe(false)
    expect(h.creates()).toBe(1)
  })
  it('reports an unavailable output after one URL refresh without regenerating', async () => {
    const h = await setup()
    const result = await h.adapter.submit(h.request, { idempotencyKey: 'url' })
    h.controls.expired = 2
    await expect(h.adapter.download({ ref: result.externalTaskId, outputIndex: 0 })).rejects.toMatchObject({ kind: 'not_found' })
    expect(h.outputCalls()).toBe(2)
    expect(h.creates()).toBe(1)
  })
  it('maps missing tasks, unknown states and mismatched identities conservatively', async () => {
    const h = await setup()
    h.controls.status = 'future-state'
    await expect(h.adapter.getTask('video:task-1')).rejects.toMatchObject({ kind: 'transient' })
    h.controls.status = 'queued'
    expect(await h.adapter.getTask('video:task-1')).toEqual({ state: 'pending' })
    h.controls.wrongId = true
    await expect(h.adapter.getTask('video:task-1')).rejects.toMatchObject({ kind: 'transient' })
    h.controls.missing = true
    await expect(h.adapter.getTask('video:task-1')).rejects.toMatchObject({ kind: 'not_found' })
  })
  it('maps and redacts task moderation failures and refuses credential-bearing output URLs', async () => {
    const h = await setup()
    h.controls.status = 'failed'; h.controls.code = 1027; h.controls.errorMessage = `Authorization: Bearer ${SECRET}`
    expect(await h.adapter.getTask('video:task-1')).toMatchObject({ state: 'failed', error: { code: 'generation.moderation_rejected', message: expect.not.stringContaining(SECRET) } })
    h.controls.status = 'succeeded'; h.controls.secretUrl = true
    await expect(h.adapter.getTask('video:task-1')).rejects.toMatchObject({ message: 'MiniMax output URL is invalid' })
  })
  it.each(['image', 'video'] as const)('retains ambiguous server errors and unrecognized codes for %s', async kind => {
    const h = await setup(kind)
    for (const [index, response] of [
      { status: 503, body: 'proxy unavailable' },
      { status: 408, body: 'timeout' },
      { status: 200, body: kind === 'image' ? JSON.stringify({ base_resp: { status_code: 9999 } }) : '{}' },
      { status: 200, body: '{' },
    ].entries()) {
      h.controls.createOverride = response
      await expect(h.adapter.submit(h.request, { idempotencyKey: `unknown-${index}` })).rejects.toMatchObject({ kind: 'timeout' })
      await expect(createMiniMaxProvider(h.options).submit(h.request, { idempotencyKey: `unknown-${index}` })).rejects.toMatchObject({ kind: 'timeout' })
    }
    expect(h.creates()).toBe(4)
  })
  it.each(['image', 'video'] as const)('classifies definite pre-acceptance rejections for %s', async kind => {
    const h = await setup(kind)
    for (const [status, reason] of [[401, 'generation.provider_auth_failed'], [402, 'generation.provider_balance'], [413, 'generation.provider_request_too_large'], [400, 'generation.provider_request_rejected']] as const) {
      h.controls.createOverride = { status, body: `<html>Authorization: Bearer ${SECRET}</html>` }
      const error = await h.adapter.submit(h.request, { idempotencyKey: `reject-${status}` }).catch(error => error)
      expect(error).toMatchObject({ kind: 'rejected', reason })
      expect(String(error)).not.toContain(SECRET)
    }
    h.controls.createOverride = { status: 429, body: 'rate limited' }
    await expect(h.adapter.submit(h.request, { idempotencyKey: 'rate' })).rejects.toMatchObject({ kind: 'transient' })
    h.controls.createOverride = undefined
    await h.adapter.submit(h.request, { idempotencyKey: 'rate' })
    expect(h.creates()).toBe(6)
  })
  it('retains output moderation as a durable synchronous failure', async () => {
    const h = await setup('image')
    h.controls.code = 1027
    const result = await h.adapter.submit(h.request, { idempotencyKey: 'output-sensitive' })
    expect(await h.adapter.getTask(result.externalTaskId)).toMatchObject({ state: 'failed', error: { code: 'minimax_output_blocked', data: { reason: 'generation.moderation_rejected' }, message: expect.stringContaining('billing cannot be confirmed') } })
    expect(await createMiniMaxProvider(h.options).submit(h.request, { idempotencyKey: 'output-sensitive' })).toEqual(result)
    expect(h.creates()).toBe(1)
  })
  it('deduplicates video calls across instances and keeps secrets out of persistent files', async () => {
    const h = await setup()
    const restarted = createMiniMaxProvider(h.options)
    const results = await Promise.all([h.adapter.submit(h.request, { idempotencyKey: '../opaque/key' }), restarted.submit(h.request, { idempotencyKey: '../opaque/key' })])
    expect(results[0]).toEqual(results[1])
    expect(await createMiniMaxProvider(h.options).submit(h.request, { idempotencyKey: '../opaque/key' })).toEqual(results[0])
    expect(h.creates()).toBe(1)
    for (const file of await readdir(h.dir, { recursive: true })) {
      if (file.endsWith('intent') || file.endsWith('task.json')) expect(await readFile(join(h.dir, file), 'utf8')).not.toContain(SECRET)
    }
  })
  it('rejects an output whose bytes contradict video MIME', async () => {
    const h = await setup()
    h.controls.outputBytes = PNG
    await expect(h.adapter.download({ ref: 'video:task-1', outputIndex: 0 })).rejects.toMatchObject({ kind: 'rejected', reason: 'generation.output_type_invalid' })
  })
  it('settles expired URLs through the runner as unknown with one paid call', async () => {
    const h = await setup()
    h.controls.expired = 2
    const db = openSpaceDb(':memory:')
    const service = createGenerationService({ db, assets: createAssetStore({ blobsDir: join(h.dir, 'blobs') }), delivery: { deliverOutput: () => { throw new Error('Expired output cannot be delivered') } }, providers: [h.adapter], defaults: { video: { provider: h.adapter.id, model: h.request.model } }, pollIntervalMs: 1 })
    try {
      const { jobId } = service.submit({ sessionId: null, turnId: null, inputSnapshotId: null }, { requestId: 'expired-output', kind: 'video', prompt: h.request.prompt })
      await expect.poll(async () => { await service.pump(); return (await service.get({ jobId })).status }).toBe('unknown')
      expect(await service.get({ jobId })).toMatchObject({ error: { code: 'download_failed' } })
      expect(h.creates()).toBe(1)
      expect(h.outputCalls()).toBe(2)
    } finally { await service.stop(); db.$client.close() }
  })
  it('enforces input limits before a paid call', async () => {
    const h = await setup('image')
    const path = join(h.dir, 'large.png')
    await writeFile(path, PNG); await truncate(path, 10_000_000)
    await expect(h.adapter.submit({ ...h.request, inputs: [{ type: 'asset', kind: 'image', mime: 'image/png', path }] }, { idempotencyKey: 'large' })).rejects.toMatchObject({ reason: 'generation.provider_input_too_large' })
    const validate = h.adapter.validateInputs!
    expect(() => validate('image', 'image-01', [{ kind: 'image', mime: 'image/svg+xml' }], {}, 'generate')).toThrow('SVG')
    expect(() => validate('image', 'image-01', [{ kind: 'image', mime: 'image/webp' }], {}, 'generate')).toThrow('format')
    expect(() => validate('video', 'MiniMax-H3', [{ kind: 'video', mime: 'video/mp4' }], {}, 'generate')).toThrow('format')
    expect(() => validate('video', 'MiniMax-H3', [{ kind: 'image', mime: 'image/png', frameRole: 'first' }, { kind: 'image', mime: 'image/png' }], {}, 'generate')).toThrow('combined')
    expect(h.creates()).toBe(0)
  })
  it.each(['unreadable', 'empty', 'newline'] as const)('rejects a %s key before writing submission state', async scenario => {
    const h = await setup('image')
    const adapter = createMiniMaxProvider({ ...h.options, getKey: async () => { if (scenario === 'unreadable') throw new Error(SECRET); return scenario === 'empty' ? '' : `${SECRET}\n` } })
    await expect(adapter.submit(h.request, { idempotencyKey: scenario })).rejects.toMatchObject({ kind: 'rejected' })
    expect(h.creates()).toBe(0)
    expect(await readdir(h.dir, { recursive: true })).toEqual([])
  })
  it('downloads immediately when the runner observes success and preserves providerCancelled false', async () => {
    const h = await setup()
    const db = openSpaceDb(':memory:')
    const service = createGenerationService({ db, assets: createAssetStore({ blobsDir: join(h.dir, 'blobs') }), delivery: { deliverOutput: () => ({ status: 'target_missing' }) }, providers: [h.adapter], defaults: { video: { provider: h.adapter.id, model: h.request.model } }, pollIntervalMs: 1 })
    try {
      const { jobId } = service.submit({ sessionId: null, turnId: null, inputSnapshotId: null }, { requestId: 'immediate-download', kind: 'video', prompt: h.request.prompt })
      await service.pump()
      await expect.poll(async () => { await service.pump(); return (await service.get({ jobId })).status }).toBe('succeeded')
      expect(h.outputCalls()).toBe(1)
      expect(h.requests.map(request => request.method)).toEqual(['POST', 'GET', 'GET'])
      h.controls.status = 'queued'
      const cancelled = service.submit({ sessionId: null, turnId: null, inputSnapshotId: null }, { requestId: 'local-cancel', kind: 'video', prompt: h.request.prompt })
      await service.pump()
      await service.cancel({ sessionId: null, turnId: null, inputSnapshotId: null }, { requestId: 'cancel', jobId: cancelled.jobId })
      expect(await service.get({ jobId: cancelled.jobId })).toMatchObject({ status: 'cancelled', providerCancelled: false })
      expect(h.requests.some(request => request.method === 'DELETE')).toBe(false)
      expect(db.select().from(spaceSchema.generationAttempts).all()).toHaveLength(2)
    } finally { await service.stop(); db.$client.close() }
  })
})

describe('MiniMax parameter schemas', () => {
  it.each(MINIMAX_MODELS.filter(model => model.kind === 'video'))('constrains resolution and duration for $id', ({ id }) => {
    const schema = minimaxParamsSchema('video', id)
    expect(schema.safeParse({ duration: 4 }).success).toBe(id !== 'MiniMax-H3-Max')
    expect(schema.safeParse({ resolution: '2K' }).success).toBe(id === 'MiniMax-H3')
    expect(schema.safeParse({ resolution: '480P' }).success).toBe(id !== 'MiniMax-H3')
    expect(schema.safeParse({ duration: 16 }).success).toBe(false)
    expect(schema.safeParse({ audio: false }).success).toBe(false)
    expect(schema.safeParse({ prompt_expansion_mode: 'quality' }).success).toBe(id === 'MiniMax-H3-Max')
  })
  it.each([{ n: 10 }, { width: 512 }, { width: 513, height: 512 }, { width: 2049, height: 2048 }, { width: 1024, height: 1024, aspect_ratio: '1:1' }])('rejects invalid image settings %j', params => {
    expect(minimaxParamsSchema('image', 'image-01').safeParse(params).success).toBe(false)
  })
  it('accepts documented image settings and refuses v1 models', () => {
    expect(minimaxParamsSchema('image', 'image-01').safeParse({ n: 9, width: 2048, height: 512 }).success).toBe(true)
    expect(minimaxParamsSchema('video', 'MiniMax-Hailuo-2.3').safeParse({}).success).toBe(false)
  })
})
