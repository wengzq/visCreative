import type { EntityView } from '@vis/protocol'
import { useFormat, useMessages } from '@vis/ui-kit'
import type { SettingsLibraryHost } from './host'
import { settingAssetUrl } from './data'
import { settingsMessages } from './messages'
import { seriesMessages } from './series-messages'
import { seriesBadges } from './series-model'

export function SettingCard({ host, entity, onClick, disabled, note }: { host: SettingsLibraryHost; entity: EntityView; onClick(): void; disabled?: boolean; note?: string | undefined }) {
  const m = useMessages(settingsMessages)
  const format = useFormat()
  const series = useMessages(seriesMessages)
  const badges = seriesBadges(entity)
  return <button type="button" className="library-setting-card" aria-label={entity.name} title={entity.name} disabled={disabled} onClick={onClick}>
    <div className="library-setting-cover">{entity.refs[0] ? <img alt={m.cover} src={settingAssetUrl(host, entity.refs[0].assetVersionId)} loading="lazy" /> : <>
      <div className="library-setting-placeholder"><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3" /><circle cx="9" cy="9" r="2" /><path d="m4 18 5-5 4 4 3-3 5 5" /></svg><span>{m.noRefs}</span></div>
      <span className="library-setting-missing-badge" title={m.noRefs}><svg width="4" height="4" viewBox="0 0 4 4" fill="currentColor" aria-hidden="true"><circle cx="2" cy="2" r="2" /></svg>{m.noReference}</span>
    </>}
    </div>
    <div className="library-setting-card-body"><strong>{entity.name}</strong>{note ? <small>{note}</small> : null}<p>{entity.description}</p>
      {badges.revision ? <div className="library-series-badges"><small>{series.revision(format.number(badges.revision))}</small>{badges.newer ? <small className="is-newer">{series.newer}</small> : null}{badges.modified ? <small>{series.modified}</small> : null}</div> : null}
      <footer>
        <span aria-label={m.shots(entity.usage.shotCount, format.number(entity.usage.shotCount))} title={m.shots(entity.usage.shotCount, format.number(entity.usage.shotCount))}>
          <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="2" /><path d="M2 6h12M6 3v3M10 3v3" /></svg>{format.number(entity.usage.shotCount)}
        </span>
        <span aria-label={m.membersCount(entity.members.length, format.number(entity.members.length))} title={m.membersCount(entity.members.length, format.number(entity.members.length))}>
          <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" aria-hidden="true"><circle cx="8" cy="5" r="2" /><path d="M3 14v-2a5 5 0 0 1 10 0v2" /></svg>{entity.members.length ? format.number(entity.members.length) : m.noMembers}
        </span>
        {entity.members.some(member => member.role === 'voice') ? <span aria-label={m.voice} title={m.voice}><svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" aria-hidden="true"><rect x="6" y="2" width="4" height="8" rx="2" /><path d="M4 7v1a4 4 0 0 0 8 0V7M8 12v2M5 14h6" /></svg></span> : null}
      </footer>
    </div>
  </button>
}
