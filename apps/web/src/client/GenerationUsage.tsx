import { CloseIcon, IconButton, describeError, formatter, type Locale, messagesFor, useFormat, useLocale, useMessages } from '@vis/ui-kit'
import type { generation, JobView } from '@vis/protocol'
import { useEffect, useId, useRef, useState } from 'react'
import { jobProblem } from './store'
import { settingsMessages } from './messages'

export type GenerationUsageData = ReturnType<typeof generation.usage.result.parse>
const TERMINAL = new Set(['succeeded', 'failed', 'unknown', 'cancelled'])
export const usageLimit = (limit: number, locale: Locale = 'zh-CN') => limit === 0 ? messagesFor(settingsMessages, locale).unlimited : formatter(locale).number(limit)

export function UsageCount({ count, limit }: { count: number; limit: number }) {
  const { locale } = useLocale()
  const format = useFormat()
  return <span className={limit > 0 && count > limit ? 'is-over' : undefined}>{format.number(count)} / {usageLimit(limit, locale)}</span>
}

export function GenerationUsage({ usage, error, spaceId, onClose, onCancel, onRegenerate, onRecheck, onSelectProject }: {
  usage: GenerationUsageData | null
  error: string
  spaceId: string | undefined
  onClose(): void
  onCancel(jobId: string): Promise<void>
  onRegenerate(jobId: string): Promise<void>
  onRecheck(jobId: string): Promise<void>
  onSelectProject(spaceId: string): void
}) {
  const m = useMessages(settingsMessages)
  const { locale } = useLocale()
  const format = useFormat()
  const statuses: Record<JobView['status'], string> = { queued: m.usageQueued, running: m.usageRunning, finalizing: m.usageFinalizing, succeeded: m.usageSucceeded, failed: m.usageFailed, unknown: m.usageUnknown, cancelled: m.usageCancelled }
  const popover = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const [busy, setBusy] = useState<string | null>(null)
  useEffect(() => {
    const element = popover.current!
    const previous = document.activeElement
    element.focus()
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !element.parentElement?.contains(event.target)) onClose()
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose() }
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('keydown', escape)
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [])
  const run = (jobId: string, action: (jobId: string) => Promise<void>) => {
    setBusy(jobId)
    void action(jobId).catch(() => {}).finally(() => setBusy(null))
  }
  return <div ref={popover} role="dialog" tabIndex={-1} className="vis-popover generation-usage" aria-labelledby={titleId}>
    <header><h2 id={titleId}>{m.usageTitle}</h2><IconButton label={m.usageClose} onClick={onClose}><CloseIcon /></IconButton></header>
    {error ? <p className="app-error" role="alert">{describeError(error, locale)}</p> : null}
    {usage ? <>
      <p>{m.usageTotals(format.dateTime(new Date(`${usage.date}T00:00:00`).getTime(), { year: 'numeric', month: '2-digit', day: '2-digit' }), format.number(usage.image), format.number(usage.video), format.number(usage.audio))}</p>
      <p>{m.usageAgentPrefix}<UsageCount count={usage.agent.image} limit={usage.limits.dailyImage} />{m.usageVideoPrefix}<UsageCount count={usage.agent.video} limit={usage.limits.dailyVideo} />{m.usageAudioPrefix}<UsageCount count={usage.agent.audio} limit={usage.limits.dailyAudio} /></p>
      <p className="generation-usage-hint">{m.usageHint(usageLimit(usage.limits.maxConcurrent, locale))}</p>
      {usage.jobs.length ? <ul>{[...usage.jobs].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)).map(job => {
        const current = !job.spaceId || job.spaceId === spaceId
        const problem = jobProblem(job, locale)
        return <li key={job.jobId}>
          <div className="generation-usage-job">
            <span>{job.kind === 'video' ? m.settingsVideo : job.kind === 'image' ? m.settingsImage : job.kind === 'audio' ? m.settingsAudio : m.usageJob} · {job.status === 'queued' && job.queueReason === 'concurrency_limit' ? m.usageQueuedLimit : statuses[job.status]}</span>
            <span className="generation-usage-project">{job.spaceId && !current ? <button title={m.usageSwitchHint} onClick={() => onSelectProject(job.spaceId!)}>{job.spaceName ?? job.spaceId}</button> : job.spaceName ?? m.usageCurrentProject}</span>
            {job.createdAt !== undefined ? <time dateTime={new Date(job.createdAt).toISOString()}>{format.time(job.createdAt)}</time> : null}
            {job.recheckable ? <button disabled={Boolean(busy) || !current} title={current ? m.usageRecheckHint : m.usageSwitchFirst} onClick={() => run(job.jobId, onRecheck)}>{m.usageRecheck}</button> : null}
            {TERMINAL.has(job.status)
              ? <button disabled={Boolean(busy) || !current} title={current ? undefined : m.usageSwitchFirst} onClick={() => run(job.jobId, onRegenerate)}>{job.status === 'succeeded' ? m.usageAnotherVersion : m.usageRegenerate}</button>
              : <button disabled={Boolean(busy) || !current || job.cancelRequestedAt !== undefined} title={current ? undefined : m.usageSwitchFirst} onClick={() => run(job.jobId, onCancel)}>{job.cancelRequestedAt !== undefined ? m.usageCancelling : m.usageCancel}</button>}
          </div>
          <code title={job.jobId}>{job.jobId}</code>
          {job.queueReason === 'concurrency_limit' ? <p>{m.usageQueueHint}</p> : null}
          {problem ? <p className={job.status === 'cancelled' ? 'generation-usage-hint' : 'app-error'}>{problem}</p> : null}
        </li>
      })}</ul> : !usage.deletedProjectJobs ? <p className="generation-usage-hint">{m.usageEmpty}</p> : null}
      {usage.deletedProjectJobs ? <p className="generation-usage-hint">{m.usageDeletedProjects(format.number(usage.deletedProjectJobs))}</p> : null}
    </> : !error ? <p>{m.usageLoading}</p> : null}
  </div>
}
