import { useEffect, useRef, useSyncExternalStore } from 'react'
import { EMPTY_PREVIZ, PrevizDoc } from '@vis/protocol'
import { mapPictures, pictureKeys } from './assets'
import type { PrevizDraft, PrevizDraftHost } from './types'

const equal = (a: PrevizDoc, b: PrevizDoc) => JSON.stringify(a) === JSON.stringify(b)
const committed = (host: PrevizDraftHost) => {
  const slot = host.node.slots.find(slot => slot.slotKey === 'main')
  return { doc: slot?.content.type === 'previz' ? slot.content.doc : EMPTY_PREVIZ, revision: slot?.revision ?? 0 }
}

export function createPrevizDraft(initialHost: PrevizDraftHost) {
  let host = initialHost
  let latest = committed(host)
  let doc = latest.doc
  let saved = doc
  let baseRevision = latest.revision
  let saveState: PrevizDraft['saveState'] = 'saved'
  let saveError: unknown = null
  let conflict: PrevizDraft['conflict'] = null
  let edited = false
  let undo: PrevizDoc[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  let inFlight: Promise<void> | null = null
  let active = true
  const own = new Map<number, PrevizDoc>()
  const listeners = new Set<() => void>()
  let snapshot: PrevizDraft
  const cancelTimer = () => { clearTimeout(timer); timer = undefined }
  const publish = () => {
    snapshot = { doc, baseRevision, saveState, saveError, conflict, edit, beginEdit: () => { edited = true }, undo: undoEdit, canUndo: undo.length > 0, loadTheirs, flush }
    if (active) listeners.forEach(listener => listener())
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
    if (inFlight) return inFlight
    cancelTimer()
    if (equal(doc, saved)) { saveState = 'saved'; publish(); return }
    const original = doc
    const revision = baseRevision
    saveState = 'saving'
    saveError = null
    publish()
    const operation = (async () => {
      let payload = original
      try {
        payload = await host.prepare(original)
        if (conflict) return
        // Normalize local blob handles without losing edits made while uploads were pending.
        const replacements = new Map<string, string>()
        original.panels.forEach((panel, i) => pictureKeys.forEach(key => {
          const resolved = payload.panels[i]?.[key]
          if (panel[key] && resolved) replacements.set(panel[key], resolved)
        }))
        doc = mapPictures(doc, id => replacements.get(id) ?? id)
        undo = undo.map(item => mapPictures(item, id => replacements.get(id) ?? id))
        own.set(revision + 1, payload)
        const result = await host.commit(payload, revision)
        if (result === 'conflict') { own.delete(revision + 1); markConflict(); return }
        saved = payload
        baseRevision = Math.max(baseRevision, revision + 1)
        if (!conflict) saveState = equal(doc, saved) ? 'saved' : 'saving'
      } catch (error) {
        if (latest.revision === revision + 1 && equal(latest.doc, payload)) {
          saved = payload
          baseRevision = latest.revision
          if (!conflict) saveState = equal(doc, saved) ? 'saved' : 'saving'
        } else {
          own.delete(revision + 1)
          saveError = error
          if (!conflict) saveState = 'unsaved'
        }
      }
    })()
    inFlight = operation
    await operation
    inFlight = null
    publish()
    if (!conflict && !saveError && !equal(doc, saved)) await commit()
  }
  function edit(next: PrevizDoc, immediate = false) {
    if (conflict || equal(doc, next)) return
    const parsed = PrevizDoc.safeParse({ ...next, rev: doc.rev + 1 })
    if (!parsed.success) return
    undo.push(doc)
    doc = parsed.data
    edited = true
    saveState = 'saving'
    publish()
    cancelTimer()
    if (immediate) void commit()
    else if (active) timer = setTimeout(() => void commit(), 500)
  }
  function undoEdit() {
    if (conflict || !undo.length) return
    doc = { ...undo.pop()!, rev: doc.rev + 1 }
    edited = true
    saveState = 'saving'
    publish()
    void commit()
  }
  function loadTheirs() {
    if (inFlight || latest.revision <= baseRevision && conflict) return
    cancelTimer()
    doc = saved = latest.doc
    baseRevision = latest.revision
    undo = []
    own.clear()
    edited = false
    conflict = null
    saveError = null
    saveState = 'saved'
    publish()
  }
  async function flush() {
    cancelTimer()
    if (inFlight) await inFlight
    if (!conflict) await commit()
    if (saveError) throw saveError
    return !conflict && saveState === 'saved'
  }
  function updateHost(next: PrevizDraftHost) {
    host = next
    const incoming = committed(host)
    if (incoming.revision === latest.revision && equal(incoming.doc, latest.doc)) return
    latest = incoming
    if (incoming.revision < baseRevision) return
    const ownDoc = own.get(incoming.revision)
    if (ownDoc && equal(ownDoc, incoming.doc)) { baseRevision = incoming.revision; return }
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
    activate() { active = true },
    dispose() { active = false; cancelTimer() },
  }
}

export function usePrevizDraft(host: PrevizDraftHost) {
  const ref = useRef<ReturnType<typeof createPrevizDraft> | null>(null)
  if (!ref.current) ref.current = createPrevizDraft(host)
  const controller = ref.current
  useEffect(() => { controller.updateHost(host) }, [controller, host])
  useEffect(() => { controller.activate(); return () => controller.dispose() }, [controller])
  return useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
}
