import { useFormat, useMessages } from '@vis/ui-kit'
import { useState } from 'react'
import { Icon } from './Icon'
import { messages } from './messages'
import { promptMessages } from './prompt-messages'
import type { PromptReference } from './prompt-references'
import { nodeWheel } from './wheel'
import { VideoPoster } from './VideoPoster'

export function ReferencePreview({ reference, assetUrl, posterUrl }: { reference: PromptReference; assetUrl(id: string): string; posterUrl(id: string): string }) {
  const m = useMessages(messages)
  const format = useFormat()
  const [duration, setDuration] = useState<number | null>(null)
  const main = reference.node?.slots.find(slot => slot.slotKey === 'main')
  if (main?.content.type === 'asset') {
    const src = assetUrl(main.content.assetVersionId)
    if (reference.node?.kind === 'audio') return <><Icon kind="audio" /><audio src={src} preload="metadata" onLoadedMetadata={event => setDuration(event.currentTarget.duration)} />{duration !== null && Number.isFinite(duration) ? <small className="vis-reference-duration">{format.number(Math.floor(duration / 60))}:{format.number(Math.floor(duration % 60)).padStart(2, '0')}</small> : null}</>
    if (reference.node?.kind === 'video') return <VideoPoster src={src} posterSrc={posterUrl(main.content.assetVersionId)} />
    return <img src={src} alt="" draggable={false} />
  }
  return main?.content.type === 'text' ? <span>{main.content.body || m.emptyText}</span> : <Icon kind={reference.node?.kind ?? 'image'} />
}

export function ReferenceStrip({ references, assetUrl, posterUrl, onInsert, onRemove }: {
  references: readonly PromptReference[]
  assetUrl(id: string): string
  posterUrl(id: string): string
  onInsert(nodeId: string): void
  onRemove(nodeId: string): void
}) {
  const m = useMessages(messages)
  const p = useMessages(promptMessages)
  const format = useFormat()
  return <div className="vis-prompt-inputs" onWheelCapture={event => nodeWheel(event, true, true)}>
    {references.map(reference => {
      const label = reference.number === undefined ? (reference.node ? m[reference.node.kind] : p.brokenReference) : p.referenceLabel(m[reference.node!.kind], format.number(reference.number))
      return <div key={reference.nodeId} className="vis-numbered-reference">
        <button className={`vis-reference-preview vis-reference-preview-${reference.node?.kind ?? 'image'}`} aria-label={p.insertReference(label)} disabled={reference.number === undefined} onMouseDown={event => event.preventDefault()} onClick={() => onInsert(reference.nodeId)}>
          <ReferencePreview reference={reference} assetUrl={assetUrl} posterUrl={posterUrl} />
          {reference.number !== undefined ? <span className="vis-reference-number">{format.number(reference.number)}</span> : null}
        </button>
        <button className="vis-reference-remove" aria-label={m.removeReferenceLabel(reference.nodeId)} title={m.removeReference} onClick={() => onRemove(reference.nodeId)}><Icon kind="close" /></button>
      </div>
    })}
  </div>
}
