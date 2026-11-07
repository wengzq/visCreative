import { useState } from 'react'
import type { EntityView } from '@vis/protocol'
import { describeError, useLocale, useMessages } from '@vis/ui-kit'
import type { SettingsLibraryHost } from './host'
import { SettingsDialog } from './Dialog'
import { groupSettings, settingKinds } from './model'
import { SettingCard } from './SettingCard'
import { settingsMessages } from './messages'
import { saveSeriesSetting, useSeriesSettings } from './series-data'
import { unusedSeriesSettings } from './series-model'
import { seriesMessages } from './series-messages'
import { SeriesCard } from './SeriesCard'
import { SeriesLink } from './SeriesDialogs'

export function SettingPicker({ host, castIds, styleId, castLimitReached = false, onPick, onClose }: {
  host: SettingsLibraryHost; castIds: readonly string[]; styleId?: string; castLimitReached?: boolean
  onPick(entity: EntityView): Promise<void>; onClose(): void
}) {
  const m = useMessages(settingsMessages)
  const seriesCopy = useMessages(seriesMessages)
  const series = useSeriesSettings(host)
  const { locale } = useLocale()
  const items = series.entities
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const groups = groupSettings(items, query)
  return <SettingsDialog title={m.addFromLibrary} onClose={onClose}>
    <input type="search" aria-label={m.search} placeholder={m.search} value={query} onChange={event => setQuery(event.target.value)} maxLength={200} />
    {settingKinds.map(kind => groups[kind].length ? <section key={kind}><h3>{m[kind]}</h3>
      {kind === 'style' && styleId ? <p className="library-setting-hint">{m.replaceStyle}</p> : null}
      <div className="library-setting-grid">{groups[kind].map(entity => <SettingCard key={entity.id} host={host} entity={entity}
      note={entity.kind === 'style' && entity.id === styleId ? m.currentStyle : undefined}
      disabled={busy || (entity.kind === 'style' ? entity.id === styleId : castLimitReached || castIds.includes(entity.id))} onClick={() => {
        setBusy(true); setError(null)
        void onPick(entity).then(onClose).catch(setError).finally(() => setBusy(false))
      }} />)}</div></section> : null)}
    {!items.length ? <p>{m.empty}</p> : null}
    {series.series ? <section><h3>{seriesCopy.sharedSettings} · {series.series.name}</h3>
      <div className="library-setting-grid">{unusedSeriesSettings(series.items, query).map(item => <SeriesLink key={item.seriesEntityId} host={host} seriesEntityId={item.seriesEntityId}
        onError={setError} onLinked={async entity => { saveSeriesSetting(host, entity); await onPick(entity); onClose() }}>
        {(link, linking) => <SeriesCard host={host} seriesId={series.series!.seriesId} item={item} disabled={busy || linking || (item.kind !== 'style' && castLimitReached)} onClick={link} />}
      </SeriesLink>)}</div>
    </section> : null}
    {error || series.error ? <p role="alert">{describeError(error ?? series.error, locale)}</p> : null}
  </SettingsDialog>
}
