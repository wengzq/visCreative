import { afterEach, expect, it, vi } from 'vitest'
import { EMPTY_SCENE, type NodeView, type SceneDoc, type SceneObject } from '@vis/protocol'
import { createSceneDraft, type SceneDraftHost } from './draft'

const figure: SceneObject = {
  id: 'figure', name: 'Figure', transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
  hidden: false, createdBy: 'user', userTouched: true, source: { type: 'figure', bodyId: 'human', heightM: 1.8, pose: {} },
}
const initial: SceneDoc = { ...EMPTY_SCENE, objects: [figure] }
const node = (doc = initial, revision = 1): NodeView => ({
  nodeId: 'scene', kind: 'scene', x: 0, y: 0, w: 360, h: 280, z: 1, layoutRevision: 1,
  slots: [{ slotId: 'main', slotKey: 'main', contentType: 'scene', revision, content: { type: 'scene', doc } }],
})
const makeHost = (): SceneDraftHost => ({ node: node(), commit: async () => 'ok' })
const rename = (doc: SceneDoc, name: string): SceneDoc => ({ ...doc, objects: doc.objects.map(object => ({ ...object, name })) })
afterEach(() => vi.useRealTimers())

it('debounces changes and creates a single revision-checked save for a released transform', async () => {
  vi.useFakeTimers()
  const host = makeHost()
  host.commit = vi.fn(async () => 'ok' as const)
  const controller = createSceneDraft(host)
  controller.getSnapshot().beginEdit()
  await vi.advanceTimersByTimeAsync(1000)
  expect(host.commit).not.toHaveBeenCalled()
  controller.getSnapshot().edit(rename(initial, 'First'))
  await vi.advanceTimersByTimeAsync(300)
  controller.getSnapshot().edit(rename(controller.getSnapshot().doc, 'Second'))
  await vi.advanceTimersByTimeAsync(499)
  expect(host.commit).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(host.commit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ rev: 2, objects: [expect.objectContaining({ name: 'Second' })] }), 1)
  expect(controller.getSnapshot().saveState).toBe('saved')
  controller.dispose()
})

it('preserves edits made during a save and recognizes its own event before the reply', async () => {
  const host = makeHost()
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  const sent: SceneDoc[] = []
  const controller = createSceneDraft(host)
  host.commit = async (doc, revision) => {
    sent.push(doc)
    controller.updateHost({ ...host, node: node(doc, revision + 1) })
    await pending
    return 'ok'
  }
  controller.getSnapshot().edit(rename(initial, 'First'), true)
  controller.getSnapshot().edit(rename(controller.getSnapshot().doc, 'Second'))
  release()
  expect(await controller.getSnapshot().flush()).toBe(true)
  expect(sent).toHaveLength(2)
  expect(sent[0]!.objects[0]!.name).toBe('First')
  expect(controller.getSnapshot()).toMatchObject({ saveState: 'saved', conflict: null, baseRevision: 3, doc: { objects: [{ name: 'Second' }] } })
  controller.dispose()
})

it('recognizes its own write when the gateway stamps object protection metadata', async () => {
  const host = makeHost()
  const untouched = { ...initial, objects: [{ ...figure, userTouched: false, createdBy: 'agent' as const }] }
  host.node = node(untouched)
  const controller = createSceneDraft(host)
  host.commit = async (doc, revision) => {
    controller.updateHost({ ...host, node: node({ ...doc, objects: doc.objects.map(object => ({ ...object, userTouched: true })) }, revision + 1) })
    return 'ok'
  }
  controller.getSnapshot().edit(rename(untouched, 'Moved by author'), true)
  await controller.getSnapshot().flush()
  expect(controller.getSnapshot()).toMatchObject({ saveState: 'saved', conflict: null, doc: { objects: [{ name: 'Moved by author', createdBy: 'agent', userTouched: true }] } })
  controller.dispose()
})

it('retains local edits during a conflict, stops autosave and loads the remote document explicitly', async () => {
  vi.useFakeTimers()
  const host = makeHost()
  host.commit = vi.fn(async () => 'ok' as const)
  const controller = createSceneDraft(host)
  controller.getSnapshot().edit(rename(initial, 'Mine'))
  const theirs = rename(initial, 'Theirs')
  controller.updateHost({ ...host, node: node(theirs, 2) })
  await vi.advanceTimersByTimeAsync(1000)
  expect(await controller.getSnapshot().flush()).toBe(false)
  expect(host.commit).not.toHaveBeenCalled()
  expect(controller.getSnapshot()).toMatchObject({ saveState: 'conflict', doc: { objects: [{ name: 'Mine' }] }, conflict: { theirs } })
  controller.getSnapshot().undo()
  expect(controller.getSnapshot().doc.objects[0]!.name).toBe('Mine')
  controller.getSnapshot().loadTheirs()
  expect(controller.getSnapshot()).toMatchObject({ saveState: 'saved', canUndo: false, conflict: null, doc: theirs })
  controller.dispose()
})

it('retries failed saves and commits undo with a new document revision', async () => {
  const host = makeHost()
  let failing = true
  host.commit = async () => { if (failing) throw new Error('Disconnected'); return 'ok' }
  const controller = createSceneDraft(host)
  controller.getSnapshot().edit(rename(initial, 'Edited'))
  await expect(controller.getSnapshot().flush()).rejects.toThrow('Disconnected')
  expect(controller.getSnapshot().saveState).toBe('unsaved')
  failing = false
  expect(await controller.getSnapshot().flush()).toBe(true)
  controller.getSnapshot().undo()
  await controller.getSnapshot().flush()
  expect(controller.getSnapshot().doc).toEqual({ ...initial, rev: 2 })
  expect(controller.getSnapshot().baseRevision).toBe(3)
  controller.dispose()
})

it('adopts remote changes before local interaction and conflicts during a pending gesture', () => {
  const host = makeHost()
  const controller = createSceneDraft(host)
  controller.updateHost({ ...host, node: node(rename(initial, 'Remote'), 2) })
  expect(controller.getSnapshot().doc.objects[0]!.name).toBe('Remote')
  controller.getSnapshot().beginEdit()
  controller.updateHost({ ...host, node: node(rename(initial, 'Changed again'), 3) })
  expect(controller.getSnapshot().saveState).toBe('conflict')
  controller.dispose()
})

it('recognizes a successful event even if the commit reply is lost and cancels timers on disposal', async () => {
  vi.useFakeTimers()
  const host = makeHost()
  const controller = createSceneDraft(host)
  host.commit = async (doc, revision) => {
    controller.updateHost({ ...host, node: node(doc, revision + 1) })
    throw new Error('Reply lost')
  }
  controller.getSnapshot().edit(rename(initial, 'Saved remotely'))
  expect(await controller.getSnapshot().flush()).toBe(true)
  expect(controller.getSnapshot().saveState).toBe('saved')
  host.commit = vi.fn(async () => 'ok' as const)
  controller.getSnapshot().edit(rename(controller.getSnapshot().doc, 'Pending'))
  controller.dispose()
  await vi.advanceTimersByTimeAsync(1000)
  expect(host.commit).not.toHaveBeenCalled()
})
