import { describeError, useFormat, useLocale, useMessages } from '@vis/ui-kit'
import { workMessages } from '../messages'
import type { WorkSlotsView } from '@vis/protocol'
import { useState } from 'react'
import { relativeTime } from './model'
import { WorkDialog } from './WorkDialog'

/** To adjust the limit, the host opens the guardrails group in the existing generation service settings. */
export interface SlotsPopoverProps {
  slots: WorkSlotsView
  spaceNames?: ReadonlyMap<string, string>
  onClose(): void
  onAdjustLimit(): void
  onCancelQueue(input: { spaceId: string; workItemId: string }): void | Promise<void>
}

export function SlotsPopover({ slots, spaceNames, onClose, onAdjustLimit, onCancelQueue }: SlotsPopoverProps) {
  const { locale } = useLocale()
  const t = useMessages(workMessages)
  const format = useFormat()
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set())
  const [error, setError] = useState<unknown>(null)
  const cancel = async (spaceId: string, workItemId: string) => {
    if (busy.has(workItemId)) return
    setBusy(current => new Set(current).add(workItemId))
    setError(null)
    try { await onCancelQueue({ spaceId, workItemId }) }
    catch (error) { setError(error) }
    finally { setBusy(current => { const next = new Set(current); next.delete(workItemId); return next }) }
  }
  return <WorkDialog popover title={t.globalRunning(format.number(slots.used), format.number(slots.limit))} className="vis-work-slots" onClose={onClose}>
    <div className="vis-work-slots-summary"><div>{slots.bySpace.map(space => <span key={space.spaceId}>{spaceNames?.get(space.spaceId) ?? space.spaceId} <strong>{format.number(space.used)}{space.limit !== null ? `/${format.number(space.limit)}` : ''}</strong></span>)}</div><button onClick={onAdjustLimit}>{t.adjustLimit}</button></div>
    <h3>{t.waitingSlot}</h3>{slots.queue.length ? <ol className="vis-work-slot-queue">{slots.queue.map(entry => <li key={entry.workItemId}><div><strong>{spaceNames?.get(entry.spaceId) ?? entry.spaceId} › {entry.title}</strong><time dateTime={new Date(entry.waitingSince).toISOString()}>{relativeTime(entry.waitingSince, undefined, locale)}</time></div><button disabled={busy.has(entry.workItemId)} onClick={() => void cancel(entry.spaceId, entry.workItemId)} aria-label={t.cancelQueueTitle(entry.title)}>{busy.has(entry.workItemId) ? t.cancelling : t.cancelQueue}</button></li>)}</ol> : <p className="vis-work-empty">{t.noQueuedItems}</p>}
    {error !== null ? <p className="vis-work-error" role="alert">{describeError(error, locale)}</p> : null}
  </WorkDialog>
}
