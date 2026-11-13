import { EMPTY_SCENE, SceneDoc } from '@vis/protocol'
import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { SceneDraft, SceneEditorHost } from './types'

export type SceneDraftHost = Pick<SceneEditorHost, 'node' | 'commit'>
const equal = (a: SceneDoc, b: SceneDoc) => JSON.stringify(a) === JSON.stringify(b)
const sameWrite = (a: SceneDoc, b: SceneDoc) => {
  const content = (doc: SceneDoc) => ({
    ...doc,
    objects: doc.objects.map(({ createdBy, userTouched, ...object }) => object),
    views: doc.views.map(({ createdBy, userTouched, ...view }) => view),
  })
  return JSON.stringify(content(a)) === JSON.stringify(content(b))
}
const stamped = (doc: SceneDoc, incoming: SceneDoc): SceneDoc => {
  const objects = new Map(incoming.objects.map(object => [object.id, object]))
  const views = new Map(incoming.views.map(view => [view.id, view]))
  return {
    ...doc,
    objects: doc.objects.map(object => {
      const canonical = objects.get(object.id)
      return canonical ? { ...object, createdBy: canonical.createdBy, userTouched: canonical.userTouched } : object
    }),
    // Step d stamps views the same way, so the echo of our own write must not read as someone else's.
    views: doc.views.map(view => {
      const canonical = views.get(view.id)
      return canonical ? { ...view, createdBy: canonical.createdBy, userTouched: canonical.userTouched } : view
    }),
  }
}
const committed = (host: SceneDraftHost) => {
  const slot = host.node.slots.find(slot => slot.slotKey === 'main')
  return { doc: slot?.content.type === 'scene' ? slot.content.doc : EMPTY_SCENE, revision: slot?.revision ?? 0 }
}

export function createSceneDraft(initialHost: SceneDraftHost) {
  let host = initialHost
  let latest = committed(host)
  let doc = latest.doc
  let saved = doc
  let baseRevision = latest.revision
  let saveState: SceneDraft['saveState'] = 'saved'
  let saveError: unknown = null
  let conflict: SceneDraft['conflict'] = null
  let edited = false
  let undo: SceneDoc[] = []
  // A held key's repeats share a run, and the entry pushed at its start already restores the document before it.
  let run: string | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let inFlight: Promise<void> | null = null
  let active = true
  const own = new Map<number, SceneDoc>()
  const listeners = new Set<() => void>()
  let snapshot: SceneDraft
  const cancelTimer = () => { clearTimeout(timer); timer = undefined }
  const publish = () => {
    snapshot = { doc, baseRevision, getSnapshot: () => snapshot, saveState, saveError, conflict, edit, beginEdit: () => { edited = true }, undo: undoEdit, canUndo: undo.length > 0, loadTheirs, flush, adopt }
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
    const payload = doc
    const revision = baseRevision
    saveState = 'saving'
    saveError = null
    own.set(revision + 1, payload)
    publish()
    const operation = (async () => {
      try {
        const result = await host.commit(payload, revision)
        if (result === 'conflict') { own.delete(revision + 1); markConflict(); return }
        saved = latest.revision === revision + 1 && sameWrite(latest.doc, payload) ? stamped(payload, latest.doc) : payload
        baseRevision = Math.max(baseRevision, revision + 1)
        if (!conflict) saveState = equal(doc, saved) ? 'saved' : 'saving'
      } catch (error) {
        if (latest.revision === revision + 1 && sameWrite(latest.doc, payload)) {
          saved = stamped(payload, latest.doc)
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
    if (active && !conflict && !saveError && !equal(doc, saved)) await commit()
  }
  function edit(next: SceneDoc, immediate = false, nextRun?: string) {
    if (nextRun !== run) run = undefined
    if (conflict || equal(doc, next)) return
    const parsed = SceneDoc.safeParse({ ...next, rev: doc.rev + 1 })
    if (!parsed.success) return
    if (run === undefined) undo.push(doc)
    run = nextRun
    doc = parsed.data
    edited = true
    saveState = 'saving'
    saveError = null
    publish()
    cancelTimer()
    if (immediate) void commit()
    else if (active) timer = setTimeout(() => void commit(), 500)
  }
  function undoEdit() {
    if (conflict || !undo.length) return
    run = undefined
    doc = { ...undo.pop()!, rev: doc.rev + 1 }
    edited = true
    saveState = 'saving'
    saveError = null
    publish()
    void commit()
  }
  function loadTheirs() {
    if (inFlight || latest.revision <= baseRevision && conflict) return
    cancelTimer()
    doc = saved = latest.doc
    baseRevision = latest.revision
    undo = []
    run = undefined
    own.clear()
    edited = false
    conflict = null
    saveError = null
    saveState = 'saved'
    publish()
  }
  // Resolution is an explicit author action. Adopt its saved result only while the flushed draft is still clean.
  function adopt(incoming: SceneDoc, revision: number, expectedRevision: number) {
    if (revision < latest.revision || baseRevision !== expectedRevision || inFlight || !equal(doc, saved)) return
    latest = { doc: incoming, revision }
    loadTheirs()
  }
  async function flush() {
    cancelTimer()
    if (inFlight) await inFlight
    if (!conflict) await commit()
    if (saveError) throw saveError
    return !conflict && saveState === 'saved'
  }
  function updateHost(next: SceneDraftHost) {
    host = next
    const incoming = committed(host)
    if (incoming.revision < latest.revision || incoming.revision === latest.revision && equal(incoming.doc, latest.doc)) return
    latest = incoming
    if (incoming.revision < baseRevision) return
    const ownDoc = own.get(incoming.revision)
    if (ownDoc && sameWrite(ownDoc, incoming.doc)) {
      // The gateway stamps authorship metadata. Its echo is still our write, including during a drag's save.
      doc = stamped(doc, incoming.doc)
      saved = stamped(saved, incoming.doc)
      undo = undo.map(item => stamped(item, incoming.doc))
      baseRevision = incoming.revision
      // Retain newer entries until their events arrive, without growing for the entire editor lifetime.
      for (const revision of own.keys()) if (revision <= incoming.revision) own.delete(revision)
      publish()
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
    activate() {
      active = true
      if (!conflict && !equal(doc, saved)) timer = setTimeout(() => void commit(), 500)
    },
    dispose() { active = false; cancelTimer() },
  }
}

export function useSceneDraft(host: SceneDraftHost): SceneDraft {
  const controller = useMemo(() => createSceneDraft(host), [host.node.nodeId])
  useEffect(() => { controller.updateHost(host) }, [controller, host])
  useEffect(() => { controller.activate(); return () => controller.dispose() }, [controller])
  return useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
}
