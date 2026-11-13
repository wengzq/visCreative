import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { detectVideoEncoder, SOFTWARE_FIRST_H264_ENCODERS, type EncoderRunner } from '@vis/assets'
import { GenerationOperation } from '@vis/protocol'
import { z } from 'zod'
import { operationSpecOf, ProviderError } from '../types'
import type { ProviderAdapter, ProviderRequest } from '../types'
import { createPng } from './png'
import { createWav } from './wav'
import { MOCK_OPERATION_SPECS } from './models'

export type MockProviderOptions = {
  seed?: number
  /** RFC 0046: packaged builds run a bundled ffmpeg instead of the one on PATH. */
  ffmpegPath?: string
  encoderRunner?: EncoderRunner
  clock?: () => number
  latencyMs?: number
  failureRate?: number
  /** Test-only vendor rewrite; omitted by default so existing mock behavior stays unchanged. */
  revisedPrompt?: string
  faults?: {
    lostSubmitResponse?: number
    getTaskTransient?: number
    downloadTransient?: number
  }
}

const paramsSchema = z.object({
  n: z.int().min(1).max(4).default(1).meta({ 'x-vis-label': { zh: '数量', en: 'Count' } }),
  width: z.int().min(64).max(2048).default(512).meta({ 'x-vis-label': { zh: '宽度', en: 'Width' } }),
  height: z.int().min(64).max(2048).default(512).meta({ 'x-vis-label': { zh: '高度', en: 'Height' } }),
  durationMs: z.int().positive().optional().meta({ 'x-vis-label': { zh: '时长（毫秒）', en: 'Duration (ms)' } }),
})
const musicParamsSchema = z.object({
  n: z.literal(1).default(1).meta({ 'x-vis-label': { zh: '数量', en: 'Count' } }),
  duration: z.int().min(5).max(60).default(10).describe('Music duration in seconds, 5–60').meta({ 'x-vis-label': { zh: '时长', en: 'Duration' }, 'x-vis-description': { zh: '音乐秒数，5–60', en: 'Music duration in seconds, 5–60' } }),
})
const sfxParamsSchema = z.object({
  n: z.literal(1).default(1).meta({ 'x-vis-label': { zh: '数量', en: 'Count' } }),
  duration: z.int().min(1).max(10).default(2).describe('Sound effect duration in seconds, 1–10').meta({ 'x-vis-label': { zh: '时长', en: 'Duration' }, 'x-vis-description': { zh: '音效秒数，1–10', en: 'Sound effect duration in seconds, 1–10' } }),
})

function schemaFor(kind: ProviderRequest['kind'], model: string) {
  return kind === 'audio' ? (model === 'mock-sfx-1' ? sfxParamsSchema : musicParamsSchema) : paramsSchema
}

type Task = {
  operation: ProviderRequest['operation']
  kind: ProviderRequest['kind']
  model: string
  prompt: string
  frames?: ProviderRequest['frames']
  inputs: ProviderRequest['inputs']
  params: { n?: number; width?: number; height?: number; durationMs?: number | undefined; duration?: number }
  createdAt: number
  failed: boolean
  cancelled?: boolean
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Operation aborted', 'AbortError')
}

