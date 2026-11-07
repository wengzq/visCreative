import { useEffect, useRef, useState } from 'react'
import type { EntityView, SeriesRevisionView, seriesEntity } from '@vis/protocol'
import { describeError, useFormat, useLocale, useMessages } from '@vis/ui-kit'
import type { SettingsLibraryHost } from './host'
import { SettingsDialog } from './Dialog'
import { duplicateSettingId } from './model'
import { seriesMoved } from './series-model'
import { seriesMessages } from './series-messages'
import { settingsMessages } from './messages'

type Diff = ReturnType<typeof seriesEntity.diff.result.parse>

export function SeriesActionDialog({ host, entity, action, onClose, onSaved }: {
  host: SettingsLibraryHost; entity: EntityView; action: 'update' | 'publish' | 'reset'
  onClose(): void; onSaved(entity: EntityView): void
}) {
  const m = useMessages(seriesMessages)
  const common = useMessages(settingsMessages)
  const format = useFormat()
  const { locale } = useLocale()
  const [diff, setDiff] = useState<Diff | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [conflict, setConflict] = useState(false)
  const [busy, setBusy] = useState(false)
  // A retry of the same choice reuses its requestId, so a publish whose series write landed but project write failed finishes instead of conflicting with itself.
  const requestIds = useRef(new Map<string, string>())
  useEffect(() => {
    if (action !== 'update') return
    let active = true
    void host.call('entity.seriesDiff', { entityId: entity.id }).then(value => { if (active) setDiff(value) }, cause => { if (active) setError(cause) })
    return () => { active = false }
  }, [host, entity.id, action])
  const run = async (resolve?: 'overwrite' | 'takeSeries') => {
    setBusy(true); setError(null)
    try {
      const expectedRevision = diff?.entity.revision ?? entity.revision
      const key = `${action}:${resolve ?? ''}:${expectedRevision}`
      const requestId = requestIds.current.get(key) ?? crypto.randomUUID()
      requestIds.current.set(key, requestId)
      const params = { requestId, entityId: entity.id, expectedRevision }
      const saved = action === 'publish'
        ? (await host.call('entity.publish', { ...params, ...(resolve ? { resolve } : {}) })).entity
        : await host.call(action === 'update' ? 'entity.updateFromSeries' : 'entity.resetToSeries', params)
      onSaved(saved); onClose()
    } catch (cause) {
      if (action === 'publish' && seriesMoved(cause)) setConflict(true)
      else setError(cause)
    } finally { setBusy(false) }
  }
  const preview = (revision: SeriesRevisionView, label: string) => <section>
    <h3>{label} · {m.revision(format.number(revision.revision))}</h3>
    {revision.refs[0] && seriesId ? <img alt={common.cover} src={host.seriesRefUrl?.(seriesId, revision.refs[0].refId)} /> : <p>{common.noCover}</p>}
    <strong>{revision.name}</strong><p>{revision.description}</p>
  </section>
  const [seriesId, setSeriesId] = useState<string>()
  useEffect(() => {
    if (action !== 'update') return
    let active = true
    void host.call('series.entityList', {}).then(result => { if (active) setSeriesId(result.series?.seriesId) }, cause => { if (active) setError(cause) })
    return () => { active = false }
  }, [host, action])
  return <SettingsDialog title={conflict ? m.conflictTitle : action === 'update' ? m.updateTitle : action === 'publish' ? m.publishTitle : m.resetTitle}
    onClose={() => { if (!busy) onClose() }} footer={<>
      <button disabled={busy} onClick={onClose}>{action === 'update' ? m.later : common.cancel}</button>
      {conflict ? <>
        <button disabled={busy} onClick={() => void run('takeSeries')}>{m.takeSeries}</button>
        <button className="is-primary" disabled={busy} onClick={() => void run('overwrite')}>{m.overwrite}</button>
      </> : <button className="is-primary" disabled={busy || (action === 'update' && !diff)} onClick={() => void run()}>{action === 'update' ? m.update : action === 'publish' ? m.publish : m.reset}</button>}
    </>}>
    {action === 'update' ? diff ? <>
      <div className="library-series-comparison">{preview(diff.pinned, m.pinned)}{preview(diff.latest, m.latest)}</div>
      <p>{m.shots(format.number(diff.entity.usage.shotCount))}</p><p>{m.otherEpisodes}</p>
    </> : <p role="status">{common.loading}</p> : <p>{conflict ? m.conflictNote(format.number(entity.series?.revision ?? 0)) : action === 'publish' ? m.publishNote(format.number((entity.series?.latestRevision ?? 0) + 1)) : m.resetNote}</p>}
    {error ? <p role="alert">{describeError(error, locale)}</p> : null}
  </SettingsDialog>
}

export function SeriesLink({ host, seriesEntityId, children, onLinked, onError }: {
  host: SettingsLibraryHost; seriesEntityId: string
  children(link: () => void, busy: boolean): React.ReactNode
  onLinked(entity: EntityView): void | Promise<void>
  onError?(error: unknown): void
}) {
  const m = useMessages(seriesMessages)
  const common = useMessages(settingsMessages)
  const { locale } = useLocale()
  const [collision, setCollision] = useState<EntityView | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const link = async (replace?: EntityView) => {
    setBusy(true); setError(null)
    try {
      const entity = await host.call('entity.link', {
        requestId: crypto.randomUUID(), seriesEntityId,
        ...(replace ? { replaceEntityId: replace.id, expectedRevision: replace.revision } : {}),
      })
      await onLinked(entity); setCollision(null)
    } catch (cause) {
      const id = duplicateSettingId(cause)
      if (id && !replace) {
        try { setCollision(await host.call('entity.get', { entityId: id })) } catch (readError) { setError(readError) }
      } else { setError(cause); onError?.(cause) }
    } finally { setBusy(false) }
  }
  return <>{children(() => void link(), busy)}
    {error ? <p role="alert">{describeError(error, locale)}</p> : null}
    {collision ? <SettingsDialog title={m.collisionTitle} onClose={() => { if (!busy) setCollision(null) }}
      footer={<><button disabled={busy} onClick={() => setCollision(null)}>{common.cancel}</button><button className="is-primary" disabled={busy} onClick={() => void link(collision)}>{m.replace}</button></>}>
      <strong>{collision.name}</strong><p>{m.collisionNote}</p>
    </SettingsDialog> : null}
  </>
}
