import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAssetStore } from '@vis/assets'
import { openSpaceDb, spaceSchema } from '@vis/storage'
import { describe, expect, it } from 'vitest'
import { createGenerationService } from '../../service'
import { providerContract } from '../contract'
import { builtinProviderTypes, createProviderTypeRegistry } from '../registry'
import type { ProviderRequest } from '../types'
import { createOpenAIProvider } from './index'
import { imageOutput } from './image'
import { OPENAI_MAX_INPUT_BYTES, OPENAI_MODELS, openaiParamsSchema } from './params'
import { openaiProviderType } from './type'
import { fakeOpenAI, PNG, type Scenario } from './testing/fake-server'

const secret = 'fake-openai-key/+private'
const request: ProviderRequest = { kind: 'image', operation: 'generate', model: OPENAI_MODELS[0], prompt: 'A blue bird', inputs: [], params: {} }
async function harness(scenario: Scenario = 'normal', timeoutMs = 5000) {
  const server = await fakeOpenAI(scenario)
  const dataDir = await mkdtemp(join(tmpdir(), 'vis-openai-'))
  const options = { id: 'openai-test', baseUrl: server.baseUrl, dataDir, imageModels: OPENAI_MODELS.map(id => ({ id, label: id })), getKey: async () => secret, timeoutMs, maxOutputBytes: 1024 }
  return { ...server, dataDir, options, adapter: createOpenAIProvider(options), async close() { await server.close(); await rm(dataDir, { recursive: true, force: true }) } }
}

providerContract('OpenAI Images', async scenario => {
  const h = await harness(scenario === 'cancel-confirmed' || scenario === 'cancel-unconfirmed' || scenario === 'wrong-mime' || scenario === 'oversized' ? 'normal' : scenario)
  let output = { ref: 'unused', outputIndex: 0 }
  if (scenario === 'wrong-mime' || scenario === 'oversized') {
    const { externalTaskId } = await h.adapter.submit(request, { idempotencyKey: 'unsafe' })
    output = { ref: externalTaskId, outputIndex: 0 }
    const dir = join(h.dataDir, 'generation-sync', createHash('sha256').update(h.adapter.id).digest('hex'), externalTaskId)
    if (scenario === 'oversized') await writeFile(join(dir, '0.bin'), Buffer.alloc(1025))
    else {
      const file = join(dir, 'task.json')
      const record = JSON.parse(await readFile(file, 'utf8'))
      record.outputs[0].mime = 'text/html'
      await writeFile(file, JSON.stringify(record))
    }
  }
  return { ...h, request, secret, recoversLost: false, output }
})

