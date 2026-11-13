import { useFormat, useLocale, useMessages } from '@vis/ui-kit'
import { useEffect, useRef, useState } from 'react'
import type { useGenerationChoice } from './ModelPicker'
import { controlMessages } from './messages'
import { parameterDescription, parameterFields, parameterLabel, parameterOption, parameterSummary, segmentOptions } from './params'
import { promptMessages } from './prompt-messages'

type Settings = ReturnType<typeof useGenerationChoice>

export function ModelParameters({ settings }: { settings: Settings }) {
  const { locale } = useLocale()
  const m = useMessages(controlMessages)
  const p = useMessages(promptMessages)
  const { model, choice, select } = settings
  return <div className="vis-model-params">{model && choice ? parameterFields(model.paramsSchema).map(([name, field]) => {
    const value = choice.params[name]
    const update = (value: unknown) => {
      const params = { ...choice.params }
      if (value === undefined) delete params[name]
      else params[name] = value
      void select({ ...choice, params })
    }
    const label = parameterLabel(name, field, locale, m.parameterLabel)
    const optionLabel = (value: unknown) => parameterOption(name, value, field, locale, p.parameterOption)
    const segments = segmentOptions(field)
    return <div className="vis-param-field" key={name} title={parameterDescription(field, locale)} role="group" aria-label={label}>
      <span>{label}{value === field.default ? <small>{m.defaultParameter}</small> : null}</span>
      {segments ? <div className="vis-param-segments">
        {segments.map(value => <button key={String(value)} aria-pressed={value === choice.params[name]} onClick={() => update(value)}>{optionLabel(value)}</button>)}
        {field.type === 'string' && field.examples && !field.enum ? <input className="vis-param-custom" aria-label={m.customParameterLabel(label)} value={typeof value === 'string' && !segments.includes(value) ? value : ''} placeholder={m.customParameter} title={parameterDescription(field, locale) ?? m.customSizeHint} onChange={event => update(event.target.value || undefined)} /> : null}
      </div> : field.enum ? <select aria-label={label} value={value === undefined ? '' : String(value)} onChange={event => update(field.enum!.find(value => String(value) === event.target.value))}><option value="">{m.modelDefault}</option>{field.enum.map(value => <option key={String(value)} value={String(value)}>{optionLabel(value)}</option>)}</select>
        : field.type === 'boolean' ? <button className="vis-param-toggle" aria-label={label} role="switch" aria-checked={value === true} onClick={() => update(value !== true)} />
        : <input aria-label={label} type={field.type === 'string' ? 'text' : 'number'} min={field.minimum} max={field.maximum} step={field.type === 'integer' ? 1 : 'any'} value={value === undefined ? '' : String(value)} placeholder={m.modelDefault} onChange={event => update(event.target.value === '' ? undefined : field.type === 'string' ? event.target.value : Number(event.target.value))} />}
    </div>
  }) : null}</div>
}

export function ParamsSummary({ settings }: { settings: Settings }) {
  const { locale } = useLocale()
  const m = useMessages(controlMessages)
  const p = useMessages(promptMessages)
  const format = useFormat()
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const popup = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    const position = () => {
      if (!popup.current || !root.current) return
      popup.current.style.left = '0px'
      const anchor = root.current.getBoundingClientRect()
      popup.current.style.maxHeight = `${Math.max(0, Math.min(520, anchor.top - 16))}px`
      const rect = popup.current.getBoundingClientRect()
      popup.current.style.left = `${Math.max(8 - rect.left, Math.min(0, window.innerWidth - rect.right - 8))}px`
    }
    document.addEventListener('pointerdown', close)
    window.addEventListener('resize', position)
    position()
    return () => { document.removeEventListener('pointerdown', close); window.removeEventListener('resize', position) }
  }, [open, settings.model])
  if (!settings.configured) return null
  const summary = settings.model && settings.choice ? parameterSummary(settings.model.paramsSchema, settings.choice.params, {
    number: format.number,
    boolean: value => value ? p.enabled : p.disabled,
    label: (name, field) => parameterLabel(name, field, locale, m.parameterLabel),
    option: (name, value, field) => parameterOption(name, value, field, locale, p.parameterOption),
    value: p.parameterValue,
  }) : ''
  return <div ref={root} className="vis-params-summary" onKeyDown={event => {
    if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); trigger.current?.focus() }
  }}>
    <button ref={trigger} className="vis-params-trigger" aria-label={p.parameterSummary} aria-expanded={open} title={summary || p.noParameters} onClick={() => setOpen(value => !value)}>{summary || p.noParameters}</button>
    {open ? <div ref={popup} className="vis-model-popover vis-params-popover" role="dialog" aria-label={p.parameters}><ModelParameters settings={settings} /></div> : null}
  </div>
}
