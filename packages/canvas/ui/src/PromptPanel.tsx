import type { NodeView } from '@vis/protocol'
import { CloseIcon, IconButton, useMessages } from '@vis/ui-kit'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { CanvasActions } from './CanvasView'
import { Icon } from './Icon'
import { messages } from './messages'
import { ModelPicker, type useGenerationChoice } from './ModelPicker'
import { ParamsSummary } from './ParamsSummary'
import { PromptRefInput, type PromptRefInputHandle } from './PromptRefInput'
import { ReferenceStrip } from './ReferenceStrip'
import { hasBrokenReferences, numberedReferences } from './prompt-references'
import { promptMessages } from './prompt-messages'
import './prompt-panel.css'

export function PromptPanel({ view, nodes, text, saving, generation, actions, assetUrl, posterUrl, picking, onPick, onChange, onCommit, onReset, panel }: {
  panel?: { header: ReactNode; generationLabel: string; paidLabel?: string | undefined; action: string; hideAction?: boolean; hint?: string | undefined; allowEmpty?: boolean }
  view: NodeView
  nodes: NodeView[]
  text: string
  saving: boolean
  generation: ReturnType<typeof useGenerationChoice>
  actions: CanvasActions
  assetUrl(id: string): string
  posterUrl(id: string): string
  picking: boolean
  onPick(): void
  onChange(text: string): void
  onCommit(): Promise<boolean>
  onReset(): void
}) {
  const m = useMessages(messages)
  const p = useMessages(promptMessages)
  const [expanded, setExpanded] = useState(false)
  const [composing, setComposing] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [sending, setSending] = useState(false)
  const dialog = useRef<HTMLDialogElement>(null)
  const expandButton = useRef<HTMLButtonElement>(null)
  const upload = useRef<HTMLInputElement>(null)
  const input = useRef<PromptRefInputHandle>(null)
  const references = useMemo(() => numberedReferences(view.inputs ?? [], nodes), [view.inputs, nodes])
  const broken = hasBrokenReferences(text, references)
  const kind = view.kind === 'audio' ? 'audio' : view.kind === 'video' ? 'video' : 'image'
  useEffect(() => {
    const element = dialog.current
    if (!element) return
    if (expanded) element.showModal()
    else if (element.open) { element.close(); expandButton.current?.focus() }
  }, [expanded])
  useEffect(() => () => { dialog.current?.close() }, [])
  return <dialog ref={dialog} className={`vis-dialog vis-prompt-shell${expanded ? ' is-expanded' : ''}`} aria-label={expanded ? p.expandedPrompt : undefined}
    onCancel={event => { event.preventDefault(); setExpanded(false) }}
    onClick={event => { if (expanded && event.target === event.currentTarget) setExpanded(false) }}
    onPointerDown={event => event.stopPropagation()}
    onKeyDown={event => {
      if (panel && !expanded && event.key === 'Escape' && !event.defaultPrevented) onReset()
      if (!((event.metaKey || event.ctrlKey) && ['z', 'y'].includes(event.key.toLowerCase()))) event.stopPropagation()
    }}>
    {expanded ? <div className="vis-dialog-header"><h2>{p.expandedPrompt}</h2><IconButton label={p.closeExpandedPrompt} onClick={() => setExpanded(false)}><CloseIcon /></IconButton></div> : null}
    <div className="vis-node-prompt vis-prompt-panel nodrag nopan nowheel" style={expanded ? undefined : { width: Math.max(420, view.w) }}>
      {panel?.header}
      <section className={panel ? 'vis-previz-generation' : 'vis-prompt-generation'} aria-label={panel?.generationLabel}>
      {panel ? <div className="vis-previz-stage-heading"><h4>{panel.generationLabel}</h4>{panel.paidLabel ? <span className="vis-previz-paid" role="status">{panel.paidLabel}</span> : null}</div> : null}
      <div className="vis-prompt-panel-top">
        {!panel ? <div className="vis-prompt-sources">
          <button aria-label={p.uploadReference} disabled={!actions.onUploadReference || uploading} onClick={() => upload.current?.click()}><Icon kind="plus" />{m.upload}</button>
          <input ref={upload} type="file" multiple accept="image/*,video/*,audio/*" aria-label={p.uploadReference} hidden onChange={event => {
            const files = Array.from(event.currentTarget.files ?? [])
            event.currentTarget.value = ''
            if (!files.length || !actions.onUploadReference) return
            setUploading(true)
            void actions.onUploadReference(view.nodeId, files).catch(() => {}).finally(() => setUploading(false))
          }} />
          <button aria-label={m.addReference} title={m.selectReference} aria-pressed={picking} onClick={() => { setExpanded(false); onPick() }}><Icon kind="plus" />{p.canvasReference}</button>
        </div> : <span />}
        {!expanded ? <button ref={expandButton} className="vis-prompt-expand" aria-label={p.expandPrompt} title={p.expandPrompt} onClick={() => setExpanded(true)}><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M3 3l6 6m12-6-6 6M3 21l6-6m12 6-6-6" /></svg></button> : null}
      </div>
      {references.length ? <ReferenceStrip references={references} assetUrl={assetUrl} posterUrl={posterUrl} onInsert={nodeId => input.current?.insert(nodeId)}
        onRemove={nodeId => void actions.onSetInputs(view.nodeId, (view.inputs ?? []).filter(id => id !== nodeId)).catch(() => {})} /> : null}
      <PromptRefInput ref={input} value={text} references={references} assetUrl={assetUrl} posterUrl={posterUrl} placeholder={kind === 'audio' ? m.audioPrompt : kind === 'video' ? m.videoPrompt : m.imagePrompt}
        readOnly={saving || sending} onChange={onChange} onCommit={() => void onCommit()} onReset={expanded ? () => setExpanded(false) : onReset} onComposing={setComposing} />
      {broken ? <div className="vis-prompt-broken" role="status">{p.brokenReferenceHint}</div> : null}
      {panel?.hint ? <p role="status">{panel.hint}</p> : null}
      <div className="vis-prompt-footer">
        <div className="vis-prompt-settings"><ModelPicker kind={kind} settings={generation} placement={panel ? 'beside' : 'above'} /><ParamsSummary settings={generation} /></div>
        {!panel?.hideAction ? <button className={panel ? 'is-primary' : 'vis-send-button'} aria-label={panel?.action ?? m.generate} title={panel?.hint ?? (broken ? p.brokenReferenceHint : generation.blocked ? m.configureKey : m.generate)}
          disabled={Boolean(panel?.hint) || (!panel?.allowEmpty && !text.trim()) || broken || composing || sending || uploading || generation.blocked || generation.saving}
          onMouseDown={event => event.preventDefault()} onClick={() => {
            setSending(true)
            void (async () => {
              if (await onCommit()) await actions.onGenerate(view.nodeId, generation.fallback ? generation.choice ?? undefined : undefined)
            })().catch(() => {}).finally(() => setSending(false))
          }}>{panel ? panel.action : <Icon kind="generate" />}</button> : null}
      </div>
      </section>
    </div>
  </dialog>
}
