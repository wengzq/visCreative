import type { MethodResult, SkillDraftReceipt, TranscriptItem } from '@vis/protocol'
import { SkillDraftReceipt as DraftSchema } from '@vis/protocol'
import { describeError, useLocale, useMessages } from '@vis/ui-kit'
import { useEffect, useState } from 'react'
import { skillCopyMessages } from './messages'

export type SkillDraftHost = {
  state(draftId: string): Promise<MethodResult<'skill.draftState'>>
  discard(draftId: string, revision: number): Promise<unknown>
  subscribe(listener: () => void): () => void
  review(draftId: string): void
}

/** Derive cards from actual receipts; the current draft state is read separately from historical text. */
export function skillDraftResults(items: TranscriptItem[]): Map<string, SkillDraftReceipt> {
  const last = new Map<string, { itemId: string; draft: SkillDraftReceipt }>()
  for (const item of items) {
    if (item.kind !== 'tool_result') continue
    const payload = item.payload as { text?: unknown; isError?: boolean; skillDraft?: unknown } | null
    if (payload?.isError) continue
    const structured = DraftSchema.safeParse(payload?.skillDraft)
    if (structured.success) { last.set(structured.data.draftId, { itemId: item.itemId, draft: structured.data }); continue }
    if (typeof payload?.text !== 'string') continue
    try {
      const result = JSON.parse(payload.text)
      if (result.location !== 'Settings > My skills') continue
      const parsed = DraftSchema.safeParse(result.draft)
      if (parsed.success) last.set(parsed.data.draftId, { itemId: item.itemId, draft: parsed.data })
    } catch { /* Non-JSON receipts do not propose a skill. */ }
  }
  return new Map([...last.values()].map(({ itemId, draft }) => [itemId, draft]))
}

export function SkillDraftCard({ draft, host }: { draft: SkillDraftReceipt; host?: SkillDraftHost | undefined }) {
  const m = useMessages(skillCopyMessages)
  const { locale } = useLocale()
  const [state, setState] = useState<MethodResult<'skill.draftState'> | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!host) return
    let current = true
    let generation = 0
    const refresh = () => {
      const attempt = ++generation
      void host.state(draft.draftId).then(value => { if (current && attempt === generation) { setState(value); setError(null) } }, error => { if (current && attempt === generation) setError(error) })
    }
    refresh()
    const unsubscribe = host.subscribe(refresh)
    return () => { current = false; unsubscribe() }
  }, [host, draft.draftId])
  const value = state?.draft ?? draft
  return <article className="vis-skill-draft-card" aria-label={m.title}>
    <strong>{value.name}</strong><p>{value.description}</p>
    {state?.status === 'saved' ? <span role="status">{m.saved}</span> : state?.status === 'discarded' ? <span role="status">{m.discarded}</span> : <div>
      <button type="button" disabled={!host || !state || busy} onClick={() => host?.review(draft.draftId)}>{m.review}</button>
      <button type="button" disabled={!host || !state || busy} onClick={() => {
        if (!host || !window.confirm(m.discardConfirm)) return
        setBusy(true)
        void host.discard(draft.draftId, value.revision).then(() => host.state(draft.draftId)).then(setState).catch(setError).finally(() => setBusy(false))
      }}>{m.discard}</button>
    </div>}
    {error ? <p role="alert">{describeError(error, locale)}</p> : null}
  </article>
}