describe('OpenAI request translation and capabilities', () => {
  it('serializes documented moderation and planning complexity in JSON and multipart requests', async () => {
    const h = await harness()
    try {
      const path = join(h.dataDir, 'reference.png')
      await writeFile(path, PNG)
      const { externalTaskId } = await h.adapter.submit({ ...request, params: { n: 10, moderation: 'low', complexity: 'high' } }, { idempotencyKey: 'copy-json' })
      await h.adapter.submit({ ...request, params: { moderation: 'auto', complexity: 'medium' }, inputs: [{ type: 'asset', kind: 'image', mime: 'image/png', path }] }, { idempotencyKey: 'copy-multipart' })
      expect(h.requests[0]?.fields).toMatchObject({ n: 10, moderation: 'low', complexity: 'high' })
      expect(await h.adapter.getTask(externalTaskId)).toMatchObject({ state: 'succeeded', outputs: expect.arrayContaining([{ outputIndex: 9, ref: externalTaskId }]) })
      expect(h.requests[1]?.fields).toMatchObject({ moderation: 'auto', complexity: 'medium' })
    } finally { await h.close() }
  })
  it('sends generation to an overridden path and refuses paths that could leave the base URL', async () => {
    const h = await harness()
    try {
      const routed: string[] = []
      const adapter = createOpenAIProvider({ ...h.options, endpoints: { generate: '/v2/generation' }, fetch: (input, init) => {
        routed.push(String(input))
        return fetch(String(input).replace('/v2/generation', '/images/generations'), init)
      } })
      await adapter.submit(request, { idempotencyKey: 'custom-path' })
      expect(routed).toEqual([`${h.baseUrl}/v2/generation`])
      routed.length = 0
      const direct = createOpenAIProvider({ ...h.options, endpoints: {}, fetch: (input, init) => {
        routed.push(String(input))
        return fetch(`${String(input)}/images/generations`, init)
      } })
      await direct.submit(request, { idempotencyKey: 'base-url-only' })
      expect(routed).toEqual([h.baseUrl])
      for (const endpoints of [{ generate: 'https://other.invalid/x' }, { generate: '/x?ak=fake' }, { generate: '/../x' }, { unknown: '/x' }]) {
        expect(() => createOpenAIProvider({ ...h.options, endpoints })).toThrow('endpoint paths')
      }
    } finally { await h.close() }
  })

  it('registers an unverified image service with global host and the confirmed models', () => {
    const type = createProviderTypeRegistry(builtinProviderTypes).descriptors.find(type => type.type === 'openai')
    expect(type).toMatchObject({ needsKey: true, verified: false, kinds: ['image'], allowCustomBaseUrl: true, regions: [{ id: 'global', baseUrl: 'https://api.openai.com/v1' }] })
    expect(type?.knownModels.map(model => model.id)).toEqual(OPENAI_MODELS)
    expect(openaiProviderType.availability?.en).toContain('Hong Kong')
  })

  it('posts generation JSON, combines text inputs, stages every output and detects bytes rather than requested format', async () => {
    const h = await harness()
    try {
      const { externalTaskId } = await h.adapter.submit({ ...request, inputs: [{ type: 'text', text: 'Make it small' }], params: { n: 2, output_format: 'webp', output_compression: 80, background: 'transparent', quality: 'max', size: '1536x864' } }, { idempotencyKey: 'translate' })
      expect(h.requests[0]).toMatchObject({ path: '/v1/images/generations', trace: 'translate', fields: { model: request.model, prompt: 'A blue bird\n\nMake it small', n: 2, quality: 'max', size: '1536x864', background: 'transparent', output_format: 'webp', output_compression: 80 }, images: [] })
      expect(h.requests[0]?.fields).not.toHaveProperty('input_fidelity')
      expect(h.requests[0]?.fields).not.toHaveProperty('moderation')
      expect(h.requests[0]?.fields).not.toHaveProperty('response_format')
      const state = await h.adapter.getTask(externalTaskId)
      expect(state.state).toBe('succeeded')
      if (state.state !== 'succeeded') throw new Error('Expected success')
      expect(state.outputs).toHaveLength(2)
      for (const output of state.outputs) expect(await h.adapter.download(output)).toEqual({ data: new Uint8Array(PNG), mime: 'image/png', width: 1, height: 1 })
      expect(h.adapter.cancel).toBeUndefined()
      expect(h.adapter.findTaskByIdempotencyKey).toBeUndefined()
      expect(h.adapter.frameModesFor?.('image', request.model)).toEqual([])
    } finally { await h.close() }
  })

  it.each(OPENAI_MODELS)('uploads four multipart image references for %s', async model => {
    const h = await harness()
    try {
      const path = join(h.dataDir, 'input.png')
      await writeFile(path, PNG)
      await h.adapter.submit({ ...request, model, inputs: Array.from({ length: 4 }, () => ({ type: 'asset' as const, kind: 'image' as const, mime: 'image/png', path })) }, { idempotencyKey: 'edit' })
      expect(h.requests[0]).toMatchObject({ path: '/v1/images/edits', fields: { model, n: '1', size: 'auto', quality: 'auto' } })
      expect(h.requests[0]?.images).toEqual(Array.from({ length: 4 }, () => ({ name: 'image[]', type: 'image/png', data: PNG })))
      expect(h.requests[0]?.fields).not.toHaveProperty('input_fidelity')
    } finally { await h.close() }
  })

  it('rejects SVG, unsupported media, frame inputs and too many references', async () => {
    const h = await harness()
    try {
      for (const inputs of [
        [{ kind: 'image' as const, mime: 'image/svg+xml' }],
        [{ kind: 'video' as const, mime: 'video/mp4' }],
        [{ kind: 'image' as const, mime: 'image/png', frameRole: 'first' as const }],
        Array.from({ length: 5 }, () => ({ kind: 'image' as const, mime: 'image/png' })),
      ]) expect(() => h.adapter.validateInputs?.('image', request.model, inputs, {}, 'generate')).toThrow()
      expect(h.creates()).toBe(0)
    } finally { await h.close() }
  })

  it('rejects oversized files and mismatched image bytes before making a paid call', async () => {
    const h = await harness()
    try {
      const path = join(h.dataDir, 'large.png')
      await writeFile(path, PNG)
      await truncate(path, OPENAI_MAX_INPUT_BYTES)
      const req = { ...request, inputs: [{ type: 'asset' as const, kind: 'image' as const, mime: 'image/png', path }] }
      await expect(h.adapter.submit(req, { idempotencyKey: 'large' })).rejects.toMatchObject({ kind: 'rejected', reason: 'generation.provider_input_too_large' })
      await writeFile(path, '<svg/>')
      await expect(h.adapter.submit(req, { idempotencyKey: 'bad' })).rejects.toMatchObject({ kind: 'rejected', reason: 'generation.provider_input_unsupported' })
      expect(h.creates()).toBe(0)
    } finally { await h.close() }
  })
})

