import { CloseIcon, IconButton, describeError, useLocale, useMessages } from '@vis/ui-kit'
import { isBackdropClick } from './dialogBackdrop'
import { attachmentMessages } from './messages'
import type { AssetVersionView } from '@vis/protocol'
import { useEffect, useRef, useState } from 'react'
import { attachmentError, attachmentRefs, removeAttachments, updateAttachment, type AttachmentDraft, type AttachmentDrafts } from './attachmentState'
import { SessionIcon } from './SessionIcon'

export function useAttachments(sessionId: string | null, onImport: (file: File) => Promise<AssetVersionView>) {
  const { locale } = useLocale()
  const [drafts, setDrafts] = useState<AttachmentDrafts>({})
  const attachments = sessionId ? drafts[sessionId] ?? [] : []
  const add = (files: Iterable<File>) => {
    if (!sessionId) return
    for (const file of files) {
      const id = crypto.randomUUID()
      const error = attachmentError(file, locale)
      const attachment: AttachmentDraft = error ? { id, name: file.name, status: 'error', error, validationFile: { name: file.name, type: file.type, size: file.size } } : { id, name: file.name, status: 'pending' }
      setDrafts(current => ({ ...current, [sessionId]: [...current[sessionId] ?? [], attachment] }))
      if (error) continue
      void (async () => {
        let result: AttachmentDraft
        try { result = { id, name: file.name, status: 'ready', asset: await onImport(file) } }
        catch (error) { result = { id, name: file.name, status: 'error', error } }
        setDrafts(current => updateAttachment(current, sessionId, result))
      })()
    }
  }
  const clear = (ids: readonly string[]) => {
    if (sessionId) setDrafts(current => removeAttachments(current, sessionId, ids))
  }
  const addAsset = (asset: AssetVersionView) => {
    if (!sessionId) return
    setDrafts(current => {
      const existing = current[sessionId] ?? []
      if (existing.some(item => item.status === 'ready' && item.asset.assetVersionId === asset.assetVersionId)) return current
      return { ...current, [sessionId]: [...existing, { id: crypto.randomUUID(), name: asset.displayName ?? asset.assetVersionId, status: 'ready', asset }] }
    })
  }
  return { attachments, pending: attachments.some(item => item.status === 'pending'), refs: attachmentRefs(attachments), add, addAsset, remove: (id: string) => clear([id]), clear }
}

function AttachmentIcon() {
  return <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m8 12 6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l8-8a7 7 0 0 1 10 10l-8 8" /></svg>
}

type AssetPreviewProps = {
  resolveAsset?: ((assetVersionId: string) => Promise<AssetVersionView>) | undefined
  assetUrl?: ((assetVersionId: string) => string) | undefined
  posterUrl?: ((assetVersionId: string) => string) | undefined
}

export function AttachmentThumb({ assetVersionId, asset, resolveAsset, assetUrl, posterUrl, onRemove }: AssetPreviewProps & {
  assetVersionId: string
  asset?: AssetVersionView | undefined
  onRemove?: (() => void) | undefined
}) {
  const m = useMessages(attachmentMessages)
  const { locale } = useLocale()
  const [resolved, setResolved] = useState<AssetVersionView | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [open, setOpen] = useState(false)
  const [posterFailed, setPosterFailed] = useState(false)
  const resolver = useRef(resolveAsset)
  resolver.current = resolveAsset
  const canResolve = Boolean(resolveAsset)
  useEffect(() => {
    setResolved(null)
    setError(null)
    setOpen(false)
    setPosterFailed(false)
    if (asset || !canResolve) return
    let current = true
    void resolver.current!(assetVersionId).then(value => { if (current) setResolved(value) }, error => {
      if (current) setError(error)
    })
    return () => { current = false }
  }, [assetVersionId, asset, canResolve])
  const view = asset ?? (resolved?.assetVersionId === assetVersionId ? resolved : null)
  const name = view?.displayName ?? assetVersionId
  const src = view && assetUrl ? assetUrl(assetVersionId) : null
  const errorText = error ? describeError(error, locale) : ''
  const label = errorText ? m.readFailed(errorText) : view ? m.previewAttachment(name) : m.readingAttachment
  return <span className="vis-ref-wrap vis-attachment-wrap">
    <button type="button" className={`vis-ref-thumb vis-attachment-thumb${view?.hasAlpha ? ' vis-alpha-media' : ''} is-${error ? 'error' : view?.kind ?? 'pending'}`} title={errorText || name} aria-label={label} disabled={!view || !src} onClick={() => setOpen(true)}>
      {view?.kind === 'image' && src ? <img src={src} alt={name} loading="lazy" /> : null}
      {view?.kind === 'video' && src ? <>{posterUrl && !posterFailed ? <img src={posterUrl(assetVersionId)} alt={name} loading="lazy" onError={() => setPosterFailed(true)} /> : <SessionIcon kind="video" />}<span className="vis-ref-play"><SessionIcon kind="play" /></span></> : null}
      {view?.kind === 'audio' ? <SessionIcon kind="audio" /> : null}
      {!view ? <span className="vis-attachment-state">{error ? m.failed : m.reading}</span> : null}
      <span className="vis-ref-origin" title={m.attachment}><AttachmentIcon /></span>
    </button>
    {onRemove ? <button type="button" className="vis-ref-remove" aria-label={m.removeAttachment(name)} onClick={onRemove}><SessionIcon kind="close" /></button> : null}
    {open && view && src ? <AttachmentPreview asset={view} src={src} onClose={() => setOpen(false)} /> : null}
  </span>
}

