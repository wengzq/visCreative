import type { AgentModelOption, SessionSummary } from '@vis/protocol'
import { useId, useRef, useState } from 'react'
import { describeError, useLocale, useMessages } from '@vis/ui-kit'
import { sessionMessages } from './messages'

export function AgentConfigPicker({ session, pending, onOptions, onSave }: {
  session: SessionSummary
  pending: boolean
  onOptions(sessionId: string): Promise<AgentModelOption[]>
  onSave(sessionId: string, config: SessionSummary['agentConfig']): Promise<void>
}) {
  const m = useMessages(sessionMessages)
  const { locale } = useLocale()
  const id = useId()
  const button = useRef<HTMLButtonElement>(null)
  const popover = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [models, setModels] = useState<AgentModelOption[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<{ reset: Array<'effort' | 'speed'> } | { error: unknown } | null>(null)
  const { model, effort, serviceTier } = session.agentConfig
  const selected = models?.find(option => model === null ? option.isDefault : option.id === model)
  const tierLabel = (id: string) => id === 'default' ? m.standardSpeed : selected?.serviceTiers.find(option => option.id === id)?.label ?? id
  const base = model === null && effort === null ? m.default : `${selected?.label ?? model ?? m.default} · ${selected?.efforts.find(option => option.id === effort)?.label ?? effort ?? m.default}`
  const label = serviceTier ? `${base} · ${tierLabel(serviceTier)}` : base
  // Speed tiers vary by model; show only when the selected model has tiers or a speed is already set; dsh never sees this
  const showSpeed = Boolean(selected?.serviceTiers.length) || serviceTier !== null
  const tierNote = serviceTier && serviceTier !== 'default' ? selected?.serviceTiers.find(option => option.id === serviceTier)?.description : undefined

  async function load() {
    if (models !== null || loading) return
    setLoading(true)
    setLoadError(false)
    try { setModels(await onOptions(session.sessionId)) }
    catch { setLoadError(true) }
    finally { setLoading(false) }
  }

  async function save(nextModel: string | null, nextEffort: string | null, nextTier: string | null, reset: Array<'effort' | 'speed'> = []) {
    setSaving(true)
    setNotice(null)
    try {
      await onSave(session.sessionId, { model: nextModel, effort: nextEffort, serviceTier: nextTier })
      if (reset.length) setNotice({ reset })
    } catch (error) { setNotice({ error }) }
    finally { setSaving(false) }
  }

  return <>
    <button ref={button} type="button" className="vis-ref-add vis-agent-config-trigger" title={label} aria-label={m.modelAndEffortLabel(label)} aria-expanded={open} aria-controls={id} popoverTarget={id} onClick={() => {
      const rect = button.current?.getBoundingClientRect()
      if (rect && popover.current) {
        popover.current.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 328))}px`
        popover.current.style.top = `${rect.top - 8}px`
      }
    }}><span className="vis-agent-config-label">{label}</span><svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg></button>
    {pending ? <span className="vis-composer-hint" role="status">{m.nextTurn}</span> : null}
    <div ref={popover} id={id} popover="auto" role="dialog" className="vis-popover vis-agent-config" aria-label={m.modelAndEffort} onToggle={event => {
      const isOpen = event.newState === 'open'
      setOpen(isOpen)
      if (isOpen) { void load(); popover.current?.querySelector('select')?.focus() }
    }}>
      <label>{m.model}<select aria-label={m.model} value={model ?? ''} disabled={saving} onChange={event => {
        const next = event.target.value || null
        const target = models?.find(option => next === null ? option.isDefault : option.id === next)
        const resetEffort = effort !== null && !target?.efforts.some(option => option.id === effort)
        // All models accept standard speed default; other tiers require checking whether the new model supports them after a switch
        const resetSpeed = serviceTier !== null && serviceTier !== 'default' && !target?.serviceTiers.some(option => option.id === serviceTier)
        void save(next, resetEffort ? null : effort, resetSpeed ? null : serviceTier, [...(resetEffort ? ['effort' as const] : []), ...(resetSpeed ? ['speed' as const] : [])])
      }}>
        <option value="">{m.default}</option>
        {model && !models?.some(option => option.id === model) ? <option value={model} disabled>{model}</option> : null}
        {models?.map(option => <option key={option.id} value={option.id}>{option.label}{option.isDefault ? m.agentDefaultSuffix : ''}</option>)}
      </select></label>
      <label>{m.effort}<select aria-label={m.effort} value={effort ?? ''} disabled={saving} onChange={event => { void save(model, event.target.value || null, serviceTier) }}>
        <option value="">{m.default}</option>
        {effort && !selected?.efforts.some(option => option.id === effort) ? <option value={effort} disabled>{effort}</option> : null}
        {selected?.efforts.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
      </select></label>
      {showSpeed ? <label>{m.speed}<select aria-label={m.speed} value={serviceTier ?? ''} disabled={saving} onChange={event => { void save(model, effort, event.target.value || null) }}>
        <option value="">{m.default}</option>
        <option value="default">{m.standardSpeed}</option>
        {serviceTier && serviceTier !== 'default' && !selected?.serviceTiers.some(option => option.id === serviceTier) ? <option value={serviceTier} disabled>{serviceTier}</option> : null}
        {selected?.serviceTiers.map(option => <option key={option.id} value={option.id} title={option.description}>{option.label}</option>)}
      </select></label> : null}
      {tierNote ? <p className="vis-agent-config-note">{tierNote}</p> : null}
      {loading ? <p role="status">{m.loadingModels}</p> : null}
      {loadError ? <p role="status">{m.modelsUnavailable} <button type="button" onClick={() => { void load() }}>{m.retry}</button></p> : null}
      {saving ? <p role="status">{m.saving}</p> : null}
      {notice && 'reset' in notice ? notice.reset.map(kind => <p key={kind} role="status">{kind === 'effort' ? m.effortReset : m.speedReset}</p>) : null}
      {notice && 'error' in notice ? <p role="status">{m.settingsFailed(describeError(notice.error, locale))}</p> : null}
    </div>
  </>
}
