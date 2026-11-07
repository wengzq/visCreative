import { createHash } from 'node:crypto'
import { readFile, readdir, truncate, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createAssetStore, createFfmpegMedia } from '@vis/assets'
import { openSpaceDb, spaceSchema } from '@vis/storage'
import { describe, expect, it } from 'vitest'
import { createGenerationService } from '../../service'
import { providerContract } from '../contract'
import { createProviderTypeRegistry } from '../registry'
import { createGeminiProvider } from './index'
import { GEMINI_BASE_URL, GEMINI_MAX_INPUT_BYTES, GEMINI_MODELS, geminiParamsSchema } from './models'
import { geminiProviderType } from './type'
import { fakeGemini, PNG, SECRET } from './testing/fake'

providerContract('Gemini background video', scenario => fakeGemini(scenario, 'video'))
providerContract('Gemini synchronous image', async scenario => {
  const h = await fakeGemini(scenario === 'cancel-confirmed' || scenario === 'cancel-unconfirmed' || scenario === 'wrong-mime' || scenario === 'oversized' ? 'normal' : scenario, 'image')
  // The adapter's cancel capability belongs to background video, not staged image calls.
  const adapter = { ...h.adapter }
  delete adapter.cancel
  let output = h.output
  if (scenario === 'wrong-mime' || scenario === 'oversized') {
    const { externalTaskId } = await adapter.submit(h.request, { idempotencyKey: 'unsafe' })
    output = { outputIndex: 0, ref: externalTaskId }
    const dir = join(h.dir, 'generation-sync', createHash('sha256').update(`${adapter.id}:gemini-image`).digest('hex'), externalTaskId.slice(6))
    if (scenario === 'oversized') await writeFile(join(dir, '0.bin'), Buffer.alloc(1025))
    else {
      const path = join(dir, 'task.json')
      const saved = JSON.parse(await readFile(path, 'utf8'))
      saved.outputs[0].mime = 'text/html'
      await writeFile(path, JSON.stringify(saved))
    }
  }
  return { ...h, adapter, output }
})

