import { crc32, inflateSync } from 'node:zlib'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { operationSpecOf, paramsSchemaOf, ProviderError } from '../types'
import type { ProviderAdapter, ProviderOutputRef, ProviderRequest } from '../types'
import { createMockProvider } from './index'

const hasFfprobe = (() => {
  try { execFileSync('ffprobe', ['-version'], { stdio: 'ignore' }); return true } catch { return false }
})()

const imageRequest: ProviderRequest = {
  operation: 'generate',
  kind: 'image',
  model: 'mock-image-1',
  prompt: '蓝色天空中的白云',
  params: { n: 2, width: 64, height: 96 },
  inputs: [],
}

async function expectProviderError(promise: Promise<unknown>, kind: ProviderError['kind']) {
  await expect(promise).rejects.toBeInstanceOf(ProviderError)
  await expect(promise).rejects.toMatchObject({ kind })
}

async function outputsOf(provider: ProviderAdapter, id: string): Promise<ProviderOutputRef[]> {
  const state = await provider.getTask(id)
  expect(state.state).toBe('succeeded')
  if (state.state !== 'succeeded') throw new Error('Job should have completed')
  return state.outputs
}

function expectValidPng(data: Uint8Array, width: number, height: number) {
  const png = Buffer.from(data)
  expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
  const chunks: { type: string, data: Buffer }[] = []
  let offset = 8
  while (offset < png.length) {
    const length = png.readUInt32BE(offset)
    const end = offset + 8 + length
    expect(end + 4).toBeLessThanOrEqual(png.length)
    expect(png.readUInt32BE(end)).toBe(crc32(png.subarray(offset + 4, end)))
    chunks.push({ type: png.toString('ascii', offset + 4, offset + 8), data: png.subarray(offset + 8, end) })
    offset = end + 4
  }
  expect(offset).toBe(png.length)
  expect(chunks[0]?.type).toBe('IHDR')
  expect(chunks.at(-1)?.type).toBe('IEND')
  const header = chunks[0]!.data
  expect(header.length).toBe(13)
  expect(header.readUInt32BE(0)).toBe(width)
  expect(header.readUInt32BE(4)).toBe(height)
  const compressed = Buffer.concat(chunks.filter(chunk => chunk.type === 'IDAT').map(chunk => chunk.data))
  expect(inflateSync(compressed).length).toBeGreaterThan(0)
}

