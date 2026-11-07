import { expect, it, vi } from 'vitest'
import type { EntityView, SpaceEvent } from '@vis/protocol'
import { createSeriesCache } from './series-data'
import type { SettingsLibraryHost } from './host'

it('debounces series notifications and refreshes only linked settings without rereading media or the whole library', async () => {
  vi.useFakeTimers()
  const entity: EntityView = { id: 'hero', kind: 'character', name: 'Hero', description: '', refs: [], members: [],
    revision: 1, createdAt: 1, updatedAt: 1, usage: { scriptNodeIds: [], shotCount: 0 },
    series: { seriesEntityId: 'shared', revision: 1, latestRevision: 1, modifiedLocally: false } }
  let seriesChanged = () => {}
  let event = (_event: SpaceEvent) => {}
  const offSeries = vi.fn()
  const offEvent = vi.fn()
  const call = vi.fn(async (method: string, params?: { entityId?: string }) => {
    if (method === 'series.entityList') return { series: { seriesId: 'series', name: 'Series' }, items: [] }
    if (method === 'entity.list') return { items: [entity, { ...entity, id: 'episode-only', series: undefined }] }
    if (method === 'entity.get') return params?.entityId === 'episode-only' ? { ...entity, id: 'episode-only', series: undefined } : { ...entity, series: { ...entity.series!, latestRevision: 2 } }
    throw new Error(`Unexpected call ${method}`)
  })
  const host = { call, onEvent: (listener: typeof event) => { event = listener; return offEvent },
    onSeriesChanged: (listener: typeof seriesChanged) => { seriesChanged = listener; return offSeries } } as unknown as SettingsLibraryHost
  try {
    const cache = createSeriesCache(host)
    const unsubscribe = cache.subscribe(vi.fn())
    await vi.waitFor(() => expect(cache.snapshot().loading).toBe(false))
    call.mockClear()
    seriesChanged(); seriesChanged(); seriesChanged()
    await vi.advanceTimersByTimeAsync(79)
    expect(call).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(call.mock.calls.map(([method]) => method)).toEqual(['series.entityList', 'entity.get'])
    expect(cache.snapshot().entities.find(item => item.id === 'hero')?.series?.latestRevision).toBe(2)
    expect(cache.snapshot().entities).toHaveLength(2)
    call.mockClear()
    event({ type: 'asset.updated', entityId: 'media' } as SpaceEvent)
    await vi.advanceTimersByTimeAsync(100)
    expect(call).not.toHaveBeenCalled()
    event({ type: 'entity.updated', entityId: 'episode-only' } as SpaceEvent)
    await vi.advanceTimersByTimeAsync(100)
    expect(call.mock.calls.map(([method]) => method)).toEqual(['entity.get'])
    call.mockClear()
    event({ type: 'entity.updated', entityId: 'hero' } as SpaceEvent)
    await vi.advanceTimersByTimeAsync(100)
    expect(call.mock.calls.map(([method]) => method)).toEqual(['entity.get', 'series.entityList'])
    unsubscribe()
    expect(offSeries).toHaveBeenCalledOnce()
    expect(offEvent).toHaveBeenCalledOnce()
  } finally { vi.useRealTimers() }
})
