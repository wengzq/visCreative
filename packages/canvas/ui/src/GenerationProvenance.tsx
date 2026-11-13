import type { NodeView } from '@vis/protocol'
import { useFormat, useLocale, useMessages } from '@vis/ui-kit'
import { useEffect, useRef, useState } from 'react'
import type { CanvasActions } from './CanvasView'
import { type GenerationSource, isOperationSource, restoreGenerationOps, sameGenerationDraft, sourceDefaults } from './generation-provenance'
import type { useGenerationChoice } from './ModelPicker'
import { controlMessages, messages } from './messages'
import { parameterLabel, parameterOption, parameterSummary } from './params'
import { promptMessages } from './prompt-messages'
import { numberedReferences } from './prompt-references'
import { ReferencePreview } from './ReferenceStrip'
import { toolbarMessages } from './toolbar-messages'

export function GenerationProvenance({ source, view, nodes, text, generation, actions, emptyDraft, expectedRevision, assetUrl, posterUrl, onRestored, onBusy }: {
  source: GenerationSource
  view: NodeView
  nodes: NodeView[]
  text: string
  generation: ReturnType<typeof useGenerationChoice>
  actions: CanvasActions
  emptyDraft: boolean
  expectedRevision: number
  assetUrl(id: string): string
  posterUrl(id: string): string
  onRestored(): void
  onBusy(busy: boolean): void
}) {
  const p = useMessages(promptMessages)
  const m = useMessages(messages)
  const c = useMessages(controlMessages)
  const t = useMessages(toolbarMessages)
  const format = useFormat()
  const { locale } = useLocale()
  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const confirmDialog = useRef<HTMLDialogElement>(null)
  const pending = useRef<{ text: string; revision: number } | null>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const promptSlot = view.slots.find(slot => slot.slotKey === 'prompt')
  const operation = isOperationSource(source)
  const empty = emptyDraft || operation
  const used = source.usedPrompt ?? source.prompt ?? ''
  // Only a vendor rewrite is known to be what the model used; every other kind is at most what was sent.
  const label = source.usedPromptKind === 'revised' ? p.modelUsedPrompt : p.sentPrompt
  const provider = generation.catalog?.providers.find(provider => provider.id === source.provider)
  const model = provider?.models.find(model => model.id === source.model)
  const same = !operation && Boolean(promptSlot) && sameGenerationDraft(view, source, nodes, text, generation.choice ?? view.generation, sourceDefaults(generation.catalog, source))
  const schema = operation ? model?.operationSpecs?.[source.operation]?.paramsSchema : model?.paramsSchema
  const showPrompt = !operation || Boolean(source.prompt?.trim()) || ((model?.operationSpecs?.[source.operation]?.prompt ?? 'none') !== 'none' && Boolean(used))
  const summary = schema ? parameterSummary(schema, source.params, {
    number: format.number, boolean: value => value ? p.enabled : p.disabled,
    label: (name, field) => parameterLabel(name, field, locale, c.parameterLabel),
    option: (name, value, field) => parameterOption(name, value, field, locale, p.parameterOption),
    value: p.parameterValue,
  }) : Object.entries(source.params).map(([name, value]) => p.parameterValue(c.parameterLabel(name), typeof value === 'number' ? format.number(value) : typeof value === 'boolean' ? value ? p.enabled : p.disabled : String(value))).join(' · ')
  useEffect(() => {
    const element = confirmDialog.current
    if (confirming) element?.showModal()
    else if (element?.open) { element.close(); trigger.current?.focus() }
  }, [confirming])
  useEffect(() => {
    const saved = pending.current
    if (!saved || !promptSlot || promptSlot.revision <= saved.revision || promptSlot.content.type !== 'text' || promptSlot.content.body !== saved.text) return
    pending.current = null
    setOpen(false)
    setCopied(false)
    onRestored()
    setBusy(false)
    onBusy(false)
  }, [promptSlot, onRestored, onBusy])
  useEffect(() => () => { confirmDialog.current?.close(); onBusy(false) }, [onBusy])
  const restore = async () => {
    if (!actions.onApply || busy) return
    setConfirming(false)
    setBusy(true)
    onBusy(true)
    pending.current = { text: source.prompt ?? '', revision: expectedRevision }
    try { await actions.onApply(restoreGenerationOps(view, source, nodes, expectedRevision), p.restoreVersionSettings) }
    catch { pending.current = null; setBusy(false); onBusy(false) }
  }
  const restoreButton = <button ref={trigger} disabled={!actions.onApply || busy} onMouseDown={event => event.preventDefault()} onClick={() => {
    if (text.trim() && text !== (source.prompt ?? '')) { onBusy(true); setConfirming(true) }
    else void restore()
  }}>{p.restoreVersionSettings}</button>
  const details = <div className={`vis-generation-provenance-details${empty ? ' is-empty' : ''}`}>
    {showPrompt ? <>
      <div className="vis-generation-provenance-label">{label}</div>
      <div className="vis-generation-used-prompt" role="textbox" aria-label={label} aria-readonly="true" aria-multiline="true" tabIndex={0}>{used}</div>
    </> : null}
    {!same ? <>
      <div>{provider ? c.providerLabel(provider.id, provider.label) : source.provider} · {model ? c.modelLabel(model.id, model.label) : source.model}</div>
      <div aria-label={p.parameterSummary}>{summary || p.noParameters}</div>
      <div className="vis-prompt-inputs">{numberedReferences(source.inputNodeIds, nodes).map((reference, index) => <div key={reference.nodeId} className="vis-reference-preview" role="img" aria-label={reference.node ? reference.number === undefined ? m[reference.node.kind] : p.referenceLabel(m[reference.node.kind], format.number(reference.number)) : p.brokenReference}>
        <ReferencePreview reference={reference} assetUrl={assetUrl} posterUrl={posterUrl} />
        {reference.number !== undefined || !reference.node ? <span className="vis-reference-number">{format.number(reference.number ?? index + 1)}</span> : null}
      </div>)}</div>
    </> : null}
    {showPrompt ? <button onMouseDown={event => event.preventDefault()} onClick={() => {
      if (!navigator.clipboard) return
      void navigator.clipboard.writeText(used).then(() => setCopied(true)).catch(() => {})
    }}>{copied ? p.promptCopied : p.copyPrompt}</button> : null}
  </div>
  if (operation) return <div className="vis-generation-provenance is-empty" aria-label={p.operationProvenance}>
    <div className="vis-generation-operation-label">{t[source.operation]}</div>{details}
  </div>
  if (same && used === text) return null
  return <div className={`vis-generation-provenance${empty ? ' is-empty' : ''}`}>
    {empty ? <>{details}<div className="vis-generation-provenance-actions">{restoreButton}</div></> : same ? <>
      <button aria-expanded={open} onMouseDown={event => event.preventDefault()} onClick={() => { setOpen(!open); setCopied(false) }}>{label}</button>
      {open ? details : null}
    </> : <>
      <div className="vis-generation-provenance-notice" role="status">{p.differentSettings}</div>
      <div className="vis-generation-provenance-actions">
        <button aria-expanded={open} onMouseDown={event => event.preventDefault()} onClick={() => { setOpen(!open); setCopied(false) }}>{p.showVersionSettings}</button>
        {restoreButton}
      </div>
      {open ? details : null}
    </>}
    {confirming ? <dialog ref={confirmDialog} className="vis-dialog vis-generation-restore-dialog" aria-label={p.replaceDraftConfirm} onCancel={() => { setConfirming(false); onBusy(false) }}>
      <p>{p.replaceDraftConfirm}</p>
      <footer><button onClick={() => { setConfirming(false); onBusy(false) }}>{p.cancelRestore}</button><button className="is-primary" onClick={() => void restore()}>{p.replaceDraft}</button></footer>
    </dialog> : null}
  </div>
}
