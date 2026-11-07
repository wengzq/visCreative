import { useEffect, useRef, useState } from 'react'
import type { AssetVersionView, LibraryAsset } from '@vis/protocol'
import { describeError, useFormat, useLocale, useMessages } from '@vis/ui-kit'
import type { LibraryHost } from '../types'
import { mediaMessages } from './messages'
import { updateAsset } from './state'

export const parseTags = (value: string) => [...new Set(value.split(/[,，]/).map(tag => tag.trim()).filter(Boolean))]

export function MediaDetail({ host, initial, entities, onClose }: { host: LibraryHost; initial: LibraryAsset; entities: ReadonlyMap<string, string>; onClose(): void }) {
  const m = useMessages(mediaMessages)
  const format = useFormat()
  const { locale } = useLocale()
  const [asset, setAsset] = useState(initial)
  const [name, setName] = useState(initial.displayName ?? '')
  const [category, setCategory] = useState(initial.category ?? '')
  const [tags, setTags] = useState(initial.tags.join(', '))
  const [versions, setVersions] = useState<AssetVersionView[]>([initial.latest])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [archiveConfirm, setArchiveConfirm] = useState(false)
  const archiveDialog = useRef<HTMLDialogElement>(null)
  const drawer = useRef<HTMLDivElement>(null)
  const assetRef = useRef(asset)
  assetRef.current = asset
  useEffect(() => {
    // A list reload may lag behind our own save, so older revisions are ignored. Usage changes keep the revision, and untouched fields follow newer ones.
    const current = assetRef.current
    if (initial.assetId !== current.assetId || initial.revision < current.revision) return
    setName(value => value.trim() === (current.displayName ?? '') ? initial.displayName ?? '' : value)
    setCategory(value => value.trim() === (current.category ?? '') ? initial.category ?? '' : value)
    setTags(value => value === current.tags.join(', ') ? initial.tags.join(', ') : value)
    setAsset(initial)
  }, [initial])
  useEffect(() => {
    if (!archiveConfirm) return
    const previous = document.activeElement as HTMLElement | null
    const element = archiveDialog.current
    element?.showModal()
    return () => { element?.close(); previous?.focus() }
  }, [archiveConfirm])
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const tools = drawer.current?.closest('.library-panel')?.querySelector<HTMLElement>('.library-panel-tools')
    const wasInert = tools?.inert ?? false
    if (tools) tools.inert = true
    drawer.current?.focus()
    return () => { if (tools) tools.inert = wasInert; previous?.focus() }
  }, [])
  useEffect(() => {
    let active = true
    void host.versions(asset).then(versions => { if (active) setVersions(versions) }, error => { if (active) setError(error) })
    return () => { active = false }
  }, [host, asset.latest.assetVersionId])
  const write = async (fields: Parameters<typeof updateAsset>[2]) => {
    setBusy(true)
    setError(null)
    try {
      const next = await updateAsset(host, asset, fields)
      setAsset(next)
      setName(next.displayName ?? '')
      setCategory(next.category ?? '')
      setTags(next.tags.join(', '))
      return true
    }
    catch (error) { setError(error); return false }
    finally { setBusy(false) }
  }
  const changed = name.trim() !== (asset.displayName ?? '') || category.trim() !== (asset.category ?? '') || tags !== asset.tags.join(', ')
  return <div ref={drawer} tabIndex={-1} className="library-detail" role="region" aria-label={m.detail} onKeyDown={event => { if (event.key === 'Escape' && !busy && !archiveConfirm) { event.stopPropagation(); onClose() } }}>
    <header><h3>{m.detail}</h3><button aria-label={m.close} onClick={onClose}>×</button></header>
    {asset.kind === 'image' ? <img className="library-detail-preview" src={host.assetUrl(asset.latest.assetVersionId)} alt={asset.displayName ?? ''} /> : asset.kind === 'video' ? <video className="library-detail-preview" controls poster={host.posterUrl(asset.latest.assetVersionId)} src={host.assetUrl(asset.latest.assetVersionId)} /> : <audio controls src={host.assetUrl(asset.latest.assetVersionId)} onPlay={event => {
      const current = event.currentTarget
      current.closest('.library-panel')?.querySelectorAll('audio').forEach(player => { if (player !== current) player.pause() })
    }} />}
    <form onSubmit={event => {
      event.preventDefault()
      const fields: Parameters<typeof updateAsset>[2] = {}
      if (name.trim() !== (asset.displayName ?? '')) fields.displayName = name.trim() || null
      if (category.trim() !== (asset.category ?? '')) fields.category = category.trim() || null
      if (tags !== asset.tags.join(', ')) fields.tags = parseTags(tags)
      void write(fields)
    }}>
      <label>{m.name}<input aria-label={m.name} value={name} maxLength={200} onChange={event => setName(event.target.value)} disabled={busy} /></label>
      <label>{m.category}<input aria-label={m.category} value={category} maxLength={20} placeholder={asset.effectiveCategory ?? m.uncategorized} onChange={event => setCategory(event.target.value)} disabled={busy} /></label>
      <label>{m.tags}<input aria-label={m.tags} value={tags} onChange={event => setTags(event.target.value)} disabled={busy} /></label>
      <small className="library-muted">{m.tagsHint}</small>
      <button className="library-primary" type="submit" disabled={busy || !changed}>{m.save}</button>
    </form>
    {asset.labeledBy === 'agent' ? <button disabled={busy || changed} onClick={() => void write({ confirm: true })}>{m.confirm}</button> : null}
    <div className="library-media-chips">{asset.entityIds.map(id => entities.get(id)).filter(Boolean).map(entity => <span className="library-entity-chip" key={entity}>{entity}</span>)}</div>
    <h4>{m.versions(format.number(asset.versionCount))}</h4>
    <ul className="library-version-list">{versions.map(version => <li key={version.assetVersionId}><a href={host.assetUrl(version.assetVersionId)} target="_blank" rel="noreferrer">{m.version(format.number(version.version))}</a>{version.assetVersionId === asset.latest.assetVersionId ? <span>{m.latest}</span> : null}</li>)}</ul>
    <h4>{m.usage(format.number(asset.usage.count))}</h4>
    {asset.usage.nodeIds.length ? <ul className="library-usage-list">{asset.usage.nodeIds.map(id => <li key={id}><button onClick={() => host.focusNode(id)}>{host.nodeTitle(id) ?? m.node}</button></li>)}</ul> : <p className="library-muted">{m.noUsage}</p>}
    {asset.usage.count > asset.usage.nodeIds.length ? <small>{m.usageMore}</small> : null}
    <button className="library-archive" disabled={busy} onClick={() => {
      if (!asset.archived) setArchiveConfirm(true)
      else void write({ archived: false }).then(saved => { if (saved) onClose() })
    }}>{asset.archived ? m.restore : m.archive}</button>
    {archiveConfirm ? <dialog ref={archiveDialog} className="vis-dialog library-dialog" aria-label={m.archiveTitle} onCancel={event => { if (busy) event.preventDefault(); else setArchiveConfirm(false) }}>
      <h2>{m.archiveTitle}</h2><p>{m.archiveNote}</p>
      {error ? <p role="alert">{describeError(error, locale)}</p> : null}
      <footer><button disabled={busy} onClick={() => setArchiveConfirm(false)}>{m.cancel}</button><button disabled={busy} onClick={() => void write({ archived: true }).then(saved => { if (saved) onClose() })}>{m.archive}</button></footer>
    </dialog> : null}
    {error ? <p role="alert">{describeError(error, locale)}</p> : null}
  </div>
}
