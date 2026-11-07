import type { MethodResult } from '@vis/protocol'
import { describeError, formatter, type Locale, useFormat, useLocale, useMessages } from '@vis/ui-kit'
import { WorkDialog } from '@vis/workbench-ui'
import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { RpcClient } from './rpc'
import { settingsMessages } from './messages'

type DeletedProject = MethodResult<'space.listDeleted'>['spaces'][number]
type DiskUsage = MethodResult<'space.diskUsage'>
type UsageState = { usage?: DiskUsage; error?: unknown }
const rid = () => `web-${crypto.randomUUID()}`

export function diskSize(bytes: number, locale: Locale = 'zh-CN') {
  return formatter(locale).bytes(bytes)
}

export function PurgeProjectDialog({ project, usage, busy, error, onClose, onPurge }: {
  project: DeletedProject
  usage?: DiskUsage
  busy: boolean
  error: string
  onClose(): void
  onPurge(deleteProjectDir: boolean): void
}) {
  const m = useMessages(settingsMessages)
  const { locale } = useLocale()
  const format = useFormat()
  const cancel = useRef<HTMLButtonElement>(null)
  const [deleteProjectDir, setDeleteProjectDir] = useState(false)
  const descriptionId = useId()
  const canDeleteDir = project.canDeleteProjectDir && project.rootPathExists
  useEffect(() => { cancel.current?.focus() }, [])
  return <WorkDialog title={m.purgeTitle(project.name)} onClose={onClose} hasUnsavedInput={busy || deleteProjectDir}>
    <div className="vis-work-form">
      <p>{m.purgeDataWarning(usage ? format.bytes(usage.dataBytes) : m.calculating)}</p>
      <label className="project-purge-checkbox"><input type="checkbox" checked={deleteProjectDir} disabled={busy || !canDeleteDir} aria-describedby={descriptionId} onChange={event => setDeleteProjectDir(event.currentTarget.checked)} />{m.purgeDirectoryLabel(!project.rootPathExists ? m.projectDirectoryMissing : usage?.projectDirBytes != null ? format.bytes(usage.projectDirBytes) : m.calculating)}</label>
      <p className="vis-work-delete-directory"><span>{project.rootPath}</span></p>
      <div id={descriptionId}>
        {!canDeleteDir ? <p className="vis-work-muted">{!project.rootPathExists ? m.projectDirectoryMissing : project.canDeleteProjectDirReason ? describeError(project.canDeleteProjectDirReason, locale) : m.purgeDirectoryProtected}</p> : null}
        {deleteProjectDir ? <p className="vis-work-error">{m.purgeDirectoryWarning}</p> : null}
      </div>
      {error ? <p className="vis-work-error" role="alert">{describeError(error, locale)}</p> : null}
      <div className="vis-work-form-actions"><button ref={cancel} type="button" autoFocus onClick={onClose}>{m.cancel}</button><button type="button" className="is-danger" disabled={busy} onClick={() => onPurge(deleteProjectDir && canDeleteDir)}>{busy ? m.deleting : m.purge}</button></div>
    </div>
  </WorkDialog>
}

