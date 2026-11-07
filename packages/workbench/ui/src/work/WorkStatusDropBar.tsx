import { useLocale, useMessages } from '@vis/ui-kit'
import { workMessages } from '../messages'
import type { WorkItemView, WorkStatus } from '@vis/protocol'
import { BOARD_STATUSES, statusLabels } from './model'
import './work.css'

export type WorkTreeDrag = { item: WorkItemView; status: WorkStatus | null }

export function WorkStatusDropBar({ drag }: { drag: WorkTreeDrag | null }) {
  const { locale } = useLocale()
  const t = useMessages(workMessages)
  const statuses = statusLabels(locale)
  return <section className={`vis-work-status-drop-bar${drag ? ' is-open' : ''}`} aria-label={t.statusBar} aria-hidden={!drag}>
    <span>{t.moveTitleTo(drag?.item.title ?? '')}</span>
    <div>{BOARD_STATUSES.map(status => <div key={status} role="region" aria-label={t.moveToStatus(statuses[status])} data-work-status-drop={status} className={`vis-work-status-drop${drag?.status === status ? ' is-over' : ''}`}><span className={`vis-work-status-dot is-${status}`} />{statuses[status]}</div>)}</div>
  </section>
}
