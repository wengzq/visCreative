import type { AssetVersionView } from '@vis/protocol'
import { useEffect, useRef, useState } from 'react'
import type { PromptReference } from './prompt-references'

type Metadata = { status: 'ready'; durationMs: number | undefined } | { status: 'failed' } | { status: 'pending'; promise: Promise<void> }

export function useVideoReferences(references: readonly PromptReference[], resolve: ((id: string) => Promise<AssetVersionView>) | undefined) {
  const ids = [...new Set(references.flatMap(reference => {
    const main = reference.node?.slots.find(slot => slot.slotKey === 'main')
    return reference.node?.kind === 'video' && main?.content.type === 'asset' ? [main.content.assetVersionId] : []
  }))].sort()
  const key = JSON.stringify(ids)
  const resolver = useRef(resolve)
  resolver.current = resolve
  const cache = useRef(new Map<string, Metadata>())
  const [attempt, setAttempt] = useState(0)
  const [, refresh] = useState(0)
  const canResolve = Boolean(resolve)
  useEffect(() => {
    const load = resolver.current
    if (!ids.length || !load) return
    let current = true
    const requests: Promise<void>[] = []
    for (const id of ids) {
      let entry = cache.current.get(id)
      if (!entry) {
        // Immutable asset versions keep their metadata even after a reference is removed.
        const promise = Promise.resolve().then(() => load(id)).then(asset => {
          const duration = asset.durationMs
          cache.current.set(id, { status: 'ready', durationMs: typeof duration === 'number' && Number.isFinite(duration) && duration >= 0 ? duration : undefined })
        }, () => { cache.current.set(id, { status: 'failed' }) })
        entry = { status: 'pending', promise }
        cache.current.set(id, entry)
      }
      if (entry.status === 'pending') requests.push(entry.promise)
    }
    if (!requests.length) return
    void Promise.all(requests).then(() => { if (current) refresh(value => value + 1) })
    return () => { current = false }
  }, [key, canResolve, attempt])
  return {
    references: references.map(reference => {
      const main = reference.node?.slots.find(slot => slot.slotKey === 'main')
      const metadata = main?.content.type === 'asset' ? cache.current.get(main.content.assetVersionId) : undefined
      return { ...reference, durationMs: metadata?.status === 'ready' ? metadata.durationMs : undefined }
    }),
    loading: canResolve && ids.some(id => !cache.current.has(id) || cache.current.get(id)?.status === 'pending'),
    failed: ids.some(id => cache.current.get(id)?.status === 'failed'),
    retry: () => {
      const failed = ids.filter(id => cache.current.get(id)?.status === 'failed')
      if (!failed.length) return
      for (const id of failed) cache.current.delete(id)
      setAttempt(value => value + 1)
    },
  }
}
