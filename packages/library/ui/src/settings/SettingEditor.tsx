import { useEffect, useState } from 'react'
import type { EntityKind, EntityMember, EntityRef, EntityView, MethodParams } from '@vis/protocol'
import { describeError, useFormat, useLocale, useMessages } from '@vis/ui-kit'
import type { SettingsLibraryHost } from './host'
import { SettingsDialog } from './Dialog'
import { settingAssetUrl, useSettingMedia } from './data'
import { duplicateSettingId, revisionConflict, settingKinds } from './model'
import { settingsMessages } from './messages'
import { AudioIcon } from './AudioIcon'
import { SeriesActionDialog } from './SeriesDialogs'
import { useSeriesSettings } from './series-data'
import { seriesMessages } from './series-messages'

type Changes = Pick<MethodParams<'entity.update'>, 'name' | 'description' | 'refs' | 'members'>

export async function updateSetting(host: SettingsLibraryHost, previous: EntityView, changes: Changes): Promise<EntityView> {
  try { return await host.call('entity.update', { entityId: previous.id, expectedRevision: previous.revision, ...changes }) }
  catch (error) {
    if (!revisionConflict(error)) throw error
    const current = await host.call('entity.get', { entityId: previous.id })
    // Retrying is safe only when another editor left the fields being saved untouched.
    if (Object.keys(changes).some(key => JSON.stringify(current[key as keyof Changes]) !== JSON.stringify(previous[key as keyof Changes]))) throw error
    return host.call('entity.update', { entityId: current.id, expectedRevision: current.revision, ...changes })
  }
}

