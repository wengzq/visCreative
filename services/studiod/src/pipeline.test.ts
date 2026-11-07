// Backend integration tests: real canvas-core, assets and generation assembled with a mock Provider.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAssetStore } from '@vis/assets'
import { createCanvasService, type CanvasService } from '@vis/canvas-core'
import { createGenerationService, createMockProvider, type GenerationService } from '@vis/generation'
import { METHODS } from '@vis/protocol'
import { openSpaceDb, readEventsAfter, type SpaceDb } from '@vis/storage'

const LATENCY = 1500
const user = { kind: 'user' } as const
const agent = { sessionId: null, turnId: null, inputSnapshotId: null }

let dir: string
let clock: number
let db: SpaceDb
let canvas: CanvasService
let generation: GenerationService

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vis-pipeline-'))
  clock = 1_800_000_000_000
  const now = () => clock
  db = openSpaceDb(join(dir, 'space.db'))
  canvas = createCanvasService({ db, now })
  generation = createGenerationService({
    db,
    assets: createAssetStore({ blobsDir: join(dir, 'blobs'), now }),
    delivery: canvas,
    providers: [createMockProvider({ clock: now, latencyMs: LATENCY })],
    defaults: { image: { provider: 'mock' }, video: { provider: 'mock' }, audio: { provider: 'mock' } },
    now,
    pollIntervalMs: 1000,
  })
})
afterEach(() => {
  db.$client.close()
  rmSync(dir, { recursive: true, force: true })
})

async function finish(jobId: string) {
  await generation.pump()
  clock += LATENCY
  await generation.pump()
  return generation.get({ jobId })
}

function createEmptyImageNode(requestId: string) {
  const { idMap } = canvas.apply(user, { requestId, ops: [{ op: 'node.create', tempId: 'n', kind: 'image', x: 0, y: 0, w: 320, h: 320 }] })
  const node = canvas.get({ nodeIds: [idMap.n!] }).nodes[0]!
  return { nodeId: node.nodeId, slotId: node.slots[0]!.slotId }
}

