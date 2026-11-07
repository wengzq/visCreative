import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { stageSyncOutput } from './sync'
import type { ProviderRequest } from './types'

const request: ProviderRequest = { kind: 'image', operation: 'generate', model: 'tiny', prompt: 'Test', inputs: [], params: {} }

it('stages synchronous outputs and deduplicates across concurrency and restart', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'vis-sync-'))
  const call = vi.fn(async () => [{ data: new Uint8Array([1, 2]), mime: 'image/png', width: 1 }])
  const options = { dataDir, providerId: 'tiny', maxBytes: 10, mimeTypes: ['image/png'], call }
  try {
    const adapter = stageSyncOutput(options)
    const other = stageSyncOutput(options)
    const submitted = await Promise.all([adapter.submit(request, { idempotencyKey: '../same' }), other.submit(request, { idempotencyKey: '../same' })])
    expect(submitted[0]).toEqual(submitted[1])
    const restarted = stageSyncOutput(options)
    expect(await restarted.submit(request, { idempotencyKey: '../same' })).toEqual(submitted[0])
    const state = await restarted.getTask(submitted[0]!.externalTaskId)
    expect(state.state).toBe('succeeded')
    if (state.state !== 'succeeded') throw new Error('Expected staged output')
    expect(await restarted.download(state.outputs[0]!)).toEqual({ data: new Uint8Array([1, 2]), mime: 'image/png', width: 1 })
    expect(call).toHaveBeenCalledTimes(1)
    await restarted.cleanup!({ idempotencyKey: '../same', status: 'succeeded' })
    expect((await readdir(dataDir, { recursive: true })).filter(name => name.endsWith('.bin'))).toEqual([])
    expect(await stageSyncOutput(options).submit(request, { idempotencyKey: '../same' })).toEqual(submitted[0])
    expect(call).toHaveBeenCalledTimes(1)
    await expect(restarted.download({ ref: '../escape', outputIndex: 0 })).rejects.toMatchObject({ kind: 'not_found' })
  } finally { await rm(dataDir, { recursive: true, force: true }) }
})

it.each(['mime', 'size', 'empty'])('records completed paid calls with unusable %s output as failed without retaining bytes', async invalid => {
  const dataDir = await mkdtemp(join(tmpdir(), 'vis-sync-'))
  const valid = { data: new Uint8Array([1]), mime: 'image/png' }
  const call = vi.fn(async () => invalid === 'empty' ? [] : [valid, { data: new Uint8Array(invalid === 'size' ? 11 : 1), mime: invalid === 'mime' ? 'text/html' : 'image/png' }])
  const options = { dataDir, providerId: 'tiny', maxBytes: 10, mimeTypes: ['image/png'], call }
  try {
    const adapter = stageSyncOutput(options)
    const submitted = await adapter.submit(request, { idempotencyKey: 'invalid' })
    expect(await adapter.getTask(submitted.externalTaskId)).toMatchObject({ state: 'failed', error: { code: 'sync_output_invalid', message: expect.stringContaining('call completed') } })
    expect((await readdir(dataDir, { recursive: true })).filter(name => name.endsWith('.bin'))).toEqual([])
    await adapter.cleanup!({ idempotencyKey: 'invalid', status: 'failed' })
    expect(await stageSyncOutput(options).submit(request, { idempotencyKey: 'invalid' })).toEqual(submitted)
    expect(call).toHaveBeenCalledTimes(1)
  } finally { await rm(dataDir, { recursive: true, force: true }) }
})

it('treats a transport failure as unknown and never repeats the synchronous call after restart', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'vis-sync-'))
  const call = vi.fn(async () => { throw new Error('Authorization: Bearer fake-sync-secret') })
  const options = { dataDir, providerId: 'tiny', maxBytes: 10, mimeTypes: ['image/png'], call }
  try {
    for (let index = 0; index < 2; index++) {
      await expect(stageSyncOutput(options).submit(request, { idempotencyKey: 'lost' })).rejects.toMatchObject({ kind: 'timeout', message: 'Synchronous generation result is unknown; not resubmitted' })
    }
    expect(call).toHaveBeenCalledTimes(1)
  } finally { await rm(dataDir, { recursive: true, force: true }) }
})

it('persists a completed failure and its reason across restart and cleanup without another call', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'vis-sync-failed-'))
  const call = vi.fn(async () => ({ state: 'failed' as const, error: { code: 'blocked_output', message: 'Generated output was blocked', reason: 'generation.moderation_rejected' } }))
  const options = { dataDir, providerId: 'tiny', maxBytes: 10, mimeTypes: ['image/png'], call }
  try {
    const adapter = stageSyncOutput(options)
    const submitted = await adapter.submit(request, { idempotencyKey: 'blocked' })
    const restarted = stageSyncOutput(options)
    expect(await restarted.getTask(submitted.externalTaskId)).toEqual({ state: 'failed', error: { code: 'blocked_output', message: 'Generated output was blocked', data: { reason: 'generation.moderation_rejected' } } })
    await restarted.cleanup!({ idempotencyKey: 'blocked', status: 'failed' })
    expect(await stageSyncOutput(options).submit(request, { idempotencyKey: 'blocked' })).toEqual(submitted)
    expect((await readdir(dataDir, { recursive: true })).filter(name => name.endsWith('.bin'))).toEqual([])
    expect(call).toHaveBeenCalledTimes(1)
  } finally { await rm(dataDir, { recursive: true, force: true }) }
})
