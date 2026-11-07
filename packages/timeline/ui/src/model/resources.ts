import { useEffect, useSyncExternalStore } from 'react'
import type { MediaPreview } from '@vis/protocol'
import type { TimelineEditorHost } from '../types'
import { retryableError } from './errors'

export type AssetInfo = Awaited<ReturnType<TimelineEditorHost['assetInfo']>>
export function createResources(host: TimelineEditorHost) {
  let version = 0
  const listeners = new Set<() => void>()
  const info = new Map<string, AssetInfo>()
  const previews = new Map<string, MediaPreview>()
  const pending = new Map<string, Promise<void>>()
  const errors = new Map<string, unknown>()
  const expires = new Map<string, number>()
  const emit = () => { version++; listeners.forEach(listener => listener()) }
  const failed = (key: string, error: unknown) => {
    errors.set(key, error)
    if (retryableError(error)) expires.set(key, Date.now() + 10_000)
  }
  const cachedError = (key: string) => {
    const until = expires.get(key)
    if (until !== undefined && Date.now() >= until) { errors.delete(key); expires.delete(key) }
    return errors.has(key)
  }
  return {
    host, users: 0, info, previews, errors,
    version: () => version,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    metadata(id: string): Promise<void> {
      const key = `info:${id}`
      if (pending.has(key)) return pending.get(key)!
      if (info.has(id) || cachedError(key)) return Promise.resolve()
      const promise = this.host.assetInfo(id).then(result => { info.set(id, result) }, error => failed(key, error))
        .then(() => { pending.delete(key); emit() })
      pending.set(key, promise)
      return promise
    },
    preview(id: string, kind: 'peaks' | 'filmstrip'): Promise<void> {
      const key = `${kind}:${id}`
      if (pending.has(key)) return pending.get(key)!
      if (previews.has(key) || cachedError(key)) return Promise.resolve()
      const promise = this.host.preview(id, kind).then(result => { previews.set(key, result) }, error => failed(key, error))
        .then(() => { pending.delete(key); emit() })
      pending.set(key, promise)
      return promise
    },
  }
}
const editors = new Map<string, ReturnType<typeof createResources>>()

/** Panels share requests; the last unmount releases the editor's metadata and preview cache. */
export function useMediaResources(host: TimelineEditorHost, assetIds: readonly string[] = []) {
  const key = host.node.nodeId
  let resources = editors.get(key)
  if (!resources) { resources = createResources(host); editors.set(key, resources) }
  resources.host = host
  const cache = resources
  useSyncExternalStore(cache.subscribe, cache.version, cache.version)
  const ids = [...new Set(assetIds)].sort().join('\n')
  useEffect(() => {
    for (const id of ids.split('\n').filter(Boolean)) void cache.metadata(id)
  }, [cache, ids])
  useEffect(() => {
    cache.users++
    return () => { cache.users--; queueMicrotask(() => { if (cache.users === 0 && editors.get(key) === cache) editors.delete(key) }) }
  }, [cache, key])
  return cache
}
