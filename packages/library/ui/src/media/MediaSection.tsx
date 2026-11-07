import { useCallback, useEffect, useRef, useState } from 'react'
import type { LibraryAsset, MediaKind } from '@vis/protocol'
import { describeError, useFormat, useLocale, useMessages } from '@vis/ui-kit'
import type { LibraryHost } from '../types'
import { listParams, mergePage, refreshesMedia, type AssetPage, type MediaFilters } from './state'
import { mediaMessages } from './messages'
import { VirtualMedia } from './VirtualMedia'

export function MediaSection({ kind, host, filters, selected, entities, onSelect, onOpen, onFacets, onItems }: {
  kind: MediaKind; host: LibraryHost; filters: MediaFilters; selected: ReadonlySet<string>; entities: ReadonlyMap<string, string>
  onSelect(asset: LibraryAsset): void; onOpen(asset: LibraryAsset): void; onFacets(kind: MediaKind, facets: AssetPage['facets']): void
  onItems(items: LibraryAsset[]): void
}) {
  const m = useMessages(mediaMessages)
  const format = useFormat()
  const { locale } = useLocale()
  const [category, setCategory] = useState<string | null>()
  const [collapsed, setCollapsed] = useState(false)
  const [page, setPage] = useState<AssetPage>({ items: [] })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<unknown>(null)
  const generation = useRef(0)
  const pages = useRef(1)
  const pending = useRef(false)
  const params = listParams(filters, kind, category)
  const paramsKey = JSON.stringify(params)
  const load = useCallback(async (append = false, cursor?: string) => {
    const epoch = ++generation.current
    pending.current = true
    setLoading(true)
    setError(null)
    try {
      let result = await host.call('asset.list', { ...JSON.parse(paramsKey), ...(cursor ? { cursor } : {}) })
      if (!append) {
        const targetPages = pages.current
        for (let index = 1; index < targetPages && result.nextCursor; index++) {
          result = mergePage(result, await host.call('asset.list', { ...JSON.parse(paramsKey), cursor: result.nextCursor }))
        }
      }
      if (epoch !== generation.current) return
      if (append) { pages.current++; setPage(previous => mergePage(previous, result)) }
      else { setPage(result); onFacets(kind, result.facets) }
      onItems(result.items)
    } catch (error) { if (epoch === generation.current) setError(error) }
    finally { if (epoch === generation.current) { pending.current = false; setLoading(false) } }
  }, [host, kind, paramsKey, onFacets, onItems])
  useEffect(() => {
    pages.current = 1
    setPage({ items: [] })
    void load()
    return () => { generation.current++ }
  }, [load])
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const off = host.onEvent(event => {
      if (!refreshesMedia(event)) return
      clearTimeout(timer)
      timer = setTimeout(() => void load(), 160)
    })
    return () => { clearTimeout(timer); off() }
  }, [host, load])
  const categories = [...(page.facets?.categories ?? [])].sort((a, b) => a.name === null ? 1 : b.name === null ? -1 : a.name.localeCompare(b.name))
  const count = filters.tag ? page.facets?.tags.find(tag => tag.name === filters.tag)?.count ?? 0 : categories.reduce((total, facet) => total + facet.count, 0)
  return <section className="library-kind-section" aria-label={m[kind]}>
    <header className="library-kind-header">
      <h3 className="library-kind-heading">{m[kind]}<span className="library-kind-count">{format.number(count)}</span></h3>
      {/* All / Uncategorized alone filters nothing, so tabs appear once a named category exists. */}
      {!collapsed && (category !== undefined || categories.some(facet => facet.name !== null)) ? <div className="library-categories" role="group" aria-label={`${m[kind]} · ${m.category}`}>
        <button aria-pressed={category === undefined} onClick={() => setCategory(undefined)}>{m.all}</button>
        {categories.map(facet => <button key={facet.name ?? '__uncategorized'} aria-pressed={category === facet.name} onClick={() => setCategory(facet.name)}>{facet.name ?? m.uncategorized}<span>{format.number(facet.count)}</span></button>)}
      </div> : null}
      <button className={`library-kind-chevron${collapsed ? ' is-collapsed' : ''}`} aria-label={collapsed ? m.expand(m[kind]) : m.collapse(m[kind])} aria-expanded={!collapsed} onClick={() => setCollapsed(value => !value)}><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg></button>
    </header>
    {!collapsed ? <>
      {error ? <p role="alert">{describeError(error, locale)} <button onClick={() => void load()}>{m.retry}</button></p> : null}
      {page.items.length ? <VirtualMedia assets={page.items} host={host} selected={selected} entities={entities} onSelect={onSelect} onOpen={onOpen} /> : loading ? <div className={`library-media-skeleton${kind === 'audio' ? ' is-audio' : ''}`} aria-label={m.loading} role="status"><span /><span /><span /></div> : <div className="library-section-empty">{filters.query || filters.tag || category !== undefined || filters.unused || filters.unlabeled || filters.archived || filters.entityId ? m.noMatches : m.empty}</div>}
      {page.nextCursor ? <button className="library-load-more" disabled={loading} onClick={() => { if (!pending.current) void load(true, page.nextCursor) }}>{loading ? m.loading : m.loadMore}</button> : null}
    </> : null}
  </section>
}
