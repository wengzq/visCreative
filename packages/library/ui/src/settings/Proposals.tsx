import { useEffect, useState } from 'react'
import type { EntityProposalView, EntityView, LibraryAsset } from '@vis/protocol'
import { describeError, useFormat, useLocale, useMessages } from '@vis/ui-kit'
import type { SettingsLibraryHost } from './host'
import { canAcceptProposal, proposalChanged, proposalDraft, toggleProposalMember, type ProposalDraft } from './model'
import { settingAssetUrl, useSettingMedia } from './data'
import { settingsMessages } from './messages'
import { AudioIcon } from './AudioIcon'

type RefLookup = { host: SettingsLibraryHost; key: string; assets: Record<string, string>; error?: unknown }
const refsKey = (proposal: EntityProposalView) => JSON.stringify(proposal.refs ?? [])

export function PendingProposals({ host, proposals, settings, onResolved, onEntity }: { host: SettingsLibraryHost; proposals: EntityProposalView[]; settings: EntityView[]; onResolved(): void; onEntity(entity: EntityView): void }) {
  const m = useMessages(settingsMessages)
  const format = useFormat()
  const { locale } = useLocale()
  const { media, error: mediaError, loading: mediaLoading } = useSettingMedia(host)
  const [refLookups, setRefLookups] = useState<Record<string, RefLookup>>({})
  const [drafts, setDrafts] = useState<Record<string, ProposalDraft>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [failures, setFailures] = useState(0)
  useEffect(() => {
    setDrafts(current => Object.fromEntries(proposals.map(proposal => [proposal.proposalId, current[proposal.proposalId] ?? proposalDraft(proposal)])))
  }, [proposals])
  const proposalRefsKey = JSON.stringify(proposals.map(proposal => [proposal.proposalId, refsKey(proposal)]))
  useEffect(() => {
    let active = true
    for (const proposal of proposals) {
      const key = refsKey(proposal)
      const previous = refLookups[proposal.proposalId]
      if (previous?.host === host && previous.key === key) continue
      void Promise.all((proposal.refs ?? []).map(id => host.call('asset.get', { assetVersionId: id }))).then(items => {
        if (active) setRefLookups(current => ({ ...current, [proposal.proposalId]: {
          host, key, assets: { ...(previous?.host === host ? previous.assets : {}), ...Object.fromEntries(items.map(item => [item.assetVersionId, item.assetId])) },
        } }))
      }, error => {
        if (active) setRefLookups(current => ({ ...current, [proposal.proposalId]: { host, key, assets: {}, error } }))
      })
    }
    return () => { active = false }
  }, [host, proposalRefsKey])
  const draftOf = (proposal: EntityProposalView) => drafts[proposal.proposalId] ?? proposalDraft(proposal)
  const lookupOf = (proposal: EntityProposalView) => {
    const lookup = refLookups[proposal.proposalId]
    return lookup?.host === host && lookup.key === refsKey(proposal) ? lookup : undefined
  }
  const ready = (proposal: EntityProposalView) => !!lookupOf(proposal) && !lookupOf(proposal)?.error && !mediaLoading && !mediaError
  const canAccept = (proposal: EntityProposalView) => ready(proposal) && canAcceptProposal(proposal, draftOf(proposal))
  const resolve = async (proposal: EntityProposalView, accept: boolean) => {
    if (accept && !canAccept(proposal)) return
    const assets = { ...Object.fromEntries(media.map(item => [item.latest.assetVersionId, item.assetId])), ...lookupOf(proposal)?.assets }
    const original = draftOf(proposal)
    const draft = { ...original, refs: original.refs.filter(id => original.members.some(member => member.assetId === assets[id])) }
    const result = await host.call('entity.proposalResolve', {
      requestId: crypto.randomUUID(), proposalId: proposal.proposalId, accept,
      ...(accept && proposalChanged(proposal, draft) ? { edits: { ...draft, name: draft.name.trim() } } : {}),
    })
    if (result.entity) onEntity(result.entity)
  }
  const work = async (callback: () => Promise<void>) => {
    setBusy(true); setError(null); setFailures(0)
    try { await callback() } catch (cause) { setError(cause) }
    finally { setBusy(false); onResolved() }
  }
  return <section className="library-setting-proposals" aria-label={m.proposals}>
    <header><h3>{m.proposals} <small>{format.number(proposals.length)}</small></h3><button disabled={busy || !proposals.some(canAccept)} onClick={() => void work(async () => {
      let failed = 0
      for (const proposal of proposals) {
        if (!canAccept(proposal)) { failed++; continue }
        try { await resolve(proposal, true) } catch (cause) { failed++; setError(cause) }
      }
      setFailures(failed)
    })}>{m.acceptAll}</button></header>
    {proposals.map(proposal => <ProposalCard key={proposal.proposalId} host={host} proposal={proposal} draft={draftOf(proposal)} media={media}
      target={settings.find(item => item.id === proposal.entityId)} busy={busy}
      refAssets={lookupOf(proposal)?.assets ?? {}} refError={lookupOf(proposal)?.error} refsReady={ready(proposal)}
      onChange={draft => {
        setDrafts(current => ({ ...current, [proposal.proposalId]: draft }))
        const lookup = lookupOf(proposal)
        if (lookup) setRefLookups(current => ({ ...current, [proposal.proposalId]: {
          ...lookup, assets: { ...lookup.assets, ...Object.fromEntries(media.filter(item => draft.refs.includes(item.latest.assetVersionId))
            .map(item => [item.latest.assetVersionId, item.assetId])) },
        } }))
      }}
      onResolve={accept => void work(() => resolve(proposal, accept))} />)}
    {error || mediaError ? <p role="alert">{describeError(error ?? mediaError, locale)}</p> : null}
    {failures ? <p role="status">{m.failures(format.number(failures))}</p> : null}
  </section>
}

