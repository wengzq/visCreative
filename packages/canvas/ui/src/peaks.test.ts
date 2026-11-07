import { expect, it, vi } from 'vitest'
import type { MediaPreview } from '@vis/protocol'
import { createPeaksCache } from './peaks'

it('shares pending and fulfilled previews by immutable asset version across nodes and panels', async () => {
  const peaks: MediaPreview = { kind: 'peaks', durationMs: 180_000, binsPerSecond: 50, peaks: [.2, .8] }
  const preview = vi.fn(async () => peaks)
  const load = createPeaksCache()
  const first = load('audio', preview)
  expect(load('audio', preview)).toBe(first)
  expect(await first).toBe(peaks)
  expect(await load('audio', preview)).toBe(peaks)
  expect(preview).toHaveBeenCalledExactlyOnceWith('audio', 'peaks')
  await load('another-version', preview)
  expect(preview).toHaveBeenCalledTimes(2)
})

it('returns the flat placeholder on preview errors, retries them later, and ignores unexpected preview kinds', async () => {
  const load = createPeaksCache()
  const rejected = vi.fn(async (): Promise<MediaPreview> => { throw new Error('Preview unavailable') })
  expect(await load('failed', rejected)).toBeUndefined()
  expect(await load('failed', rejected)).toBeUndefined()
  expect(rejected).toHaveBeenCalledTimes(2)
  expect(await load('filmstrip', async () => ({ kind: 'filmstrip', durationMs: 1000, frames: 1, frameWidth: 160, frameHeight: 90, intervalMs: 1000 }))).toBeUndefined()
})