export function AttachmentPreview({ asset, src, onClose }: { asset: AssetVersionView; src: string; onClose(): void }) {
  const m = useMessages(attachmentMessages)
  const dialog = useRef<HTMLDialogElement>(null)
  const name = asset.displayName ?? asset.assetVersionId
  useEffect(() => {
    const previous = document.activeElement
    const element = dialog.current!
    element.showModal()
    return () => {
      element.close()
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [])
  return <dialog ref={dialog} onClick={event => { if (isBackdropClick(event)) onClose() }} className="vis-dialog vis-workspace-dialog vis-attachment-preview" aria-label={m.attachmentPreview(name)} onCancel={event => { event.preventDefault(); onClose() }} onKeyDown={event => event.stopPropagation()}>
    <div className="vis-dialog-header"><h2>{name}</h2><IconButton type="button" label={m.closePreview} onClick={onClose}><CloseIcon /></IconButton></div>
    <div className="vis-dialog-body">{asset.kind === 'image' ? <img src={src} alt={name} /> : asset.kind === 'video' ? <video className={asset.hasAlpha ? 'vis-alpha-media' : undefined} src={src} controls autoPlay /> : <audio src={src} controls autoPlay />}</div>
  </dialog>
}

export function Attachments({ attachments, onRemove, assetUrl, posterUrl }: { attachments: readonly AttachmentDraft[]; onRemove(id: string): void; assetUrl: (assetVersionId: string) => string; posterUrl: (assetVersionId: string) => string }) {
  const m = useMessages(attachmentMessages)
  const { locale } = useLocale()
  return <>{attachments.map(attachment => attachment.status === 'ready'
    ? <AttachmentThumb key={attachment.id} assetVersionId={attachment.asset.assetVersionId} asset={attachment.asset} assetUrl={assetUrl} posterUrl={posterUrl} onRemove={() => onRemove(attachment.id)} />
    : <span className="vis-ref-wrap vis-attachment-wrap" key={attachment.id}>
      <span className={`vis-ref-thumb vis-attachment-thumb is-${attachment.status}`} title={attachment.name} aria-label={attachment.status === 'pending' ? m.importingLabel(attachment.name) : m.importFailedLabel(attachment.name)} aria-busy={attachment.status === 'pending'}><AttachmentIcon /><span className="vis-attachment-state">{attachment.status === 'pending' ? m.importing : m.importFailed}</span></span>
      <button type="button" className="vis-ref-remove" aria-label={m.removeAttachment(attachment.name)} onClick={() => onRemove(attachment.id)}><SessionIcon kind="close" /></button>
      {attachment.status === 'error' ? <span className="vis-attachment-error" role="alert">{m.attachmentError(attachment.name, attachment.validationFile ? attachmentError(attachment.validationFile, locale)! : describeError(attachment.error, locale))}</span> : null}
    </span>)}</>
}
