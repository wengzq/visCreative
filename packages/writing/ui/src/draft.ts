import { useEffect, useRef, useSyncExternalStore } from 'react'
import { WRITING_LIMITS, type TextEditRef } from '@vis/protocol'
import type { WritingHost } from './types'

const committed = (host: WritingHost) => {
  const slot = host.node.slots.find(slot => slot.slotKey === 'main')
  return { body: slot?.content.type === 'text' ? slot.content.body : '', revision: slot?.revision ?? 0 }
}

export function createWritingDraft(initialHost: WritingHost) {
  let host = initialHost
  let latest = committed(host)
  let body = latest.body
  let saved = body
  let revision = latest.revision
  let state: 'saved' | 'saving' | 'unsaved' | 'conflict' = 'saved'
  let pendingReview: { requestId: string; edits: TextEditRef[] } | undefined
  let error: unknown = null
  let conflict = false
  let edited = false
  let generation = 0
  let active = true
  let pendingSince: number | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let inFlight: Promise<void> | null = null
  const own = new Map<number, string>()
  const listeners = new Set<() => void>()
  const snapshot = () => ({ body, revision, state, error, conflict, generation, pendingReview: !!pendingReview, accept, edit, beginEdit: () => { edited = true }, flush, loadTheirs })
  let value = snapshot()
  const publish = () => { value = snapshot(); if (active) listeners.forEach(listener => listener()) }
  const cancel = () => { clearTimeout(timer); timer = undefined }
  const markConflict = () => { cancel(); conflict = true; state = 'conflict'; error = null; publish() }
  const schedule = () => {
    cancel()
    if (!active || conflict || (body === saved && !pendingReview)) return
    pendingSince ??= Date.now()
    timer = setTimeout(() => void commit(), Math.max(0, Math.min(WRITING_LIMITS.autosaveMs, WRITING_LIMITS.maxWaitMs - (Date.now() - pendingSince))))
  }
  async function commit(): Promise<void> {
    if (conflict) return
    if (inFlight) return inFlight
    cancel()
    if (body === saved && !pendingReview) { pendingSince = null; state = 'saved'; publish(); return }
    const payload = body
    const expected = revision
    pendingSince = null
    state = 'saving'
    error = null
    own.set(expected + 1, payload)
    publish()
    const operation = (async () => {
      try {
        const result = pendingReview ? await host.commit(payload, expected, pendingReview) : await host.commit(payload, expected)
        if (result === 'conflict') { own.delete(expected + 1); markConflict(); return }
        pendingReview = undefined
        saved = payload
        revision = Math.max(revision, expected + 1)
        if (!conflict) state = body === saved ? 'saved' : 'saving'
      } catch (cause) {
        if (latest.revision === expected + 1 && latest.body === payload) { pendingReview = undefined; saved = payload; revision = latest.revision; state = body === saved ? 'saved' : 'saving' }
        else { own.delete(expected + 1); error = cause; if (!conflict) state = 'unsaved' }
      }
    })()
    inFlight = operation
    await operation
    inFlight = null
    // Retain only the pending/latest acknowledgments, never a typing session's worth of whole bodies.
    for (const key of own.keys()) if (key < revision - 1) own.delete(key)
    publish()
    if (!conflict && !error && body !== saved) schedule()
  }
  function edit(next: string) {
    if (conflict || next === body) return
    body = next
    edited = true
    state = body === saved ? 'saved' : 'saving'
    if (body === saved) pendingSince = null
    error = null
    publish()
    schedule()
  }
  async function accept(next: string, edits: TextEditRef[]) {
    if (conflict || inFlight || pendingReview) return false
    pendingReview = { requestId: `writing-review-${crypto.randomUUID()}`, edits }
    edit(next)
    publish()
    return flush()
  }
  function loadTheirs() {
    if (inFlight) return
    cancel()
    pendingReview = undefined
    body = saved = latest.body
    revision = latest.revision
    conflict = false
    edited = false
    error = null
    state = 'saved'
    pendingSince = null
    generation++
    own.clear()
    publish()
  }
  async function flush() {
    cancel()
    // Closing must drain edits made during a pending save before the editor can unmount.
    while (!conflict) {
      if (inFlight) await inFlight
      if (body === saved && !pendingReview) break
      await commit()
      if (error) throw error
    }
    if (error) throw error
    return !conflict
  }
  function updateHost(next: WritingHost) {
    host = next
    const incoming = committed(host)
    if (incoming.revision === latest.revision && incoming.body === latest.body) return
    latest = incoming
    if (incoming.revision < revision) return
    if (own.get(incoming.revision) === incoming.body) { revision = incoming.revision; return }
    if (!edited && !inFlight) { body = saved = incoming.body; revision = incoming.revision; generation++; publish() }
    else markConflict()
  }
  publish()
  return {
    getSnapshot: () => value,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    updateHost,
    activate() { active = true; schedule() },
    dispose() { active = false; cancel() },
  }
}

export function useWritingDraft(host: WritingHost) {
  const ref = useRef<ReturnType<typeof createWritingDraft> | null>(null)
  if (!ref.current) ref.current = createWritingDraft(host)
  const controller = ref.current
  useEffect(() => { controller.updateHost(host) }, [controller, host])
  useEffect(() => { controller.activate(); return () => controller.dispose() }, [controller])
  return useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
}

/** Imported text must start and end on its own lines, or a Markdown heading stops being a heading. */
export function blockInsert(before: string, after: string, body: string) {
  const lead = !before ? '' : before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n'
  const trail = !after ? '' : after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n'
  return lead + body + trail
}
