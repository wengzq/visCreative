import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TimelineEditorHost } from '../types'
import { createResources } from './resources'

afterEach(() => vi.useRealTimers())

describe('editor preview failure cache', () => {
  it.each([
    { code: 'unavailable', data: { reason: 'media.preview_unavailable' } },
    { data: { code: 'unavailable', reason: 'media.interrupted' } },
    { code: 'unavailable', message: 'Connection to studiod closed' },
    { code: 'timeout' },
  ])('retries transient failures after ten seconds: %j', async failure => {
    vi.useFakeTimers()
    const preview = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue({ kind: 'peaks', peaks: [], binsPerSecond: 1 })
    const cache = createResources({ preview } as unknown as TimelineEditorHost)
    const first = cache.preview('asset', 'peaks')
    expect(cache.preview('asset', 'peaks')).toBe(first)
    await first
    await vi.advanceTimersByTimeAsync(9999)
    await cache.preview('asset', 'peaks')
    expect(preview).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await cache.preview('asset', 'peaks')
    expect(preview).toHaveBeenCalledTimes(2)
    expect(cache.errors.has('peaks:asset')).toBe(false)
    expect(cache.previews.get('peaks:asset')?.kind).toBe('peaks')
  })
  it.each([
    { data: { code: 'not_found', reason: 'asset.version_not_found' } },
    { data: { code: 'invalid_params', reason: 'media.kind_mismatch' } },
    { data: { code: 'invalid_params', reason: 'media.no_audio' } },
  ])('keeps permanent failures cached: %j', async failure => {
    vi.useFakeTimers()
    const preview = vi.fn().mockRejectedValue(failure)
    const cache = createResources({ preview } as unknown as TimelineEditorHost)
    await cache.preview('asset', 'filmstrip')
    await vi.advanceTimersByTimeAsync(60_000)
    await cache.preview('asset', 'filmstrip')
    expect(preview).toHaveBeenCalledTimes(1)
    expect(cache.errors.get('filmstrip:asset')).toBe(failure)
  })
})