function ProposalCard({ host, proposal, target, draft, media, busy, refAssets, refError, refsReady, onChange, onResolve }: {
  host: SettingsLibraryHost; proposal: EntityProposalView; target?: EntityView | undefined; draft: ProposalDraft; media: LibraryAsset[]; busy: boolean
  refAssets: Record<string, string>; refError?: unknown; refsReady: boolean
  onChange(draft: ProposalDraft): void; onResolve(accept: boolean): void
}) {
  const m = useMessages(settingsMessages)
  const { locale } = useLocale()
  const selected = new Set(draft.members.map(member => member.assetId))
  return <article className="library-setting-proposal" aria-label={proposal.name}>
    <div className="library-setting-proposal-title"><span className="library-setting-chip">{m[proposal.kind]}</span>{proposal.entityId ? <span>{m.target(target?.name ?? proposal.entityId)}</span> : null}</div>
    <label>{m.proposalName}<input aria-label={m.proposalName} maxLength={60} disabled={busy} value={draft.name} onChange={event => onChange({ ...draft, name: event.target.value })} /></label>
    <blockquote className="library-setting-reason"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" aria-label={m.agentReason}><rect x="3" y="4" width="10" height="9" rx="2" /><path d="M8 1v3M6 7v2M10 7v2M6 11h4" /></svg><span>{proposal.reason}</span></blockquote>
    {proposal.needsRecheck ? <p className="library-setting-warning" role="status">{m.recheck}</p> : null}
    <div className="library-setting-proposal-members" role="group" aria-label={m.proposalMember}>{proposal.members.map(member => {
      const item = media.find(item => item.assetId === member.assetId)
      const name = item?.displayName ?? member.assetId
      const versions = Object.entries(refAssets).filter(([, assetId]) => assetId === member.assetId).map(([id]) => id)
      if (item) versions.push(item.latest.assetVersionId)
      const imageId = item?.kind === 'image' ? draft.refs.find(id => refAssets[id] === member.assetId) ?? item.latest.assetVersionId : undefined
      return <div className="library-setting-proposal-member" key={member.assetId} title={name}>
        <input type="checkbox" aria-label={m.selectMember(name)} checked={selected.has(member.assetId)} disabled={busy || !refsReady}
          onChange={() => onChange(toggleProposalMember(draft, member, versions))} />
        {imageId ? <button type="button" className="library-proposal-cover-choice" aria-label={m.useCover(name)} title={m.useCover(name)}
          disabled={busy || !refsReady || !selected.has(member.assetId)} aria-pressed={draft.refs[0] === imageId}
          onClick={() => onChange({ ...draft, refs: [imageId, ...draft.refs.filter(id => id !== imageId)].slice(0, 4) })}>
          <img alt="" src={settingAssetUrl(host, imageId)} />
          {draft.refs[0] === imageId ? <svg className="library-proposal-cover-star" viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-label={m.cover}><path d="m8 1 2.1 4.3 4.8.7-3.5 3.4.8 4.8L8 12l-4.2 2.2.8-4.8L1.1 6l4.8-.7Z" /></svg> : null}
        </button> : <span className="library-proposal-audio-icon" aria-hidden="true"><AudioIcon /></span>}
        <span>{name}</span><small>{m[member.role]}</small>
      </div>
    })}</div>
    {draft.refs.length ? <button className="library-proposal-clear-cover" title={m.clearCover} disabled={busy} onClick={() => onChange({ ...draft, refs: [] })}>{m.clearCover}</button> : null}
    {refError ? <p role="alert">{describeError(refError, locale)}</p> : null}
    <footer><button disabled={busy} onClick={() => onResolve(false)}>{m.reject}</button><button className="is-primary" title={proposal.needsRecheck ? m.recheck : undefined} disabled={busy || !refsReady || !canAcceptProposal(proposal, draft)} onClick={() => onResolve(true)}>{m.accept}</button></footer>
  </article>
}
