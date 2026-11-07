import { afterEach, expect, it, vi } from 'vitest'
import { EMPTY_PREVIZ, emptyPrevizPanel, type NodeView, type PrevizDoc } from '@vis/protocol'
import { createPrevizDraft } from './draft'
import type { PrevizDraftHost } from './types'

const initial: PrevizDoc = { ...EMPTY_PREVIZ, panels: [emptyPrevizPanel('one')] }
const node = (doc = initial, revision = 1): NodeView => ({ nodeId: 'previz', kind: 'previz', x: 0, y: 0, w: 360, h: 280, z: 1, layoutRevision: 1, slots: [{ slotId: 'main', slotKey: 'main', contentType: 'previz', revision, content: { type: 'previz', doc } }] })
const makeHost = (): PrevizDraftHost => ({ node: node(), nodes: [], assetUrl: id => id, upload: async () => 'uploaded', prepare: async doc => doc, commit: async () => 'ok', onClose() {} })
const note = (doc: PrevizDoc, value: string) => ({ ...doc, panels: doc.panels.map(panel => ({ ...panel, note: value })) })
afterEach(() => vi.useRealTimers())

it('normalizes uploaded pictures, preserves edits during a save and recognizes its own event before the reply', async () => {
  const host = makeHost()
  let release!: () => void
  const waiting = new Promise<void>(resolve => { release = resolve })
  host.prepare = async doc => { await waiting; return { ...doc, panels: doc.panels.map(panel => ({ ...panel, image: panel.image === 'local' ? 'uploaded' : panel.image })) } }
  const sent: PrevizDoc[] = []
  const controller = createPrevizDraft(host)
  host.commit = async (doc, revision) => {
    sent.push(doc)
    controller.updateHost({ ...host, node: node(doc, revision + 1) })
    return 'ok'
  }
  controller.getSnapshot().edit({ ...initial, panels: [{ ...initial.panels[0]!, image: 'local' }] }, true)
  controller.getSnapshot().edit(note(controller.getSnapshot().doc, 'Later note'))
  release()
  await controller.getSnapshot().flush()
  expect(sent).toHaveLength(2)
  expect(sent[0]!.panels[0]!.image).toBe('uploaded')
  expect(controller.getSnapshot()).toMatchObject({ saveState: 'saved', conflict: null, doc: { panels: [{ note: 'Later note', image: 'uploaded' }] } })
})

it('retains the local version, stops writes and clears undo only when loading a remote version', async () => {
  vi.useFakeTimers()
  const host = makeHost()
  host.commit = vi.fn(async () => 'ok' as const)
  const controller = createPrevizDraft(host)
  controller.getSnapshot().edit(note(initial, 'Mine'))
  const theirs = note(initial, 'Theirs')
  controller.updateHost({ ...host, node: node(theirs, 2) })
  await vi.advanceTimersByTimeAsync(1000)
  expect(await controller.getSnapshot().flush()).toBe(false)
  expect(host.commit).not.toHaveBeenCalled()
  expect(controller.getSnapshot()).toMatchObject({ saveState: 'conflict', doc: { panels: [{ note: 'Mine' }] }, conflict: { theirs } })
  controller.getSnapshot().loadTheirs()
  expect(controller.getSnapshot()).toMatchObject({ saveState: 'saved', canUndo: false, doc: theirs })
})

it('retries a failed upload without marking the local document saved', async () => {
  const host = makeHost()
  let failing = true
  host.prepare = async doc => { if (failing) throw new Error('Disconnected'); return doc }
  const controller = createPrevizDraft(host)
  controller.getSnapshot().edit(note(initial, 'Retry me'))
  await expect(controller.getSnapshot().flush()).rejects.toThrow('Disconnected')
  expect(controller.getSnapshot().saveState).toBe('unsaved')
  failing = false
  await controller.getSnapshot().flush()
  expect(controller.getSnapshot().saveState).toBe('saved')
  controller.getSnapshot().undo()
  await controller.getSnapshot().flush()
  expect(controller.getSnapshot().doc.panels[0]!.note).toBe('')
})

it('treats a remote edit arriving while a drawing or import is pending as a conflict', () => {
  const host = makeHost()
  const controller = createPrevizDraft(host)
  controller.getSnapshot().beginEdit()
  controller.updateHost({ ...host, node: node(note(initial, 'Agent note'), 2) })
  expect(controller.getSnapshot().saveState).toBe('conflict')
})