export function createMockProvider(opts: MockProviderOptions = {}): ProviderAdapter {
  const clock = opts.clock ?? Date.now
  const latencyMs = opts.latencyMs ?? 1500
  const failureRate = opts.failureRate ?? 0
  const lostSubmitResponse = opts.faults?.lostSubmitResponse ?? 0
  let getTaskTransient = opts.faults?.getTaskTransient ?? 0
  let downloadTransient = opts.faults?.downloadTransient ?? 0
  let seed = (opts.seed ?? 1) >>> 0
  const tasks = new Map<string, Task>()
  const keys = new Map<string, string>()

  function random(): number {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed / 0x100000000
  }

  function getTask(id: string): Task {
    const task = tasks.get(id)
    if (!task) throw new ProviderError('not_found', 'Job does not exist')
    return task
  }

  const adapter: ProviderAdapter = {
    id: 'mock',
    type: 'mock',
    kinds: ['image', 'video', 'audio'],
    models: ['mock-image-1', 'mock-video-1', 'mock-music-1', 'mock-sfx-1'],
    defaultModels: { image: 'mock-image-1', video: 'mock-video-1', audio: 'mock-music-1' },
    operationsFor: () => GenerationOperation.options,
    operationSpecFor: (_kind, _model, operation) => operation === 'generate' ? undefined : MOCK_OPERATION_SPECS[operation],
    frameModesFor: kind => kind === 'video' ? ['first', 'first_last'] : [],
    referenceLimitsFor: (kind, model) => kind === 'video' && model === 'mock-video-1' ? { image: 9, video: { max: 3, minMs: 1, maxMs: 30000, totalMs: 30000 }, audio: { max: 3, minMs: 1, maxMs: 30000, totalMs: 30000 } } : undefined,
    paramsSchema,
    paramsSchemaFor: schemaFor,
    async submit(req, { idempotencyKey, signal }) {
      checkAbort(signal)
      const existing = keys.get(idempotencyKey)
      if (existing) return { externalTaskId: existing }
      if (!((req.kind === 'image' && req.model === 'mock-image-1') ||
        (req.kind === 'video' && req.model === 'mock-video-1') ||
        (req.kind === 'audio' && ['mock-music-1', 'mock-sfx-1'].includes(req.model)))) {
        throw new ProviderError('rejected', 'Media type does not match the model')
      }
      const schema = req.operation === 'generate' ? schemaFor(req.kind, req.model) : operationSpecOf(adapter, req.kind, req.model, req.operation).paramsSchema
      const parsed = schema.safeParse(req.params)
      if (!parsed.success) throw new ProviderError('rejected', parsed.error.message)
      const externalTaskId = `mock-${tasks.size + 1}`
      tasks.set(externalTaskId, {
        operation: req.operation ?? 'generate',
        kind: req.kind,
        model: req.model,
        prompt: req.prompt,
        ...(req.frames ? { frames: req.frames } : {}),
        inputs: req.inputs,
        params: parsed.data,
        createdAt: clock(),
        failed: random() < failureRate,
      })
      keys.set(idempotencyKey, externalTaskId)
      if (random() < lostSubmitResponse) throw new ProviderError('timeout', 'Job accepted but response lost')
      return { externalTaskId }
    },
    async getTask(externalTaskId, options) {
      checkAbort(options?.signal)
      const task = getTask(externalTaskId)
      if (task.cancelled) return { state: 'cancelled' }
      if (getTaskTransient > 0) {
        getTaskTransient--
        throw new ProviderError('transient', 'Simulated temporary query failure')
      }
      const elapsed = clock() - task.createdAt
      if (elapsed < latencyMs) return { state: 'running', progress: Math.max(0, elapsed / latencyMs) }
      if (task.failed) return { state: 'failed', error: { code: 'mock_failed', message: 'Simulated generation failure' } }
      return {
        state: 'succeeded',
        ...(opts.revisedPrompt !== undefined ? { revisedPrompt: opts.revisedPrompt } : {}),
        outputs: Array.from({ length: task.params.n ?? 1 }, (_, outputIndex) => ({ outputIndex, ref: externalTaskId })),
      }
    },
    async findTaskByIdempotencyKey(idempotencyKey) {
      const externalTaskId = keys.get(idempotencyKey)
      return externalTaskId ? { externalTaskId } : null
    },
    async cancel(externalTaskId) {
      getTask(externalTaskId).cancelled = true
      return { cancelled: true }
    },
    async download(output, options) {
      checkAbort(options?.signal)
      const task = getTask(output.ref)
      if (task.cancelled) throw new ProviderError('rejected', 'Job cancelled')
      if (!Number.isInteger(output.outputIndex) || output.outputIndex < 0 || output.outputIndex >= (task.params.n ?? 1)) {
        throw new ProviderError('rejected', 'Output index out of range')
      }
      if (task.failed || clock() - task.createdAt < latencyMs) {
        throw new ProviderError('rejected', 'Job has no downloadable outputs yet')
      }
      if (downloadTransient > 0) {
        downloadTransient--
        throw new ProviderError('transient', 'Simulated temporary download failure')
      }
      if (task.kind === 'video') {
        if (task.operation !== 'generate') {
          const dir = await mkdtemp(join(tmpdir(), 'vis-mock-operation-'))
          try {
            const image = join(dir, 'label.png')
            const video = join(dir, 'label.mp4')
            await writeFile(image, createPng(128, 128, task.prompt, output.outputIndex, task.operation))
            const encoder = await detectVideoEncoder({ ...(opts.ffmpegPath ? { ffmpegPath: opts.ffmpegPath } : {}), ...(opts.encoderRunner ? { exec: opts.encoderRunner } : {}), priority: SOFTWARE_FIRST_H264_ENCODERS })
            await promisify(execFile)(opts.ffmpegPath ?? 'ffmpeg', ['-v', 'error', '-nostdin', '-loop', '1', '-i', image, '-t', '1', '-r', '10', '-c:v', encoder.name, ...encoder.args, '-metadata', `comment=${task.operation}`, '-y', video], { windowsHide: true, timeout: 30_000, ...(options?.signal ? { signal: options.signal } : {}) })
            return { data: await readFile(video), mime: 'video/mp4', width: 128, height: 128, durationMs: 1000, fps: 10 }
          } finally { await rm(dir, { recursive: true, force: true }) }
        }
        const data = await readFile(new URL('./fixtures/sample.mp4', import.meta.url), options?.signal ? { signal: options.signal } : {})
        checkAbort(options?.signal)
        // MP4 readers ignore the trailing diagnostic payload, while tests can inspect exactly which frames arrived.
        return { data: Buffer.concat([data, Buffer.from(`\nVIS_FRAMES:${JSON.stringify(task.frames ?? null)}\nVIS_INPUTS:${JSON.stringify(task.inputs)}`)]), mime: 'video/mp4', width: 128, height: 128, durationMs: 1000, fps: 24 }
      }
      if (task.kind === 'audio') {
        const duration = task.params.duration!
        return { data: createWav(task.prompt, duration, task.model === 'mock-sfx-1'), mime: 'audio/wav', durationMs: duration * 1000 }
      }
      const { width = 512, height = 512 } = task.params
      return { data: createPng(width, height, task.prompt, output.outputIndex, task.operation !== 'generate' ? task.operation : undefined, { Inputs: task.inputs, Frames: task.frames ?? null }), mime: 'image/png', width, height }
    },
  }
  return adapter
}