export function SettingEditor({ host, entity, onClose, onSaved, onOpenExisting }: {
  host: SettingsLibraryHost; entity?: EntityView; onClose(): void; onSaved(entity: EntityView): void; onOpenExisting(id: string): void
}) {
  const m = useMessages(settingsMessages)
  const seriesCopy = useMessages(seriesMessages)
  const series = useSeriesSettings(host)
  const [seriesAction, setSeriesAction] = useState<'publish' | 'reset' | null>(null)
  const format = useFormat()
  const { locale } = useLocale()
  const [current, setCurrent] = useState(entity)
  const [name, setName] = useState(entity?.name ?? '')
  const [kind, setKind] = useState<EntityKind>(entity?.kind ?? 'character')
  const [description, setDescription] = useState(entity?.description ?? '')
  const [refs, setRefs] = useState<EntityRef[]>(entity?.refs ?? [])
  const [members, setMembers] = useState<EntityMember[]>(entity?.members ?? [])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [confirmUnmerge, setConfirmUnmerge] = useState(false)
  const [addingMembers, setAddingMembers] = useState(false)
  const [memberQuery, setMemberQuery] = useState('')
  const [refPicker, setRefPicker] = useState(false)
  const { media, error: mediaError } = useSettingMedia(host)
  const [requestId] = useState(() => crypto.randomUUID())
  const duplicates = duplicateSettingId(error)
  const byId = new Map(media.map(item => [item.assetId, item]))
  const memberImages = media.filter(item => item.kind === 'image' && members.some(member => member.assetId === item.assetId))
  const canvasImages = host.settingsCanvasImages?.() ?? []
  const dirty = !current || name.trim() !== current.name || description !== current.description ||
    JSON.stringify(refs) !== JSON.stringify(current.refs) || JSON.stringify(members) !== JSON.stringify(current.members)
  const reset = (saved: EntityView) => {
    setCurrent(saved); setKind(saved.kind); setName(saved.name); setDescription(saved.description); setRefs(saved.refs); setMembers(saved.members)
  }
  const work = async (callback: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try { await callback() }
    catch (cause) {
      setError(cause)
      setConfirmDelete(false)
      setConfirmUnmerge(false)
    } finally { setBusy(false) }
  }
  const saveDraft = async () => {
    const fields = { name: name.trim(), description, refs, members }
    const saved = current ? await updateSetting(host, current, Object.fromEntries(Object.entries(fields)
      .filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(current[key as keyof typeof fields]))) as Changes)
      : await host.call('entity.create', { requestId, kind, ...fields })
    onSaved(saved)
    return saved
  }
  const save = () => work(async () => {
    await saveDraft()
    onClose()
  })
  const addRef = (ref: EntityRef) => {
    if (refs.length < 4 && !refs.some(item => item.assetVersionId === ref.assetVersionId)) setRefs([...refs, ref])
    setRefPicker(false)
  }
  useEffect(() => {
    if (!current) return
    return host.onEvent(event => {
      if (event.type === 'entity.deleted' && event.entityId === current.id) onClose()
    })
  }, [host, current?.id, onClose])
  return <SettingsDialog title={current ? m.edit : m.create} onClose={onClose}
    footer={<><button disabled={busy} onClick={onClose}>{m.cancel}</button><button className="is-primary" disabled={busy || !name.trim() || !dirty} onClick={() => void save()}>{m.save}</button></>}>
    <div className="library-setting-fields">
      <label>{m.kind}<select aria-label={m.kind} value={kind} disabled={busy || !!current} onChange={event => setKind(event.target.value as EntityKind)}>{settingKinds.map(value => <option key={value} value={value}>{m[value]}</option>)}</select></label>
      <label>{m.name}<input autoFocus aria-label={m.name} maxLength={60} value={name} disabled={busy} onChange={event => setName(event.target.value)} /></label>
      <label>{m.description}<textarea aria-label={m.description} rows={4} maxLength={4000} value={description} disabled={busy} onChange={event => setDescription(event.target.value)} /></label>
    </div>
    <section className="library-setting-section" aria-label={m.refs}>
      <header><h3>{m.refs}</h3><button disabled={busy || refs.length >= 4} onClick={() => setRefPicker(!refPicker)}>{m.addRef}</button></header>
      <p className="library-setting-hint">{m.refHint}</p>
      <div className="library-setting-refs">{refs.map((ref, index) => <div key={ref.assetVersionId}>
        <img src={settingAssetUrl(host, ref.assetVersionId)} alt={index === 0 ? m.cover : m.refs} />
        {index === 0 ? <small>{m.cover}</small> : <button disabled={busy} onClick={() => setRefs([ref, ...refs.filter(item => item !== ref)])}>{m.makeCover}</button>}
        <button disabled={busy} aria-label={m.removeRef} onClick={() => setRefs(refs.filter(item => item !== ref))}>×</button>
      </div>)}</div>
      {refPicker ? <div className="library-setting-ref-picker">
        <h4>{m.memberImages}</h4><div className="library-setting-refs">{memberImages.map(item => <button key={item.assetId} disabled={refs.some(ref => ref.assetVersionId === item.latest.assetVersionId)} aria-label={item.displayName ?? item.assetId} onClick={() => addRef({ assetVersionId: item.latest.assetVersionId })}><img alt={item.displayName ?? item.assetId} src={settingAssetUrl(host, item.latest.assetVersionId)} /></button>)}</div>
        <h4>{m.canvasImages}</h4><div className="library-setting-refs">{canvasImages.map(item => <button key={item.ref.assetVersionId} disabled={refs.some(ref => ref.assetVersionId === item.ref.assetVersionId)} aria-label={item.label} onClick={() => addRef(item.ref)}><img alt={item.label} src={settingAssetUrl(host, item.ref.assetVersionId)} /></button>)}</div>
      </div> : null}
    </section>
    {current && series.series ? <section className="library-setting-section library-series-editor">
      <button disabled={busy || dirty} title={dirty ? seriesCopy.saveFirst : undefined} onClick={() => setSeriesAction('publish')}>{seriesCopy.publish}</button>
      {current.series?.modifiedLocally ? <button disabled={busy || dirty} title={dirty ? seriesCopy.saveFirst : undefined} onClick={() => setSeriesAction('reset')}>{seriesCopy.reset}</button> : null}
      {dirty ? <p className="library-setting-hint">{seriesCopy.saveFirst}</p> : null}
    </section> : null}
    {current && seriesAction ? <SeriesActionDialog host={host} entity={current} action={seriesAction} onClose={() => setSeriesAction(null)} onSaved={saved => { reset(saved); onSaved(saved) }} /> : null}
    <section className="library-setting-section" aria-label={m.members}>
      <header><h3>{m.members} <small>{format.number(members.length)}</small></h3><button disabled={busy || members.length >= 200} onClick={() => setAddingMembers(!addingMembers)}>{m.addMembers}</button></header>
      <div className="library-setting-member-list">{members.map(member => {
        const item = byId.get(member.assetId)
        return <div key={member.assetId} className="library-setting-member">
          {item?.kind === 'image' ? <img alt="" src={settingAssetUrl(host, item.latest.assetVersionId)} /> : <span className="library-setting-member-icon" aria-hidden="true"><AudioIcon /></span>}
          <span>{item?.displayName ?? member.assetId}</span><select aria-label={m.role} value={member.role} disabled={busy} onChange={event => setMembers(members.map(value => value.assetId === member.assetId ? { ...value, role: event.target.value as EntityMember['role'] } : value))}>{(['image', 'video', 'voice', 'other'] as const).map(role => <option key={role} value={role}>{m[role]}</option>)}</select>
          <button aria-label={m.removeMember} disabled={busy} onClick={() => setMembers(members.filter(value => value.assetId !== member.assetId))}>×</button>
        </div>
      })}</div>
      {addingMembers ? <div className="library-setting-member-picker"><input aria-label={m.search} placeholder={m.search} value={memberQuery} onChange={event => setMemberQuery(event.target.value)} />
        {media.filter(item => !members.some(member => member.assetId === item.assetId) && (item.displayName ?? item.assetId).toLocaleLowerCase().includes(memberQuery.toLocaleLowerCase())).slice(0, 100).map(item => <button key={item.assetId} disabled={busy || members.length >= 200} onClick={() => setMembers([...members, { assetId: item.assetId, role: item.kind === 'audio' ? 'voice' : item.kind }])}>{item.displayName ?? item.assetId}</button>)}
      </div> : null}
      {current && host.showSettingMembers ? <button onClick={() => { host.showSettingMembers!(current.id); onClose() }}>{m.showMembers}</button> : null}
    </section>
    {current ? <div className="library-setting-danger">
      <button disabled={busy} title={m.unmergeHint} onClick={() => setConfirmUnmerge(true)}>{m.unmerge}</button>
      <button className="is-danger" disabled={busy} onClick={() => setConfirmDelete(true)}>{m.delete}</button>
    </div> : null}
    {error || mediaError ? <p role="alert">{revisionConflict(error) ? m.conflict : duplicates ? m.duplicate : describeError(error ?? mediaError, locale)}
      {duplicates ? <button onClick={() => onOpenExisting(duplicates)}>{m.openExisting}</button> : null}
      {revisionConflict(error) && current ? <button disabled={busy} onClick={() => void work(async () => {
        const latest = await host.call('entity.get', { entityId: current.id })
        reset(latest); onSaved(latest)
      })}>{m.reload}</button> : null}
    </p> : null}
    {confirmDelete && current ? <SettingsDialog title={m.deleteTitle} onClose={() => setConfirmDelete(false)}
      footer={<><button disabled={busy} onClick={() => setConfirmDelete(false)}>{m.cancel}</button><button className="is-danger" disabled={busy} onClick={() => void work(async () => {
        await host.call('entity.delete', { entityId: current.id, expectedRevision: current.revision }); onClose()
      })}>{m.delete}</button></>}><p>{m.deleteHint}</p></SettingsDialog> : null}
    {confirmUnmerge && current && dirty ? <SettingsDialog title={m.unmerge} onClose={() => setConfirmUnmerge(false)}
      footer={<><button disabled={busy} onClick={() => setConfirmUnmerge(false)}>{m.cancel}</button>
        <button disabled={busy} onClick={() => reset(current)}>{m.discardChanges}</button>
        <button className="is-primary" disabled={busy || !name.trim()} onClick={() => void work(async () => reset(await saveDraft()))}>{m.saveChanges}</button></>}>
      <p>{m.unsavedUnmerge}</p>
    </SettingsDialog> : null}
    {confirmUnmerge && current && !dirty ? <SettingsDialog title={m.unmerge} onClose={() => setConfirmUnmerge(false)}
      footer={<><button disabled={busy} onClick={() => setConfirmUnmerge(false)}>{m.cancel}</button><button className="is-primary" disabled={busy} onClick={() => void work(async () => {
        const saved = await host.call('entity.unmerge', { requestId: crypto.randomUUID(), entityId: current.id, expectedRevision: current.revision })
        reset(saved); setConfirmUnmerge(false); onSaved(saved)
      })}>{m.unmerge}</button></>}><p>{m.unmergeHint}</p></SettingsDialog> : null}
  </SettingsDialog>
}
