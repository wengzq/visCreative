import { SceneProposal as ProposalSchema, type SceneChangeRef, type SceneProposal, type TranscriptItem } from '@vis/protocol'
import { describeError, useLocale, useMessages } from '@vis/ui-kit'
import { useState } from 'react'
import { sceneProposalMessages } from './messages'

export type SceneProposalHost = {
  state(proposalId: string): SceneProposal | undefined
  resolve(slotId: string, action: 'accept' | 'reject', changes: SceneChangeRef[]): Promise<unknown>
  open(proposal: SceneProposal): void
}

export function sceneProposalResults(items: TranscriptItem[]): Map<string, SceneProposal> {
  const last = new Map<string, { itemId: string; proposal: SceneProposal }>()
  for (const item of items) {
    if (item.kind !== 'tool_result') continue
    const payload = item.payload as { isError?: boolean; sceneProposal?: unknown } | null
    if (payload?.isError) continue
    const parsed = ProposalSchema.safeParse(payload?.sceneProposal)
    if (parsed.success) last.set(parsed.data.proposalId, { itemId: item.itemId, proposal: parsed.data })
  }
  return new Map([...last.values()].map(({ itemId, proposal }) => [itemId, proposal]))
}

export function SceneProposalCard({ proposal, host }: { proposal: SceneProposal; host?: SceneProposalHost | undefined }) {
  const m = useMessages(sceneProposalMessages)
  const { locale } = useLocale()
  const live = host?.state(proposal.proposalId)
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const value = live ?? proposal
  const resolve = async (action: 'accept' | 'reject') => {
    if (!host || !live) return
    const changes = live.changes.filter(change => action === 'accept' ? change.status === 'pending' : ['pending', 'stale', 'superseded'].includes(change.status))
      .map(change => ({ proposalId: live.proposalId, changeId: change.changeId }))
    if (!changes.length) return
    setBusy(true)
    setError(null)
    try {
      await host.resolve(value.slotId, action, changes)
    } catch (error) { setError(error) }
    finally { setBusy(false) }
  }
  return <article className="vis-scene-proposal-card" aria-label={m.title}>
    <strong>{value.summary}</strong>
    <ul>{value.changes.map(change => <li key={change.changeId}><span>{change.target === 'duration' ? m.duration : change.base.name}</span><span>{m.state(change.status)}</span></li>)}</ul>
    <div>
      <button disabled={!host || !live || busy || !value.changes.some(change => change.status === 'pending')} onClick={() => void resolve('accept')}>{m.acceptAll}</button>
      <button disabled={!host || !live || busy || !value.changes.some(change => ['pending', 'stale', 'superseded'].includes(change.status))} onClick={() => void resolve('reject')}>{m.rejectAll}</button>
      <button disabled={!host || busy} onClick={() => host?.open(value)}>{m.open}</button>
    </div>
    {error ? <p role="alert">{describeError(error, locale)}</p> : null}
  </article>
}
