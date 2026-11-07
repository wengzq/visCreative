import type { LibraryAsset, MethodParams } from '@vis/protocol'
import { useEffect, useSyncExternalStore } from 'react'
import type { SettingsLibraryHost } from './host'

export async function readMedia(host: SettingsLibraryHost, entityId?: string): Promise<LibraryAsset[]> {
  const items: LibraryAsset[] = []
  let cursor: string | undefined
  do {
    const page = await host.call('asset.list', { limit: 200, archived: false, usage: 'all', ...(entityId ? { entityId } : {}), ...(cursor ? { cursor } : {}) })
    items.push(...page.items)
    cursor = page.nextCursor
  } while (cursor)
  return items
}

type MediaSnapshot = { media: LibraryAsset[]; error: unknown; loading: boolean }
type MediaPage = { cursor?: string; items: LibraryAsset[] }
const mediaParams = (cursor?: string): MethodParams<'asset.list'> => ({
  limit: 200, archived: false, usage: 'all', ...(cursor ? { cursor } : {}),
})

function invalidCursor(error: unknown) {
  const value = error as { details?: { reason?: string }; data?: { reason?: string; details?: { reason?: string } } } | null
  return (value?.details ?? value?.data?.details ?? value?.data)?.reason === 'library.invalid_cursor'
}

function createMediaCache(host: SettingsLibraryHost) {
  let snapshot: MediaSnapshot = { media: [], error: null, loading: true }
  let pages: MediaPage[] = []
  let started = false
  let refreshing = false
  let fullRefresh = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const changed = new Set<string>()
  const listeners = new Set<() => void>()
  const publish = (error: unknown = null) => {
    const media = new Map<string, LibraryAsset>()
    for (const page of pages) for (const item of page.items) if (!media.has(item.assetId)) media.set(item.assetId, item)
    snapshot = { media: [...media.values()], error, loading: false }
    for (const listener of listeners) listener()
  }
  const readPages = async () => {
    const result: MediaPage[] = []
    let cursor: string | undefined
    do {
      const page = await host.call('asset.list', mediaParams(cursor))
      result.push({ ...(cursor ? { cursor } : {}), items: page.items })
      cursor = page.nextCursor
    } while (cursor)
    pages = result
  }
  const schedule = () => {
    clearTimeout(timer)
    timer = setTimeout(() => { void refresh() }, 300)
  }
  const refresh = async () => {
    if (refreshing) { schedule(); return }
    const ids = [...changed]
    changed.clear()
    const affected = new Set(ids.map(id => pages.findIndex(page => page.items.some(item => item.assetId === id))))
    const all = fullRefresh || affected.has(-1)
    fullRefresh = false
    refreshing = true
    try {
      if (all) await readPages()
      else {
        // The contract has no read-by-asset method, so retain the opaque page cursors.
        const results = await Promise.all([...affected].map(async index => ({
          index, page: await host.call('asset.list', mediaParams(pages[index]!.cursor)),
        })))
        for (const { index, page } of results) pages[index] = { ...pages[index]!, items: page.items }
      }
      publish()
    } catch (error) {
      if (!all && invalidCursor(error)) { fullRefresh = true; schedule() }
      else publish(error)
    } finally {
      refreshing = false
      if (changed.size || fullRefresh) schedule()
    }
  }
  return {
    snapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    start: () => {
      if (started) return
      started = true
      host.onEvent(event => {
        if (event.type !== 'asset.updated') return
        changed.add(event.entityId)
        schedule()
      })
      refreshing = true
      void readPages().then(() => publish(), error => publish(error)).finally(() => {
        refreshing = false
        if (changed.size) schedule()
      })
    },
  }
}

const mediaCaches = new WeakMap<SettingsLibraryHost, ReturnType<typeof createMediaCache>>()

export function useSettingMedia(host: SettingsLibraryHost) {
  let cache = mediaCaches.get(host)
  if (!cache) { cache = createMediaCache(host); mediaCaches.set(host, cache) }
  const snapshot = useSyncExternalStore(cache.subscribe, cache.snapshot, cache.snapshot)
  useEffect(cache.start, [cache])
  return snapshot
}

export function settingAssetUrl(host: SettingsLibraryHost, id: string) {
  return host.settingsAssetUrl?.(id) ?? ''
}
