import type { SceneProposal } from '@vis/protocol'
import { useFormat, useMessages } from '@vis/ui-kit'
import { sceneMessages } from './messages'
import { sceneChangeDetails } from './proposals'
import type { SceneEditorHost } from './types'

export function SceneProposals({ host, disabled, preview, resolve }: {
  host: SceneEditorHost
  disabled: boolean
  preview(proposal: SceneProposal | null, pinned?: boolean): void
  resolve(action: 'accept' | 'reject', proposal: SceneProposal, changeId?: string): void
}) {
  const m = useMessages(sceneMessages)
  const f = useFormat()
  const proposals = host.proposals ?? []
  const count = proposals.reduce((n, proposal) => n + proposal.changes.filter(change => change.status === 'pending').length, 0)
  return <section className="vis-sc-inspector-section vis-sc-proposals" aria-label={m.proposals}>
    <h3>{m.proposalCount(f.number(count))}</h3>
    {!proposals.length ? <p className="vis-sc-muted">{m.noProposals}</p> : null}
    {proposals.map(proposal => <article key={proposal.proposalId} aria-label={proposal.summary}>
      <strong>{proposal.summary}</strong><p className="vis-sc-muted">{host.sessionName?.(proposal.sessionId) ?? m.proposalSession}</p>
      <ul>{proposal.changes.map(change => {
        const detail = sceneChangeDetails(change)
        const fields = detail.fields.map(field => m.proposalField(field))
        if (detail.keys !== null) fields.push(m.proposalKeys(f.number(detail.keys)))
        const line = m.proposalLine(detail.name ?? m.duration, fields.join(', '))
        const dismissable = ['pending', 'stale', 'superseded'].includes(change.status)
        return <li key={change.changeId} onMouseEnter={() => { if (!disabled && change.status === 'pending') preview(proposal) }} onMouseLeave={() => preview(null)}
          onFocus={event => { if (!disabled && change.status === 'pending' && event.target === event.currentTarget) preview(proposal) }} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) preview(null) }} tabIndex={0}>
          <span>{line}</span><span className={`vis-sc-change-state is-${change.status}`}>{m.proposalState(change.status)}</span>
          <div className="vis-sc-button-row">
            <button disabled={disabled || change.status !== 'pending'} onClick={() => preview(proposal, true)}>{m.preview}</button>
            <button aria-label={m.acceptChange(detail.name ?? m.duration)} disabled={disabled || change.status !== 'pending' || !host.resolveProposal} onClick={() => resolve('accept', proposal, change.changeId)}>{m.accept}</button>
            <button aria-label={m.rejectChange(detail.name ?? m.duration)} disabled={disabled || !dismissable || !host.resolveProposal} onClick={() => resolve('reject', proposal, change.changeId)}>{m.reject}</button>
          </div>
        </li>
      })}</ul>
      <div className="vis-sc-button-row">
        <button disabled={disabled || !host.resolveProposal || !proposal.changes.some(change => change.status === 'pending')} onClick={() => resolve('accept', proposal)}>{m.acceptAll}</button>
        <button disabled={disabled || !host.resolveProposal || !proposal.changes.some(change => ['pending', 'stale', 'superseded'].includes(change.status))} onClick={() => resolve('reject', proposal)}>{m.rejectAll}</button>
      </div>
    </article>)}
  </section>
}
