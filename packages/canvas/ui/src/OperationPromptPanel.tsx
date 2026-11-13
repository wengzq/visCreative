import type { GenerationOperation, NodeView } from '@vis/protocol'
import { CloseIcon, IconButton, useMessages } from '@vis/ui-kit'
import { useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { CanvasActions } from './CanvasView'
import { GenerationSettingsContext, ModelPicker, type useGenerationChoice } from './ModelPicker'
import { ModelParameters, ParamsSummary } from './ParamsSummary'
import { PromptRefInput, type PromptRefInputHandle } from './PromptRefInput'
import { ReferenceStrip } from './ReferenceStrip'
import { messages } from './messages'
import { operationChoiceKey, operationSpec, operationSubmitDisabled, resolveOperationChoice } from './operation-panel'
import { readChoice, type GenerationChoice } from './params'
import { promptMessages } from './prompt-messages'
import { hasBrokenReferences, numberedReferences } from './prompt-references'
import { usePromptPanelBounds } from './prompt-panel-bounds'
import { toolbarMessages } from './toolbar-messages'

export function OperationPromptPanel({ view, operation, actions, assetUrl, posterUrl, onClose }: {
  view: NodeView
  operation: GenerationOperation
  actions: CanvasActions
  assetUrl(id: string): string
  posterUrl(id: string): string
  onClose(): void
}) {
  const context = useContext(GenerationSettingsContext)
  const p = useMessages(promptMessages)
  const m = useMessages(messages)
  const t = useMessages(toolbarMessages)
  const catalog = context?.catalog ?? null
  const key = operationChoiceKey(context?.spaceId ?? '', operation)
  const [selected, setSelected] = useState<GenerationChoice | null>(() => resolveOperationChoice(catalog, view.kind, operation, readChoice(key), view.generation))
  const choice = resolveOperationChoice(catalog, view.kind, operation, selected, view.generation)
  const provider = catalog?.providers.find(provider => provider.id === choice?.provider)
  const selectedModel = provider?.models.find(model => model.id === choice?.model && model.kind === view.kind)
  const spec = operationSpec(selectedModel, operation)
  const settings: ReturnType<typeof useGenerationChoice> = {
    catalog, spaceId: context?.spaceId ?? '', onManage: () => context?.onManage(), configured: Boolean(context),
    choice, provider, model: selectedModel ? { ...selectedModel, paramsSchema: spec.paramsSchema } : undefined,
    select: async next => setSelected(next), fallback: false, saving: false, removed: false, dismissRemoved() {},
    blocked: !choice || !provider?.available || !selectedModel || Boolean(provider.needsKey && !provider.hasKey),
  }
  const [text, setText] = useState('')
  const [composing, setComposing] = useState(false)
  const [sending, setSending] = useState(false)
  const pending = useRef(false)
  const mounted = useRef(true)
  const dialog = useRef<HTMLDialogElement>(null)
  const input = useRef<PromptRefInputHandle>(null)
  const references = useMemo(() => numberedReferences([view.nodeId], [view]), [view])
  const main = view.slots.find(slot => slot.slotKey === 'main')
  const broken = spec.prompt !== 'none' && hasBrokenReferences(text, references)
  const disabled = !actions.onSubmitOperation || operationSubmitDisabled(spec.prompt, text, {
    blocked: settings.blocked, sending, composing, broken, hasSubject: main?.content.type === 'asset',
  })
  usePromptPanelBounds(dialog, true)
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopImmediatePropagation()
      onClose()
    }
    window.addEventListener('keydown', close, true)
    return () => window.removeEventListener('keydown', close, true)
  }, [onClose])
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  const submit = async () => {
    if (pending.current || disabled || !choice || !actions.onSubmitOperation) return
    pending.current = true
    setSending(true)
    try {
      await actions.onSubmitOperation(view.nodeId, { operation, ...choice, prompt: spec.prompt === 'none' ? '' : text })
      try { localStorage.setItem(key, JSON.stringify(choice)) } catch {}
      if (mounted.current) onClose()
    } catch {} finally {
      pending.current = false
      if (mounted.current) setSending(false)
    }
  }
  const kind = view.kind === 'video' ? 'video' : 'image'
  return <dialog ref={dialog} className="vis-dialog vis-prompt-shell" onPointerDown={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
    <section className="vis-node-prompt vis-prompt-panel vis-operation-panel nodrag nopan nowheel" aria-label={t[operation]} style={{ width: Math.max(420, view.w) }}>
      <div className="vis-operation-heading">
        <h4 aria-label={t[operation]}>{t[operation]}<span className="vis-operation-paid" aria-label={t.providerHint} /></h4>
        <IconButton label={p.closeOperation} onClick={onClose}><CloseIcon /></IconButton>
      </div>
      <div aria-label={p.operationSubject}>
        <ReferenceStrip references={references} assetUrl={assetUrl} posterUrl={posterUrl} onInsert={nodeId => input.current?.insert(nodeId)} />
      </div>
      <ModelParameters settings={settings} />
      {spec.prompt !== 'none' ? <PromptRefInput ref={input} value={text} references={references} assetUrl={assetUrl} posterUrl={posterUrl}
        placeholder={kind === 'video' ? m.videoPrompt : m.imagePrompt} readOnly={sending} onChange={setText}
        onCommit={() => {}} onReset={onClose} onComposing={setComposing} /> : null}
      {broken ? <div className="vis-prompt-broken" role="status">{p.brokenReferenceHint}</div> : null}
      <div className="vis-prompt-footer">
        <div className="vis-prompt-settings"><ModelPicker kind={kind} settings={settings} operation={operation} /><ParamsSummary settings={settings} /></div>
        <button className="is-primary" aria-label={t[operation]} title={settings.blocked ? m.configureKey : t.providerHint} disabled={disabled}
          onMouseDown={event => event.preventDefault()} onClick={() => void submit()}>{t[operation]}</button>
      </div>
    </section>
  </dialog>
}
