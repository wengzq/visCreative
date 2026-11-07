import { useEffect, useRef, useSyncExternalStore } from 'react'
import { TimelineDoc } from '@vis/protocol'
import type { TimelineDraft, TimelineEditorHost } from './types'
import { sameDocument as equal } from './model/edit'
import { linkCaptions } from './model/linkage'
import { retryableError } from './model/errors'

// Per timeline node and local to this browser, never in the document (RFC 0024 d.4)
const linkageKey = (nodeId: string) => `vis.timeline.captionLinkage.${nodeId}`
function readLinkage(nodeId: string) {
  try { return localStorage.getItem(linkageKey(nodeId)) !== 'off' } catch { return true }
}

function committed(host: TimelineEditorHost) {
  const slot = host.node.slots.find(slot => slot.slotKey === 'main')
  return { doc: slot?.content.type === 'timeline' ? slot.content.doc : { version: 1 as const, tracks: [] }, revision: slot?.revision ?? 0 }
}

/** Kept independent of React so save races can be exercised with controlled promises and timers. */
export function createTimelineDraft(initialHost: TimelineEditorHost) {
  let host = initialHost
  let latest = committed(host)
  let doc = latest.doc
  let saved = doc
  let baseRevision = latest.revision
  let saveState: TimelineDraft['saveState'] = 'saved'
  let saveError: unknown = null
  let conflict: TimelineDraft['conflict'] = null
  let edited = false
  let undo: TimelineDoc[] = []
  let redo: TimelineDoc[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  let retry = 0
  let inFlight: Promise<void> | null = null
  let sending: TimelineDoc | null = null
  let pendingImmediate = false
  let captionLinkage = readLinkage(host.node.nodeId)
  let active = true
  const own = new Map<number, TimelineDoc>()
  const listeners = new Set<() => void>()
  let snapshot: TimelineDraft

  const cancelTimer = () => { clearTimeout(timer); timer = undefined }
  const publish = () => {
    snapshot = { doc, baseRevision, saveState, saveError, conflict, edit, undo: undoEdit, redo: redoEdit, canUndo: undo.length > 0, canRedo: redo.length > 0, loadTheirs, flush, captionLinkage, setCaptionLinkage }
    if (active) listeners.forEach(listener => listener())
  }
  const schedule = (delay: number) => {
    cancelTimer()
    if (active) timer = setTimeout(() => { timer = undefined; void commit() }, delay)
  }
  const markConflict = () => {
    cancelTimer()
    conflict = { theirs: latest.doc, revision: latest.revision }
    saveState = 'conflict'
    saveError = null
    publish()
  }

  async function commit(): Promise<void> {
    if (conflict) return
    if (inFlight) { pendingImmediate = true; return inFlight }
    if (equal(doc, saved)) {
      cancelTimer()
      if (saveState !== 'saved' || saveError) { saveState = 'saved'; saveError = null; publish() }
      return
    }
    pendingImmediate = false
    cancelTimer()
    const payload = doc
    const revision = baseRevision
    const previousSaved = saved
    sending = payload
    saveState = 'saving'
    saveError = null
    publish()
    // This marker also recognizes an own canvas event arriving before the RPC response.
    own.set(revision + 1, payload)
    const operation = (async () => {
      try {
        const result = await host.commit(payload, revision)
        if (result === 'conflict') {
          own.delete(revision + 1)
          markConflict()
          return
        }
        saved = payload
        baseRevision = Math.max(baseRevision, revision + 1)
        retry = 0
        if (!conflict) saveState = equal(doc, saved) ? 'saved' : 'saving'
      } catch (error) {
        // An event confirming the write wins over a lost response.
        if (latest.revision === revision + 1 && equal(latest.doc, payload) && !equal(previousSaved, payload)) {
          saved = payload
          baseRevision = latest.revision
          saveState = equal(doc, saved) ? 'saved' : 'saving'
        } else {
          own.delete(revision + 1)
          saveError = error
          if (!conflict) {
            saveState = 'unsaved'
            if (retryableError(error)) schedule(Math.min(30_000, 1000 * 2 ** retry++))
          }
        }
      }
    })()
    inFlight = operation
    await operation
    inFlight = null
    sending = null
    publish()
    if (!conflict && !saveError && !equal(doc, saved)) {
      const immediate = pendingImmediate
      pendingImmediate = false
      if (immediate || timer === undefined) await commit()
    }
  }

  function edit(next: TimelineDoc, opts?: { immediate?: boolean }): 'captions' | undefined {
    if (conflict) return
    const linked = captionLinkage ? linkCaptions(doc, next) : { ok: true as const, doc: next }
    if (!linked.ok) return linked.reason
    const parsed = TimelineDoc.safeParse(linked.doc)
    if (!parsed.success || equal(doc, parsed.data)) return
    undo.push(doc)
    redo = []
    doc = parsed.data
    edited = true
    if (saveState !== 'unsaved') saveState = 'saving'
    publish()
    if (opts?.immediate) { cancelTimer(); pendingImmediate = true; void commit() }
    else schedule(500)
  }

  function setCaptionLinkage(on: boolean) {
    captionLinkage = on
    try { localStorage.setItem(linkageKey(host.node.nodeId), on ? 'on' : 'off') } catch {}
    publish()
  }

  function undoEdit() {
    if (conflict || !undo.length) return
    redo.push(doc)
    doc = undo.pop()!
    edited = true
    saveState = equal(doc, saved) && !inFlight ? 'saved' : 'saving'
    publish()
    pendingImmediate = true
    void commit()
  }
  function redoEdit() {
    if (conflict || !redo.length) return
    undo.push(doc)
    doc = redo.pop()!
    edited = true
    saveState = 'saving'
    publish()
    pendingImmediate = true
    void commit()
  }
  function loadTheirs() {
    if (inFlight) return
    if (conflict && latest.revision <= baseRevision) return
    cancelTimer()
    doc = saved = latest.doc
    baseRevision = latest.revision
    undo = []
    redo = []
    own.clear()
    edited = false
    conflict = null
    saveError = null
    retry = 0
    saveState = 'saved'
    publish()
  }
  async function flush() {
    cancelTimer()
    pendingImmediate = true
    if (inFlight) await inFlight
    if (!conflict) await commit()
    if (saveError) throw saveError
  }

  function updateHost(next: TimelineEditorHost) {
    host = next
    const incoming = committed(next)
    if (incoming.revision === latest.revision && equal(incoming.doc, latest.doc)) return
    latest = incoming
    if (incoming.revision < baseRevision) return
    const ownDoc = own.get(incoming.revision)
    if ((ownDoc && equal(ownDoc, incoming.doc)) || (sending && incoming.revision === baseRevision + 1 && equal(sending, incoming.doc))) {
      baseRevision = incoming.revision
      return
    }
    if (!edited && !inFlight) {
      doc = saved = incoming.doc
      baseRevision = incoming.revision
      saveState = 'saved'
      publish()
    } else markConflict()
  }
  publish()
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    updateHost,
    activate() { active = true; if (!conflict && !equal(doc, saved)) schedule(500) },
    dispose() { active = false; cancelTimer() },
  }
}

export function useTimelineDraft(host: TimelineEditorHost): TimelineDraft {
  const ref = useRef<ReturnType<typeof createTimelineDraft> | null>(null)
  if (!ref.current) ref.current = createTimelineDraft(host)
  const controller = ref.current
  useEffect(() => { controller.updateHost(host) }, [controller, host])
  useEffect(() => { controller.activate(); return () => controller.dispose() }, [controller])
  return useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
}