describe('Gemini adapter', () => {
  it('registers an unverified global image and video service', () => {
    expect(createProviderTypeRegistry().get('gemini')).toBe(geminiProviderType)
    expect(geminiProviderType).toMatchObject({ label: { zh: 'Google Gemini', en: 'Google Gemini' }, needsKey: true, verified: false, allowCustomBaseUrl: true, kinds: ['image', 'video'], regions: [{ id: 'global', baseUrl: GEMINI_BASE_URL }] })
    expect(geminiProviderType.availability?.en).toMatch(/mainland China, Hong Kong or Macau.*not been verified against the real API/)
    expect(geminiProviderType.knownModels.map(model => model.id)).toEqual(GEMINI_MODELS.map(model => model.id))
  })

  it('refuses unsafe URLs, URL credentials and query parameters before reading the key', async () => {
    const h = await fakeGemini()
    try {
      for (const baseUrl of [GEMINI_BASE_URL.replace('https://', 'http://'), `${GEMINI_BASE_URL}?key=fake`, GEMINI_BASE_URL.replace('https://', 'https://user@')]) expect(() => createGeminiProvider({ ...h.options, baseUrl })).toThrow('valid endpoint')
      expect(h.requests).toHaveLength(0)
    } finally { await h.close() }
  })

  it.each(['image', 'video'] as const)('uses header authentication exclusively for %s, including poll and download', async kind => {
    const h = await fakeGemini('normal', kind)
    try {
      const result = await h.adapter.submit(h.request, { idempotencyKey: 'header-only' })
      const task = await h.adapter.getTask(result.externalTaskId)
      expect(task.state).toBe('succeeded')
      if (task.state !== 'succeeded') throw new Error('Expected completed output')
      expect((await h.adapter.download(task.outputs[0]!)).mime).toBe(kind === 'image' ? 'image/png' : 'video/mp4')
      if (kind === 'video') await h.adapter.download(h.output)
      expect(h.requests.every(req => req.authenticated)).toBe(true)
      expect(h.requests.every(req => !req.path.includes('key=') && !req.path.includes(SECRET) && !req.path.includes(encodeURIComponent(SECRET)))).toBe(true)
      expect(h.adapter.findTaskByIdempotencyKey).toBeUndefined()
      for (const file of (await readdir(h.dir, { recursive: true })).filter(file => file.endsWith('.json'))) expect(await readFile(join(h.dir, file), 'utf8')).not.toContain(SECRET)
    } finally { await h.close() }
  })

  it.each(GEMINI_MODELS.filter(model => model.kind === 'image'))('stages synchronous generateContent output for $id', async model => {
    const h = await fakeGemini('normal', 'image')
    try {
      const result = await h.adapter.submit({ ...h.request, model: model.id, inputs: [{ type: 'text', text: 'Use soft lighting' }], params: { aspect_ratio: '16:9', ...(model.id === 'gemini-2.5-flash-image' || model.id === 'gemini-3.1-flash-lite-image' ? {} : { image_size: '2K' }) } }, { idempotencyKey: model.id })
      expect(h.requests[0]).toMatchObject({ path: `/v1beta/models/${model.id}:generateContent`, body: { contents: [{ parts: [{ text: 'A blue bird\n\nUse soft lighting' }] }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '16:9' } } } })
      expect(h.requests[0]?.body).not.toHaveProperty('background')
      expect(await h.adapter.cancel!(result.externalTaskId)).toEqual({ cancelled: false })
      const state = await createGeminiProvider(h.options).getTask(result.externalTaskId)
      expect(state.state).toBe('succeeded')
      if (state.state !== 'succeeded') throw new Error('Expected staged image')
      expect(await h.adapter.download(state.outputs[0]!)).toMatchObject({ data: new Uint8Array(PNG), mime: 'image/png' })
      await h.adapter.cleanup!({ idempotencyKey: model.id, status: 'succeeded' })
      expect(await createGeminiProvider(h.options).submit(h.request, { idempotencyKey: model.id })).toEqual(result)
      expect(h.creates()).toBe(1)
      expect((await readdir(h.dir, { recursive: true })).some(file => file.endsWith('.bin'))).toBe(false)
    } finally { await h.close() }
  })

  it.each(['image', 'video'] as const)('uploads extensionless image references in the %s API shape', async kind => {
    const h = await fakeGemini('normal', kind)
    try {
      const path = join(h.dir, 'asset-blob')
      await writeFile(path, PNG)
      const input = { type: 'asset' as const, kind: 'image' as const, mime: 'image/png', path }
      await h.adapter.submit({ ...h.request, inputs: [input] }, { idempotencyKey: 'reference' })
      if (kind === 'image') expect(h.requests[0]?.body.contents).toEqual([{ role: 'user', parts: [{ text: h.request.prompt }, { inlineData: { mimeType: 'image/png', data: PNG.toString('base64') } }] }])
      else expect(h.requests[0]).toMatchObject({ revision: '2026-05-20', body: { model: h.request.model, background: true, store: true, input: [{ type: 'image', mime_type: 'image/png', data: PNG.toString('base64') }, { type: 'text', text: h.request.prompt }], response_format: { type: 'video', delivery: 'uri', aspect_ratio: '16:9', resolution: '720p' }, generation_config: { video_config: { task: 'reference_to_video' } } } })
    } finally { await h.close() }
  })

  it('translates first and last frames in order', async () => {
    const h = await fakeGemini()
    try {
      const path = join(h.dir, 'frame')
      await writeFile(path, PNG)
      const frame = { type: 'asset' as const, kind: 'image' as const, mime: 'image/png', path }
      await h.adapter.submit({ ...h.request, frames: { first: frame, last: frame }, params: { resolution: '4k', aspect_ratio: '9:16' } }, { idempotencyKey: 'frames' })
      expect(h.requests[0]?.body).toMatchObject({ generation_config: { video_config: { task: 'image_to_video' } }, response_format: { resolution: '4k', aspect_ratio: '9:16' } })
      expect(h.requests[0]?.body.input).toHaveLength(3)
    } finally { await h.close() }
  })

  it('rejects unsupported inputs and oversized or mismatched references before submission', async () => {
    const h = await fakeGemini('normal', 'image')
    try {
      for (const inputs of [[{ kind: 'image' as const, mime: 'image/svg+xml' }], [{ kind: 'video' as const, mime: 'video/mp4' }], Array.from({ length: 4 }, () => ({ kind: 'image' as const, mime: 'image/png' })), [{ kind: 'image' as const, mime: 'image/png', frameRole: 'first' as const }]]) expect(() => h.adapter.validateInputs!('image', h.request.model, inputs, {}, 'generate')).toThrow()
      const path = join(h.dir, 'reference')
      await writeFile(path, PNG)
      const req = { ...h.request, inputs: [{ type: 'asset' as const, kind: 'image' as const, mime: 'image/png', path }] }
      await truncate(path, GEMINI_MAX_INPUT_BYTES + 1)
      await expect(h.adapter.submit(req, { idempotencyKey: 'oversized-input' })).rejects.toMatchObject({ reason: 'generation.provider_input_too_large' })
      await writeFile(path, '<svg/>')
      await expect(h.adapter.submit(req, { idempotencyKey: 'mismatch' })).rejects.toMatchObject({ kind: 'rejected' })
      expect(h.creates()).toBe(0)
    } finally { await h.close() }
  })

  it.each(['image', 'video'] as const)('keeps lost, malformed and server-error %s submissions unknown across restarts', async kind => {
    for (const scenario of ['lost', 'malformed', 'server'] as const) {
      const h = await fakeGemini(scenario, kind)
      try {
        await expect(h.adapter.submit(h.request, { idempotencyKey: scenario })).rejects.toMatchObject({ kind: 'timeout' })
        await expect(createGeminiProvider(h.options).submit(h.request, { idempotencyKey: scenario })).rejects.toMatchObject({ kind: 'timeout' })
        expect(h.creates()).toBe(1)
      } finally { await h.close() }
    }
  })

  it('deduplicates concurrent adapter instances while keeping distinct attempts separate', async () => {
    const h = await fakeGemini()
    try {
      const other = createGeminiProvider(h.options)
      const [first, repeated] = await Promise.all([h.adapter.submit(h.request, { idempotencyKey: 'shared' }), other.submit(h.request, { idempotencyKey: 'shared' })])
      expect(repeated).toEqual(first)
      const second = await other.submit(h.request, { idempotencyKey: 'separate' })
      expect(second).not.toEqual(first)
      expect(await createGeminiProvider(h.options).submit(h.request, { idempotencyKey: 'shared' })).toEqual(first)
      expect(h.creates()).toBe(2)
    } finally { await h.close() }
  })

  it('persists completed unusable image output without another paid call', async () => {
    const h = await fakeGemini('invalid-output', 'image')
    try {
      const result = await h.adapter.submit(h.request, { idempotencyKey: 'unusable' })
      expect(await h.adapter.getTask(result.externalTaskId)).toMatchObject({ state: 'failed', error: { code: 'sync_output_invalid' } })
      expect(await createGeminiProvider(h.options).submit(h.request, { idempotencyKey: 'unusable' })).toEqual(result)
      expect(h.creates()).toBe(1)
    } finally { await h.close() }
  })

  it('does not confirm cancel from the acknowledgement, only a later cancelled read', async () => {
    const h = await fakeGemini()
    try {
      const result = await h.adapter.submit(h.request, { idempotencyKey: 'cancel' })
      expect(await h.adapter.cancel!(result.externalTaskId)).toEqual({ cancelled: false })
      expect(h.requests.slice(-2).map(req => [req.method, req.path])).toEqual([['POST', '/v1beta/interactions/interaction-1/cancel'], ['GET', '/v1beta/interactions/interaction-1']])
      h.controls.afterCancel = 'cancelled'
      expect(await h.adapter.cancel!(result.externalTaskId)).toEqual({ cancelled: true })
      expect(await h.adapter.getTask(result.externalTaskId)).toEqual({ state: 'cancelled' })
    } finally { await h.close() }
  })

  it.each(['moderation', 'candidate-safety'] as const)('distinguishes prompt and generated candidate safety: %s', async scenario => {
    const h = await fakeGemini(scenario, 'image')
    try {
      if (scenario === 'moderation') await expect(h.adapter.submit(h.request, { idempotencyKey: scenario })).rejects.toMatchObject({ kind: 'rejected', reason: 'generation.moderation_rejected' })
      else {
        const result = await h.adapter.submit(h.request, { idempotencyKey: scenario })
        expect(await h.adapter.getTask(result.externalTaskId)).toMatchObject({ state: 'failed', error: { code: 'gemini_safety_blocked', data: { reason: 'generation.moderation_rejected' }, message: expect.stringContaining('billing cannot be confirmed') } })
        expect(await createGeminiProvider(h.options).submit(h.request, { idempotencyKey: scenario })).toEqual(result)
      }
      expect(h.creates()).toBe(1)
    } finally { await h.close() }
  })

  it('treats promptFeedback IMAGE_SAFETY as a generated-output block', async () => {
    const h = await fakeGemini('normal', 'image')
    try {
      h.controls.createBody = { promptFeedback: { blockReason: 'IMAGE_SAFETY' } }
      const result = await h.adapter.submit(h.request, { idempotencyKey: 'image-safety' })
      expect(await h.adapter.getTask(result.externalTaskId)).toMatchObject({ state: 'failed', error: { code: 'gemini_safety_blocked' } })
    } finally { await h.close() }
  })

  it.each(['safety', 'content_blocked'])('persists %s after acceptance with a billing-neutral reason', async code => {
    const h = await fakeGemini()
    const db = openSpaceDb(':memory:')
    const service = createGenerationService({ db, assets: createAssetStore({ blobsDir: join(h.dir, 'blobs') }), delivery: { deliverOutput: () => { throw new Error('Blocked outputs cannot deliver') } }, providers: [h.adapter], defaults: { video: { provider: h.adapter.id, model: h.request.model } }, pollIntervalMs: 1 })
    try {
      h.controls.status = 'failed'
      h.controls.pollError = code
      const { jobId } = service.submit({ sessionId: null, turnId: null, inputSnapshotId: null }, { requestId: code, kind: 'video', prompt: h.request.prompt })
      await expect.poll(async () => { await service.pump(); return (await service.get({ jobId })).status }).toBe('failed')
      expect(await service.get({ jobId })).toMatchObject({ error: { code: 'gemini_safety_blocked', data: { reason: 'generation.moderation_rejected' }, message: expect.stringContaining('billing cannot be confirmed') } })
      const attempt = db.select().from(spaceSchema.generationAttempts).get()!
      h.controls.pollError = ''
      h.controls.status = 'completed'
      expect(await createGeminiProvider(h.options).getTask(attempt.externalTaskId!)).toMatchObject({ state: 'failed' })
      expect(JSON.stringify(db.select().from(spaceSchema.events).all())).not.toContain(SECRET)
      expect(h.creates()).toBe(1)
    } finally { await service.stop(); db.$client.close(); await h.close() }
  })

  it('uses overridden paths, keeps the interaction revision and downloads through overridden file paths', async () => {
    const h = await fakeGemini()
    const custom = 'https://gateway.invalid/gw'
    const routed: string[] = []
    try {
      const adapter = createGeminiProvider({ ...h.options, baseUrl: custom, endpoints: { video: '/gen', file: '/blobs/{id}', fileDownload: '/blobs/{id}/content' }, fetch: (input, init) => {
        routed.push(String(input))
        return h.options.fetch!(String(input).replace(`${custom}/gen`, `${GEMINI_BASE_URL}/interactions`).replace(`${custom}/blobs/video-result/content`, `${GEMINI_BASE_URL}/files/video-result:download`).replace(`${custom}/blobs/`, `${GEMINI_BASE_URL}/files/`), init)
      } })
      await adapter.submit(h.request, { idempotencyKey: 'custom-path' })
      expect(routed[0]).toBe(`${custom}/gen`)
      expect(h.requests[0]?.revision).toBe('2026-05-20')
      routed.length = 0
      await adapter.download(h.output)
      expect(routed).toEqual([`${custom}/blobs/video-result`, `${custom}/blobs/video-result/content?alt=media`])
      routed.length = 0
      expect(await adapter.cancel!('video:interaction-1')).toEqual({ cancelled: false })
      expect(routed).toEqual([])
    } finally { await h.close() }
  })

  it('keeps every keyed request on a custom endpoint, including relayed Google file URIs', async () => {
    const h = await fakeGemini()
    const custom = 'https://gateway.invalid/gemini/v1beta'
    const routed: string[] = []
    try {
      const adapter = createGeminiProvider({ ...h.options, baseUrl: custom, fetch: (input, init) => {
        routed.push(String(input))
        return h.options.fetch!(String(input).replace(custom, GEMINI_BASE_URL), init)
      } })
      for (const ref of [h.output.ref, `${custom}/files/video-result:download?alt=media`]) {
        routed.length = 0
        await adapter.download({ ...h.output, ref })
        expect(routed).toEqual([`${custom}/files/video-result`, `${custom}/files/video-result:download?alt=media`])
      }
      routed.length = 0
      for (const ref of ['https://other.invalid/v1beta/files/video-result', 'https://gateway.invalid/other/files/video-result']) {
        await expect(adapter.download({ ...h.output, ref })).rejects.toMatchObject({ kind: 'rejected' })
      }
      expect(routed).toEqual([])
      expect(h.requests.every(request => request.authenticated)).toBe(true)
    } finally { await h.close() }
  })

  it('checks URI processing, host and expiry without forwarding a key elsewhere', async () => {
    const h = await fakeGemini()
    try {
      for (const ref of ['https://other.invalid/video.mp4', `${GEMINI_BASE_URL}/files/output?key=${encodeURIComponent(SECRET)}`, `${GEMINI_BASE_URL}/files/output?unknown=1`, `${GEMINI_BASE_URL}/files/output#fragment`]) await expect(h.adapter.download({ outputIndex: 0, ref })).rejects.toMatchObject({ kind: 'rejected' })
      expect(h.requests).toHaveLength(0)
      h.controls.fileState = 'PROCESSING'
      await expect(h.adapter.download(h.output)).rejects.toMatchObject({ kind: 'transient' })
      expect(h.requests).toHaveLength(1)
      h.controls.fileState = 'ACTIVE'
      h.controls.fileStatus = 404
      await expect(h.adapter.download(h.output)).rejects.toMatchObject({ kind: 'not_found' })
      expect(h.creates()).toBe(0)
    } finally { await h.close() }
  })

  it.each(['missing', 'unreadable', 'line-break'] as const)('checks a %s key before writing an intent', async invalid => {
    const h = await fakeGemini()
    try {
      const adapter = createGeminiProvider({ ...h.options, getKey: async () => { if (invalid === 'unreadable') throw new Error(SECRET); return invalid === 'missing' ? undefined : `${SECRET}\n` } })
      const error = await adapter.submit(h.request, { idempotencyKey: 'key-preflight' }).catch(error => error)
      expect(error).toMatchObject({ kind: 'rejected', reason: invalid === 'unreadable' ? 'generation.provider_key_unreadable' : 'generation.provider_auth_failed' })
      expect(String(error)).not.toContain(SECRET)
      expect(await readdir(h.dir)).toEqual([])
    } finally { await h.close() }
  })

  it('validates MP4 output with the real media probe', async () => {
    const h = await fakeGemini()
    try {
      const adapter = createGeminiProvider({ ...h.options, media: createFfmpegMedia() })
      expect(await adapter.download(h.output)).toMatchObject({ mime: 'video/mp4', width: expect.any(Number), height: expect.any(Number), durationMs: expect.any(Number) })
    } finally { await h.close() }
  })

  it('rejects unknown models, unsupported controls and legacy image resolution settings', () => {
    expect(geminiParamsSchema('video', 'future').safeParse({}).success).toBe(false)
    expect(geminiParamsSchema('video', 'gemini-omni-1.1-flash').safeParse({ negative_prompt: 'blur' }).success).toBe(false)
    expect(geminiParamsSchema('image', 'gemini-2.5-flash-image').safeParse({ image_size: '4K' }).success).toBe(false)
    expect(geminiParamsSchema('image', 'gemini-3.1-flash-lite-image').safeParse({ image_size: '2K' }).success).toBe(false)
    expect(() => geminiParamsSchema('image', 'future').toJSONSchema()).not.toThrow()
  })
})
