import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createAssetStore, type AssetStore } from '@vis/assets'
import { EMPTY_SCENE, SCENE_LIMITS, type CanvasOp, type SceneDoc, type SceneObject, type SceneView } from '@vis/protocol'
import { openSpaceDb, type SpaceDb } from '@vis/storage'
import { validateScene } from './scene'
import { createCanvasService, type CanvasService } from './service'
import { mediaVersionKind } from './write'

let db: SpaceDb
let canvas: CanvasService
let assets: AssetStore
let dir: string
const apply = (ops: CanvasOp[]) => canvas.apply({ kind: 'user' }, { requestId: crypto.randomUUID(), ops })
const main = (id: string) => canvas.get({ nodeIds: [id] }).nodes[0]!.slots[0]!
const object = (assetVersionId: string): SceneObject => ({
  id: 'model', name: 'Imported model', hidden: true, createdBy: 'user', userTouched: true,
  transform: { position: [1, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
  source: { type: 'model', assetVersionId },
})
const view = (still: string | null): SceneView => ({
  id: 'wide', name: 'Wide', camera: { position: [0, 2, 5], target: [0, 1, 0], roll: 0, focalLengthMm: 35 }, aspectRatio: '16:9', still,
})
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vis-scene-validation-'))
  db = openSpaceDb(':memory:')
  canvas = createCanvasService({ db })
  assets = createAssetStore({ blobsDir: join(dir, 'blobs') })
})
afterEach(() => { db.$client.close(); rmSync(dir, { recursive: true, force: true }) })

it('creates independent scenes and versions, rejects stale writes, and restores scene documents through undo and redo', () => {
  const nodeId = apply([{ op: 'node.create', kind: 'scene', tempId: 'scene' }]).idMap.scene!
  const slotId = main(nodeId).slotId
  expect(main(nodeId)).toMatchObject({ revision: 1, content: { type: 'scene', doc: EMPTY_SCENE } })
  const doc: SceneDoc = { ...EMPTY_SCENE, rev: 1, views: [view(null)] }
  const op: CanvasOp = { op: 'scene.set', slotId, expectedRevision: 1, doc }
  apply([op])
  expect(main(nodeId).content).toEqual({ type: 'scene', doc })
  expect(() => apply([op])).toThrow(expect.objectContaining({ code: 'revision_conflict' }))
  canvas.undo({ requestId: crypto.randomUUID() })
  expect(main(nodeId).content).toEqual({ type: 'scene', doc: EMPTY_SCENE })
  canvas.redo({ requestId: crypto.randomUUID() })
  expect(main(nodeId).content).toEqual({ type: 'scene', doc })
  expect(canvas.history({ slotId, limit: 50 }).versions).toHaveLength(4)
})

it('accepts project model and image versions, including hidden model objects', async () => {
  const staged = await assets.stageBytes(Buffer.from('scene assets'))
  const model = assets.registerVersion(db, { staged, kind: 'model', mime: 'model/gltf-binary', origin: 'import' })
  const image = assets.registerVersion(db, { staged, kind: 'image', mime: 'image/png', origin: 'import' })
  const doc: SceneDoc = { ...EMPTY_SCENE, objects: [object(model.assetVersionId)], views: [view(image.assetVersionId)] }
  expect(validateScene(db, doc)).toEqual(doc)
  const nodeId = apply([
    { op: 'node.create', kind: 'scene', tempId: 'scene' },
    { op: 'scene.set', slotId: 'scene:main', expectedRevision: 1, doc },
  ]).idMap.scene!
  expect(main(nodeId).content).toEqual({ type: 'scene', doc })
})

it('refuses missing and non-model object assets and non-image stills', async () => {
  const staged = await assets.stageBytes(Buffer.from('scene assets'))
  const versions = new Map<string, string>()
  for (const kind of ['image', 'video', 'audio', 'font', 'model'] as const) {
    versions.set(kind, assets.registerVersion(db, { staged, kind, mime: 'application/octet-stream', origin: 'import' }).assetVersionId)
  }
  for (const kind of ['image', 'video', 'audio', 'font']) {
    expect(() => validateScene(db, { ...EMPTY_SCENE, objects: [object(versions.get(kind)!)] })).toThrow(expect.objectContaining({ code: 'invalid_params', details: expect.objectContaining({ reason: 'scene.model_required' }) }))
  }
  for (const kind of ['video', 'audio', 'font', 'model']) {
    expect(() => validateScene(db, { ...EMPTY_SCENE, views: [view(versions.get(kind)!)] })).toThrow(expect.objectContaining({ code: 'invalid_params', details: expect.objectContaining({ reason: 'scene.image_required' }) }))
  }
  for (const doc of [
    { ...EMPTY_SCENE, objects: [object('another-project-model')] },
    { ...EMPTY_SCENE, views: [view('another-project-image')] },
  ]) expect(() => validateScene(db, doc)).toThrow(expect.objectContaining({ code: 'not_found' }))
})