describe('OpenAI parameter schemas', () => {
  it.each(OPENAI_MODELS)('gates quality by model: %s', model => {
    const schema = openaiParamsSchema(model)
    expect(schema.safeParse({ quality: 'max' }).success).toBe(model.startsWith('gpt-image-2.5-'))
    expect(schema.safeParse({ quality: 'xhigh' }).success).toBe(model.startsWith('gpt-image-2.5-'))
    expect(schema.safeParse({ quality: 'high' }).success).toBe(true)
  })
  it.each(['auto', '1024x1024', '1536x1024', '1024x1536', '1536x864', '3840x2160', '2160x3840'])('accepts documented size %s', size => {
    expect(openaiParamsSchema(request.model).safeParse({ size }).success).toBe(true)
  })
  it.each([{ size: '1025x1024' }, { size: '512x512' }, { size: '4096x2048' }, { size: '3840x3840' }, { size: '3072x768' }, { n: 11 }, { n: 0 }, { output_compression: 10 }, { output_format: 'jpeg', background: 'transparent' }, { input_fidelity: 'high' }, { moderation: 'invalid' }, { complexity: 'invalid' }, { output_format: 'webp', output_compression: 101 }])('rejects invalid parameters %j', params => {
    expect(openaiParamsSchema(request.model).safeParse(params).success).toBe(false)
  })
})

