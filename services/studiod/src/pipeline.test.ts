// Backend integration tests: real canvas-core, assets and generation assembled with a mock Provider.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAssetStore } from '@vis/assets'
import { createCanvasService, type CanvasService } from '@vis/canvas-core'
import { createGenerationService, createMockProvider, type GenerationService } from '@vis/generation'
import { METHODS } from '@vis/protocol'
import { openSpaceDb, readEventsAfter, spaceSchema, type SpaceDb } from '@vis/storage'

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
    expect(created.inputs).toEqual([source.nodeId])
    expect(created.generation).toEqual({ provider: 'mock', model: 'mock-image-1', params: { n: 1, width: 512, height: 256 } })
    expect(created.slots).toEqual([
      { slotId: created.slots[0]!.slotId, slotKey: 'main', contentType: 'image', revision: 1, content: { type: 'asset', assetVersionId: view.outputs[0]!.assetVersionId, mime: 'image/png' }, writer: { actor: 'system' }, source: { jobId, inputNodeIds: [source.nodeId] } },
      { slotId: created.slots[1]!.slotId, slotKey: 'prompt', contentType: 'text', revision: 1, content: { type: 'text', body: '变体' }, writer: { actor: 'system' } },
    ])
    // The node was created empty at submit (RFC 0047) and delivery filled its main slot
    expect(readEventsAfter(db, 0).find(e => e.type === 'node.created' && e.entityId === created.nodeId)!.payload).toMatchObject({
      nodeId: created.nodeId, x: 360, y: 0, w: 320, h: 160, slots: [{ slotKey: 'main', revision: 0, content: { type: 'empty' } }, { slotKey: 'prompt', content: { body: '变体' } }],
    })
    expect(view.targets).toEqual([{ outputIndex: 0, kind: 'new_node', status: 'delivered', nodeId: created.nodeId, slotId: created.slots[0]!.slotId, nearNodeId: source.nodeId }])
  })

  describe('result placeholders (RFC 0047)', () => {
    const live = () => canvas.get({}).nodes
    const seededSource = async () => {
      const source = createEmptyImageNode('src')
      const seed = generation.submit(agent, { requestId: 'seed', kind: 'image', prompt: 's', targets: [{ outputIndex: 0, kind: 'slot', slotId: source.slotId }] })
      return { ...source, seeded: await finish(seed.jobId) }
    }
    const submitBeside = (requestId: string, source: { slotId: string }, extra: Record<string, unknown> = {}) =>
      generation.submit(agent, { requestId, kind: 'image', prompt: '变体', inputs: [{ slotId: source.slotId }], ...extra })

    it('creates the empty result node at submit and names it in the receipt', async () => {
      const source = await seededSource()
      const undoEntries = () => db.select().from(spaceSchema.undoEntries).all().length
      const before = undoEntries()
      const receipt = submitBeside('gen', source)
      const placeholder = live().find(node => node.nodeId !== source.nodeId)!
      expect(placeholder).toMatchObject({ kind: 'image', x: 360, y: 0, purpose: 'artifact', inputs: [source.nodeId], slots: [{ slotKey: 'main', revision: 0, content: { type: 'empty' } }, { slotKey: 'prompt' }] })
      expect(receipt.bindings).toEqual([{ bindingId: expect.any(String), outputIndex: 0, target: { kind: 'new_node', nearNodeId: source.nodeId, nodeId: placeholder.nodeId, slotId: placeholder.slots[0]!.slotId } }])
      await expect(generation.get({ jobId: receipt.jobId })).resolves.toMatchObject({ targets: [{ kind: 'new_node', status: 'pending', nodeId: placeholder.nodeId, slotId: placeholder.slots[0]!.slotId }] })
      // A system operation: the author's undo history does not gain an entry for it
      expect(undoEntries()).toBe(before)
    })

    it('fills the placeholder in place even after the author moved it', async () => {
      const source = await seededSource()
      const { jobId, bindings } = submitBeside('gen', source)
      const target = bindings[0]!.target as { nodeId: string }
      canvas.apply(user, { requestId: 'move', ops: [{ op: 'node.layout', nodeId: target.nodeId, x: 900, y: 500 }] })
      const view = await finish(jobId)
      expect(view.outputs[0]!.delivery).toMatchObject({ status: 'delivered', nodeId: target.nodeId })
      expect(live()).toHaveLength(2)
      expect(live().find(node => node.nodeId === target.nodeId)).toMatchObject({ x: 900, y: 500, slots: [{ revision: 1, content: { assetVersionId: view.outputs[0]!.assetVersionId } }, { slotKey: 'prompt' }] })
    })

    it('keeps the author\'s media when they fill the placeholder first, and keeps the output as an asset when it was deleted', async () => {
      const source = await seededSource()
      const { seeded } = source
      const written = submitBeside('written', source)
      const deleted = submitBeside('deleted', source)
      const [w, d] = [written, deleted].map(r => r.bindings[0]!.target as { nodeId: string; slotId: string })
      canvas.apply(user, { requestId: 'fill', ops: [{ op: 'slot.setAsset', slotId: w!.slotId, assetVersionId: seeded.outputs[0]!.assetVersionId, expectedRevision: 0 }] })
      canvas.apply(user, { requestId: 'del', ops: [{ op: 'node.delete', nodeId: d!.nodeId }] })
      expect((await finish(written.jobId)).outputs[0]!.delivery.status).toBe('conflict')
      expect((await finish(deleted.jobId)).outputs[0]!.delivery.status).toBe('target_missing')
      expect(live().find(node => node.nodeId === w!.nodeId)!.slots[0]!.content).toMatchObject({ assetVersionId: seeded.outputs[0]!.assetVersionId })
      expect(live().some(node => node.nodeId === d!.nodeId)).toBe(false)
    })

    it('cancelling removes an empty placeholder and keeps one the author wrote into; regenerating makes a fresh one', async () => {
      const source = await seededSource()
      const { seeded } = source
      const empty = submitBeside('empty', source)
      const kept = submitBeside('kept', source)
      const keptTarget = kept.bindings[0]!.target as { nodeId: string; slotId: string }
      canvas.apply(user, { requestId: 'fill', ops: [{ op: 'slot.setAsset', slotId: keptTarget.slotId, assetVersionId: seeded.outputs[0]!.assetVersionId, expectedRevision: 0 }] })
      await generation.cancel(agent, { requestId: 'cancel-empty', jobId: empty.jobId }, { releasePlaceholders: true })
      await generation.cancel(agent, { requestId: 'cancel-kept', jobId: kept.jobId }, { releasePlaceholders: true })
      const emptyNodeId = (empty.bindings[0]!.target as { nodeId: string }).nodeId
      expect(live().map(node => node.nodeId).sort()).toEqual([source.nodeId, keptTarget.nodeId].sort())
      expect(readEventsAfter(db, 0).some(e => e.type === 'node.deleted' && e.entityId === emptyNodeId)).toBe(true)

      // A cancellation caused by recall, stop or work deletion leaves the empty placeholder on the canvas
      const cascaded = submitBeside('cascaded', source)
      await generation.cancel(agent, { requestId: 'cancel-cascaded', jobId: cascaded.jobId })
      expect(live().some(node => node.nodeId === (cascaded.bindings[0]!.target as { nodeId: string }).nodeId)).toBe(true)

      const again = generation.regenerate(agent, { requestId: 'again', jobId: empty.jobId })
      const fresh = (again.bindings[0]!.target as { nodeId: string }).nodeId
      expect(fresh).not.toBe(emptyNodeId)
      expect((await finish(again.jobId)).outputs[0]!.delivery).toMatchObject({ status: 'delivered', nodeId: fresh })
    })

    it('creates one placeholder per output, none on an identical retry, and none when submit is rejected', async () => {
      const source = await seededSource()
      const first = submitBeside('two', source, { params: { n: 2 } })
      expect(first.bindings.map(binding => (binding.target as { nodeId?: string }).nodeId)).toEqual([expect.any(String), expect.any(String)])
      expect(live()).toHaveLength(3)
      expect(submitBeside('two', source, { params: { n: 2 } })).toEqual(first)
      expect(() => generation.submit(agent, { requestId: 'bad', kind: 'image', prompt: 'p', model: 'missing-model' })).toThrow()
      expect(live()).toHaveLength(3)
    })

    it('sizes a video placeholder from the job aspect', () => {
      // The Mock model takes width and height; vendor ratio and size strings are covered in canvas-core
      const receipt = generation.submit(agent, { requestId: 'tall', kind: 'video', prompt: '竖屏', params: { width: 360, height: 640 } })
      expect(live().find(node => node.nodeId === (receipt.bindings[0]!.target as { nodeId: string }).nodeId)).toMatchObject({ kind: 'video', w: 320, h: 569 })
    })
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
        source: { ...source, prompt: 'p', usedPrompt: 'p', usedPromptKind: 'authored', provider: 'mock', model: 'mock-image-1', params: { n: 1, width: 768, height: 512 } } },
      { revision: 1, content: { type: 'asset', assetVersionId: seedView.outputs[0]!.assetVersionId, mime: 'image/png' }, createdAt: clock - LATENCY, actor: 'system', isCurrent: false,
        source: { jobId: seed.jobId, prompt: 'seed', usedPrompt: 'seed', usedPromptKind: 'authored', provider: 'mock', model: 'mock-image-1', params: { n: 1, width: 512, height: 512 }, inputNodeIds: [] } },
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
