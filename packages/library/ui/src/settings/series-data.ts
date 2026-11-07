import { useSyncExternalStore } from 'react'
import type { EntityView, SeriesEntityView } from '@vis/protocol'
import type { SettingsLibraryHost } from './host'
import { mergeSetting } from './model'

type Snapshot = {
  series: { seriesId: string; name: string } | null
  items: SeriesEntityView[]
  entities: EntityView[]
  loading: boolean
  error: unknown
}

export function createSeriesCache(host: SettingsLibraryHost) {
  let state: Snapshot = { series: null, items: [], entities: [], loading: true, error: null }
  const listeners = new Set<() => void>()
  let cleanup: (() => void) | undefined
  let generation = 0
  const set = (patch: Partial<Snapshot>) => {
    state = { ...state, ...patch }
    for (const listener of listeners) listener()
  }
  const refresh = async (linkedOnly = false) => {
    const read = ++generation
    const partial = linkedOnly && !state.loading
    try {
      const [list, entities] = await Promise.all([
        host.call('series.entityList', {}),
        partial
          ? Promise.all(state.entities.filter(item => item.series).map(item => host.call('entity.get', { entityId: item.id })))
          : host.call('entity.list', { includeDeleted: false }).then(result => result.items),
      ])
      if (read !== generation) return
      set({ ...list, entities: partial ? entities.reduce(mergeSetting, state.entities) : entities, loading: false, error: null })
    } catch (error) { if (read === generation) set({ error, loading: false }) }
  }
  // A local edit can only change which series settings are linked, so it rereads the series list alone.
  let listRead = 0
  const refreshList = async () => {
    const read = ++listRead
    try {
      const list = await host.call('series.entityList', {})
      if (read === listRead) set(list)
    } catch (error) { if (read === listRead) set({ error }) }
  }
  return {
    snapshot: () => state,
    refresh,
    upsert: (entity: EntityView) => set({
      entities: mergeSetting(state.entities, entity),
      items: state.items.map(item => item.seriesEntityId === entity.series?.seriesEntityId
        ? { ...item, linkedEntityId: entity.id, linkedRevision: entity.series.revision } : item),
    }),
    subscribe(listener: () => void) {
      listeners.add(listener)
      if (!cleanup) {
        let timer: ReturnType<typeof setTimeout> | undefined
        const changed = new Set<string>()
        let seriesChanged = false
        const schedule = () => {
          clearTimeout(timer)
          timer = setTimeout(() => {
            const ids = [...changed]
            changed.clear()
            if (seriesChanged) { seriesChanged = false; void refresh(true) }
            for (const entityId of ids) void host.call('entity.get', { entityId }).then(entity => {
              const linked = entity.series || state.entities.find(item => item.id === entityId)?.series
              set({ entities: mergeSetting(state.entities, entity) })
              if (linked && state.series) void refreshList()
            }).catch(error => set({ error }))
          }, 80)
        }
        const offEvent = host.onEvent(event => {
          if (!event.type.startsWith('entity.') || event.type === 'entity.proposalChanged') return
          if (event.type === 'entity.deleted') {
            const linked = state.entities.find(item => item.id === event.entityId)?.series
            set({ entities: state.entities.filter(item => item.id !== event.entityId) })
            if (linked && state.series) void refreshList()
          } else changed.add(event.entityId)
          schedule()
        })
        const offSeries = host.onSeriesChanged?.(() => { seriesChanged = true; schedule() })
        cleanup = () => { clearTimeout(timer); offEvent(); offSeries?.(); generation++ }
        void refresh()
      }
      return () => {
        listeners.delete(listener)
        if (!listeners.size) { cleanup?.(); cleanup = undefined }
      }
    },
  }
}

const caches = new WeakMap<SettingsLibraryHost, ReturnType<typeof createSeriesCache>>()
function seriesCache(host: SettingsLibraryHost) {
  let cache = caches.get(host)
  if (!cache) { cache = createSeriesCache(host); caches.set(host, cache) }
  return cache
}
export const saveSeriesSetting = (host: SettingsLibraryHost, entity: EntityView) => seriesCache(host).upsert(entity)
export const refreshSeriesSettings = (host: SettingsLibraryHost) => seriesCache(host).refresh()

export function useSeriesSettings(host: SettingsLibraryHost) {
  const cache = seriesCache(host)
  return useSyncExternalStore(cache.subscribe, cache.snapshot, cache.snapshot)
}
