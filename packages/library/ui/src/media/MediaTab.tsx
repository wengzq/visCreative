import type { LibraryHost } from '../types'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { LibraryAsset, MediaKind } from '@vis/protocol'
import { describeError, useFormat, useLocale, useMessages } from '@vis/ui-kit'
import { mediaMessages } from './messages'
import { emptyFilters, type AssetPage } from './state'
import { MediaSection } from './MediaSection'
import { MediaDetail } from './MediaDetail'
import { BulkEdit } from './BulkEdit'

export function MediaTab({ host, query = '', renderGroupIntoSetting }: {
  host: LibraryHost; query?: string
  renderGroupIntoSetting?(assetIds: string[], close: () => void): ReactNode
}) {
  const m = useMessages(mediaMessages)
  const format = useFormat()
  const { locale } = useLocale()
  const [filters, setFilters] = useState(emptyFilters)
  const [entities, setEntities] = useState<ReadonlyMap<string, string>>(new Map())
  const [selected, setSelected] = useState<Map<string, LibraryAsset>>(new Map())
  const [detail, setDetail] = useState<LibraryAsset>()
  const [bulk, setBulk] = useState(false)
  const [group, setGroup] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [facets, setFacets] = useState<Partial<Record<MediaKind, AssetPage['facets']>>>({})
  const onFacets = useCallback((kind: MediaKind, value: AssetPage['facets']) => setFacets(previous => ({ ...previous, [kind]: value })), [])
  const onItems = useCallback((items: LibraryAsset[]) => {
    setDetail(previous => previous ? items.find(item => item.assetId === previous.assetId) ?? previous : previous)
  }, [])
  const tags = useMemo(() => [...new Set(Object.values(facets).flatMap(value => value?.tags.map(tag => tag.name) ?? []))].sort((a, b) => a.localeCompare(b)), [facets])
  const params = useMemo(() => ({ ...filters, query, entityId: host.entityId }), [filters, query, host.entityId])
  const ids = useMemo(() => new Set(selected.keys()), [selected])
  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = () => { void host.call('entity.list', { includeDeleted: false }).then(({ items }) => { if (active) setEntities(new Map(items.map(entity => [entity.id, entity.name]))) }, error => { if (active) setError(error) }) }
    refresh()
    const off = host.onEvent(event => {
      if (!event.type.startsWith('entity.')) return
      clearTimeout(timer)
      timer = setTimeout(refresh, 120)
    })
    return () => { active = false; clearTimeout(timer); off() }
  }, [host])
  const select = (asset: LibraryAsset) => {
    setSelected(previous => {
      const next = new Map(previous)
      if (next.has(asset.assetId)) next.delete(asset.assetId)
      else if (next.size < 50) next.set(asset.assetId, asset)
      return next
    })
  }
  return <div className="library-media-tab">
    <div inert={!!detail}>
    <div className="library-media-filters">
      <div className="library-filter-toggles">{(['unused', 'unlabeled', 'archived'] as const).map(key => <button key={key} aria-pressed={filters[key]} onClick={() => setFilters(previous => ({ ...previous, [key]: !previous[key] }))}>{m[key]}</button>)}</div>
      {tags.length ? <div className="library-tag-filters" role="group" aria-label={m.tags}>{tags.map(tag => <button key={tag} aria-pressed={filters.tag === tag} onClick={() => setFilters(previous => ({ ...previous, tag: previous.tag === tag ? undefined : tag }))}>{tag}</button>)}</div> : null}
      {host.entityId ? <div className="library-entity-filter"><span>{entities.get(host.entityId) ?? m.entityFilter}</span><button aria-label={m.clearEntity} onClick={() => host.showMedia()}>×</button></div> : null}
    </div>
    {selected.size ? <div className="library-selection-bar"><span>{m.selected(format.number(selected.size))}</span><button onClick={() => setBulk(true)}>{m.bulk}</button>{renderGroupIntoSetting ? <button onClick={() => setGroup(true)}>{m.group}</button> : null}<button onClick={() => setSelected(new Map())}>{m.clear}</button></div> : null}
    {error ? <p role="alert">{describeError(error, locale)}</p> : null}
    <div className="library-media-sections">{(['audio', 'image', 'video'] as const).map(kind => <MediaSection key={kind} kind={kind} host={host} filters={params} selected={ids} entities={entities} onSelect={select} onOpen={setDetail} onFacets={onFacets} onItems={onItems} />)}</div>
    <p className="library-empty-hint">{m.emptyHint}</p>
    </div>
    {detail ? <MediaDetail key={detail.assetId} host={host} initial={detail} entities={entities} onClose={() => setDetail(undefined)} /> : null}
    {bulk ? <BulkEdit host={host} assets={[...selected.values()]} onClose={() => { setBulk(false); setSelected(new Map()) }} /> : null}
    {/* B2 integration: the shell injects GroupIntoSettingDialog without sharing ownership of settings files. */}
    {group ? renderGroupIntoSetting?.([...selected.keys()], () => { setGroup(false); setSelected(new Map()) }) : null}
  </div>
}
