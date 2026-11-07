import { PlanPayload, ReasoningPayload, type TranscriptItem } from '@vis/protocol'
import { useEffect, useId, useRef, useState } from 'react'
import { AgentMarkdown } from './AgentMarkdown'
import { elapsedTime, planProgress } from './activity'
import { useFormat, useLocale, useMessages } from '@vis/ui-kit'
import { sessionMessages } from './messages'

export function useClock(active: boolean) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

export function ReasoningBlock({ item, active }: { item: TranscriptItem; active: boolean }) {
  const m = useMessages(sessionMessages)
  const { locale } = useLocale()
  const now = useClock(active)
  const [manualOpen, setManualOpen] = useState<boolean>()
  const bodyId = useId()
  const open = manualOpen ?? active
  const parsed = ReasoningPayload.safeParse(item.payload)
  const text = parsed.success ? parsed.data.text : ''
  const preview = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (active && manualOpen === undefined && preview.current) preview.current.scrollTop = preview.current.scrollHeight
  }, [text, active, manualOpen])
  const format = useFormat()
  const seconds = Math.max(1, Math.floor((item.updatedAt - item.createdAt) / 1000))
  return <div className="vis-item is-markdown vis-reasoning">
    <button type="button" disabled={!active && !text.trim()} aria-expanded={open && !!text.trim()} aria-controls={text.trim() ? bodyId : undefined} onClick={() => setManualOpen(!open)}>
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true"><path d={open ? 'm3 6 5 5 5-5' : 'm6 3 5 5-5 5'} /></svg>
      {active ? <>{m.thinking}<span aria-hidden="true"> · {elapsedTime(now - item.createdAt, locale)}</span></> : m.reasonedFor(format.number(seconds))}
    </button>
    {open && text.trim() ? <div id={bodyId} ref={preview} className={`vis-reasoning-body${active && manualOpen === undefined ? ' is-preview' : ''}`}><AgentMarkdown>{text}</AgentMarkdown></div> : null}
  </div>
}

export function PlanCard({ item }: { item: TranscriptItem }) {
  const m = useMessages(sessionMessages)
  const { locale } = useLocale()
  const parsed = PlanPayload.safeParse(item.payload)
  if (!parsed.success) return null
  return <section className="vis-item vis-plan" aria-label={m.turnPlan}>
    <strong>{planProgress(item, locale)}</strong>
    {parsed.data.explanation ? <p>{parsed.data.explanation}</p> : null}
    <ul>{parsed.data.entries.map((entry, index) => <li key={index} className={`is-${entry.status}`}>
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-label={{ pending: m.planPending, in_progress: m.planInProgress, completed: m.planCompleted }[entry.status]} role="img">
        {entry.status === 'completed' ? <path d="m3 8 3 3 7-7" /> : <circle cx="8" cy="8" r="5" strokeDasharray={entry.status === 'in_progress' ? '23 9' : undefined} />}
      </svg><span>{entry.text}</span>
    </li>)}</ul>
  </section>
}