it('validates scene structure and limits and refuses generic slot writes', () => {
  expect(validateScene(db, EMPTY_SCENE)).toEqual(EMPTY_SCENE)
  for (const doc of [
    { ...EMPTY_SCENE, version: 2 }, { ...EMPTY_SCENE, views: Array.from({ length: SCENE_LIMITS.views + 1 }, (_, i) => ({ ...view(null), id: `view-${i}` })) },
    { ...EMPTY_SCENE, views: [view(null), view(null)] }, { ...EMPTY_SCENE, views: [{ ...view(null), camera: { ...view(null).camera, focalLengthMm: 301 } }] },
  ]) expect(() => validateScene(db, doc as SceneDoc)).toThrow(expect.objectContaining({ code: 'invalid_params', details: expect.objectContaining({ reason: 'scene.invalid_document' }) }))
  const nodeId = apply([{ op: 'node.create', kind: 'scene', tempId: 'scene' }]).idMap.scene!
  const slotId = main(nodeId).slotId
  for (const op of [
    { op: 'slot.clear', slotId, expectedRevision: 1 },
    { op: 'slot.setText', slotId, expectedRevision: 1, body: 'Cannot replace a scene' },
  ] as const) expect(() => apply([op])).toThrow(expect.objectContaining({ code: 'invalid_params' }))
  const imageId = apply([{ op: 'node.create', kind: 'image', tempId: 'image' }]).idMap.image!
  expect(() => apply([{ op: 'scene.set', slotId: main(imageId).slotId, expectedRevision: 0, doc: EMPTY_SCENE }])).toThrow(expect.objectContaining({ code: 'invalid_params', details: expect.objectContaining({ reason: 'scene.slot_required' }) }))
})

it('keeps referenced model versions registered and outside orphan cleanup after new versions and scene deletion', async () => {
  const old = assets.registerVersion(db, { staged: await assets.stageBytes(Buffer.from('old model')), kind: 'model', mime: 'model/gltf-binary', origin: 'import' })
  const latest = assets.registerVersion(db, { staged: await assets.stageBytes(Buffer.from('new model')), assetId: old.assetId, kind: 'model', mime: 'model/gltf-binary', origin: 'import' })
  const nodeId = apply([
    { op: 'node.create', kind: 'scene', tempId: 'scene' },
    { op: 'scene.set', slotId: 'scene:main', expectedRevision: 1, doc: { ...EMPTY_SCENE, objects: [object(old.assetVersionId)] } },
  ]).idMap.scene!
  expect(await assets.findOrphanBlobs(db)).toEqual([])
  apply([{ op: 'node.delete', nodeId }])
  expect(await assets.findOrphanBlobs(db)).toEqual([])
  expect(assets.getVersion(db, old.assetVersionId)).toMatchObject({ kind: 'model', version: 1 })
  expect(assets.getVersion(db, latest.assetVersionId)).toMatchObject({ kind: 'model', version: 2 })
  canvas.undo({ requestId: crypto.randomUUID() })
  expect(main(nodeId).content).toMatchObject({ type: 'scene', doc: { objects: [object(old.assetVersionId)] } })
})

it('never accepts models as media node content', async () => {
  const model = assets.registerVersion(db, { staged: await assets.stageBytes(Buffer.from('model')), kind: 'model', mime: 'model/gltf-binary', origin: 'import' })
  expect(() => mediaVersionKind(db, model.assetVersionId)).toThrow(expect.objectContaining({ code: 'invalid_params', details: expect.objectContaining({ reason: 'media.kind_mismatch' }) }))
  for (const kind of ['image', 'video', 'audio'] as const) {
    expect(() => apply([{ op: 'node.create', kind, tempId: kind, content: { assetVersionId: model.assetVersionId } }])).toThrow(expect.objectContaining({ code: 'invalid_params' }))
    const nodeId = apply([{ op: 'node.create', kind, tempId: kind }]).idMap[kind]!
    expect(() => apply([{ op: 'slot.setAsset', slotId: main(nodeId).slotId, expectedRevision: 0, assetVersionId: model.assetVersionId }])).toThrow(expect.objectContaining({ code: 'invalid_params' }))
  }
})
