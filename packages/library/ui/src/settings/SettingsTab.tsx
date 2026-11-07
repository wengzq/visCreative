import { useCallback, useEffect, useRef, useState } from 'react'
import type { EntityProposalView, EntityView } from '@vis/protocol'
import { describeError, useFormat, useLocale, useMessages } from '@vis/ui-kit'
import type { SettingsLibraryHost } from './host'
import { groupSettings, settingKinds } from './model'
import { SettingEditor } from './SettingEditor'
import { PendingProposals } from './Proposals'
import { settingsMessages } from './messages'
import { SettingCard } from './SettingCard'
import './settings.css'
import { refreshSeriesSettings, saveSeriesSetting, useSeriesSettings } from './series-data'
import { seriesMessages } from './series-messages'
import { unusedSeriesSettings } from './series-model'
import { SeriesActionDialog, SeriesLink } from './SeriesDialogs'
import { SeriesCard } from './SeriesCard'

export function SettingsTab({ host, query }: { host: SettingsLibraryHost; query?: string }) {
  const m = useMessages(settingsMessages)
  const seriesCopy = useMessages(seriesMessages)
  const series = useSeriesSettings(host)
  const format = useFormat()
  const { locale } = useLocale()
  const items = series.entities
  const [proposals, setProposals] = useState<EntityProposalView[]>([])
  const pendingRef = useRef(proposals)
  const [error, setError] = useState<unknown>(null)
  const [editing, setEditing] = useState<EntityView | null>(null)
  const [updating, setUpdating] = useState<EntityView | null>(null)
  const refreshProposals = useCallback(async () => {
    const result = await host.call('entity.proposalList', { status: 'pending' })
    pendingRef.current = result.items
    setProposals(result.items)
  }, [host])
  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = () => refreshProposals().catch(cause => { if (active) setError(cause) })
    void refresh()
    const off = host.onEvent(event => {
      if (!event.type.startsWith('entity.') && event.type !== 'asset.updated') return
      if (event.type === 'asset.updated' && !pendingRef.current.some(proposal => proposal.members.some(member => member.assetId === event.entityId))) return
      clearTimeout(timer)
      timer = setTimeout(() => { void refresh() }, 80)
    })
    return () => { active = false; off(); clearTimeout(timer) }
  }, [host, refreshProposals])
  const groups = groupSettings(items, query ?? '')
  const unused = unusedSeriesSettings(series.items, query)
  const saved = (entity: EntityView) => saveSeriesSetting(host, entity)
  const openExisting = async (entityId: string) => {
    try { setEditing(await host.call('entity.get', { entityId })) } catch (cause) { setError(cause) }
  }
  return <div className="library-settings">
    {error || series.error ? <p role="alert">{describeError(error ?? series.error, locale)} <button onClick={() => {
      setError(null); void refreshSeriesSettings(host); void refreshProposals().catch(setError)
    }}>{m.retry}</button></p> : null}
    {series.loading ? <p role="status">{m.loading}</p> : null}
    {proposals.length ? <PendingProposals host={host} proposals={proposals} settings={items}
      onEntity={saved}
      onResolved={() => void refreshProposals().catch(setError)} /> : null}
    {!series.loading && !items.length ? <div className="library-settings-empty"><svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path d="m12 3 9 5-9 5-9-5 9-5Z M3 12l9 5 9-5 M3 16l9 5 9-5" /></svg><h3>{m.empty}</h3><p>{m.emptyHint}</p></div> : null}
    {!series.loading && items.length > 0 && settingKinds.every(kind => !groups[kind].length) && !unused.length ? <p>{m.noMatches}</p> : null}
    {series.series ? <h3>{seriesCopy.episodeSettings}</h3> : null}
    {settingKinds.map(kind => groups[kind].length ? <details className="library-setting-group" key={kind} open>
      <summary>{m[kind]} <span>{format.number(groups[kind].length)}</span><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg></summary>
      <div className="library-setting-grid">{groups[kind].map(entity => <div key={entity.id}><SettingCard host={host} entity={entity} onClick={() => setEditing(entity)} />
        {entity.series && entity.series.latestRevision > entity.series.revision ? <button className="library-series-update" aria-label={`${seriesCopy.updateTitle} ${entity.name}`} onClick={() => setUpdating(entity)}>{seriesCopy.update}</button> : null}
      </div>)}</div>
    </details> : null)}
    {series.series ? <details className="library-setting-group library-series-unused">
      <summary>{seriesCopy.unused(series.series.name, format.number(unused.length))}</summary>
      <div className="library-setting-grid">{unused.map(item => <SeriesLink key={item.seriesEntityId} host={host} seriesEntityId={item.seriesEntityId} onLinked={saved} onError={setError}>
        {(link, busy) => <SeriesCard host={host} seriesId={series.series!.seriesId} item={item} onClick={link} disabled={busy} />}
      </SeriesLink>)}</div>
    </details> : null}
    {updating ? <SeriesActionDialog host={host} entity={updating} action="update" onClose={() => setUpdating(null)} onSaved={saved} /> : null}
    {editing ? <SettingEditor key={editing.id} host={host} entity={editing}
      onClose={() => setEditing(null)} onSaved={saved}
      onOpenExisting={id => void openExisting(id)} /> : null}
  </div>
}
