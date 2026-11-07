import { SCENE_LIMITS } from '@vis/protocol'
import { useEffect, useRef, useState } from 'react'

export function NameField({ label, value, disabled, onChange }: { label: string; value: string; disabled: boolean; onChange(value: string): void }) {
  const [text, setText] = useState(value)
  useEffect(() => setText(value), [value])
  const commit = () => {
    const next = text.trim()
    if (next) onChange(next)
    else setText(value)
  }
  return <label className="vis-sc-field">{label}<input aria-label={label} value={text} maxLength={SCENE_LIMITS.name} disabled={disabled}
    onChange={event => setText(event.target.value)}
    onBlur={commit}
    onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setText(value) }
      if (event.key === 'Enter') { event.preventDefault(); commit() }
    }} /></label>
}

export function NumberField({ label, caption, value, disabled, min, max, commitOnBlur = false, onChange }: {
  label: string
  caption?: string
  value: number
  disabled: boolean
  min?: number
  max?: number
  commitOnBlur?: boolean
  onChange(value: number): void
}) {
  const display = (number: number) => String(Number(number.toFixed(4)))
  const [text, setText] = useState(display(value))
  const [focused, setFocused] = useState(false)
  const cancelled = useRef(false)
  useEffect(() => { if (!focused) setText(display(value)) }, [value, focused])
  const finish = (input: HTMLInputElement) => {
    input.blur()
    input.closest<HTMLElement>('.vis-sc-editor')?.focus({ preventScroll: true })
  }
  return <label className="vis-sc-field">{caption ?? label}<input type="number" aria-label={label} value={text} min={min} max={max} step="any" disabled={disabled}
    onFocus={() => { setFocused(true); cancelled.current = false }}
    onChange={event => {
      setText(event.target.value)
      if (!commitOnBlur && event.target.value && event.target.validity.valid && Number.isFinite(event.target.valueAsNumber)) onChange(event.target.valueAsNumber)
    }}
    onBlur={event => {
      let next = value
      if (commitOnBlur && !cancelled.current && event.target.value && event.target.value !== display(value) && Number.isFinite(event.target.valueAsNumber)) {
        next = Math.max(min ?? -Infinity, Math.min(max ?? Infinity, event.target.valueAsNumber))
        onChange(next)
      }
      setFocused(false)
      setText(display(next))
    }}
    onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancelled.current = true; setText(display(value)); finish(event.currentTarget) }
      if (event.key === 'Enter') { event.preventDefault(); if (commitOnBlur || event.currentTarget.reportValidity()) finish(event.currentTarget) }
    }} /></label>
}