describe('submit -> generate -> persist -> populate canvas', () => {
  it('populates the specified slot and exposes the new asset on the canvas', async () => {
    const target = createEmptyImageNode('req_node')
    const { jobId } = generation.submit(agent, { requestId: 'req_gen', kind: 'image', prompt: '屋顶花园', targets: [{ outputIndex: 0, kind: 'slot', slotId: target.slotId }] })

    const view = await finish(jobId)
    expect(view).toMatchObject({ status: 'succeeded', outputs: [{ delivery: { status: 'delivered', nodeId: target.nodeId, slotId: target.slotId } }] })
    expect(canvas.get({}).nodes[0]!.slots[0]).toMatchObject({ revision: 1, content: { type: 'asset', assetVersionId: view.outputs[0]!.assetVersionId } })

    const events = readEventsAfter(db, 0)
    const types = events.map(e => e.type)
    expect(types).toEqual(expect.arrayContaining(['asset.versionAdded', 'slot.revised', 'binding.stateChanged']))
    expect(types.at(-1)).toBe('job.stateChanged')
    // The UI displays status from event payloads: job events include full views, delivery events include target nodes.
    expect(events.find(e => e.type === 'binding.stateChanged')!.payload).toMatchObject({ jobId, status: 'delivered', nodeId: target.nodeId })
    expect(events.find(e => e.type === 'job.stateChanged')!.payload).toMatchObject({
      status: 'queued', job: { status: 'queued', targets: [{ outputIndex: 0, kind: 'slot', status: 'pending', nodeId: target.nodeId, slotId: target.slotId }] },
    })
    expect(events.at(-1)!.payload).toMatchObject({ status: 'succeeded', job: { status: 'succeeded', targets: [{ status: 'delivered' }] } })
  })

  it('creates a node beside the input node when no target is specified', async () => {
    const source = createEmptyImageNode('req_src')
    const seed = generation.submit(agent, { requestId: 'req_seed', kind: 'image', prompt: '种子图', targets: [{ outputIndex: 0, kind: 'slot', slotId: source.slotId }] })
    await finish(seed.jobId)

    const { jobId } = generation.submit(agent, { requestId: 'req_var', kind: 'image', prompt: '变体', params: { width: 512, height: 256 }, inputs: [{ slotId: source.slotId }] })
    const view = await finish(jobId)
    const created = canvas.get({ nodeIds: [view.outputs[0]!.delivery.nodeId!] }).nodes[0]!
    expect(created).toMatchObject({ kind: 'image', x: 360, y: 0, w: 320, h: 160 })
    expect(created.slots[0]!.source).toEqual({ jobId, inputNodeIds: [source.nodeId] })
    expect(canvas.history({ slotId: created.slots[0]!.slotId, limit: 50 }).versions[0]).toMatchObject({ actor: 'system', source: { jobId, prompt: '变体', inputNodeIds: [source.nodeId] } })
    expect(readEventsAfter(db, 0).find(e => e.type === 'node.created' && e.entityId === created.nodeId)!.payload).toMatchObject({ slots: [{ source: { jobId, inputNodeIds: [source.nodeId] } }] })
    expect(view.targets).toEqual([{ outputIndex: 0, kind: 'new_node', status: 'delivered', nodeId: created.nodeId, nearNodeId: source.nodeId }])
  })

  it('deduplicates populated provenance in input order, excludes self and retains deleted inputs; manual writes clear it', async () => {
    const { idMap } = canvas.apply(user, { requestId: 'inputs', ops: ['a', 'b'].map(tempId => ({ op: 'node.create' as const, tempId, kind: 'text' as const, x: 0, y: 0, w: 320, h: 200, content: { text: tempId } })) })
    const [a, b] = ['a', 'b'].map(key => canvas.get({ nodeIds: [idMap[key]!] }).nodes[0]!)
    const target = createEmptyImageNode('target')
    const seed = generation.submit(agent, { requestId: 'seed', kind: 'image', prompt: 'seed', targets: [{ outputIndex: 0, kind: 'slot', slotId: target.slotId }] })
    const seedView = await finish(seed.jobId)
    const { jobId } = generation.submit(agent, {
      requestId: 'with-inputs', kind: 'image', prompt: 'p', params: { width: 768 },
      inputs: [b!.slots[0]!.slotId, target.slotId, a!.slots[0]!.slotId, b!.slots[0]!.slotId].map(slotId => ({ slotId })),
      targets: [{ outputIndex: 0, kind: 'slot', slotId: target.slotId }],
    })
    canvas.apply(user, { requestId: 'delete-input', ops: [{ op: 'node.delete', nodeId: b!.nodeId }] })
    const view = await finish(jobId)
    const source = { jobId, inputNodeIds: [b!.nodeId, a!.nodeId] }
    expect(canvas.get({ nodeIds: [target.nodeId] }).nodes[0]!.slots[0]!.source).toEqual(source)
    expect(readEventsAfter(db, 0).filter(e => e.type === 'slot.revised').at(-1)!.payload).toMatchObject({ slot: { source } })
    canvas.apply(user, { requestId: 'manual-write', ops: [{ op: 'slot.setAsset', slotId: target.slotId, assetVersionId: seedView.outputs[0]!.assetVersionId, expectedRevision: 2 }] })
    expect(canvas.get({ nodeIds: [target.nodeId] }).nodes[0]!.slots[0]!.source).toBeUndefined()
    expect((readEventsAfter(db, 0).filter(e => e.type === 'slot.revised').at(-1)!.payload as { slot: object }).slot).not.toHaveProperty('source')
    const history = canvas.history({ slotId: target.slotId, limit: 50 })
    expect(METHODS['slot.history'].result.parse(history)).toEqual(history)
    expect(history.hasMore).toBe(false)
    expect(history.versions).toEqual([
      { revision: 3, content: { type: 'asset', assetVersionId: seedView.outputs[0]!.assetVersionId, mime: 'image/png' }, createdAt: clock, actor: 'user', isCurrent: true },
      { revision: 2, content: { type: 'asset', assetVersionId: view.outputs[0]!.assetVersionId, mime: 'image/png' }, createdAt: clock, actor: 'system', isCurrent: false,
        source: { ...source, prompt: 'p', provider: 'mock', model: 'mock-image-1', params: { prompt: 'p', n: 1, width: 768, height: 512 } } },
      { revision: 1, content: { type: 'asset', assetVersionId: seedView.outputs[0]!.assetVersionId, mime: 'image/png' }, createdAt: clock - LATENCY, actor: 'system', isCurrent: false,
        source: { jobId: seed.jobId, prompt: 'seed', provider: 'mock', model: 'mock-image-1', params: { prompt: 'seed', n: 1, width: 512, height: 512 }, inputNodeIds: [] } },
    ])
    expect(() => canvas.apply(user, { requestId: 'stale-restore', ops: [{ op: 'slot.setAsset', slotId: target.slotId, assetVersionId: view.outputs[0]!.assetVersionId, expectedRevision: 2 }] })).toThrow(expect.objectContaining({ code: 'revision_conflict' }))
    expect(canvas.history({ slotId: target.slotId, limit: 50 })).toEqual(history)
  })

  it('generating again for the same slot prevents the earlier completed request from overwriting it while retaining its output as an asset', async () => {
    const target = createEmptyImageNode('req_node')
    const first = generation.submit(agent, { requestId: 'req_a', kind: 'image', prompt: 'A', targets: [{ outputIndex: 0, kind: 'slot', slotId: target.slotId }] })
    await generation.pump()
    clock += 500
    const second = generation.submit(agent, { requestId: 'req_b', kind: 'image', prompt: 'B', targets: [{ outputIndex: 0, kind: 'slot', slotId: target.slotId }] })
    await generation.pump()

    // A completes first, but the slot has already accepted B.
    clock += LATENCY - 500
    await generation.pump()
    const a = await generation.get({ jobId: first.jobId })
    expect(a).toMatchObject({ status: 'succeeded', outputs: [{ delivery: { status: 'conflict' } }] })
    expect(canvas.get({}).nodes[0]!.slots[0]!.revision).toBe(0)

    // B next polls 2000ms after submission.
    clock += 1000
    await generation.pump()
    const b = await generation.get({ jobId: second.jobId })
    expect(b.outputs[0]!.delivery.status).toBe('delivered')
    expect(canvas.get({}).nodes[0]!.slots[0]!.content).toMatchObject({ assetVersionId: b.outputs[0]!.assetVersionId })

    // The user can manually populate the slot with A's output through a new validated edit.
    canvas.apply(user, { requestId: 'req_fill', ops: [{ op: 'slot.setAsset', slotId: target.slotId, assetVersionId: a.outputs[0]!.assetVersionId, expectedRevision: 1 }] })
    expect(canvas.get({}).nodes[0]!.slots[0]).toMatchObject({ revision: 2, content: { assetVersionId: a.outputs[0]!.assetVersionId } })
  })

  it('deleting the target during generation returns target_missing, retains the output and does not restore the node', async () => {
    const target = createEmptyImageNode('req_node')
    const { jobId } = generation.submit(agent, { requestId: 'req_gen', kind: 'image', prompt: 'p', targets: [{ outputIndex: 0, kind: 'slot', slotId: target.slotId }] })
    await generation.pump()
    canvas.apply(user, { requestId: 'req_del', ops: [{ op: 'node.delete', nodeId: target.nodeId }] })

    const view = await finish(jobId)
    expect(view).toMatchObject({ status: 'succeeded', outputs: [{ delivery: { status: 'target_missing' } }] })
    expect(canvas.get({}).nodes).toHaveLength(0)
  })
})
