import { EMPTY_SCENE, type NodeView, type SceneDoc } from '@vis/protocol'
import { expect, it, vi } from 'vitest'
import { createSceneDraft } from './draft'
import { captureSceneStill } from './output'
import type { SceneEditorHost } from './types'
import { createSceneViewportController, viewportBinding } from './viewport-state'

const initial: SceneDoc = {
  ...EMPTY_SCENE, rev: 60,
  views: [{ id: 'wide', name: 'Wide', aspectRatio: '16:9', still: null, createdBy: 'user', userTouched: false, camera: { position: [3, 2, 5], target: [0, 1, 0], roll: 0, focalLengthMm: 35 } }],
}
const node = (doc: SceneDoc, revision: number): NodeView => ({
  nodeId: 'scene', kind: 'scene', x: 0, y: 0, w: 360, h: 280, z: 1, layoutRevision: 1,
  slots: [{ slotId: 'main', slotKey: 'main', contentType: 'scene', revision, content: { type: 'scene', doc } }],
})
function setup(doc = initial) {
  const host: SceneEditorHost = {
    node: node(doc, 7), nodes: [], assetUrl: id => id,
    upload: vi.fn(async () => 'picture'), importModel: vi.fn(), listModels: vi.fn(),
    commit: vi.fn(async () => 'ok' as const), saveImage: vi.fn(), renderVideo: vi.fn(), sendToPanel: vi.fn(), onClose: vi.fn(),
  }
  const draft = createSceneDraft(host)
  const controller = createSceneViewportController(host)
  const capture = vi.fn(async () => new Blob(['png'], { type: 'image/png' }))
  viewportBinding(controller).connect({ captureView: capture, readCamera: () => initial.views[0]!.camera, frameSelection() {} })
  return { host, draft, controller, capture }
}

it.each(['Close?', 'Wide: hero', '远景'.repeat(100)])('uploads under the view name, shortened when very long: %s', async name => {
  const { host, draft, controller } = setup({ ...initial, views: [{ ...initial.views[0]!, name }] })
  const frame = await captureSceneStill(draft.getSnapshot(), controller, host, 'wide')
  expect(host.upload).toHaveBeenCalledExactlyOnceWith(expect.any(Blob), `${name.slice(0, 120)}.png`)
  expect(frame!.name).toBe(name)
  draft.dispose()
})

it('flushes edits and the still before reading the committed slot revision from a fresh snapshot', async () => {
  const { host, draft, controller, capture } = setup()
  const order: string[] = []
  host.commit = vi.fn(async (doc: SceneDoc, revision: number) => { order.push(`commit:${revision}`); draft.updateHost({ ...host, node: node(doc, revision + 1) }); return 'ok' as const })
  host.upload = vi.fn(async () => { order.push('upload'); return 'picture' })
  draft.updateHost(host)
  const snapshot = draft.getSnapshot()
  snapshot.edit({ ...snapshot.doc, views: [{ ...initial.views[0]!, name: 'Edited wide' }] })
  const frame = await captureSceneStill(snapshot, controller, host, 'wide')
  expect(order).toEqual(['commit:7', 'upload', 'commit:8'])
  expect(capture).toHaveBeenCalledExactlyOnceWith('wide')
  expect(frame).toEqual({ viewId: 'wide', assetVersionId: 'picture', sceneRev: 9, name: 'Edited wide' })
  expect(draft.getSnapshot()).toMatchObject({ baseRevision: 9, saveState: 'saved', doc: { rev: 62, views: [{ still: 'picture' }] } })
  expect(snapshot.baseRevision).toBe(7)
  draft.dispose()
})

it('stops before capturing a conflicted draft and preserves the panel until an explicit send', async () => {
  const { host, draft, controller, capture } = setup()
  draft.getSnapshot().beginEdit()
  draft.updateHost({ ...host, node: node({ ...initial, rev: 61 }, 8) })
  expect(await captureSceneStill(draft.getSnapshot(), controller, host, 'wide')).toBeNull()
  expect(capture).not.toHaveBeenCalled()
  expect(host.upload).not.toHaveBeenCalled()
  expect(host.sendToPanel).not.toHaveBeenCalled()
  draft.dispose()
})

it('does not send or write a still when another writer changes the document during upload', async () => {
  const { host, draft, controller } = setup()
  host.upload = vi.fn(async () => {
    draft.updateHost({ ...host, node: node({ ...initial, rev: 61 }, 8) })
    return 'picture'
  })
  expect(await captureSceneStill(draft.getSnapshot(), controller, host, 'wide')).toBeNull()
  expect(host.commit).not.toHaveBeenCalled()
  expect(host.sendToPanel).not.toHaveBeenCalled()
  expect(draft.getSnapshot().doc.views[0]!.still).toBeNull()
  draft.dispose()
})

it('propagates a failed still commit without creating an image or changing a panel', async () => {
  const { host, draft, controller } = setup()
  host.commit = vi.fn(async () => { throw new Error('Disconnected') })
  draft.updateHost(host)
  await expect(captureSceneStill(draft.getSnapshot(), controller, host, 'wide')).rejects.toThrow('Disconnected')
  expect(host.saveImage).not.toHaveBeenCalled()
  expect(host.sendToPanel).not.toHaveBeenCalled()
  expect(draft.getSnapshot().saveState).toBe('unsaved')
  draft.dispose()
})