describe('OpenAI paid-call outcomes', () => {
  it.each([
    ['moderation', 'rejected', 'generation.moderation_rejected'],
    ['quota', 'rejected', 'generation.provider_balance'],
    ['credit_balance_exhausted', 'rejected', 'generation.provider_balance'],
    ['organization_spend_limit_exceeded', 'rejected', 'generation.provider_balance'],
    ['project_spend_limit_exceeded', 'rejected', 'generation.provider_balance'],
    ['organization_usage_limit_exceeded', 'rejected', 'generation.provider_balance'],
    ['auth', 'rejected', 'generation.provider_auth_failed'],
    ['verification', 'rejected', 'generation.provider_verification_required'],
    ['invalid', 'rejected', 'generation.provider_request_rejected'],
    ['forbidden', 'rejected', 'generation.provider_request_rejected'],
    ['rate', 'transient', undefined],
  ] as const)('maps %s before acceptance', async (scenario, kind, reason) => {
    const h = await harness(scenario)
    try { await expect(h.adapter.submit(request, { idempotencyKey: scenario })).rejects.toMatchObject({ kind, reason }) }
    finally { await h.close() }
  })

  it.each(['lost', 'server', 'unparseable', 'slow'] as const)('never repeats an unknown %s call, including after restart', async scenario => {
    const h = await harness(scenario, scenario === 'slow' ? 100 : 5000)
    try {
      await expect(h.adapter.submit(request, { idempotencyKey: scenario })).rejects.toMatchObject({ kind: 'timeout' })
      await expect(createOpenAIProvider(h.options).submit(request, { idempotencyKey: scenario })).rejects.toMatchObject({ kind: 'timeout' })
      expect(h.creates()).toBe(1)
    } finally { await h.close() }
  })

  it.each(['wrong-mime', 'oversized', 'invalid-base64', 'url-output'] as const)('settles completed but unusable %s output as failed', async scenario => {
    const h = await harness(scenario)
    try {
      const result = await h.adapter.submit(request, { idempotencyKey: scenario })
      expect(await h.adapter.getTask(result.externalTaskId)).toMatchObject({ state: 'failed', error: { code: 'sync_output_invalid' } })
      expect(await createOpenAIProvider(h.options).submit(request, { idempotencyKey: scenario })).toEqual(result)
      expect(h.creates()).toBe(1)
    } finally { await h.close() }
  })

  it.each(['unreadable', 'missing', 'carriage-return', 'line-feed', 'trailing-line-feed'] as const)('validates a %s key before reading references or writing an intent', async invalid => {
    const h = await harness()
    let valid = false
    const adapter = createOpenAIProvider({
      ...h.options,
      getKey: async () => {
        if (valid) return secret
        if (invalid === 'unreadable') throw new Error(`Credential store failed: ${secret}`)
        if (invalid === 'missing') return undefined
        return invalid === 'carriage-return' ? `bad\r${secret}` : invalid === 'line-feed' ? `bad\n${secret}` : `${secret}\n`
      },
    })
    try {
      const badReference = { ...request, inputs: [{ type: 'asset' as const, kind: 'image' as const, mime: 'image/png', path: join(h.dataDir, 'does-not-exist.png') }] }
      const error = await adapter.submit(badReference, { idempotencyKey: 'key-preflight' }).catch(error => error)
      expect(error).toMatchObject({ kind: 'rejected', reason: invalid === 'unreadable' ? 'generation.provider_key_unreadable' : 'generation.provider_auth_failed' })
      expect(String(error)).not.toContain(secret)
      expect(await readdir(h.dataDir, { recursive: true })).toEqual([])
      expect(h.creates()).toBe(0)
      valid = true
      await adapter.submit(request, { idempotencyKey: 'key-preflight' })
      expect(h.creates()).toBe(1)
    } finally { await h.close() }
  })

  it('settles a credential-store read failure through the runner as rejected with no paid attempt', async () => {
    const h = await harness()
    const adapter = createOpenAIProvider({ ...h.options, getKey: async () => { throw new Error(secret) } })
    const db = openSpaceDb(':memory:')
    const service = createGenerationService({
      db, assets: createAssetStore({ blobsDir: join(h.dataDir, 'blobs') }),
      delivery: { deliverOutput: () => { throw new Error('An unreadable key cannot produce output') } },
      providers: [adapter], defaults: { image: { provider: adapter.id, model: request.model } },
    })
    try {
      const { jobId } = service.submit({ sessionId: null, turnId: null, inputSnapshotId: null }, { requestId: 'unreadable-key', kind: 'image', prompt: request.prompt })
      await service.pump()
      expect(await service.get({ jobId })).toMatchObject({ status: 'failed', error: { code: 'provider_rejected', data: { reason: 'generation.provider_key_unreadable' } } })
      expect(JSON.stringify(db.select().from(spaceSchema.events).all())).not.toContain(secret)
      expect((await readdir(h.dataDir, { recursive: true })).some(path => path.endsWith('task.json'))).toBe(false)
      expect(h.creates()).toBe(0)
    } finally { await service.stop(); db.$client.close(); await h.close() }
  })

  it.each([400, 401, 403, 413, 429, 503])('classifies HTTP %s without requiring a usable diagnostic body', async status => {
    const h = await harness()
    try {
      const kind = status === 503 ? 'timeout' : status === 429 ? 'transient' : 'rejected'
      const reason = status === 401 ? 'generation.provider_auth_failed' : status === 413 ? 'generation.provider_request_too_large' : kind === 'rejected' ? 'generation.provider_request_rejected' : undefined
      for (const [index, response] of [
        { body: `<html>Proxy error ${secret}</html>`, contentType: 'text/html' },
        { body: '{', contentType: 'application/json' },
        { body: 'x'.repeat(70_000), contentType: 'application/json' },
        { body: 'x'.repeat(70_000), contentType: 'application/json', chunked: true },
        { body: '{"error":', contentType: 'application/json', truncated: true },
      ].entries()) {
        h.setResponse({ status, ...response })
        const error = await h.adapter.submit(request, { idempotencyKey: `proxy-${index}` }).catch(error => error)
        expect(error).toMatchObject({ kind, reason })
        expect(String(error)).not.toContain(secret)
      }
      expect(h.creates()).toBe(5)
    } finally { await h.close() }
  })

  it.each([{}, { data: [] }, { data: [{ b64_json: PNG.toString('base64') }, { b64_json: PNG.toString('base64') }] }, { data: [{ b64_json: 'AA=A' }] }])('durably fails a complete invalid JSON success: %j', async body => {
    const h = await harness()
    try {
      h.setResponse({ status: 200, body: JSON.stringify(body), contentType: 'application/json' })
      const result = await h.adapter.submit(request, { idempotencyKey: 'invalid-success' })
      expect(await h.adapter.getTask(result.externalTaskId)).toMatchObject({ state: 'failed', error: { code: 'sync_output_invalid' } })
      await h.adapter.cleanup!({ idempotencyKey: 'invalid-success', status: 'failed' })
      expect(await createOpenAIProvider(h.options).submit(request, { idempotencyKey: 'invalid-success' })).toEqual(result)
      expect(h.creates()).toBe(1)
      expect((await readdir(h.dataDir, { recursive: true })).filter(path => path.endsWith('.bin'))).toEqual([])
    } finally { await h.close() }
  })

  it.each([false, true])('durably fails an oversized success envelope (chunked: %s)', async chunked => {
    const h = await harness()
    try {
      h.setResponse({ status: 200, body: 'x'.repeat(70_000), contentType: 'application/json', chunked })
      const result = await h.adapter.submit(request, { idempotencyKey: 'large-envelope' })
      expect(await h.adapter.getTask(result.externalTaskId)).toMatchObject({ state: 'failed', error: { code: 'sync_output_invalid' } })
      expect(await createOpenAIProvider(h.options).submit(request, { idempotencyKey: 'large-envelope' })).toEqual(result)
      expect(h.creates()).toBe(1)
    } finally { await h.close() }
  })

  it('keeps a truncated success response unknown without retrying after restart', async () => {
    const h = await harness()
    try {
      h.setResponse({ status: 200, body: '{"data":', contentType: 'application/json', truncated: true })
      await expect(h.adapter.submit(request, { idempotencyKey: 'truncated' })).rejects.toMatchObject({ kind: 'timeout' })
      await expect(createOpenAIProvider(h.options).submit(request, { idempotencyKey: 'truncated' })).rejects.toMatchObject({ kind: 'timeout' })
      expect(h.creates()).toBe(1)
    } finally { await h.close() }
  })

  it('keeps moderation with no stage as a durable failure that does not claim no generation occurred', async () => {
    const h = await harness()
    try {
      h.setResponse({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: { code: 'moderation_blocked' } }) })
      const result = await h.adapter.submit(request, { idempotencyKey: 'missing-stage' })
      expect(await h.adapter.getTask(result.externalTaskId)).toMatchObject({
        state: 'failed', error: { code: 'moderation_blocked', data: { reason: 'generation.moderation_rejected' }, message: expect.stringContaining('may have run; billing cannot be confirmed') },
      })
      expect(await createOpenAIProvider(h.options).submit(request, { idempotencyKey: 'missing-stage' })).toEqual(result)
      expect(h.creates()).toBe(1)
    } finally { await h.close() }
  })

  it.each(['output-moderation', 'unknown-moderation'] as const)('preserves the reason through the real runner for %s', async scenario => {
    const h = await harness(scenario)
    const db = openSpaceDb(':memory:')
    const service = createGenerationService({
      db, assets: createAssetStore({ blobsDir: join(h.dataDir, 'blobs') }),
      delivery: { deliverOutput: () => { throw new Error('Blocked outputs cannot deliver') } },
      providers: [h.adapter], defaults: { image: { provider: h.adapter.id, model: request.model } }, pollIntervalMs: 1,
    })
    try {
      const { jobId } = service.submit({ sessionId: null, turnId: null, inputSnapshotId: null }, { requestId: scenario, kind: 'image', prompt: request.prompt })
      await expect.poll(async () => { await service.pump(); return (await service.get({ jobId })).status }).toBe('failed')
      expect(await service.get({ jobId })).toMatchObject({ status: 'failed', error: { code: 'moderation_blocked', data: { reason: 'generation.moderation_rejected' }, message: expect.stringContaining(scenario === 'output-moderation' ? 'generated and then blocked' : 'may have run') } })
      const attempt = db.select().from(spaceSchema.generationAttempts).get()!
      expect(await createOpenAIProvider(h.options).submit(request, { idempotencyKey: attempt.id })).toEqual({ externalTaskId: attempt.externalTaskId })
      expect(h.creates()).toBe(1)
      expect((await readdir(h.dataDir, { recursive: true })).filter(name => name.endsWith('.bin'))).toEqual([])
      const persisted = JSON.stringify(db.select().from(spaceSchema.events).all())
      expect(persisted).not.toContain(secret)
      expect(persisted).toContain('generation.moderation_rejected')
    } finally { await service.stop(); db.$client.close(); await h.close() }
  })
})

