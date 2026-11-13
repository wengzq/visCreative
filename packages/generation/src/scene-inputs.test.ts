import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createAssetStore, type AssetStore } from '@vis/assets'
import type { CanvasDeliveryPort } from '@vis/domain'
import { SceneDoc } from '@vis/protocol'
import { eq, openSpaceDb, spaceSchema as s, type SpaceDb, type SpaceTx } from '@vis/storage'
import { createMockProvider } from './providers/mock'
import { createRenderProvider } from './providers/render'
import type { ProviderRequest } from './providers/types'
import { createGenerationService, type GenerationService } from './service'

const caller = { sessionId: null, turnId: null, inputSnapshotId: null }
const now = () => 1_800_000_000_000
const doc = () => SceneDoc.parse({
  version: 1, rev: 0, durationS: 1,
  objects: ['second', 'first', 'second', 'missing'].map((id, index) => ({
    id: `object-${index}`, name: id, hidden: false, createdBy: 'user', userTouched: false,
    transform: { position: [index, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
    source: { type: 'model', assetVersionId: id },
  })),
  views: [{ id: 'wide', name: 'Wide', aspectRatio: '16:9', still: null, camera: { position: [0, 1, 5], target: [0, 1, 0], roll: 0, focalLengthMm: 35 } }],
})
let dir: string
let db: SpaceDb
let assets: AssetStore
let service: GenerationService
let submits: ProviderRequest[]
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vis-scene-inputs-'))
  db = openSpaceDb(':memory:')
  assets = createAssetStore({ blobsDir: join(dir, 'blobs'), now })
  submits = []
  const mock = createMockProvider({ clock: now, latencyMs: 1000 })
  const render = createRenderProvider({ workDir: join(dir, 'render'), chromePath: join(dir, 'missing-chrome') })
  service = createGenerationService({
    db, assets, now, defaults: {},
    providers: [{
      ...render, getTask: mock.getTask, cancel: mock.cancel!, download: mock.download, findTaskByIdempotencyKey: mock.findTaskByIdempotencyKey!,
      submit: (request, options) => {
        submits.push(request)
        return mock.submit({ ...request, model: request.kind === 'image' ? 'mock-image-1' : 'mock-video-1' }, options)
      },
    }],
    delivery: { deliverOutput: () => { throw new Error('No output is due in snapshot tests') } } satisfies CanvasDeliveryPort<SpaceTx>,
  })
  db.insert(s.operations).values({ id: 'scene-op', actorKind: 'user', createdAt: now() }).run()
  db.insert(s.nodes).values({ id: 'scene-node', kind: 'scene', x: 0, y: 0, w: 100, h: 100, z: 0, createdAt: now() }).run()
  db.insert(s.slots).values({ id: 'scene-slot', nodeId: 'scene-node', slotKey: 'main', contentType: 'scene', currentRevision: 1 }).run()
  db.insert(s.slotRevisions).values({ slotId: 'scene-slot', revision: 1, sceneDoc: doc(), operationId: 'scene-op', createdAt: now() }).run()
})
afterEach(async () => {
  await service.stop()
  rmSync(dir, { recursive: true, force: true })
})

it('pins the submitted scene and retains model inputs in document order through regeneration', async () => {
  for (const id of ['first', 'second']) {
    const staged = await assets.stageBytes(Buffer.from(`model-${id}`))
    db.insert(s.blobs).values({ hash: staged.hash, byteSize: staged.byteSize, createdAt: now() }).run()
    db.insert(s.assets).values({ id: `asset-${id}`, kind: 'model', origin: 'import', createdAt: now() }).run()
    db.insert(s.assetVersions).values({ id, assetId: `asset-${id}`, version: 1, blobHash: staged.hash, mime: 'model/gltf-binary', createdAt: now() }).run()
  }
  const submitted = service.submit(caller, { requestId: 'scene-submit', provider: 'render', model: 'scene', kind: 'video', prompt: '', params: { viewId: 'wide' }, inputs: [{ slotId: 'scene-slot', revision: 1 }] })
  expect(db.select().from(s.jobInputs).where(eq(s.jobInputs.jobId, submitted.jobId)).orderBy(s.jobInputs.ordinal).all()).toMatchObject([
    { slotId: 'scene-slot', slotRevision: 1, assetVersionId: null },
    { slotId: null, assetVersionId: 'second' },
    { slotId: null, assetVersionId: 'first' },
  ])
  const changed = { ...doc(), rev: 1, durationS: 2, objects: [] }
  db.insert(s.slotRevisions).values({ slotId: 'scene-slot', revision: 2, sceneDoc: changed, operationId: 'scene-op', createdAt: now() }).run()
  db.update(s.slots).set({ currentRevision: 2 }).where(eq(s.slots.id, 'scene-slot')).run()
  await service.pump()
  expect(submits).toHaveLength(1)
  expect(submits[0]).toMatchObject({ params: { fps: 24 }, inputs: [{ type: 'scene', doc: doc(), models: [{ assetVersionId: 'second' }, { assetVersionId: 'first' }] }] })
  expect(submits[0]!.inputs).toHaveLength(1)
  await service.cancel(caller, { requestId: 'scene-cancel', jobId: submitted.jobId })
  const regenerated = service.regenerate(caller, { requestId: 'scene-regenerate', jobId: submitted.jobId })
  await service.pump()
  expect(submits[1]!.inputs).toEqual(submits[0]!.inputs)
  expect(db.select().from(s.jobInputs).where(eq(s.jobInputs.jobId, regenerated.jobId)).all()).toHaveLength(3)
})

it.each([
  { params: { viewId: 'absent' }, reason: 'generation.render_scene_view_missing' },
  { params: { viewId: 'wide', fps: 61 }, reason: 'generation.invalid_params' },
])('rejects invalid scene submission with $reason and rolls back provenance', ({ params, reason }) => {
  expect(() => service.submit(caller, { requestId: 'invalid', provider: 'render', model: 'scene', kind: 'video', prompt: '', params, inputs: [{ slotId: 'scene-slot' }] })).toThrow(expect.objectContaining({ details: expect.objectContaining({ reason }) }))
  expect(db.select().from(s.generationJobs).all()).toHaveLength(0)
  expect(db.select().from(s.jobInputs).all()).toHaveLength(0)
})

it('refuses static videos during submission while allowing a static image', () => {
  const staticScene = doc()
  delete staticScene.durationS
  db.update(s.slotRevisions).set({ sceneDoc: staticScene }).where(eq(s.slotRevisions.slotId, 'scene-slot')).run()
  const base = { provider: 'render', model: 'scene', prompt: '', params: { viewId: 'wide' }, inputs: [{ slotId: 'scene-slot' }] }
  expect(() => service.submit(caller, { ...base, requestId: 'static-video', kind: 'video' })).toThrow(expect.objectContaining({ details: { reason: 'generation.render_scene_motion_required', params: {} } }))
  expect(service.submit(caller, { ...base, requestId: 'static-image', kind: 'image' })).toMatchObject({ status: 'queued' })
})