export function RecentlyDeleted({ rpc, refreshKey, onChanged, notify }: {
  rpc: Pick<RpcClient, 'call'>
  refreshKey: unknown
  onChanged(): Promise<void>
  notify(text: string): void
}) {
  const m = useMessages(settingsMessages)
  const { locale } = useLocale()
  const format = useFormat()
  const [spaces, setSpaces] = useState<DeletedProject[]>([])
  const [usages, setUsages] = useState<Record<string, UsageState>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<{ kind: 'load' | 'refresh' | 'restore'; error: unknown } | null>(null)
  const [status, setStatus] = useState<{ kind: 'restore'; name: string; missing: boolean } | { kind: 'purge'; name: string; moved: string | undefined } | null>(null)
  const [reload, setReload] = useState(0)
  const [busy, setBusy] = useState<string | null>(null)
  const [purging, setPurging] = useState<DeletedProject | null>(null)
  const [purgeError, setPurgeError] = useState<unknown>(null)
  const purgeRequest = useRef<{ deleteProjectDir: boolean; requestId: string } | null>(null)
  const restoreRequests = useRef(new Map<string, string>())
  useEffect(() => {
    let current = true
    setLoading(true)
    setError(null)
    void rpc.call<MethodResult<'space.listDeleted'>>('space.listDeleted', {}).then(({ spaces }) => {
      if (!current) return
      setSpaces(spaces)
      setUsages({})
      setLoading(false)
      for (const project of spaces) void rpc.call<DiskUsage>('space.diskUsage', { spaceId: project.spaceId }).then(usage => {
        if (current) setUsages(previous => ({ ...previous, [project.spaceId]: { usage } }))
      }, error => {
        if (current) setUsages(previous => ({ ...previous, [project.spaceId]: { error } }))
      })
    }, error => { if (current) { setLoading(false); setError({ kind: 'load', error }) } })
    return () => { current = false }
  }, [rpc, refreshKey, reload])

  const restore = async (project: DeletedProject) => {
    if (busy) return
    setBusy(project.spaceId)
    setError(null)
    try {
      const requestId = restoreRequests.current.get(project.spaceId) ?? rid()
      restoreRequests.current.set(project.spaceId, requestId)
      await rpc.call('space.restore', { requestId, spaceId: project.spaceId })
      restoreRequests.current.delete(project.spaceId)
      setSpaces(previous => previous.filter(item => item.spaceId !== project.spaceId))
      setStatus({ kind: 'restore', name: project.name, missing: !project.rootPathExists })
      notify(m.recentRestoreStatus(project.name, !project.rootPathExists))
      await onChanged().catch(error => setError({ kind: 'refresh', error }))
    } catch (error) { setError({ kind: 'restore', error }) }
    finally { setBusy(null) }
  }
  const purge = async (deleteProjectDir: boolean) => {
    if (!purging || busy) return
    if (!purgeRequest.current || purgeRequest.current.deleteProjectDir !== deleteProjectDir) purgeRequest.current = { deleteProjectDir, requestId: rid() }
    setBusy(purging.spaceId)
    setPurgeError(null)
    try {
      const result = await rpc.call<MethodResult<'space.purge'>>('space.purge', { ...purgeRequest.current, spaceId: purging.spaceId })
      setSpaces(previous => previous.filter(item => item.spaceId !== purging.spaceId))
      setStatus({ kind: 'purge', name: purging.name, moved: result.movedProjectDir })
      notify(m.recentPurgeStatus(purging.name, result.movedProjectDir))
      setPurging(null)
      await onChanged().catch(error => setError({ kind: 'refresh', error }))
    } catch (error) { setPurgeError(error); setReload(value => value + 1) }
    finally { setBusy(null) }
  }
  const confirmation = purging ? <PurgeProjectDialog project={purging} {...(usages[purging.spaceId]?.usage ? { usage: usages[purging.spaceId]!.usage! } : {})} busy={busy === purging.spaceId} error={purgeError ? m.recentPurgeFailed(describeError(purgeError, locale)) : ''} onClose={() => { if (!busy) setPurging(null) }} onPurge={value => { void purge(value) }} /> : null
  return <section className="recently-deleted" aria-label={m.recentlyDeleted}>
    <h2>{m.recentlyDeleted}</h2>
    <p className="provider-settings-hint">{m.recentHint}</p>
    {status ? <p role="status">{status.kind === 'restore' ? m.recentRestoreStatus(status.name, status.missing) : m.recentPurgeStatus(status.name, status.moved)}</p> : null}
    {loading ? <p role="status">{m.recentLoading}</p> : null}
    {error ? <p className="provider-settings-error" role="alert">{error.kind === 'refresh' ? m.recentRefreshFailed(describeError(error.error, locale)) : error.kind === 'restore' ? m.recentRestoreFailed(describeError(error.error, locale)) : describeError(error.error, locale)}<button type="button" onClick={() => setReload(value => value + 1)}>{m.retry}</button></p> : null}
    {!loading && !error && !spaces.length ? <p className="provider-settings-hint">{m.recentEmpty}</p> : null}
    <ul>{spaces.map(project => {
      const size = usages[project.spaceId]
      return <li key={project.spaceId} aria-label={m.recentProjectLabel(project.name)}>
        <div className="recently-deleted-heading"><h3>{project.name}</h3><time dateTime={new Date(project.deletedAt).toISOString()}>{format.dateTime(project.deletedAt)}</time></div>
        <code>{project.rootPath}</code>
        <p className="provider-settings-hint">{m.recentSize(size?.usage ? format.bytes(size.usage.dataBytes) : size?.error ? m.calculationFailed : m.calculating, !project.rootPathExists || size?.usage?.projectDirBytes === null ? m.projectDirectoryMissing : m.recentDirectorySize(size?.usage?.projectDirBytes != null ? format.bytes(size.usage.projectDirBytes) : size?.error ? m.calculationFailed : m.calculating))}</p>
        {size?.error ? <p className="provider-settings-error" role="alert">{m.recentSizeFailed(describeError(size.error, locale))}</p> : null}
        {project.purgeError ? <p className="provider-settings-error" role="alert">{m.recentPurgeIncomplete(describeError(project.purgeError, locale))}</p> : null}
        <div className="recently-deleted-actions"><button type="button" disabled={busy !== null || Boolean(project.purgeError)} title={project.purgeError ? m.recentCannotRestore : undefined} onClick={() => { void restore(project) }}>{busy === project.spaceId && !purging ? m.recentRestoring : m.recentRestore}</button><button type="button" className="provider-settings-danger" disabled={busy !== null} onClick={() => { purgeRequest.current = null; setPurgeError(null); setPurging(project) }}>{m.purgeAction}</button></div>
      </li>
    })}</ul>
    {confirmation && typeof document !== 'undefined' ? createPortal(confirmation, document.body) : confirmation}
  </section>
}
