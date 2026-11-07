import { useFormat, useMessages } from '@vis/ui-kit'
import { attachmentMessages } from './messages'
import { useState } from 'react'
import type { AssetVersionView } from '@vis/protocol'
import type { SessionPanelProps } from './SessionPanel'
import { plainTextSummary } from './workspaceUtils'
import { SessionIcon } from './SessionIcon'
import { AttachmentThumb } from './Attachments'

export type RefPreview =
  | { kind: 'image'; src: string; label: string }
  | { kind: 'audio'; src: string; label: string }
  | { kind: 'video'; src: string; label: string; posterSrc?: string }
  | { kind: 'text'; text: string; label: string }
  | { kind: 'script'; shots: number; assets: number; label: string }
  | { kind: 'empty'; nodeKind: 'text' | 'image' | 'video' | 'audio' | 'script'; label: string }
  | { kind: 'missing'; label: string }

type PreviewProps = Pick<SessionPanelProps, 'resolveRef' | 'onLocateRef'>

export function ScriptSummary({ preview }: { preview: Extract<RefPreview, { kind: 'script' }> }) {
  const m = useMessages(attachmentMessages)
  const format = useFormat()
  return <>{m.scriptSummary(format.number(preview.shots), format.number(preview.assets))}</>
}

/** Node previews in the @ list; large highlights the current item to distinguish similar images */
export function NodePreview({ preview, large }: { preview: RefPreview; large?: boolean }) {
  return <span className={`vis-mention-thumb is-${preview.kind}${large ? ' is-large' : ''}`} aria-hidden="true">
    {preview.kind === 'image' ? <img src={preview.src} alt="" loading="lazy" /> : null}
    {preview.kind === 'video' ? <><VideoPoster preview={preview} /><span className="vis-ref-play"><SessionIcon kind="play" /></span></> : null}
    {preview.kind === 'audio' ? <SessionIcon kind="audio" /> : null}
    {preview.kind === 'text' ? large ? <span className="vis-mention-text">{plainTextSummary(preview.text)}</span> : <SessionIcon kind="text" /> : null}
    {preview.kind === 'script' ? <><SessionIcon kind="script" />{large ? <span className="vis-mention-text"><ScriptSummary preview={preview} /></span> : null}</> : null}
    {preview.kind === 'empty' ? <SessionIcon kind={preview.nodeKind} /> : null}
  </span>
}

export function RefThumb({ nodeId, resolveRef, onLocateRef, onRemove }: PreviewProps & { nodeId: string; onRemove?: (() => void) | undefined }) {
  const m = useMessages(attachmentMessages)
  const preview = resolveRef(nodeId)
  return <span className="vis-ref-wrap">
    <button className={`vis-ref-thumb is-${preview.kind}`} title={preview.label} aria-label={m.locateNode(preview.label)} disabled={preview.kind === 'missing'} onClick={() => onLocateRef(nodeId)}>
      {preview.kind === 'image' ? <img src={preview.src} alt={preview.label} loading="lazy" /> : null}
      {preview.kind === 'video' ? <><VideoPoster preview={preview} /><span className="vis-ref-play"><SessionIcon kind="play" /></span></> : null}
      {preview.kind === 'audio' ? <SessionIcon kind="audio" /> : null}
      {preview.kind === 'text' ? <><SessionIcon kind="text" /><span className="vis-ref-text">{plainTextSummary(preview.text)}</span></> : null}
      {preview.kind === 'script' ? <><SessionIcon kind="script" /><span className="vis-ref-text"><ScriptSummary preview={preview} /></span></> : null}
      {preview.kind === 'empty' ? <SessionIcon kind={preview.nodeKind} /> : null}
      {preview.kind === 'missing' ? m.deleted : null}
      <span className="vis-ref-origin" title={m.canvasNode} aria-hidden="true"><svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.2"><rect x="2" y="2" width="8" height="8" rx="1" /><path d="M6 12v2h8V6h-2" /></svg></span>
    </button>
    {onRemove ? <button className="vis-ref-remove" aria-label={m.removeRef} onClick={onRemove}><SessionIcon kind="close" /></button> : null}
  </span>
}

function VideoPoster({ preview }: { preview: Extract<RefPreview, { kind: 'video' }> }) {
  const [failed, setFailed] = useState(false)
  return preview.posterSrc && !failed ? <img src={preview.posterSrc} alt={preview.label} loading="lazy" onError={() => setFailed(true)} /> : <SessionIcon kind="video" />
}

export function RefThumbs({ refs, onRemoveRef, resolveAsset, assetUrl, posterUrl, ...p }: PreviewProps & {
  refs: ({ nodeId: string } | { assetVersionId: string })[]
  onRemoveRef?: (nodeId: string) => void
  resolveAsset?: ((assetVersionId: string) => Promise<AssetVersionView>) | undefined
  assetUrl?: ((assetVersionId: string) => string) | undefined
  posterUrl?: ((assetVersionId: string) => string) | undefined
}) {
  const m = useMessages(attachmentMessages)
  const format = useFormat()
  const [all, setAll] = useState(false)
  const limited = !all && refs.length > 6
  return <>{(limited ? refs.slice(0, 5) : refs).map(ref => 'nodeId' in ref
    ? <RefThumb key={`node:${ref.nodeId}`} {...p} nodeId={ref.nodeId} onRemove={onRemoveRef ? () => onRemoveRef(ref.nodeId) : undefined} />
    : <AttachmentThumb key={`asset:${ref.assetVersionId}`} assetVersionId={ref.assetVersionId} resolveAsset={resolveAsset} assetUrl={assetUrl} posterUrl={posterUrl} />)}
    {limited ? <button className="vis-ref-thumb" aria-label={m.expandRefs(format.number(refs.length - 5))} onClick={() => setAll(true)}>+{format.number(refs.length - 5)}</button> : null}
  </>
}
