import { createContext, useContext, useEffect, useRef, useState } from 'react'
import type { NodeView } from '@vis/protocol'
import { useMessages } from '@vis/ui-kit'
import { defaultParams, resolveChoice, type GenerationChoice, type ProviderCatalog } from './params'
import { controlMessages } from './messages'
import { ModelParameters } from './ParamsSummary'
import './model-picker.css'

export const GenerationSettingsContext = createContext<{ catalog: ProviderCatalog | null; spaceId: string; onManage(): void } | null>(null)
export function useGenerationChoice(node: NodeView, onSetGeneration?: (nodeId: string, generation: NodeView['generation']) => Promise<void>) {
  const injected = useContext(GenerationSettingsContext)
  const context = injected ?? { catalog: null, spaceId: '', onManage() {} }
  const kind = node.kind === 'audio' ? 'audio' : node.kind === 'video' ? 'video' : 'image'
  const saved = node.generation
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [saving, setSaving] = useState(0)
  const [pending, setPending] = useState<GenerationChoice | null>(null)
  const saves = useRef(Promise.resolve())
  const latest = useRef(0)
  const resolved = context.catalog ? resolveChoice(context.catalog, kind, saved) : null
  const choice = pending ?? resolved
  const provider = context.catalog?.providers.find(p => p.id === choice?.provider)
  const model = provider?.models.find(m => m.id === choice?.model)
  const fallback = Boolean(context.catalog && saved && ((saved.provider && saved.provider !== resolved?.provider) || (saved.model && saved.model !== resolved?.model)))
  const removedKey = JSON.stringify([saved?.provider, saved?.model])
  const select = async (next: GenerationChoice) => {
    if (!onSetGeneration) return
    const edit = ++latest.current
    setPending(next)
    setSaving(count => count + 1)
    const save = saves.current.then(() => onSetGeneration(node.nodeId, next))
    saves.current = save.catch(() => {})
    try {
      await save
      try { localStorage.setItem(`vis.gen.last.${kind}`, JSON.stringify(next)) } catch {}
    } catch {} finally {
      if (edit === latest.current) setPending(null)
      setSaving(count => count - 1)
    }
  }
  return { ...context, configured: Boolean(injected), choice, provider, model, select, fallback, saving: saving > 0, removed: fallback && dismissed !== removedKey, dismissRemoved: () => setDismissed(removedKey), blocked: Boolean(injected) && (!provider || !provider.available || !model || (provider.needsKey && !provider.hasKey)) }
}
export function ModelPicker({ kind, settings, placement = 'above' }: { kind: 'image' | 'video' | 'audio'; settings: ReturnType<typeof useGenerationChoice>; /** beside: for a scrolling side column that would clip a popover above the trigger. */ placement?: 'above' | 'beside' }) {
  const m = useMessages(controlMessages)
  const { catalog, choice, provider, model, select, blocked } = settings
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const popup = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', close)
    const position = () => {
      if (!popup.current) return
      if (placement === 'beside') {
        const anchor = root.current!.getBoundingClientRect()
        popup.current.style.maxHeight = `${window.innerHeight - 16}px`
        const { width, height } = popup.current.getBoundingClientRect()
        popup.current.style.left = `${Math.max(8, anchor.left - width - 24)}px`
        popup.current.style.top = `${Math.max(8, Math.min(anchor.top, window.innerHeight - height - 8))}px`
        return
      }
      popup.current.style.left = '0px'
      const anchor = root.current!.getBoundingClientRect()
      popup.current.style.maxHeight = `min(520px, ${Math.max(0, Math.min(anchor.top, window.innerHeight) - 16)}px)`
      const rect = popup.current.getBoundingClientRect()
      popup.current.style.left = `${Math.max(8 - rect.left, Math.min(0, window.innerWidth - rect.right - 8))}px`
    }
    position()
    window.addEventListener('resize', position)
    if (placement === 'beside') window.addEventListener('scroll', position, true)
    return () => {
      document.removeEventListener('pointerdown', close)
      window.removeEventListener('resize', position)
      window.removeEventListener('scroll', position, true)
    }
  }, [open, choice?.provider, choice?.model, placement])
  if (!settings.configured) return <div className="vis-prompt-parameters">{m.mockDefaultParams}</div>
  return <div ref={root} className="vis-model-picker" onKeyDown={event => { if (event.key === 'Escape') { setOpen(false); root.current?.querySelector<HTMLButtonElement>('.vis-model-trigger')?.focus(); event.stopPropagation() } }}>
    <button className="vis-model-trigger" aria-label={m.modelAndParams} aria-expanded={open} onClick={() => setOpen(!open)}>{blocked ? <span className="vis-model-warning">● </span> : null}{provider ? m.providerLabel(provider.id, provider.label) : m.loadingModels} · {model ? m.modelLabel(model.id, model.label) : ''}<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg></button>
    {settings.removed ? <span className="vis-model-removed" role="status">{m.modelRemoved}<button onClick={settings.dismissRemoved}>{m.acknowledgeModelRemoved}</button></span> : null}
    {open ? <div ref={popup} className={`vis-model-popover${placement === 'beside' ? ' is-beside' : ''}`} role="dialog" aria-label={m.selectModelAndParams}>
      <div className="vis-model-list">{catalog?.providers.filter(p => p.available).map(p => p.models.some(model => model.kind === kind) ? <section key={p.id}><h4>{m.providerLabel(p.id, p.label)}</h4>{p.models.filter(model => model.kind === kind).map(model => <button key={model.id} className={p.needsKey && !p.hasKey ? 'is-unconfigured' : ''} aria-pressed={choice?.provider === p.id && choice?.model === model.id} onClick={() => select({ provider: p.id, model: model.id, params: defaultParams(model.paramsSchema) })}><span>{m.modelLabel(model.id, model.label)}</span>{p.needsKey && !p.hasKey ? <small>{m.keyNotConfigured}</small> : null}{choice?.provider === p.id && choice?.model === model.id ? <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m5 12 4 4L19 6" /></svg> : null}</button>)}</section> : null)}</div>
      <ModelParameters settings={settings} />
      <button className="vis-model-manage" onClick={() => { setOpen(false); settings.onManage() }}>{m.manageGenerationServices}</button>
    </div> : null}
  </div>
}