describe('mock provider', () => {
  it('declares local video references and accepts them without hosting', async () => {
    const provider = createMockProvider({ latencyMs: 0 })
    expect(provider.referenceLimitsFor?.('video', 'mock-video-1')).toEqual({ image: 9, video: { max: 3, minMs: 1, maxMs: 30000, totalMs: 30000 }, audio: { max: 3, minMs: 1, maxMs: 30000, totalMs: 30000 } })
    const request: ProviderRequest = { ...imageRequest, kind: 'video', model: 'mock-video-1', inputs: [{ type: 'asset', kind: 'video', mime: 'video/mp4', path: '/local.mp4', durationMs: 3000 }] }
    await expect(provider.submit(request, { idempotencyKey: 'local-video' })).resolves.toHaveProperty('externalTaskId')
    await expect(provider.submit({ ...request, inputs: [{ type: 'asset', kind: 'audio', mime: 'audio/wav', path: '/local.wav', durationMs: 1 }] }, { idempotencyKey: 'local-audio' })).resolves.toHaveProperty('externalTaskId')
  })

  it.each([
    { operation: 'image.upscale', kind: 'image', model: 'mock-image-1', defaults: { scale: 2 }, prompt: 'none', valid: { scale: 4 }, invalid: [{ scale: 1 }, { scale: 3 }] },
    { operation: 'image.outpaint', kind: 'image', model: 'mock-image-1', defaults: { ratio: '16:9' }, prompt: 'optional', valid: { ratio: '1:1' }, invalid: [{ ratio: 'invalid' }] },
    { operation: 'image.matting', kind: 'image', model: 'mock-image-1', defaults: {}, prompt: 'none', valid: {}, invalid: [{ scale: 2 }] },
    { operation: 'image.multiview', kind: 'image', model: 'mock-image-1', defaults: { views: 4 }, prompt: 'none', valid: { views: 2 }, invalid: [{ views: 1 }, { views: 5 }, { views: 2.5 }] },
    { operation: 'video.upscale', kind: 'video', model: 'mock-video-1', defaults: { scale: 2 }, prompt: 'none', valid: { scale: 4 }, invalid: [{ scale: 3 }] },
    { operation: 'video.removeSubtitles', kind: 'video', model: 'mock-video-1', defaults: {}, prompt: 'none', valid: {}, invalid: [{ scale: 2 }] },
    { operation: 'video.reshoot', kind: 'video', model: 'mock-video-1', defaults: { duration: 5 }, prompt: 'required', valid: { duration: 10 }, invalid: [{ duration: 0 }, { duration: 11 }, { duration: 1.5 }] },
  ] as const)('$operation has independent settings with defaults and its prompt rule', async ({ operation, kind, model, defaults, prompt, valid, invalid }) => {
    const provider = createMockProvider({ latencyMs: 0 })
    const spec = operationSpecOf(provider, kind, model, operation)
    expect(spec.prompt).toBe(prompt)
    expect(spec.paramsSchema.parse({})).toEqual(defaults)
    expect(spec.paramsSchema.parse(valid)).toEqual(valid)
    expect(spec.paramsSchema.safeParse({ width: 64, height: 64 }).success).toBe(false)
    for (const params of invalid) expect(spec.paramsSchema.safeParse(params).success).toBe(false)
    const request: ProviderRequest = { operation, kind, model, prompt: prompt === 'required' ? 'Film again' : '', params: {}, inputs: [] }
    const { externalTaskId } = await provider.submit(request, { idempotencyKey: operation })
    expect(await outputsOf(provider, externalTaskId)).toEqual([{ outputIndex: 0, ref: externalTaskId }])
    await expectProviderError(provider.submit({ ...request, params: { n: 2 } }, { idempotencyKey: `${operation}-generate-settings` }), 'rejected')
    await expect(provider.findTaskByIdempotencyKey!(`${operation}-generate-settings`)).resolves.toBeNull()
  })

  it('uses default parameters and 1500ms delay; clock rollback never makes progress negative', async () => {
    let now = 1000
    const provider = createMockProvider({ clock: () => now })
    expect(provider.paramsSchema.parse({})).toMatchObject({ n: 1, width: 512, height: 512 })
    const { externalTaskId } = await provider.submit({ ...imageRequest, params: {} }, { idempotencyKey: 'default' })
    await expect(provider.getTask(externalTaskId)).resolves.toEqual({ state: 'running', progress: 0 })
    now = 999
    await expect(provider.getTask(externalTaskId)).resolves.toEqual({ state: 'running', progress: 0 })
    now = 1750
    await expect(provider.getTask(externalTaskId)).resolves.toEqual({ state: 'running', progress: 0.5 })
    now = 2499
    expect((await provider.getTask(externalTaskId)).state).toBe('running')
    now = 2500
    const outputs = await outputsOf(provider, externalTaskId)
    expect(outputs).toEqual([{ outputIndex: 0, ref: externalTaskId }])
    const downloaded = await provider.download(outputs[0]!)
    expect(downloaded).toMatchObject({ mime: 'image/png', width: 512, height: 512 })
  })

  it('zero delay completes immediately with valid image counts, dimensions, and PNG content', async () => {
    const provider = createMockProvider({ latencyMs: 0 })
    const { externalTaskId } = await provider.submit(imageRequest, { idempotencyKey: 'images' })
    const outputs = await outputsOf(provider, externalTaskId)
    expect(outputs.map(output => output.outputIndex)).toEqual([0, 1])
    for (const output of outputs) {
      const downloaded = await provider.download(output)
      expect(downloaded).toMatchObject({ mime: 'image/png', width: 64, height: 96 })
      expectValidPng(downloaded.data, 64, 96)
    }
  })

  it('the same seed and request produce identical bytes; different output indices produce different bytes', async () => {
    const providers = [createMockProvider({ seed: 42, latencyMs: 0 }), createMockProvider({ seed: 42, latencyMs: 0 })]
    const images: Uint8Array[][] = []
    for (const provider of providers) {
      const { externalTaskId } = await provider.submit(imageRequest, { idempotencyKey: 'same' })
      const outputs = await outputsOf(provider, externalTaskId)
      images.push(await Promise.all(outputs.map(async output => (await provider.download(output)).data)))
    }
    expect(images[0]).toEqual(images[1])
    expect(images[0]![0]).not.toEqual(images[0]![1])
  })

  it('video returns recognizable MP4 and fixed metadata', async () => {
    const provider = createMockProvider({ latencyMs: 0 })
    const request: ProviderRequest = { ...imageRequest, kind: 'video', model: 'mock-video-1', params: {} }
    const { externalTaskId } = await provider.submit(request, { idempotencyKey: 'video' })
    const [output] = await outputsOf(provider, externalTaskId)
    const downloaded = await provider.download(output!)
    expect(downloaded).toMatchObject({ mime: 'video/mp4', width: 128, height: 128, durationMs: 1000, fps: 24 })
    expect(downloaded.data.length).toBeGreaterThan(8)
    expect(Buffer.from(downloaded.data).toString('ascii', 4, 8)).toBe('ftyp')
  })
  it.skipIf(!hasFfprobe)('keeps the mock video frame rate aligned with its fixture', async () => {
    const provider = createMockProvider({ latencyMs: 0 })
    const { externalTaskId } = await provider.submit({ ...imageRequest, kind: 'video', model: 'mock-video-1', params: {} }, { idempotencyKey: 'fps' })
    const downloaded = await provider.download((await outputsOf(provider, externalTaskId))[0]!)
    const path = fileURLToPath(new URL('./fixtures/sample.mp4', import.meta.url))
    const info = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=avg_frame_rate', '-of', 'json', path], { encoding: 'utf8', shell: false }))
    const [n, d] = info.streams[0].avg_frame_rate.split('/').map(Number)
    expect(downloaded.fps).toBe(n / d)
  })

  it.each([
    { model: 'mock-music-1', duration: 10, min: 5, max: 60 },
    { model: 'mock-sfx-1', duration: 2, min: 1, max: 10 },
  ])('$model synthesizes stable PCM16 mono 22050Hz WAV and validates duration by model', async ({ model, duration, min, max }) => {
    const provider = createMockProvider({ latencyMs: 0 })
    const schema = paramsSchemaOf(provider, 'audio', model)
    expect(schema.parse({})).toEqual({ n: 1, duration })
    expect(schema.safeParse({ duration: min }).success).toBe(true)
    expect(schema.safeParse({ duration: max }).success).toBe(true)
    for (const invalid of [min - 1, max + 1, min + 0.5]) {
      await expectProviderError(provider.submit({ ...imageRequest, kind: 'audio', model, params: { duration: invalid } }, { idempotencyKey: `invalid-${invalid}` }), 'rejected')
    }
    const downloads = []
    for (const [index, prompt] of ['雨夜', '雨夜', '晴天'].entries()) {
      const request: ProviderRequest = { operation: 'generate', kind: 'audio', model, prompt, params: { duration: min }, inputs: [] }
      const { externalTaskId } = await provider.submit(request, { idempotencyKey: `audio-${index}` })
      const [output] = await outputsOf(provider, externalTaskId)
      const downloaded = await provider.download(output!)
      expect(downloaded).toMatchObject({ mime: 'audio/wav', durationMs: min * 1000 })
      expect(downloaded).not.toHaveProperty('width')
      expect(downloaded).not.toHaveProperty('height')
      const wav = Buffer.from(downloaded.data)
      expect(wav.toString('ascii', 0, 4)).toBe('RIFF')
      expect(wav.readUInt32LE(4)).toBe(wav.length - 8)
      expect(wav.toString('ascii', 8, 16)).toBe('WAVEfmt ')
      expect(wav.readUInt16LE(20)).toBe(1)
      expect(wav.readUInt16LE(22)).toBe(1)
      expect(wav.readUInt32LE(24)).toBe(22050)
      expect(wav.readUInt32LE(28)).toBe(44100)
      expect(wav.readUInt16LE(32)).toBe(2)
      expect(wav.readUInt16LE(34)).toBe(16)
      expect(wav.toString('ascii', 36, 40)).toBe('data')
      expect(wav.readUInt32LE(40)).toBe(min * 22050 * 2)
      expect(wav.length).toBe(44 + min * 22050 * 2)
      expect(wav.subarray(44).some(byte => byte !== 0)).toBe(true)
      downloads.push(wav)
    }
    expect(downloads[0]).toEqual(downloads[1])
    expect(downloads[0]).not.toEqual(downloads[2])
  })

  it('identical idempotency keys reuse jobs, different keys create jobs, and unknown keys return null', async () => {
    const provider = createMockProvider()
    await expect(provider.findTaskByIdempotencyKey!('missing')).resolves.toBeNull()
    const first = await provider.submit(imageRequest, { idempotencyKey: 'same' })
    await expect(provider.submit(imageRequest, { idempotencyKey: 'same' })).resolves.toEqual(first)
    await expect(provider.findTaskByIdempotencyKey!('same')).resolves.toEqual(first)
    expect(await provider.submit(imageRequest, { idempotencyKey: 'other' })).not.toEqual(first)
  })

  it('lost submission responses recover by key; retries neither lose responses again nor create jobs', async () => {
    const provider = createMockProvider({ faults: { lostSubmitResponse: 1 }, latencyMs: 0 })
    await expectProviderError(provider.submit(imageRequest, { idempotencyKey: 'lost' }), 'timeout')
    const recovered = await provider.findTaskByIdempotencyKey!('lost')
    expect(recovered).not.toBeNull()
    await expect(provider.submit(imageRequest, { idempotencyKey: 'lost' })).resolves.toEqual(recovered)
    expect(await outputsOf(provider, recovered!.externalTaskId)).toHaveLength(2)
  })

  it('query failure counts belong to instances and recover after the first two failed calls', async () => {
    const provider = createMockProvider({ latencyMs: 0, faults: { getTaskTransient: 2 } })
    const first = await provider.submit(imageRequest, { idempotencyKey: 'first' })
    const second = await provider.submit(imageRequest, { idempotencyKey: 'second' })
    await expectProviderError(provider.getTask(first.externalTaskId), 'transient')
    await expectProviderError(provider.getTask(second.externalTaskId), 'transient')
    expect(await outputsOf(provider, first.externalTaskId)).toHaveLength(2)
    expect(await outputsOf(provider, second.externalTaskId)).toHaveLength(2)
  })

  it('download failure counts belong to instances; other outputs can download after the first failure', async () => {
    const provider = createMockProvider({ latencyMs: 0, faults: { downloadTransient: 1 } })
    const { externalTaskId } = await provider.submit(imageRequest, { idempotencyKey: 'download' })
    const outputs = await outputsOf(provider, externalTaskId)
    await expectProviderError(provider.download(outputs[0]!), 'transient')
    expect((await provider.download(outputs[1]!)).data.length).toBeGreaterThan(0)
    expect((await provider.download(outputs[0]!)).data.length).toBeGreaterThan(0)
  })

  it('failureRate 1 always fails when due and prevents downloading', async () => {
    let now = 0
    const provider = createMockProvider({ failureRate: 1, clock: () => now })
    const { externalTaskId } = await provider.submit(imageRequest, { idempotencyKey: 'failed' })
    expect((await provider.getTask(externalTaskId)).state).toBe('running')
    now = 1500
    const failed = await provider.getTask(externalTaskId)
    expect(failed).toMatchObject({ state: 'failed', error: { code: expect.any(String), message: expect.any(String) } })
    now = 3000
    await expect(provider.getTask(externalTaskId)).resolves.toEqual(failed)
    await expectProviderError(provider.download({ ref: externalTaskId, outputIndex: 0 }), 'rejected')
  })

  it('the same seed reproduces mixed-probability job failure and lost-submission sequences', async () => {
    const sequences: unknown[][] = []
    for (let instance = 0; instance < 2; instance++) {
      const provider = createMockProvider({ seed: 42, latencyMs: 0, failureRate: 0.5, faults: { lostSubmitResponse: 0.5 } })
      const sequence = []
      for (let index = 0; index < 8; index++) {
        const idempotencyKey = `seed-${index}`
        let lost = false
        try {
          await provider.submit(imageRequest, { idempotencyKey })
        } catch (error) {
          expect(error).toBeInstanceOf(ProviderError)
          expect(error).toMatchObject({ kind: 'timeout' })
          lost = true
        }
        const recovered = await provider.findTaskByIdempotencyKey!(idempotencyKey)
        sequence.push({ lost, state: (await provider.getTask(recovered!.externalTaskId)).state })
      }
      sequences.push(sequence)
    }
    expect(sequences[0]).toEqual(sequences[1])
    expect(new Set(sequences[0]!.map(item => JSON.stringify(item))).size).toBeGreaterThan(1)
  })

  it.each([
    { n: 0 }, { n: 5 }, { n: 1.5 },
    { width: 63 }, { width: 2049 }, { width: 64.5 },
    { height: 63 }, { height: 2049 }, { height: 64.5 },
  ])('rejects invalid parameters %j without recording jobs', async params => {
    const provider = createMockProvider()
    await expectProviderError(provider.submit({ ...imageRequest, params }, { idempotencyKey: 'invalid' }), 'rejected')
    await expect(provider.findTaskByIdempotencyKey!('invalid')).resolves.toBeNull()
  })

  it.each([
    { kind: 'image', model: 'mock-video-1' },
    { kind: 'video', model: 'mock-image-1' },
    { kind: 'image', model: 'missing' },
  ] as const)('rejects mismatched kind/model: %j', async model => {
    const provider = createMockProvider()
    await expectProviderError(provider.submit({ ...imageRequest, ...model }, { idempotencyKey: 'invalid' }), 'rejected')
  })

  it('unknown job queries and downloads both return not_found', async () => {
    const provider = createMockProvider()
    await expectProviderError(provider.getTask('missing'), 'not_found')
    await expectProviderError(provider.download({ ref: 'missing', outputIndex: 0 }), 'not_found')
  })

  it('cannot download before completion or with invalid output indices', async () => {
    let now = 0
    const provider = createMockProvider({ clock: () => now })
    const { externalTaskId } = await provider.submit(imageRequest, { idempotencyKey: 'boundary' })
    await expectProviderError(provider.download({ ref: externalTaskId, outputIndex: 0 }), 'rejected')
    now = 1500
    for (const outputIndex of [-1, 0.5, 2]) {
      await expectProviderError(provider.download({ ref: externalTaskId, outputIndex }), 'rejected')
    }
  })

  it.each([undefined, '自定义取消原因'])('all three aborted methods throw DOMException AbortError (reason=%s)', async reason => {
    const provider = createMockProvider()
    const signal = AbortSignal.abort(reason)
    const calls = [
      provider.submit(imageRequest, { idempotencyKey: 'aborted', signal }),
      provider.getTask('missing', { signal }),
      provider.download({ ref: 'missing', outputIndex: 0 }, { signal }),
    ]
    for (const promise of calls) {
      await expect(promise).rejects.toBeInstanceOf(DOMException)
      await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    }
    await expect(provider.findTaskByIdempotencyKey!('aborted')).resolves.toBeNull()
  })
})
