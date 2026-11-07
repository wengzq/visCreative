import { useEffect, useState } from 'react'
import type { EntityView, SeriesTarget, SeriesView } from '@vis/protocol'
import { CloseIcon, IconButton, describeError, useLocale, useMessages } from '@vis/ui-kit'
import { useModal, type ProjectOption } from './WorkspaceDialog'
import { joinChecklist, nextEpisode, type SeriesProjectHost } from './series-model'
import { seriesProjectMessages } from './series-messages'

export function SeriesFields({ items, selected, name, episode, onSelect, onName, onEpisode, disabled }: {
  items: readonly SeriesView[]; selected: string; name: string; episode: number
  onSelect(id: string): void; onName(name: string): void; onEpisode(episode: number): void; disabled?: boolean
}) {
  const m = useMessages(seriesProjectMessages)
  return <fieldset className="vis-series-fields" disabled={disabled}>
    <label>{m.series}<select aria-label={m.series} value={selected} onChange={event => onSelect(event.target.value)}>
      <option value="">{m.newSeries}</option>{items.map(item => <option key={item.seriesId} value={item.seriesId}>{item.name}</option>)}
    </select></label>
    {!selected ? <label>{m.seriesName}<input aria-label={m.seriesName} maxLength={60} required value={name} onChange={event => onName(event.target.value)} /></label> : null}
    <label>{m.episode}<input type="number" aria-label={m.episode} min={1} max={9999} required value={episode} onChange={event => onEpisode(Number(event.target.value))} /></label>
  </fieldset>
}

export function SeriesProjectDialog({ project, host, action, onClose }: {
  project: ProjectOption; host: SeriesProjectHost; action: 'join' | 'leave' | 'episode' | 'delete'; onClose(): void
}) {
  const m = useMessages(seriesProjectMessages)
  const { locale } = useLocale()
  const [items, setItems] = useState<SeriesView[]>([])
  const [entities, setEntities] = useState<EntityView[]>([])
  const [selected, setSelected] = useState(project.series?.seriesId ?? '')
  const [name, setName] = useState('')
  const [episode, setEpisode] = useState(project.series?.episode ?? 1)
  const [checked, setChecked] = useState<string[]>([])
  const [loading, setLoading] = useState(action === 'join' || action === 'episode')
  const [busy, setBusy] = useState(false)
  const [finished, setFinished] = useState(false)
  const [failures, setFailures] = useState<{ entityId: string; code: string }[]>([])
  const [error, setError] = useState<unknown>(null)
  const modal = useModal(() => { if (!busy) onClose() })
  useEffect(() => {
    if (action !== 'join' && action !== 'episode') return
    let active = true
    void Promise.all([host.list(), action === 'join' ? host.settings(project.spaceId) : Promise.resolve([])]).then(([list, settings]) => {
      if (!active) return
      setItems(list); setEntities(settings); setChecked(joinChecklist(settings, list.find(item => item.seriesId === selected)?.settingCount ?? 0))
    }).catch(cause => { if (active) setError(cause) }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [host, project.spaceId, action])
  const choose = (id: string) => {
    const series = items.find(item => item.seriesId === id)
    setSelected(id); setEpisode(nextEpisode(series)); setChecked(joinChecklist(entities, series?.settingCount ?? 0))
  }
  const save = async () => {
    setBusy(true); setError(null)
    try {
      if (action === 'delete') await host.deleteSeries(project.series!.seriesId)
      else {
        const target: SeriesTarget | null = action === 'leave' ? null : selected ? { seriesId: selected } : { name: name.trim() }
        const result = await host.setSeries({ requestId: crypto.randomUUID(), spaceId: project.spaceId, series: target,
          ...(target ? { episode } : {}), ...(action === 'join' ? { publishEntityIds: checked } : {}) })
        if (result.failed.length) { setFailures(result.failed); setFinished(true); return }
      }
      onClose()
    } catch (cause) { setError(cause) }
    finally { setBusy(false) }
  }
  const title = action === 'join' ? m.joinTitle : action === 'leave' ? m.leaveTitle : action === 'delete' ? m.deleteTitle : m.changeEpisode
  return <dialog {...modal} aria-label={title} className="vis-dialog vis-workspace-dialog" onKeyDown={event => event.stopPropagation()}>
    <form onSubmit={event => { event.preventDefault(); void save() }}>
      <header className="vis-dialog-header"><h2>{title}</h2><IconButton type="button" label={m.close} disabled={busy} onClick={onClose}><CloseIcon /></IconButton></header>
      <div className="vis-dialog-body vis-workspace-fields">
        {loading ? <p role="status">{m.loading}</p> : null}
        {action === 'leave' || action === 'delete' ? <p>{action === 'leave' ? m.leaveNote : m.deleteNote}</p> : null}
        {action === 'join' && !loading ? <>
          <SeriesFields items={items} selected={selected} name={name} episode={episode} onSelect={choose} onName={setName} onEpisode={setEpisode} disabled={busy || finished} />
          <fieldset disabled={busy || finished}><legend>{m.publishSettings}</legend><p>{m.joinNote}</p>
            {entities.map(entity => <label key={entity.id} className="vis-series-check"><input type="checkbox" checked={checked.includes(entity.id)}
              onChange={event => setChecked(event.target.checked ? [...checked, entity.id] : checked.filter(id => id !== entity.id))} />{entity.name}</label>)}
            {!entities.length ? <p>{m.emptySettings}</p> : null}
          </fieldset>
        </> : null}
        {action === 'episode' ? <label>{m.episode}<input type="number" aria-label={m.episode} min={1} max={9999} value={episode} required onChange={event => setEpisode(Number(event.target.value))} /></label> : null}
        {failures.length ? <div role="alert"><p>{m.joinedWithFailures}</p><ul>{failures.map(failure => <li key={failure.entityId}>{m.failed(entities.find(item => item.id === failure.entityId)?.name ?? failure.entityId, failure.code)}</li>)}</ul></div> : null}
        {error ? <p role="alert">{describeError(error, locale)}</p> : null}
      </div><footer className="vis-dialog-footer">
        <button type="button" disabled={busy} onClick={onClose}>{finished ? m.close : m.cancel}</button>
        {!finished ? <button className={action === 'delete' ? 'is-danger' : 'is-primary'} disabled={busy || loading || (action === 'join' && !selected && !name.trim())} type="submit">{action === 'leave' ? m.leave : action === 'delete' ? m.delete : m.save}</button> : null}
      </footer>
    </form>
  </dialog>
}
