import type { SeriesEntityView } from '@vis/protocol'
import { useFormat, useMessages } from '@vis/ui-kit'
import type { SettingsLibraryHost } from './host'
import { seriesMessages } from './series-messages'
import { settingsMessages } from './messages'

export function SeriesCard({ host, seriesId, item, onClick, disabled }: {
  host: SettingsLibraryHost; seriesId: string; item: SeriesEntityView; onClick(): void; disabled?: boolean
}) {
  const m = useMessages(seriesMessages)
  const common = useMessages(settingsMessages)
  const format = useFormat()
  return <article className="library-setting-card library-series-card" aria-label={item.latest.name}>
    <div className="library-setting-cover">{item.latest.refs[0] ? <img alt={common.cover} src={host.seriesRefUrl?.(seriesId, item.latest.refs[0].refId)} loading="lazy" /> : <span>{common.noRefs}</span>}</div>
    <div className="library-setting-card-body"><strong>{item.latest.name}</strong><p>{item.latest.description}</p>
      <div className="library-series-badges"><small>{m.revision(format.number(item.latest.revision))}</small></div><button disabled={disabled} onClick={onClick}>{m.use}</button>
    </div>
  </article>
}