it('reads JPEG and all WebP header variants and rejects malformed media', () => {
  const jpeg = Buffer.from([255, 216, 255, 192, 0, 11, 8, 0, 32, 0, 64, 1, 1, 0x11, 0, 255, 217])
  expect(imageOutput(jpeg)).toMatchObject({ mime: 'image/jpeg', width: 64, height: 32 })
  for (const chunk of ['VP8X', 'VP8 ', 'VP8L']) {
    const data = Buffer.alloc(30)
    data.write('RIFF', 0)
    data.write('WEBP', 8)
    data.write(chunk, 12)
    if (chunk === 'VP8X') { data.writeUIntLE(63, 24, 3); data.writeUIntLE(31, 27, 3) }
    if (chunk === 'VP8 ') { data.set([0x9d, 1, 0x2a], 23); data.writeUInt16LE(64, 26); data.writeUInt16LE(32, 28) }
    if (chunk === 'VP8L') { data[20] = 0x2f; data.writeUInt32LE(63 | (31 << 14), 21) }
    expect(imageOutput(data)).toMatchObject({ mime: 'image/webp', width: 64, height: 32 })
  }
  expect(imageOutput(Buffer.from('<html/>'))).toBeUndefined()
  expect(imageOutput(PNG.subarray(0, 20))).toBeUndefined()
})

it('reads a header from a view and retains the original image bytes without copying', () => {
  const backing = Buffer.concat([Buffer.alloc(7), PNG, Buffer.alloc(5)])
  const view = backing.subarray(7, 7 + PNG.length)
  const image = imageOutput(view)
  expect(image).toMatchObject({ mime: 'image/png', width: 1, height: 1 })
  expect(image?.data).toBe(view)
  expect(image?.data.buffer).toBe(backing.buffer)
  expect(image?.data.byteOffset).toBe(view.byteOffset)
})
