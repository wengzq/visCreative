import type { DeliveryState, JobView, TranscriptItem, TransientEvent } from '@vis/protocol'

export type Transcript = { items: TranscriptItem[]; hasMore: boolean }

/** Client state for session transcripts; stores only previously opened sessions */
export type TranscriptState = {
  transcripts: ReadonlyMap<string, Transcript>
  /** sessionId -> entry id -> streaming draft */
  drafts: ReadonlyMap<string, ReadonlyMap<string, TranscriptItem>>
  messageStates: ReadonlyMap<string, DeliveryState>
  /** Generation job state from tool results, including historical jobs absent from active jobs and daily paid usage. */
  jobs: ReadonlyMap<string, JobView>
}

export const emptyTranscripts = (): TranscriptState => ({ transcripts: new Map(), drafts: new Map(), messageStates: new Map(), jobs: new Map() })

const bySeq = (a: TranscriptItem, b: TranscriptItem) => a.createdSeq - b.createdSeq

/** Loads a page: prepends older records and keeps the higher revision of each entry */
export function mergePage(s: TranscriptState, sessionId: string, page: { items: TranscriptItem[]; hasMore: boolean }, older: boolean): TranscriptState {
  const current = s.transcripts.get(sessionId)
  const items = new Map((current?.items ?? []).map(i => [i.itemId, i]))
  for (const i of page.items) {
    const had = items.get(i.itemId)
    if (!had || had.revision < i.revision) items.set(i.itemId, i)
  }
  const hasMore = older || !current ? page.hasMore : current.hasMore
  return { ...s, transcripts: new Map(s.transcripts).set(sessionId, { items: [...items.values()].sort(bySeq), hasMore }) }
}

/** Persistent entry updates; ignores unopened sessions until they are opened and read. Final entries remove streaming drafts with the same id */
export function upsertItem(s: TranscriptState, sessionId: string, item: TranscriptItem): TranscriptState {
  let next = s
  const current = s.transcripts.get(sessionId)
  if (current) {
    const had = current.items.find(i => i.itemId === item.itemId)
    if (!had || had.revision < item.revision) {
      const items = had ? current.items.map(i => (i.itemId === item.itemId ? item : i)) : [...current.items, item].sort(bySeq)
      next = { ...next, transcripts: new Map(next.transcripts).set(sessionId, { ...current, items }) }
    }
  }
  const drafts = s.drafts.get(sessionId)
  if (drafts?.has(item.itemId) && item.revision >= drafts.get(item.itemId)!.revision) {
    const d = new Map(drafts)
    d.delete(item.itemId)
    next = { ...next, drafts: new Map(next.drafts).set(sessionId, d) }
  }
  return next
}

export function appendDelta(s: TranscriptState, e: TransientEvent): TranscriptState {
  // The final entry has arrived; discard late fragments
  const persisted = s.transcripts.get(e.sessionId)?.items.find(item => item.itemId === e.itemId)
  if (persisted && persisted.revision >= e.revision) return s
  const drafts = new Map(s.drafts.get(e.sessionId) ?? [])
  const previous = drafts.get(e.itemId) ?? persisted
  const now = Date.now()
  drafts.set(e.itemId, {
    itemId: e.itemId, turnId: e.turnId ?? previous?.turnId ?? null,
    kind: e.kind ?? previous?.kind ?? 'assistant_text', revision: e.revision,
    createdSeq: previous?.createdSeq ?? Number.MAX_SAFE_INTEGER,
    createdAt: previous?.createdAt ?? now, updatedAt: now,
    payload: { text: ((previous?.payload as { text: string } | undefined)?.text ?? '') + e.delta },
  })
  return { ...s, drafts: new Map(s.drafts).set(e.sessionId, drafts) }
}

export function setMessageState(s: TranscriptState, messageId: string, state: DeliveryState): TranscriptState {
  return { ...s, messageStates: new Map(s.messageStates).set(messageId, state) }
}
