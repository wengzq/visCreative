import type { JobView, TranscriptItem } from '@vis/protocol'
import { useRef } from 'react'
import { useFormat, useLocale, useMessages } from '@vis/ui-kit'
import { PlanCard, ReasoningBlock, useClock } from './AgentActivity'
import { activityText, elapsedTime, reasoningActive } from './activity'
import { sessionMessages } from './messages'
import { ToolGroup } from './ToolGroup'
import { workBlockStats, type WorkBlockGroup } from './workBlocks'

export function WorkBlock({ block, items, jobs, silentSince, onStop, onToggle }: { block: WorkBlockGroup; items: TranscriptItem[]; jobs?: ReadonlyMap<string, JobView> | undefined; silentSince?: number | null; onStop?(): void; onToggle(): void }) {
  const m = useMessages(sessionMessages)
  const { locale } = useLocale()
  const format = useFormat()
  const now = useClock(block.active)
  const fallbackStart = useRef(Date.now())
  const stats = workBlockStats(block)
  const duration = elapsedTime((block.active ? now : stats.endedAt ?? 0) - (stats.startedAt ?? fallbackStart.current), locale)
  return <details className={`vis-item vis-work-block${block.active ? ' is-running' : ''}`} data-history-items={JSON.stringify(block.items.map(item => item.itemId))} onToggle={onToggle}>
    <summary className="vis-work-block-summary">
      {block.active ? <span className="vis-activity-dot" aria-hidden="true" /> : <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m3 8 3 3 7-7" /></svg>}
      <span className="vis-work-block-label">{block.active ? <><span role="status" className={silentSince != null ? 'vis-turn-silent' : undefined}>{silentSince != null ? m.silentWarning(format.number(Math.max(0, Math.floor((now - silentSince) / 60_000)))) : activityText(items, block.turnId!, locale)}</span><span aria-hidden="true"> · </span><span aria-label={m.turnElapsed} aria-live="off">{duration}</span></> : m.worked(duration)}{stats.tools ? ` · ${m.workTools(format.number(stats.tools))}` : ''}{stats.failed ? <span className="vis-tool-failures"> · {m.failedTools(format.number(stats.failed))}</span> : null}</span>
      {block.active && silentSince != null && onStop ? <button type="button" className="vis-work-block-stop" onClick={event => { event.preventDefault(); event.stopPropagation(); onStop() }}>{m.stop}</button> : null}
      <svg className="vis-work-block-chevron" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true"><path d="m6 3 5 5-5 5" /></svg>
    </summary>
    <div className="vis-work-block-steps">{block.steps.map(step => step.kind === 'tools'
      ? <ToolGroup key={step.itemId} group={step} jobs={jobs} onToggle={onToggle} />
      : step.item.kind === 'reasoning' ? <ReasoningBlock key={step.item.itemId} item={step.item} active={block.active && reasoningActive(step.item, items, block.turnId)} />
        : <PlanCard key={step.item.itemId} item={step.item} />)}</div>
  </details>
}
