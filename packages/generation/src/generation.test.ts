import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type AssetStore, createAssetStore } from '@vis/assets'
import { type CanvasDeliveryPort, VisError } from '@vis/domain'
import { eq, openSpaceDb, spaceSchema as s, type SpaceDb, type SpaceTx } from '@vis/storage'
import { createMockProvider, type MockProviderOptions } from './providers/mock'
import { createArkProvider } from './providers/ark'
import { ProviderError, type ProviderAdapter, type ProviderRequest } from './providers/types'
import { stageSyncOutput } from './providers/sync'
import { readActiveJobViews } from './view'
import type { GenerationQuota } from './quota'
import { createGenerationService, type GenerationService } from './service'

const LATENCY = 1500
const POLL = 1000

let dir: string
let db: SpaceDb
let assets: AssetStore
let clock: number
const now = () => clock

/** Fake delivery port: only marks bindings delivered and records calls; can throw on initial calls to simulate crashes */
function fakeDelivery() {
  const calls: { bindingId: string; assetVersionId: string }[] = []
  let failNext = 0
  const port: CanvasDeliveryPort<SpaceTx> & { calls: typeof calls; failTimes(n: number): void } = {
    calls,
    failTimes(n) { failNext = n },
    deliverOutput(tx, input) {
      if (failNext > 0) {
        failNext--
        throw new Error('Simulated crash during delivery')
      }
      calls.push(input)
      tx.update(s.deliveryBindings).set({ status: 'delivered' }).where(eq(s.deliveryBindings.id, input.bindingId)).run()
      return { status: 'delivered', nodeId: 'node_x', slotId: 'slot_x', slotRevision: 1 }
    },
  }
  return port
}

/** Wraps a Provider to record submit calls; can remove lookup-by-key support */
function spy(provider: ProviderAdapter, opts: { withoutFind?: boolean } = {}) {
  const submits: ProviderRequest[] = []
  const wrapped: ProviderAdapter = {
    ...provider,
    submit: (req, o) => { submits.push(req); return provider.submit(req, o) },
    getTask: (id, o) => provider.getTask(id, o),
    download: (out, o) => provider.download(out, o),
  }
  if (opts.withoutFind) delete (wrapped as { findTaskByIdempotencyKey?: unknown }).findTaskByIdempotencyKey
  else wrapped.findTaskByIdempotencyKey = key => provider.findTaskByIdempotencyKey!(key)
  return { provider: wrapped, submits }
}

function setup(mock: MockProviderOptions = {}, opts: { withoutFind?: boolean; queryFailureWindowMs?: number } = {}) {
  const raw = createMockProvider({ clock: now, latencyMs: LATENCY, ...mock })
  const { provider, submits } = spy(raw, opts)
  const delivery = fakeDelivery()
  const make = () =>
    createGenerationService({
      db, assets, delivery, providers: [provider], now,
      defaults: { image: { provider: 'mock' }, video: { provider: 'mock' }, audio: { provider: 'mock' } },
      pollIntervalMs: POLL, maxRetries: 3, queryFailureWindowMs: opts.queryFailureWindowMs ?? 60_000,
    })
  return { service: make(), make, provider, submits, delivery }
}

const agent = { sessionId: null, turnId: null, inputSnapshotId: null }

async function advance(service: GenerationService, ms: number) {
  clock += ms
  await service.pump()
}

/** Advances the clock until the Job ends or the step limit is exceeded */
async function runToEnd(service: GenerationService, jobId: string, stepMs = 1000) {
  for (let i = 0; i < 200; i++) {
    const { status } = await service.get({ jobId })
    if (status === 'succeeded' || status === 'failed' || status === 'unknown' || status === 'cancelled') return status
    await advance(service, stepMs)
  }
  throw new Error('Job did not finish')
}

const job = (id: string) => db.select().from(s.generationJobs).where(eq(s.generationJobs.id, id)).get()!
const attempts = (id: string) => db.select().from(s.generationAttempts).where(eq(s.generationAttempts.jobId, id)).all()

it('rejects a missing generation default before writing jobs or reserving quota', () => {
  const reserve = vi.fn()
  const quota: GenerationQuota = { reserve, rollback: vi.fn(), tryStart: vi.fn(() => true), release: vi.fn(), usage: () => ({ date: 'today', image: 0, video: 0, audio: 0, agent: { image: 0, video: 0, audio: 0 } }) }
  const service = createGenerationService({ db, assets, delivery: fakeDelivery(), providers: [createMockProvider()], defaults: {}, quota })
  expect(() => service.submit(agent, { requestId: 'missing-default', kind: 'image', prompt: 'No default' }))
    .toThrow(expect.objectContaining({ message: 'No default generation service is available for image', details: { reason: 'generation.default_provider_unavailable', params: { kind: 'image' } } }))
  expect(reserve).not.toHaveBeenCalled()
  expect(db.select().from(s.generationJobs).all()).toEqual([])
})

it('cleans sync bytes only after durable delivery and retries cleanup after restart without changing outcomes', async () => {
  const call = vi.fn(async () => [{ data: new Uint8Array([1, 2]), mime: 'image/png', width: 1, height: 1 }])
  const staged = stageSyncOutput({ dataDir: dir, providerId: 'mock', maxBytes: 10, mimeTypes: ['image/png'], call })
  const delivery = fakeDelivery()
  delivery.failTimes(1)
  const log = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const cleanup = vi.fn(async (options: Parameters<NonNullable<ProviderAdapter['cleanup']>>[0]) => {
    expect(db.select().from(s.generationJobs).all()[0]?.status).toBe('succeeded')
    expect(db.select().from(s.generationOutputs).all()).toHaveLength(1)
    if (cleanup.mock.calls.length === 1) throw new Error('fake-cleanup-secret')
    await staged.cleanup!(options)
  })
  const adapter = { ...createMockProvider(), ...staged, cleanup }
  const make = () => createGenerationService({ db, assets, delivery, providers: [adapter], defaults: { image: { provider: 'mock' } }, now, pollIntervalMs: 1 })
  const service = make()
  const { jobId } = service.submit(agent, { requestId: 'sync-cleanup', kind: 'image', prompt: 'Staged' })
  const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    await service.pump()
    await advance(service, 1000)
    expect(job(jobId).status).toBe('finalizing')
    expect(cleanup).not.toHaveBeenCalled()
    expect((await readdir(dir, { recursive: true })).some(name => name.endsWith('.bin'))).toBe(true)
    await advance(service, 6000)
    expect(job(jobId).status).toBe('succeeded')
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(log.mock.calls)).not.toContain('fake-cleanup-secret')
    await service.stop()
    const restarted = make()
    restarted.start()
    await restarted.pump()
    await restarted.stop()
    expect(cleanup).toHaveBeenCalledTimes(2)
    expect((await readdir(dir, { recursive: true })).filter(name => name.endsWith('.bin'))).toEqual([])
    const attempt = attempts(jobId)[0]!
    expect(await staged.submit({ operation: 'generate', kind: 'image', model: 'mock-image-1', prompt: 'Retry', params: {}, inputs: [] }, { idempotencyKey: attempt.id })).toEqual({ externalTaskId: attempt.externalTaskId })
    expect(call).toHaveBeenCalledTimes(1)
  } finally { await service.stop(); log.mockRestore(); errorLog.mockRestore() }
})

it('pins direct asset versions alongside slots, numbers both shapes in order, and regenerates the same versions', async () => {
  const { service, submits } = setup()
  const first = await seedImageSlot('direct-first')
  const second = await seedImageSlot('slot-second')
  const original = await first.revise('Direct')
  await second.revise('Slot')
  const assetVersionId = db.select().from(s.slotRevisions).where(eq(s.slotRevisions.slotId, first.slotId)).get()!.assetVersionId!
  const result = service.submit(agent, { requestId: 'mixed-inputs', kind: 'image', prompt: `{{ref:${first.nodeId}}} and {{ref:${second.nodeId}}}`, inputs: [{ assetVersionId }, { slotId: second.slotId }] })
  await first.revise('New canvas image')
  db.update(s.nodes).set({ deletedAt: clock }).where(eq(s.nodes.id, first.nodeId)).run()
  await service.pump()
  expect(submits[0]).toMatchObject({ prompt: '图片 1 and 图片 2', inputs: [{ path: assets.blobPath(original.hash) }, { type: 'asset' }] })
  expect(db.select().from(s.jobInputs).where(eq(s.jobInputs.jobId, result.jobId)).all()[0]).toMatchObject({ assetVersionId, slotId: null, slotRevision: null, fromSnapshot: false })
  expect(await runToEnd(service, result.jobId)).toBe('succeeded')
  service.regenerate(agent, { requestId: 'regenerate-mixed', jobId: result.jobId })
  await service.pump()
  expect(submits[1]!.inputs).toEqual(submits[0]!.inputs)
  expect(submits[1]!.prompt).toBe(submits[0]!.prompt)
})

it('rejects asset versions outside the project before creating a job or reserving quota', () => {
  const { service } = setup()
  expect(() => service.submit(agent, { requestId: 'missing-direct', kind: 'image', prompt: 'Draw', inputs: [{ assetVersionId: 'another-project-version' }] })).toThrow(expect.objectContaining({ code: 'not_found' }))
  expect(db.select().from(s.generationJobs).all()).toEqual([])
})

it('rejects font asset versions as generation inputs', () => {
  const { service } = setup()
  db.insert(s.blobs).values({ hash: 'font-hash', byteSize: 1, createdAt: 1 }).run()
  db.insert(s.assets).values({ id: 'font', kind: 'font', origin: 'import', createdAt: 1 }).run()
  db.insert(s.assetVersions).values({ id: 'font-v1', assetId: 'font', version: 1, blobHash: 'font-hash', mime: 'font/ttf', fontFamily: 'Font', createdAt: 1 }).run()
  expect(() => service.submit(agent, { requestId: 'font-direct', kind: 'image', prompt: 'Draw', inputs: [{ assetVersionId: 'font-v1' }] })).toThrow(expect.objectContaining({ code: 'invalid_params', details: expect.objectContaining({ reason: 'generation.input_not_media' }) }))
  expect(db.select().from(s.generationJobs).all()).toEqual([])
})

it('single-shot submission uses pinned setting refs and appends style text without needing source nodes', async () => {
  const { service, submits } = setup()
  const cast = await seedImageSlot('cast')
  const style = await seedImageSlot('style')
  const castVersion = await cast.revise('Hero')
  const styleVersion = await style.revise('Style')
  const castId = db.select().from(s.slotRevisions).where(eq(s.slotRevisions.slotId, cast.slotId)).get()!.assetVersionId!
  const styleId = db.select().from(s.slotRevisions).where(eq(s.slotRevisions.slotId, style.slotId)).get()!.assetVersionId!
  db.insert(s.entities).values([
    { id: 'hero', kind: 'character', name: 'Hero', refs: [{ assetVersionId: castId, sourceNodeId: cast.nodeId }], createdAt: clock, updatedAt: clock },
    { id: 'look', kind: 'style', name: 'Look', description: 'Ink look', refs: [{ assetVersionId: styleId }], createdAt: clock, updatedAt: clock },
  ]).run()
  const target = await seedImageSlot('shot-target')
  db.update(s.nodes).set({ shot: { scriptNodeId: 'script', shotId: 'shot', role: 'first' } }).where(eq(s.nodes.id, target.nodeId)).run()
  db.insert(s.nodes).values({ id: 'script', kind: 'script', x: 0, y: 0, w: 1, h: 1, z: 0, createdAt: clock }).run()
  db.insert(s.slots).values({ id: 'script-slot', nodeId: 'script', slotKey: 'main', contentType: 'script', currentRevision: 1 }).run()
  db.insert(s.slotRevisions).values({ slotId: 'script-slot', revision: 1, operationId: 'op_shot-target', createdAt: clock, scriptDoc: {
    version: 1, rev: 1, castIds: ['hero'], styleId: 'look', assets: [], shots: [{ id: 'shot', rev: 1, transition: 'cut', description: 'Walk', characterIds: ['hero'], propIds: [] }],
  } }).run()
  db.update(s.nodes).set({ deletedAt: clock }).where(eq(s.nodes.id, cast.nodeId)).run()
  service.submit(agent, { requestId: 'single-shot', kind: 'image', prompt: 'Walking', targets: [{ kind: 'slot', outputIndex: 0, slotId: target.slotId }] })
  await service.pump()
  expect(submits[0]).toMatchObject({ prompt: 'Walking\nInk look', inputs: [{ path: assets.blobPath(castVersion.hash) }, { path: assets.blobPath(styleVersion.hash) }] })
})

async function shotSettingsFixture() {
  const refs = await Promise.all(['explicit', 'hero-one', 'hero-two', 'style'].map(async id => {
    const source = await seedImageSlot(id)
    const version = await source.revise(id)
    return { ...source, ...version, assetVersionId: db.select().from(s.slotRevisions).where(eq(s.slotRevisions.slotId, source.slotId)).get()!.assetVersionId! }
  }))
  const [explicit, first, second, style] = refs as [typeof refs[number], typeof refs[number], typeof refs[number], typeof refs[number]]
  db.insert(s.entities).values([
    { id: 'hero', kind: 'character', name: 'Hero', refs: [first, second].map(ref => ({ assetVersionId: ref.assetVersionId, sourceNodeId: ref.nodeId })), createdAt: clock, updatedAt: clock },
    { id: 'look', kind: 'style', name: 'Look', description: 'Ink look', refs: [{ assetVersionId: style.assetVersionId }], createdAt: clock, updatedAt: clock },
  ]).run()
  const target = await seedImageSlot('shot-target')
  db.update(s.nodes).set({ shot: { scriptNodeId: 'script', shotId: 'shot', role: 'first' } }).where(eq(s.nodes.id, target.nodeId)).run()
  db.insert(s.nodes).values({ id: 'script', kind: 'script', x: 0, y: 0, w: 1, h: 1, z: 0, createdAt: clock }).run()
  db.insert(s.slots).values({ id: 'script-slot', nodeId: 'script', slotKey: 'main', contentType: 'script', currentRevision: 1 }).run()
  db.insert(s.slotRevisions).values({ slotId: 'script-slot', revision: 1, operationId: 'op_shot-target', createdAt: clock, scriptDoc: {
    version: 1, rev: 1, castIds: ['hero'], styleId: 'look', assets: [], shots: [{ id: 'shot', rev: 1, transition: 'cut', description: 'Walk', characterIds: ['hero'], propIds: [] }],
  } }).run()
  return { explicit, first, second, style, targets: [{ kind: 'slot' as const, outputIndex: 0, slotId: target.slotId }] }
}

it.each(['slot', 'version'] as const)('appends settings after explicit %s inputs, preserving image 1 and applying style', async shape => {
  const { service, submits } = setup()
  const { explicit, first, second, style, targets } = await shotSettingsFixture()
  const input = shape === 'slot' ? { slotId: explicit.slotId } : { assetVersionId: explicit.assetVersionId }
  service.submit(agent, { requestId: 'ordered', kind: 'image', prompt: 'Use image 1', inputs: [input], targets })
  await service.pump()
  expect(submits[0]).toMatchObject({ prompt: 'Use image 1\nInk look', inputs: [explicit, first, second, style].map(ref => ({ path: assets.blobPath(ref.hash) })) })
})

it.each(['slot', 'version'] as const)('does not append a setting ref already supplied through a %s', async shape => {
  const { service, submits } = setup()
  const { first, second, style, targets } = await shotSettingsFixture()
  const input = shape === 'slot' ? { slotId: first.slotId } : { assetVersionId: first.assetVersionId }
  service.submit(agent, { requestId: 'deduplicated', kind: 'image', prompt: `{{ref:${first.nodeId}}}`, inputs: [input], targets })
  await service.pump()
  expect(submits[0]).toMatchObject({ prompt: '图片 1\nInk look', inputs: [first, second, style].map(ref => ({ path: assets.blobPath(ref.hash) })) })
})

it.each([1, 2, 3, 4])('drops style refs before cast refs at reference limit %i while keeping caller inputs', async limit => {
  const { service, provider, submits } = setup()
  provider.referenceImageLimitFor = () => limit
  const { explicit, first, second, style, targets } = await shotSettingsFixture()
  service.submit(agent, { requestId: 'limited', kind: 'image', prompt: 'Use image 1', inputs: [{ assetVersionId: explicit.assetVersionId }], targets })
  await service.pump()
  expect(submits[0]).toMatchObject({ prompt: 'Use image 1\nInk look', inputs: [explicit, first, second, style].slice(0, limit).map(ref => ({ path: assets.blobPath(ref.hash) })) })
})

it('resolves direct version metadata and source aliases once for all inputs', async () => {
  const { service } = setup()
  const { explicit, first, second, style } = await shotSettingsFixture()
  const prepare = vi.spyOn(db.$client, 'prepare')
  try {
    service.submit(agent, { requestId: 'batched-direct', kind: 'image', prompt: `{{ref:${first.nodeId}}}`, inputs: [explicit, first, second, style].map(ref => ({ assetVersionId: ref.assetVersionId })) })
    const selects = prepare.mock.calls.map(([query]) => query).filter(query => /^\s*select\b/i.test(query))
    expect(selects.filter(query => query.includes('from "asset_versions"'))).toHaveLength(1)
    expect(selects.filter(query => query.includes('from "slots"'))).toHaveLength(1)
    expect(selects.filter(query => query.includes('from "entities"'))).toHaveLength(1)
  } finally { prepare.mockRestore() }
})

it('keeps unlimited references when an Ark-like adapter declares no reference limit', async () => {
  const { service, provider } = setup()
  const defaults = { image: { provider: 'mock' }, video: { provider: 'mock' }, audio: { provider: 'mock' } }
  service.configure([{ ...provider, type: 'volcengine-ark' }], defaults)
  const { first, targets } = await shotSettingsFixture()
  const ids = ['hero', 'scene', 'prop']
  const rows = await Promise.all(ids.map(async (id, index) => {
    const refs = await Promise.all(Array.from({ length: 4 }, async (_, n) => {
      const source = await seedImageSlot(`${id}-${n}`)
      await source.revise(`${id}-${n}`)
      return { assetVersionId: db.select().from(s.slotRevisions).where(eq(s.slotRevisions.slotId, source.slotId)).get()!.assetVersionId! }
    }))
    return { id, kind: (['character', 'scene', 'prop'] as const)[index]!, name: id, refs, createdAt: clock, updatedAt: clock }
  }))
  db.update(s.entities).set({ refs: rows[0]!.refs }).where(eq(s.entities.id, 'hero')).run()
  db.insert(s.entities).values(rows.slice(1)).run()
  const script = db.select().from(s.slotRevisions).where(eq(s.slotRevisions.slotId, 'script-slot')).get()!.scriptDoc!
  script.castIds = ids
  script.shots[0]!.sceneId = 'scene'
  script.shots[0]!.propIds = ['prop']
  db.update(s.slotRevisions).set({ scriptDoc: script }).where(eq(s.slotRevisions.slotId, 'script-slot')).run()
  const { jobId } = service.submit(agent, { requestId: 'unlimited', kind: 'image', prompt: 'Draw', inputs: [{ assetVersionId: first.assetVersionId }], targets })
  expect(db.select().from(s.jobInputs).where(eq(s.jobInputs.jobId, jobId)).all()).toHaveLength(14)
})

it('does not count explicit text inputs against image capacity and deduplicates the pinned slot revision', async () => {
  const { service, provider, submits } = setup()
  provider.referenceImageLimitFor = () => 2
  const { first, second, targets } = await shotSettingsFixture()
  await first.revise('A later canvas version')
  db.insert(s.slots).values({ id: 'text-slot', nodeId: first.nodeId, slotKey: 'prompt', contentType: 'text', currentRevision: 1 }).run()
  db.insert(s.slotRevisions).values({ slotId: 'text-slot', revision: 1, textBody: 'Saved prompt', operationId: 'op_hero-one', createdAt: clock }).run()
  service.submit(agent, { requestId: 'pinned-dedup', kind: 'image', prompt: 'Draw', inputs: [{ slotId: 'text-slot' }, { slotId: first.slotId, revision: 1 }], targets })
  await service.pump()
  expect(submits[0]).toMatchObject({ prompt: 'Draw\nInk look', inputs: [{ type: 'text', text: 'Saved prompt' }, ...[first, second].map(ref => ({ path: assets.blobPath(ref.hash) }))] })
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vis-gen-'))
  db = openSpaceDb(':memory:')
  assets = createAssetStore({ blobsDir: join(dir, 'blobs'), now })
  clock = 1_800_000_000_000
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('Generation operations and prompt references', () => {
  it('rejects undeclared frame modes before resolving inputs or reserving quota', () => {
    const provider = { ...createMockProvider(), type: 'volcengine-ark' as const, frameModesFor: () => [] }
    const reserve = vi.fn()
    const service = createGenerationService({
      db, assets, delivery: fakeDelivery(), providers: [provider], now,
      defaults: { image: { provider: 'mock' }, video: { provider: 'mock' }, audio: { provider: 'mock' } },
      quota: { reserve, rollback: vi.fn(), tryStart: () => true, release: vi.fn(), usage: () => ({ date: '', image: 0, video: 0, audio: 0, agent: { image: 0, video: 0, audio: 0 } }) },
    })
    expect(() => service.submit(agent, { requestId: 'unsupported-frames', kind: 'video', prompt: 'Move', frames: { first: { slotId: 'not-read' } } }))
      .toThrow(expect.objectContaining({ code: 'invalid_params', details: { reason: 'generation.frame_mode_unsupported', params: {} } }))
    expect(reserve).not.toHaveBeenCalled()
    expect(db.select().from(s.generationJobs).all()).toHaveLength(0)
  })

  it('pins first/last images, passes structured frames, and regenerates with the original revisions', async () => {
    const { service, submits } = setup()
    const first = await seedImageSlot('first-frame')
    const last = await seedImageSlot('last-frame')
    const original = await first.revise('original')
    await last.revise('ending')
    const result = service.submit(agent, { requestId: 'video-frames', kind: 'video', prompt: 'Move', frames: { first: { slotId: first.slotId }, last: { slotId: last.slotId } } })
    await first.revise('replacement')
    await service.pump()
    expect(submits[0]!.inputs).toEqual([])
    expect(submits[0]!.frames).toMatchObject({ first: { type: 'asset', kind: 'image', path: assets.blobPath(original.hash) }, last: { type: 'asset', kind: 'image' } })
    expect(await runToEnd(service, result.jobId)).toBe('succeeded')
    const output = (await service.get({ jobId: result.jobId })).outputs[0]!
    const version = assets.getVersion(db, output.assetVersionId)!
    expect((await readFile(assets.blobPath(version.blobHash))).includes(Buffer.from('VIS_FRAMES:'))).toBe(true)
    const regenerated = service.regenerate(agent, { requestId: 'regenerate-frames', jobId: result.jobId })
    await service.pump()
    expect(submits[1]!.frames).toEqual(submits[0]!.frames)
    expect((job(regenerated.jobId).params as Record<string, unknown>).frameRefs).toEqual({ first: { slotId: first.slotId, revision: 1 }, last: { slotId: last.slotId, revision: 1 } })
  })

  it('uses snapshot revisions for frames and rejects empty or non-image frame assets atomically', async () => {
    const { service, submits } = setup()
    const first = await seedImageSlot('snapshot-frame')
    const original = await first.revise('snapshot')
    db.insert(s.sessions).values({ id: 'frame-session', title: 'Frames', agentKind: 'codex', createdAt: clock }).run()
    db.insert(s.messages).values({ id: 'frame-message', sessionId: 'frame-session', text: 'Frames', deliveryState: 'delivered', createdAt: clock }).run()
    db.insert(s.turns).values({ id: 'frame-turn', sessionId: 'frame-session', messageId: 'frame-message', status: 'running', startedAt: clock }).run()
    db.insert(s.inputSnapshots).values({ id: 'frame-snapshot', turnId: 'frame-turn', createdAt: clock }).run()
    db.insert(s.snapshotItems).values({ snapshotId: 'frame-snapshot', ordinal: 0, nodeId: first.nodeId, slotId: first.slotId, slotRevision: 1 }).run()
    await first.revise('current')
    service.submit({ sessionId: 'frame-session', turnId: null, inputSnapshotId: 'frame-snapshot' }, { requestId: 'snapshot-frames', kind: 'video', prompt: 'Move', frames: { first: { slotId: first.slotId } } })
    await service.pump()
    expect(submits[0]!.frames!.first).toMatchObject({ path: assets.blobPath(original.hash) })
    db.insert(s.slots).values({ id: 'frame-text', nodeId: first.nodeId, slotKey: 'prompt', contentType: 'text', currentRevision: 1 }).run()
    db.insert(s.slotRevisions).values({ slotId: 'frame-text', revision: 1, textBody: 'Not an image', operationId: 'op_snapshot-frame', createdAt: clock }).run()
    expect(() => service.submit(agent, { requestId: 'invalid-frame', kind: 'video', prompt: 'Move', frames: { first: { slotId: 'frame-text' } } }))
      .toThrow(expect.objectContaining({ details: { reason: 'generation.frame_image_required', params: {} } }))
    expect(db.select().from(s.generationJobs).all()).toHaveLength(1)
  })

  it('rejects Ark frame/reference mixtures before quota reservation', async () => {
    const provider = createArkProvider({ id: 'ark', dataDir: dir, baseUrl: 'https://unused.invalid', imageModels: [],
      videoModels: [{ id: 'video', label: 'Video' }], getKey: async () => { throw new Error('No real provider calls') } })
    const reserve = vi.fn()
    const service = createGenerationService({
      db, assets, delivery: fakeDelivery(), providers: [provider], now,
      defaults: { image: { provider: 'ark' }, video: { provider: 'ark' }, audio: { provider: 'ark' } },
      quota: { reserve, rollback: vi.fn(), tryStart: () => true, release: vi.fn(), usage: () => ({ date: '', image: 0, video: 0, audio: 0, agent: { image: 0, video: 0, audio: 0 } }) },
    })
    const image = await seedImageSlot('mixed-frame')
    await image.revise('image')
    expect(() => service.submit(agent, {
      requestId: 'mixed-frames', kind: 'video', prompt: 'Move', inputs: [{ slotId: image.slotId }], frames: { first: { slotId: image.slotId } },
    })).toThrow(expect.objectContaining({ details: { reason: 'generation.frames_reference_mix', params: {} } }))
    expect(reserve).not.toHaveBeenCalled()
    expect(db.select().from(s.generationJobs).all()).toHaveLength(0)
  })

  it('validates Ark frame inputs before checking an exhausted local Agent quota', async () => {
    const provider = createArkProvider({ id: 'ark', dataDir: dir, baseUrl: 'https://unused.invalid', imageModels: [],
      videoModels: [{ id: 'video', label: 'Video' }], getKey: async () => { throw new Error('No real provider calls') } })
    const service = createGenerationService({
      db, assets, delivery: fakeDelivery(), providers: [provider], now,
      defaults: { image: { provider: 'ark' }, video: { provider: 'ark' }, audio: { provider: 'ark' } },
      limits: { maxConcurrent: 1, dailyImage: 1, dailyVideo: 1, dailyAudio: 1 },
    })
    db.insert(s.sessions).values({ id: 'paid-agent', title: 'Agent', agentKind: 'codex', createdAt: clock }).run()
    const caller = { sessionId: 'paid-agent', turnId: null, inputSnapshotId: null }
    const image = await seedImageSlot('quota-frame')
    await image.revise('image')
    service.submit(caller, { requestId: 'fill-local-quota', kind: 'video', prompt: 'Move', frames: { first: { slotId: image.slotId } } })
    expect(() => service.submit(caller, {
      requestId: 'invalid-before-local-quota', kind: 'video', prompt: 'Move', inputs: [{ slotId: image.slotId }], frames: { first: { slotId: image.slotId } },
    })).toThrow(expect.objectContaining({ details: { reason: 'generation.frames_reference_mix', params: {} } }))
    expect(db.select().from(s.generationJobs).all()).toHaveLength(1)
  })

  it('rejects undeclared operations before quota reservations or job creation', () => {
    const provider = { ...createMockProvider(), type: 'volcengine-ark' as const, operationsFor: () => ['generate'] as const }
    const reserve = vi.fn(() => { throw new Error('Quota must not be reserved') })
    const service = createGenerationService({
      db, assets, delivery: fakeDelivery(), providers: [provider], now,
      defaults: { image: { provider: 'mock' }, video: { provider: 'mock' }, audio: { provider: 'mock' } },
      quota: { reserve, rollback: vi.fn(), tryStart: () => true, release: vi.fn(), usage: () => ({ date: '', image: 0, video: 0, audio: 0, agent: { image: 0, video: 0, audio: 0 } }) },
    })
    expect(() => service.submit(agent, { requestId: 'unsupported-operation', kind: 'image', operation: 'image.upscale', prompt: '', inputs: [{ slotId: 'not-read' }] }))
      .toThrow(expect.objectContaining({ code: 'invalid_params', details: { reason: 'generation.operation_unsupported', params: { operation: 'image.upscale' } } }))
    expect(reserve).not.toHaveBeenCalled()
    expect(db.select().from(s.generationJobs).all()).toEqual([])
  })

  it('passes the operation and first subject input to mock, accepts empty prompts, and defaults to new-node delivery near the subject', async () => {
    const { service, submits } = setup()
    const subject = await seedImageSlot('subject')
    await subject.revise('image contents')
    const result = service.submit(agent, {
      requestId: 'upscale', kind: 'image', operation: 'image.upscale', prompt: '',
      inputs: [{ slotId: subject.slotId }], params: { width: 64, height: 64 },
    })
    expect(result.bindings[0]!.target).toEqual({ kind: 'new_node', nearNodeId: subject.nodeId })
    expect(await runToEnd(service, result.jobId)).toBe('succeeded')
    expect(submits[0]).toMatchObject({ operation: 'image.upscale', prompt: '', inputs: [{ type: 'asset', kind: 'image' }] })
    expect(await service.get({ jobId: result.jobId })).toMatchObject({ operation: 'image.upscale' })
    const output = db.select().from(s.generationOutputs).get()!
    const version = assets.getVersion(db, output.assetVersionId)!
    expect((await readFile(assets.blobPath(version.blobHash))).includes(Buffer.from('Operation\0image.upscale'))).toBe(true)
  })

  it('resolves repeated reference markers by submission input order while retaining the stored source prompt', async () => {
    const { service, submits } = setup()
    const a = await seedImageSlot('a')
    const b = await seedImageSlot('b')
    await a.revise('a')
    await b.revise('b')
    const prompt = `Mix {{ref:${b.nodeId}}} with {{ref:${a.nodeId}}} and {{ref:${b.nodeId}}}`
    const result = service.submit(agent, { requestId: 'references', kind: 'image', prompt, inputs: [{ slotId: a.slotId }, { slotId: b.slotId }] })
    await service.pump()
    expect(submits[0]!.prompt).toBe('Mix 图片 2 with 图片 1 and 图片 2')
    expect((job(result.jobId).params as { prompt: string }).prompt).toBe(prompt)
  })

  it('rejects a prompt marker outside the submitted inputs atomically', async () => {
    const { service } = setup()
    const a = await seedImageSlot('a')
    const b = await seedImageSlot('b')
    await a.revise('a')
    await b.revise('b')
    expect(() => service.submit(agent, {
      requestId: 'missing-reference', kind: 'image', prompt: `Use {{ref:${b.nodeId}}}`, inputs: [{ slotId: a.slotId }],
    })).toThrow(expect.objectContaining({ code: 'invalid_params', details: { reason: 'generation.prompt_reference_missing', params: { nodeId: b.nodeId } } }))
    expect(db.select().from(s.generationJobs).all()).toHaveLength(0)
    expect(db.select().from(s.jobInputs).all()).toHaveLength(0)
  })

  it('excludes the web prompt slot and text inputs from media numbering and rejects text markers', async () => {
    const { service, submits } = setup()
    const a = await seedImageSlot('web-reference')
    await a.revise('image')
    db.insert(s.slots).values({ id: 'prompt', nodeId: a.nodeId, slotKey: 'prompt', contentType: 'text', currentRevision: 1 }).run()
    db.insert(s.slotRevisions).values({ slotId: 'prompt', revision: 1, textBody: 'Prompt', operationId: 'op_web-reference', createdAt: clock }).run()
    const inputs = [{ slotId: 'prompt' }, { slotId: a.slotId }, { slotId: a.slotId }]
    service.submit(agent, { requestId: 'web-references', kind: 'image', prompt: `Use {{ref:${a.nodeId}}}`, inputs })
    await service.pump()
    expect(submits[0]!.prompt).toBe('Use 图片 1')
    expect(() => service.submit(agent, { requestId: 'text-reference', kind: 'image', prompt: `Use {{ref:${a.nodeId}}}`, inputs: [{ slotId: 'prompt' }] }))
      .toThrow(expect.objectContaining({ details: { reason: 'generation.prompt_reference_missing', params: { nodeId: a.nodeId } } }))
  })

  it('numbers image, video and audio references in one input order and uses the first occurrence of a duplicated node', async () => {
    const { service, submits } = setup()
    db.insert(s.sessions).values({ id: 'reference-agent', agentKind: 'codex', title: 'References', createdAt: clock }).run()
    const inputs: { slotId: string }[] = []
    for (const kind of ['image', 'video', 'audio'] as const) {
      const slotId = `${kind}-slot`
      db.insert(s.operations).values({ id: `${kind}-op`, actorKind: 'user', createdAt: clock }).run()
      db.insert(s.nodes).values({ id: `${kind}-node`, kind, x: 0, y: 0, w: 100, h: 100, z: 1, createdAt: clock }).run()
      db.insert(s.slots).values({ id: slotId, nodeId: `${kind}-node`, slotKey: 'main', contentType: kind, currentRevision: 1 }).run()
      const staged = await assets.stageBytes(Buffer.from(kind))
      const asset = assets.registerVersion(db, { staged, kind, mime: { image: 'image/png', video: 'video/mp4', audio: 'audio/wav' }[kind], origin: 'import' })
      db.insert(s.slotRevisions).values({ slotId, revision: 1, assetVersionId: asset.assetVersionId, operationId: `${kind}-op`, createdAt: clock }).run()
      inputs.push({ slotId })
    }
    service.submit({ sessionId: 'reference-agent', turnId: null, inputSnapshotId: null }, {
      requestId: 'mixed-references', kind: 'image', prompt: '{{ref:audio-node}} {{ref:image-node}} {{ref:video-node}}',
      inputs: [...inputs, inputs[0]!],
    })
    await service.pump()
    expect(submits[0]!.prompt).toBe('音频 3 图片 1 视频 2')
  })

  it('rejects a text or wrong-kind first input for a generation operation', async () => {
    const { service } = setup()
    const source = await seedImageSlot('wrong-kind')
    await source.revise('image')
    expect(() => service.submit(agent, { requestId: 'wrong-subject', kind: 'video', operation: 'video.upscale', prompt: '', inputs: [{ slotId: source.slotId }] }))
      .toThrow(expect.objectContaining({ code: 'invalid_params', details: { reason: 'generation.subject_required', params: {} } }))
  })
})

/** Creates an image slot with content and returns slotId; revisions can be appended afterward */
async function seedImageSlot(id: string) {
  db.insert(s.operations).values({ id: `op_${id}`, actorKind: 'user', createdAt: clock }).onConflictDoNothing().run()
  db.insert(s.nodes).values({ id: `node_${id}`, kind: 'image', x: 0, y: 0, w: 1, h: 1, z: 0, createdAt: clock }).run()
  db.insert(s.slots).values({ id: `slot_${id}`, nodeId: `node_${id}`, slotKey: 'main', contentType: 'image' }).run()
  return { nodeId: `node_${id}`, slotId: `slot_${id}`, revise: (content: string) => addRevision(`slot_${id}`, content, `op_${id}`) }
}

async function addRevision(slotId: string, content: string, operationId: string) {
  const staged = await assets.stageBytes(new TextEncoder().encode(content))
  const v = assets.registerVersion(db, { staged, kind: 'image', mime: 'image/png', origin: 'import' })
  const slot = db.select().from(s.slots).where(eq(s.slots.id, slotId)).get()!
  const revision = slot.currentRevision + 1
  db.insert(s.slotRevisions).values({ slotId, revision, assetVersionId: v.assetVersionId, operationId, createdAt: clock }).run()
  db.update(s.slots).set({ currentRevision: revision }).where(eq(s.slots.id, slotId)).run()
  return { revision, hash: staged.hash }
}

describe('generation.submit', () => {
  it('Provider validation errors without translated reasons preserve original messages and roll back jobs', () => {
    const { service, provider } = setup()
    provider.validateInputs = () => { throw new ProviderError('rejected', 'Provider-specific rejection') }
    expect(() => service.submit(agent, { requestId: 'provider-rejection', kind: 'image', prompt: 'p' }))
      .toThrow(expect.objectContaining({
        code: 'invalid_params', message: 'Provider-specific rejection',
        details: { reason: 'generation.invalid_params', params: { detail: 'Provider-specific rejection' } },
      }))
    expect(db.select().from(s.generationJobs).all()).toHaveLength(0)
  })

  it('audio uses the same idempotent submission, output registration, and delivery flow, preserving duration and generation sources', async () => {
    const { service, delivery } = setup()
    const params = { requestId: 'audio', kind: 'audio', model: 'mock-sfx-1', prompt: '雨滴', params: { duration: 1 } } as const
    const first = service.submit(agent, params)
    expect(service.submit(agent, params)).toEqual(first)
    expect(await runToEnd(service, first.jobId)).toBe('succeeded')
    const view = await service.get({ jobId: first.jobId })
    expect(view.outputs).toHaveLength(1)
    const output = view.outputs[0]!
    const version = db.select().from(s.assetVersions).where(eq(s.assetVersions.id, output.assetVersionId)).get()!
    expect(version).toMatchObject({ mime: 'audio/wav', durationMs: 1000, width: null, height: null, sourceJobId: first.jobId })
    expect(db.select().from(s.assets).where(eq(s.assets.id, version.assetId)).get()).toMatchObject({ kind: 'audio', origin: 'generation' })
    expect(job(first.jobId)).toMatchObject({ kind: 'audio', model: 'mock-sfx-1', params: { prompt: '雨滴', duration: 1 } })
    expect(delivery.calls).toHaveLength(1)
    expect(service.usage()).toMatchObject({ audio: 0, agent: { audio: 0 } })
  })

  it('models without audio-reference support return invalid_params before reserving quota and leave no jobs in the transaction', async () => {
    const { slotId } = await seedImageSlot('audio')
    const staged = await assets.stageBytes(new Uint8Array([1, 2, 3]))
    const version = assets.registerVersion(db, { staged, kind: 'audio', mime: 'audio/wav', durationMs: 2000, origin: 'import' })
    db.update(s.slots).set({ contentType: 'audio', currentRevision: 1 }).where(eq(s.slots.id, slotId)).run()
    db.insert(s.slotRevisions).values({ slotId, revision: 1, assetVersionId: version.assetVersionId, operationId: 'op_audio', createdAt: clock }).run()
    const quota: GenerationQuota = {
      reserve: vi.fn(), rollback: vi.fn(), tryStart: vi.fn(() => true), release: vi.fn(),
      usage: () => ({ date: 'today', image: 0, video: 0, audio: 0, agent: { image: 0, video: 0, audio: 0 } }),
    }
    const getKey = vi.fn(async () => 'fake-key')
    const provider = createArkProvider({ id: 'ark', dataDir: dir, baseUrl: 'http://127.0.0.1:1', imageModels: [], videoModels: [{ id: 'configured-video', label: '视频' }], getKey })
    const service = createGenerationService({ db, assets, delivery: fakeDelivery(), providers: [provider], now, quota, defaults: { image: { provider: 'ark' }, video: { provider: 'ark' }, audio: { provider: 'ark' } } })
    expect(() => service.submit(agent, { requestId: 'unsupported-audio', kind: 'video', prompt: 'p', inputs: [{ slotId }] })).toThrow(expect.objectContaining({ code: 'invalid_params', message: 'The selected model does not yet support audio references', details: { reason: 'generation.audio_reference_unsupported', params: {} } }))
    expect(quota.reserve).not.toHaveBeenCalled()
    expect(getKey).not.toHaveBeenCalled()
    expect(db.select().from(s.generationJobs).all()).toHaveLength(0)
    expect(db.select().from(s.jobInputs).all()).toHaveLength(0)
  })

  it.each(['image', 'video'] as const)('Ark %s generation rejects SVG reference images before reserving quota and leaves no jobs in the transaction', async kind => {
    const { slotId } = await seedImageSlot('svg')
    const staged = await assets.stageBytes(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))
    const version = assets.registerVersion(db, { staged, kind: 'image', mime: 'image/svg+xml', origin: 'import' })
    db.update(s.slots).set({ currentRevision: 1 }).where(eq(s.slots.id, slotId)).run()
    db.insert(s.slotRevisions).values({ slotId, revision: 1, assetVersionId: version.assetVersionId, operationId: 'op_svg', createdAt: clock }).run()
    const quota: GenerationQuota = {
      reserve: vi.fn(), rollback: vi.fn(), tryStart: vi.fn(() => true), release: vi.fn(),
      usage: () => ({ date: 'today', image: 0, video: 0, audio: 0, agent: { image: 0, video: 0, audio: 0 } }),
    }
    const getKey = vi.fn(async () => 'fake-key')
    const fetch = vi.fn<typeof globalThis.fetch>()
    const provider = createArkProvider({ id: 'ark', dataDir: dir, baseUrl: 'http://127.0.0.1:1', imageModels: [{ id: 'configured-image', label: '图片' }], videoModels: [{ id: 'configured-video', label: '视频' }], getKey, fetch })
    const service = createGenerationService({ db, assets, delivery: fakeDelivery(), providers: [provider], now, quota, defaults: { image: { provider: 'ark' }, video: { provider: 'ark' }, audio: { provider: 'ark' } } })
    expect(() => service.submit(agent, { requestId: 'svg-reference', kind, prompt: 'p', inputs: [{ slotId }] })).toThrow(expect.objectContaining({ code: 'invalid_params', message: 'SVG cannot be used as an Ark reference image; export it as PNG first', details: { reason: 'generation.svg_reference_unsupported', params: {} } }))
    expect(quota.reserve).not.toHaveBeenCalled()
    expect(getKey).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    expect(db.select().from(s.generationJobs).all()).toHaveLength(0)
    expect(db.select().from(s.jobInputs).all()).toHaveLength(0)
  })

  it('retrying the same requestId returns the same Job, created only once', () => {
    const { service } = setup()
    const params = { requestId: 'req_1', kind: 'image', prompt: '黄昏的屋顶花园' } as const
    const a = service.submit(agent, params)
    const b = service.submit(agent, params)
    expect(b).toEqual(a)
    expect(db.select().from(s.generationJobs).all()).toHaveLength(1)
    expect(a.bindings).toEqual([{ bindingId: expect.any(String), outputIndex: 0, target: { kind: 'new_node' } }])
  })

  it('creates a binding per output according to n; default targets are placed beside the first input node', async () => {
    const { service } = setup()
    const input = await seedImageSlot('in')
    await input.revise('v1')
    const r = service.submit(agent, { requestId: 'r', kind: 'image', prompt: 'p', params: { n: 2 }, inputs: [{ slotId: input.slotId }] })
    expect(r.bindings.map(b => b.target)).toEqual([
      { kind: 'new_node', nearNodeId: input.nodeId },
      { kind: 'new_node', nearNodeId: input.nodeId },
    ])
  })

  it('input versions: snapshot inputs retain snapshot revisions, others are pinned on submission; the Provider receives pinned versions', async () => {
    const { service, submits } = setup()
    const inSnap = await seedImageSlot('a')
    const v1 = await inSnap.revise('a-v1')
    const outside = await seedImageSlot('b')
    await outside.revise('b-v1')
    const b2 = await outside.revise('b-v2')

    db.insert(s.sessions).values({ id: 'ses_1', agentKind: 'claude', title: 't', createdAt: clock }).run()
    db.insert(s.messages).values({ id: 'msg_1', sessionId: 'ses_1', text: 'x', deliveryState: 'delivered', createdAt: clock }).run()
    db.insert(s.turns).values({ id: 'trn_1', sessionId: 'ses_1', messageId: 'msg_1', status: 'running' }).run()
    db.insert(s.inputSnapshots).values({ id: 'snap_1', turnId: 'trn_1', createdAt: clock }).run()
    db.insert(s.snapshotItems).values({ snapshotId: 'snap_1', ordinal: 0, nodeId: inSnap.nodeId, slotId: inSnap.slotId, slotRevision: 1 }).run()
    // The user changed this image again after the snapshot
    await inSnap.revise('a-v2')

    const r = service.submit(
      { sessionId: 'ses_1', turnId: 'trn_1', inputSnapshotId: 'snap_1' },
      { requestId: 'r', kind: 'image', prompt: 'p', inputs: [{ slotId: inSnap.slotId }, { slotId: outside.slotId }] },
    )
    expect(db.select().from(s.jobInputs).where(eq(s.jobInputs.jobId, r.jobId)).all()).toEqual([
      expect.objectContaining({ slotId: inSnap.slotId, slotRevision: v1.revision, fromSnapshot: true }),
      expect.objectContaining({ slotId: outside.slotId, slotRevision: b2.revision, fromSnapshot: false }),
    ])

    // Changes after submission also do not affect this generation
    await outside.revise('b-v3')
    await service.pump()
    expect(submits[0]!.inputs).toEqual([
      { type: 'asset', kind: 'image', mime: 'image/png', path: assets.blobPath(v1.hash) },
      { type: 'asset', kind: 'image', mime: 'image/png', path: assets.blobPath(b2.hash) },
    ])
  })

  it('slot targets accept the request and default expected revision to current; incompatible types or out-of-range values reject', async () => {
    const { service } = setup()
    const target = await seedImageSlot('t')
    await target.revise('v1')
    const r = service.submit(agent, { requestId: 'r1', kind: 'image', prompt: 'p', targets: [{ outputIndex: 0, kind: 'slot', slotId: target.slotId }] })
    expect(r.bindings[0]!.target).toEqual({ kind: 'slot', nodeId: target.nodeId, slotId: target.slotId, expectedRevision: 1 })
    expect(db.select().from(s.slots).where(eq(s.slots.id, target.slotId)).get()!.acceptedBindingId).toBe(r.bindings[0]!.bindingId)

    // Generating again: the new request supersedes the old request fill eligibility
    const r2 = service.submit(agent, { requestId: 'r2', kind: 'image', prompt: 'p2', targets: [{ outputIndex: 0, kind: 'slot', slotId: target.slotId }] })
    expect(db.select().from(s.slots).where(eq(s.slots.id, target.slotId)).get()!.acceptedBindingId).toBe(r2.bindings[0]!.bindingId)

    expect(() => service.submit(agent, { requestId: 'r3', kind: 'video', prompt: 'p', targets: [{ outputIndex: 0, kind: 'slot', slotId: target.slotId }] }))
      .toThrow(expect.objectContaining({ code: 'invalid_params' }))
    expect(() => service.submit(agent, { requestId: 'r4', kind: 'image', prompt: 'p', targets: [{ outputIndex: 1, kind: 'new_node' }] }))
      .toThrow(expect.objectContaining({ code: 'invalid_params' }))
    expect(() => service.submit(agent, { requestId: 'r5', kind: 'image', prompt: 'p', params: { n: 9 } }))
      .toThrow(expect.objectContaining({ code: 'invalid_params' }))
  })
})

describe('Execution and delivery', () => {
  it('before delivery to existing nodes, asset dimensions are registered in the same transaction for canvas aspect-ratio adjustment', async () => {
    const { service, delivery } = setup()
    const { slotId } = await seedImageSlot('fit')
    let dimensions: { width: number | null; height: number | null } | undefined
    const original = delivery.deliverOutput.bind(delivery)
    delivery.deliverOutput = (tx, input) => {
      dimensions = tx.select({ width: s.assetVersions.width, height: s.assetVersions.height }).from(s.assetVersions)
        .where(eq(s.assetVersions.id, input.assetVersionId)).get()
      return original(tx, input)
    }
    const { jobId } = service.submit(agent, { requestId: 'fit', kind: 'image', prompt: 'p', params: { width: 1920, height: 1080 }, targets: [{ kind: 'slot', slotId, outputIndex: 0 }] })
    expect(await runToEnd(service, jobId)).toBe('succeeded')
    expect(dimensions).toEqual({ width: 1920, height: 1080 })
    expect(delivery.calls).toHaveLength(1)
    expect(db.select().from(s.undoEntries).all()).toEqual([])
  })

  it('normal path: submit -> poll -> download to disk -> register and deliver -> succeeded', async () => {
    const { service, delivery } = setup()
    const { jobId, bindings } = service.submit(agent, { requestId: 'r', kind: 'image', prompt: 'p', params: { width: 256, height: 128 } })

    await service.pump()
    expect(job(jobId).status).toBe('running')
    expect(attempts(jobId)).toEqual([expect.objectContaining({ attemptNo: 1, status: 'running', externalTaskId: expect.any(String) })])

    await advance(service, LATENCY)
    const view = await service.get({ jobId })
    expect(view).toMatchObject({ status: 'succeeded', outputs: [{ outputIndex: 0, mime: 'image/png', delivery: { status: 'delivered' } }] })

    const version = db.select().from(s.assetVersions).where(eq(s.assetVersions.id, view.outputs[0]!.assetVersionId)).get()!
    expect(version).toMatchObject({ sourceJobId: jobId, width: 256, height: 128 })
    expect(existsSync(assets.blobPath(version.blobHash))).toBe(true)
    expect(delivery.calls).toEqual([{ bindingId: bindings[0]!.bindingId, assetVersionId: version.id }])
  })

  it('generation failure: failed, records the error without automatically regenerating', async () => {
    const { service, submits } = setup({ failureRate: 1 })
    const { jobId } = service.submit(agent, { requestId: 'r', kind: 'image', prompt: 'p' })
    expect(await runToEnd(service, jobId)).toBe('failed')
    expect(job(jobId).error).toMatchObject({ code: 'mock_failed' })
    expect(submits).toHaveLength(1)
  })

  it('fewer outputs than requested: missing positions become no_output and the view lists missing indices', async () => {
    const { service, provider } = setup()
    const getTask = provider.getTask
    provider.getTask = async (id, o) => {
      const state = await getTask(id, o)
      return state.state === 'succeeded' ? { ...state, outputs: state.outputs.filter(out => out.outputIndex === 0) } : state
    }
    const { jobId } = service.submit(agent, { requestId: 'r', kind: 'image', prompt: 'p', params: { n: 3 } })
    expect(await runToEnd(service, jobId)).toBe('succeeded')
    const view = await service.get({ jobId })
    expect(view.outputs.map(o => o.outputIndex)).toEqual([0])
    expect(view.missingOutputIndexes).toEqual([1, 2])
    expect(view.targets.map(x => [x.outputIndex, x.status])).toEqual([[0, 'delivered'], [1, 'no_output'], [2, 'no_output']])
    const statuses = db.select().from(s.deliveryBindings).where(eq(s.deliveryBindings.jobId, jobId)).all().map(b => [b.outputIndex, b.status])
    expect(statuses.sort()).toEqual([[0, 'delivered'], [1, 'no_output'], [2, 'no_output']])
  })

  it('generation failure also marks undelivered bindings no_output', async () => {
    const { service } = setup({ failureRate: 1 })
    const { jobId } = service.submit(agent, { requestId: 'r', kind: 'image', prompt: 'p' })
    expect(await runToEnd(service, jobId)).toBe('failed')
    expect(db.select().from(s.deliveryBindings).where(eq(s.deliveryBindings.jobId, jobId)).all().map(b => b.status)).toEqual(['no_output'])
  })

  it('video outputs are also saved to disk and delivered', async () => {
    const { service } = setup()
    const { jobId } = service.submit(agent, { requestId: 'r', kind: 'video', prompt: 'p' })
    expect(await runToEnd(service, jobId)).toBe('succeeded')
    const v = (await service.get({ jobId })).outputs[0]!
    expect(v.mime).toBe('video/mp4')
    expect(db.select().from(s.assetVersions).where(eq(s.assetVersions.id, v.assetVersionId)).get()).toMatchObject({ durationMs: 1000, fps: 24 })
  })
})

describe('Failure recovery', () => {
  it('lost submission responses recover jobs by idempotency key without duplicate submission', async () => {
    const { service, provider } = setup({ faults: { lostSubmitResponse: 1 } })
    const { jobId } = service.submit(agent, { requestId: 'r', kind: 'image', prompt: 'p' })
    expect(await runToEnd(service, jobId)).toBe('succeeded')
    const [attempt] = attempts(jobId)
    expect(await provider.findTaskByIdempotencyKey!(attempt!.id)).toEqual({ externalTaskId: attempt!.externalTaskId })
    expect(attempts(jobId)).toHaveLength(1)
  })

  it('lost submission responses without Provider lookup support become unknown and never resubmit', async () => {
    const { service, submits } = setup({ faults: { lostSubmitResponse: 1 } }, { withoutFind: true })
    const { jobId } = service.submit(agent, { requestId: 'r', kind: 'image', prompt: 'p' })
    expect(await runToEnd(service, jobId)).toBe('unknown')
    expect(submits).toHaveLength(1)
    expect(job(jobId).error).toMatchObject({ code: 'submit_unconfirmed' })
  })

  it('temporary query failures continue after backoff retries', async () => {
    const { service } = setup({ faults: { getTaskTransient: 2 } })
    const { jobId } = service.submit(agent, { requestId: 'r', kind: 'image', prompt: 'p' })
    expect(await runToEnd(service, jobId)).toBe('succeeded')
  })

  it('persistent query failures beyond the limit become unknown, not failed, because generation may still be running', async () => {
    const { service } = setup({ faults: { getTaskTransient: 100 } })
    const { jobId } = service.submit(agent, { requestId: 'r', kind: 'image', prompt: 'p' })
    expect(await runToEnd(service, jobId, 30_000)).toBe('unknown')
    expect(job(jobId).error).toMatchObject({ code: 'retries_exhausted' })
  })

  it('temporary download failures retry downloads without regenerating', async () => {
    const { service, submits } = setup({ faults: { downloadTransient: 1 } })
    const { jobId } = service.submit(agent, { requestId: 'r', kind: 'image', prompt: 'p' })
    expect(await runToEnd(service, jobId)).toBe('succeeded')
    expect(submits).toHaveLength(1)
    expect(db.select().from(s.generationOutputs).all()).toHaveLength(1)
  })

  it('persistent download failures beyond the limit become unknown without retrying forever', async () => {
    const { service, submits } = setup({ faults: { downloadTransient: 100 } })
    const { jobId } = service.submit(agent, { requestId: 'r', kind: 'image', prompt: 'p' })
    expect(await runToEnd(service, jobId, 30_000)).toBe('unknown')
    expect(job(jobId).error).toMatchObject({ code: 'retries_exhausted' })
    expect(submits).toHaveLength(1)
  })

  it('crashes during finalizing do not reregister existing outputs and continue delivering remaining outputs', async () => {
    const { service, delivery } = setup()
    const { jobId } = service.submit(agent, { requestId: 'r', kind: 'image', prompt: 'p', params: { n: 2 } })
    await service.pump()
    // The first output delivers normally; the second "crashes" inside the delivery transaction, rolling back the entire transaction
    let calls = 0
    const original = delivery.deliverOutput.bind(delivery)
    delivery.deliverOutput = (tx, input) => {
      if (++calls === 2) throw new Error('Simulated crash during delivery')
      return original(tx, input)
    }
    await advance(service, LATENCY)
    expect(job(jobId).status).toBe('finalizing')
    expect(db.select().from(s.generationOutputs).all()).toHaveLength(1)

    expect(await runToEnd(service, jobId, 5000)).toBe('succeeded')
    expect(db.select().from(s.generationOutputs).all().map(o => o.outputIndex)).toEqual([0, 1])
    expect(delivery.calls).toHaveLength(2)
    expect(db.select().from(s.assetVersions).all()).toHaveLength(2)
  })

  it('process restart: a new instance takes over running Jobs and reuses their external jobs', async () => {
    const { service, make, submits } = setup()
    const { jobId } = service.submit(agent, { requestId: 'r', kind: 'image', prompt: 'p' })
    await service.pump()
    expect(job(jobId).status).toBe('running')

    const restarted = make()
    restarted.start()
    clock += LATENCY
    await restarted.pump()
    await restarted.stop()
    expect(job(jobId).status).toBe('succeeded')
    expect(submits).toHaveLength(1)
  })

  it('crash around submission with no external Attempt ID: lookup confirms before resubmitting; without lookup, becomes unknown', async () => {
    for (const withoutFind of [false, true]) {
      db = openSpaceDb(':memory:')
      const { make, submits } = setup({}, { withoutFind })
      const t = clock
      db.insert(s.generationJobs).values({ id: 'job_c', kind: 'image', provider: 'mock', model: 'mock-image-1', params: { prompt: 'p' }, status: 'running', createdAt: t, updatedAt: t }).run()
      db.insert(s.deliveryBindings).values({ id: 'bind_c', jobId: 'job_c', outputIndex: 0, targetKind: 'new_node', status: 'pending' }).run()
      db.insert(s.generationAttempts).values({ id: 'att_c', jobId: 'job_c', attemptNo: 1, status: 'submitting', startedAt: t }).run()

      const restarted = make()
      restarted.start()
      await restarted.pump()
      if (withoutFind) {
        expect(job('job_c').status).toBe('unknown')
        expect(submits).toHaveLength(0)
      } else {
        expect(submits).toHaveLength(1)
        expect(await runToEnd(restarted, 'job_c')).toBe('succeeded')
      }
      await restarted.stop()
    }
  })
})

describe('generation.get', () => {
  it('waitMs returns early on state changes', async () => {
    const { service } = setup()
    const { jobId } = service.submit(agent, { requestId: 'r', kind: 'image', prompt: 'p' })
    const waiting = service.get({ jobId, waitMs: 10_000 })
    await service.pump()
    expect((await waiting).status).toBe('running')
  })

  it('nonexistent Job: not_found', async () => {
    const { service } = setup()
    await expect(service.get({ jobId: 'job_none' })).rejects.toMatchObject({ code: 'not_found', message: 'Generation job job_none does not exist', details: { reason: 'generation.job_not_found', params: { jobId: 'job_none' } } })
  })
})

describe('Submission defaults from node generation settings', () => {
  it('explicit fields override nodes, then global and service defaults; parameter objects replace as a whole', () => {
    const { service } = setup()
    db.insert(s.nodes).values({ id: 'node_settings', kind: 'image', x: 0, y: 0, w: 1, h: 1, z: 0, createdAt: clock,
      generation: { provider: 'mock', model: 'mock-image-1', params: { width: 768, height: 1024 } },
    }).run()
    db.insert(s.slots).values({ id: 'slot_settings', nodeId: 'node_settings', slotKey: 'main', contentType: 'image' }).run()
    const targets = [{ kind: 'slot' as const, slotId: 'slot_settings', outputIndex: 0 }]
    const saved = service.submit(agent, { requestId: 'settings-saved', kind: 'image', prompt: '节点偏好', targets })
    expect(job(saved.jobId)).toMatchObject({ provider: 'mock', model: 'mock-image-1', params: { width: 768, height: 1024 } })
    const explicit = service.submit(agent, { requestId: 'settings-explicit', kind: 'image', prompt: '显式参数', targets, params: { width: 128 } })
    expect(job(explicit.jobId).params).toMatchObject({ width: 128, height: 512 })
    db.update(s.nodes).set({ generation: { provider: 'deleted', model: 'deleted', params: { width: 768 } } }).where(eq(s.nodes.id, 'node_settings')).run()
    const override = service.submit(agent, { requestId: 'settings-override', kind: 'image', prompt: '覆盖偏好', targets, provider: 'mock', model: 'mock-image-1', params: {} })
    expect(job(override.jobId)).toMatchObject({ provider: 'mock', model: 'mock-image-1', params: { width: 512 } })
    db.update(s.nodes).set({ generation: null }).where(eq(s.nodes.id, 'node_settings')).run()
    const defaults = service.submit(agent, { requestId: 'settings-defaults', kind: 'image', prompt: '旧节点', targets })
    expect(job(defaults.jobId)).toMatchObject({ provider: 'mock', model: 'mock-image-1', params: { width: 512, height: 512 } })
  })

  it('stored node parameters no longer accepted by the model lose invalid fields; explicitly supplied invalid parameters still fail', () => {
    const { service } = setup()
    db.insert(s.nodes).values({ id: 'node_stale', kind: 'image', x: 0, y: 0, w: 1, h: 1, z: 0, createdAt: clock,
      generation: { provider: 'mock', model: 'mock-image-1', params: { width: 9999, height: 1024 } },
    }).run()
    db.insert(s.slots).values({ id: 'slot_stale', nodeId: 'node_stale', slotKey: 'main', contentType: 'image' }).run()
    const targets = [{ kind: 'slot' as const, slotId: 'slot_stale', outputIndex: 0 }]
    const saved = service.submit(agent, { requestId: 'stale-saved', kind: 'image', prompt: '旧设置', targets })
    expect(job(saved.jobId).params).toMatchObject({ width: 512, height: 1024 })
    expect(() => service.submit(agent, { requestId: 'stale-explicit', kind: 'image', prompt: '显式', targets, params: { width: 9999 } })).toThrow(/Invalid generation parameters/)
  })

  it('nodes can override global provider/model while omitted fields retain global defaults; nearNodeId is only a position hint', () => {
    const mock = createMockProvider()
    const custom = { ...mock, id: 'custom', models: ['custom-image'], defaultModels: { image: 'custom-image' } }
    const service = createGenerationService({ db, assets, delivery: fakeDelivery(), providers: [mock, custom], defaults: {
      image: { provider: 'custom', model: 'custom-image' }, video: { provider: 'mock' }, audio: { provider: 'mock' },
    }, now })
    db.insert(s.nodes).values({ id: 'node_preferred', kind: 'image', x: 0, y: 0, w: 1, h: 1, z: 0, createdAt: clock,
      generation: { provider: 'mock', model: 'mock-image-1', params: { width: 768 } },
    }).run()
    db.insert(s.slots).values({ id: 'slot_preferred', nodeId: 'node_preferred', slotKey: 'main', contentType: 'image' }).run()
    const targets = [{ kind: 'slot' as const, slotId: 'slot_preferred', outputIndex: 0 }]
    const preferred = service.submit(agent, { requestId: 'preferred', kind: 'image', prompt: '节点', targets })
    expect(job(preferred.jobId)).toMatchObject({ provider: 'mock', model: 'mock-image-1' })
    db.update(s.nodes).set({ generation: { params: { width: 768 } } }).where(eq(s.nodes.id, 'node_preferred')).run()
    const partial = service.submit(agent, { requestId: 'partial', kind: 'image', prompt: '部分设置', targets })
    expect(job(partial.jobId)).toMatchObject({ provider: 'custom', model: 'custom-image', params: { width: 768 } })
    const nearby = service.submit(agent, { requestId: 'nearby', kind: 'image', prompt: '新节点', targets: [{ kind: 'new_node', outputIndex: 0, nearNodeId: 'node_preferred' }] })
    expect(job(nearby.jobId)).toMatchObject({ provider: 'custom', model: 'custom-image', params: { width: 512 } })
  })
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

describe('Cancellation and regeneration', () => {
  it('cancelling queued jobs persists terminal state without Attempts or submission and does not restore them on restart', async () => {
    const { service, make, submits } = setup()
    const { jobId } = service.submit(agent, { requestId: 'submit', kind: 'image', prompt: 'p' })
    const result = await service.cancel(agent, { requestId: 'cancel', jobId })
    expect(result).toMatchObject({ status: 'cancelled', cancelRequestedAt: clock, providerCancelled: true, missingOutputIndexes: [0] })
    expect(await service.cancel(agent, { requestId: 'cancel', jobId })).toEqual(result)
    await service.pump()
    const restarted = make()
    restarted.start()
    await restarted.pump()
    await restarted.stop()
    expect(submits).toHaveLength(0)
    expect(attempts(jobId)).toHaveLength(0)
    expect((await service.get({ jobId, waitMs: 1000 })).status).toBe('cancelled')
  })

  it('cancelling jobs in backoff stops further submission', async () => {
    const { service, provider } = setup()
    let submits = 0
    provider.submit = async () => { submits++; throw new ProviderError('transient', 'Explicitly rejected') }
    const { jobId } = service.submit(agent, { requestId: 'submit', kind: 'image', prompt: 'p' })
    await service.pump()
    expect(job(jobId).status).toBe('running')
    await service.cancel(agent, { requestId: 'cancel', jobId })
    await advance(service, 60_000)
    expect(job(jobId).status).toBe('cancelled')
    expect(attempts(jobId)[0]!.status).toBe('cancelled')
    expect(submits).toBe(1)
  })

  it('late job IDs during submission still attempt cancellation without restoring state', async () => {
    const { service, provider, delivery } = setup()
    const entered = deferred<void>()
    const response = deferred<void>()
    const original = provider.submit
    provider.submit = async (request, options) => {
      entered.resolve()
      await response.promise
      return original(request, { idempotencyKey: options.idempotencyKey })
    }
    const { jobId } = service.submit(agent, { requestId: 'submit', kind: 'image', prompt: 'p' })
    const running = service.pump()
    await entered.promise
    expect((await service.cancel(agent, { requestId: 'cancel', jobId })).providerCancelled).toBe(false)
    response.resolve()
    await running
    expect(await service.get({ jobId })).toMatchObject({ status: 'cancelled', providerCancelled: true, outputs: [] })
    expect(attempts(jobId)[0]).toMatchObject({ status: 'cancelled', externalTaskId: expect.any(String) })
    expect(await provider.getTask(attempts(jobId)[0]!.externalTaskId!)).toEqual({ state: 'cancelled' })
    expect(delivery.calls).toHaveLength(0)
  })

  it('cancellation aborts polling; late success ignoring AbortSignal neither downloads nor delivers', async () => {
    const { service, provider, delivery } = setup()
    const entered = deferred<void>()
    const response = deferred<Awaited<ReturnType<ProviderAdapter['getTask']>>>()
    let signal: AbortSignal | undefined
    provider.getTask = async (_id, options) => { signal = options?.signal; entered.resolve(); return response.promise }
    delete provider.cancel
    const { jobId } = service.submit(agent, { requestId: 'submit', kind: 'image', prompt: 'p' })
    await service.pump()
    clock += LATENCY
    const polling = service.pump()
    await entered.promise
    expect((await service.cancel(agent, { requestId: 'cancel', jobId })).providerCancelled).toBe(false)
    expect(signal?.aborted).toBe(true)
    response.resolve({ state: 'succeeded', outputs: [{ outputIndex: 0, ref: 'late' }] })
    await polling
    expect(job(jobId).status).toBe('cancelled')
    expect(db.select().from(s.generationOutputs).all()).toHaveLength(0)
    expect(delivery.calls).toHaveLength(0)
  })

  it('late downloaded files do not register assets or fill targets', async () => {
    const { service, provider, delivery } = setup()
    const entered = deferred<void>()
    const response = deferred<void>()
    const download = provider.download
    provider.download = async output => { entered.resolve(); await response.promise; return download(output) }
    const { jobId } = service.submit(agent, { requestId: 'submit', kind: 'image', prompt: 'p' })
    await service.pump()
    clock += LATENCY
    const downloading = service.pump()
    await entered.promise
    delete provider.cancel
    await service.cancel(agent, { requestId: 'cancel', jobId })
    response.resolve()
    await downloading
    expect(job(jobId).status).toBe('cancelled')
    expect(db.select().from(s.assetVersions).all()).toHaveLength(0)
    expect(db.select().from(s.generationOutputs).all()).toHaveLength(0)
    expect(delivery.calls).toHaveLength(0)
  })

  it('cancellation during asset staging rechecks terminal state in the delivery transaction and does not register already-written files', async () => {
    const { service, delivery } = setup()
    const entered = deferred<void>()
    const proceed = deferred<void>()
    const stage = assets.stageBytes.bind(assets)
    assets.stageBytes = async bytes => { entered.resolve(); await proceed.promise; return stage(bytes) }
    const { jobId } = service.submit(agent, { requestId: 'submit', kind: 'image', prompt: 'p' })
    await service.pump()
    clock += LATENCY
    const finalizing = service.pump()
    await entered.promise
    await service.cancel(agent, { requestId: 'cancel', jobId })
    proceed.resolve()
    await finalizing
    expect(job(jobId).status).toBe('cancelled')
    expect(db.select().from(s.assetVersions).all()).toHaveLength(0)
    expect(db.select().from(s.generationOutputs).all()).toHaveLength(0)
    expect(delivery.calls).toHaveLength(0)
  })

  it('regeneration creates a new Job with original parameters and input revisions, rebinding with current target revisions', async () => {
    const { service, submits } = setup({ failureRate: 1 })
    const input = await seedImageSlot('in')
    const v1 = await input.revise('original')
    const target = await seedImageSlot('out')
    await target.revise('before')
    const first = service.submit(agent, { requestId: 'first', kind: 'image', prompt: '原提示词', params: { width: 128 }, inputs: [{ slotId: input.slotId }], targets: [{ outputIndex: 0, kind: 'slot', slotId: target.slotId }] })
    expect(await runToEnd(service, first.jobId)).toBe('failed')
    await input.revise('new input')
    await target.revise('new target')
    const next = service.regenerate(agent, { requestId: 'retry', jobId: first.jobId })
    expect(service.regenerate(agent, { requestId: 'retry', jobId: first.jobId })).toEqual(next)
    expect(next.jobId).not.toBe(first.jobId)
    expect(job(next.jobId).params).toEqual(job(first.jobId).params)
    expect(next.bindings[0]!.target).toMatchObject({ kind: 'slot', slotId: target.slotId, expectedRevision: 2 })
    expect(db.select().from(s.jobInputs).where(eq(s.jobInputs.jobId, next.jobId)).get()).toMatchObject({ slotId: input.slotId, slotRevision: v1.revision })
    expect(db.select().from(s.slots).where(eq(s.slots.id, target.slotId)).get()!.acceptedBindingId).toBe(next.bindings[0]!.bindingId)
    await service.pump()
    expect(submits[1]!.inputs).toEqual([{ type: 'asset', kind: 'image', mime: 'image/png', path: assets.blobPath(v1.hash) }])
  })

  it('sessions are isolated and successful jobs cannot be cancelled; reconnect retains failures only for current bindings', async () => {
    const { service } = setup({ failureRate: 1 })
    const target = await seedImageSlot('out')
    const first = service.submit(agent, { requestId: 'first', kind: 'image', prompt: 'p', targets: [{ outputIndex: 0, kind: 'slot', slotId: target.slotId }] })
    await expect(service.cancel({ ...agent, sessionId: 'other' }, { requestId: 'cancel', jobId: first.jobId })).rejects.toMatchObject({ code: 'forbidden' })
    expect(() => service.regenerate({ ...agent, sessionId: 'other' }, { requestId: 'retry', jobId: first.jobId })).toThrow(expect.objectContaining({ code: 'forbidden' }))
    expect(await runToEnd(service, first.jobId)).toBe('failed')
    await expect(service.cancel(agent, { requestId: 'terminal', jobId: first.jobId })).rejects.toMatchObject({ code: 'job_terminal' })
    expect(readActiveJobViews(db).map(job => job.jobId)).toEqual([first.jobId])
    const second = service.regenerate(agent, { requestId: 'retry', jobId: first.jobId })
    expect(readActiveJobViews(db).map(job => job.jobId)).toEqual([second.jobId])
  })

  it('regeneration ignores bindings for extra provider outputs and rebuilds only originally requested positions', async () => {
    const { service, provider } = setup()
    const getTask = provider.getTask
    const download = provider.download
    provider.getTask = async (id, options) => {
      const state = await getTask(id, options)
      return state.state === 'succeeded' ? { ...state, outputs: [...state.outputs, { outputIndex: 1, ref: id }] } : state
    }
    provider.download = (output, options) => download({ ...output, outputIndex: 0 }, options)
    const original = service.submit(agent, { requestId: 'original', kind: 'image', prompt: 'p', params: { n: 1 } })
    expect(await runToEnd(service, original.jobId)).toBe('succeeded')
    expect((await service.get({ jobId: original.jobId })).outputs).toHaveLength(2)
    const next = service.regenerate(agent, { requestId: 'regenerate', jobId: original.jobId })
    expect(next.bindings.map(binding => binding.outputIndex)).toEqual([0])
    expect(await runToEnd(service, next.jobId)).toBe('succeeded')
    expect((await service.get({ jobId: next.jobId })).outputs).toHaveLength(2)
  })
})

describe('Paid generation limits', () => {
  function paidService(limits = { maxConcurrent: 3, dailyImage: 50, dailyVideo: 10, dailyAudio: 20 }) {
    const raw = createMockProvider({ clock: now, latencyMs: LATENCY })
    const paid = { ...raw, id: 'paid', type: 'volcengine-ark' as const }
    const delivery = fakeDelivery()
    const service = createGenerationService({ db, assets, delivery, providers: [paid, raw], now, pollIntervalMs: POLL, limits, defaults: { image: { provider: 'paid' }, video: { provider: 'paid' }, audio: { provider: 'paid' } } })
    return { service, paid, delivery }
  }

  it('default concurrency is 3 and other jobs wait; cancellation releases capacity and mock is exempt by type', async () => {
    const { service } = paidService()
    const jobs = Array.from({ length: 4 }, (_, i) => service.submit(agent, { requestId: `p${i}`, kind: 'image', prompt: 'p' }))
    const free = service.submit(agent, { requestId: 'free', kind: 'image', provider: 'mock', prompt: 'p' })
    await service.pump()
    expect(jobs.slice(0, 3).map(job => readActiveJobViews(db).find(view => view.jobId === job.jobId)!.status)).toEqual(['running', 'running', 'running'])
    expect(await service.get({ jobId: jobs[3]!.jobId })).toMatchObject({ status: 'queued', queueReason: 'concurrency_limit' })
    expect(job(free.jobId).status).toBe('running')
    await service.cancel(agent, { requestId: 'cancel', jobId: jobs[0]!.jobId })
    await service.pump()
    expect(await service.get({ jobId: jobs[3]!.jobId })).toMatchObject({ status: 'running' })
    expect((await service.get({ jobId: jobs[3]!.jobId })).queueReason).toBeUndefined()
    expect(service.usage()).toMatchObject({ image: 4, video: 0, limits: { maxConcurrent: 3, dailyImage: 50, dailyVideo: 10 } })
  })

  it('three media types limit only agents; UI uses no daily quota, cancellation and regeneration do not bypass counts, and local date changes reset them', async () => {
    const { service } = paidService({ maxConcurrent: 0, dailyImage: 1, dailyVideo: 1, dailyAudio: 1 })
    db.insert(s.sessions).values({ id: 'ses_agent', agentKind: 'codex', title: 'Agent', createdAt: clock }).run()
    const caller = { ...agent, sessionId: 'ses_agent' }
    for (const kind of ['image', 'video', 'audio'] as const) {
      const params = { requestId: `${kind}-agent`, kind, prompt: 'p', ...(kind === 'image' ? { params: { n: 4 } } : {}) }
      service.submit(agent, { ...params, requestId: `${kind}-ui1` })
      service.submit(agent, { ...params, requestId: `${kind}-ui2` })
      expect(service.usage().agent[kind]).toBe(0)
      const first = service.submit(caller, params)
      expect(service.submit(caller, params).jobId).toBe(first.jobId)
      await service.cancel(caller, { requestId: `${kind}-cancel`, jobId: first.jobId })
      expect(() => service.submit(caller, { ...params, requestId: `${kind}-over` })).toThrow(expect.objectContaining({
        code: 'quota_exceeded', quota: { kind, count: 1, limit: 1 },
        message: `Daily agent paid ${kind} job limit 1 reached`,
        details: { reason: 'generation.agent_daily_limit', params: { kind, count: 1, limit: 1 } },
      }))
      expect(() => service.regenerate(caller, { requestId: `${kind}-retry`, jobId: first.jobId })).toThrow(expect.objectContaining({ code: 'quota_exceeded' }))
      service.regenerate(agent, { requestId: `${kind}-ui-retry`, jobId: first.jobId })
      expect(service.usage()[kind]).toBe(4)
      expect(service.usage().agent[kind]).toBe(1)
    }
    expect(service.usage().jobs).toHaveLength(12)
    expect(paidService().service.usage()).toMatchObject({ image: 4, video: 4, audio: 4, agent: { image: 1, video: 1, audio: 1 } })
    clock += 24 * 60 * 60 * 1000
    expect(service.usage()).toMatchObject({ image: 0, video: 0, audio: 0, agent: { image: 0, video: 0, audio: 0 }, jobs: [] })
    service.submit(caller, { requestId: 'tomorrow', kind: 'audio', prompt: 'p' })
    expect(service.usage()).toMatchObject({ audio: 1, agent: { audio: 1 } })
  })

  it('zero agent daily limits allow unlimited calls; mock audio does not count', () => {
    const { service } = paidService({ maxConcurrent: 0, dailyImage: 0, dailyVideo: 0, dailyAudio: 0 })
    db.insert(s.sessions).values({ id: 'ses_agent', agentKind: 'codex', title: 'Agent', createdAt: clock }).run()
    const caller = { ...agent, sessionId: 'ses_agent' }
    for (let i = 0; i < 2; i++) service.submit(caller, { requestId: `audio-${i}`, kind: 'audio', prompt: 'p' })
    service.submit(caller, { requestId: 'free', kind: 'audio', provider: 'mock', prompt: 'p' })
    expect(service.usage()).toMatchObject({ audio: 2, agent: { audio: 2 } })
  })

  it('global ledgers reserve only once, compensate failed space transactions, and release concurrency after terminal commits', async () => {
    const provider = { ...createMockProvider({ clock: now, latencyMs: LATENCY }), id: 'paid', type: 'volcengine-ark' as const }
    const quota: GenerationQuota = {
      reserve: vi.fn(), rollback: vi.fn(), tryStart: vi.fn(() => true), release: vi.fn(),
      usage: () => ({ date: 'today', image: 7, video: 2, audio: 1, agent: { image: 3, video: 1, audio: 0 }, jobs: [] }),
    }
    const service = createGenerationService({ db, assets, delivery: fakeDelivery(), providers: [provider], now, quota, defaults: { image: { provider: 'paid' }, video: { provider: 'paid' }, audio: { provider: 'paid' } } })
    db.$client.exec("CREATE TRIGGER reject_event BEFORE INSERT ON events BEGIN SELECT RAISE(FAIL, 'Simulated commit failure'); END")
    expect(() => service.submit(agent, { requestId: 'rollback', kind: 'image', prompt: 'p' })).toThrow('Simulated commit failure')
    expect(quota.reserve).toHaveBeenCalledTimes(1)
    expect(quota.rollback).toHaveBeenCalledWith(expect.any(String))
    expect(db.select().from(s.generationJobs).all()).toHaveLength(0)
    db.$client.exec('DROP TRIGGER reject_event')
    const params = { requestId: 'submit', kind: 'image', prompt: 'p' } as const
    const result = service.submit(agent, params)
    expect(service.submit(agent, params)).toEqual(result)
    expect(quota.reserve).toHaveBeenCalledTimes(2)
    expect(quota.reserve).toHaveBeenLastCalledWith({ jobId: result.jobId, kind: 'image', now: clock, byAgent: false })
    await service.pump()
    expect(quota.tryStart).toHaveBeenCalledWith(result.jobId)
    expect(quota.release).not.toHaveBeenCalled()
    await service.cancel(agent, { requestId: 'cancel', jobId: result.jobId })
    expect(quota.release).toHaveBeenCalledWith(result.jobId)
    expect(service.usage()).toMatchObject({ date: 'today', image: 7, video: 2, jobs: [] })
    db.insert(s.sessions).values({ id: 'ses_agent', agentKind: 'codex', title: 'Agent', createdAt: clock }).run()
    const agentJob = service.submit({ ...agent, sessionId: 'ses_agent' }, { requestId: 'agent-submit', kind: 'audio', prompt: 'p' })
    expect(quota.reserve).toHaveBeenLastCalledWith({ jobId: agentJob.jobId, kind: 'audio', now: clock, byAgent: true })
  })
})

describe('Query failure tolerance and rechecking', () => {
  it('query failure counts beyond the limit but inside the time window continue querying through sleep or disconnection and complete after recovery', async () => {
    const { service, submits } = setup({ faults: { getTaskTransient: 15 } }, { queryFailureWindowMs: 60 * 60_000 })
    const { jobId } = service.submit(agent, { requestId: 'r', kind: 'image', prompt: 'p' })
    expect(await runToEnd(service, jobId, 30_000)).toBe('succeeded')
    expect(submits).toHaveLength(1)
  })

  it('explicitly rejected queries such as invalid keys become unknown based on count without waiting for the time window', async () => {
    const { service, provider } = setup({}, { queryFailureWindowMs: 60 * 60_000 })
    provider.getTask = async () => { throw new ProviderError('rejected', 'AuthenticationError') }
    const { jobId } = service.submit(agent, { requestId: 'r', kind: 'image', prompt: 'p' })
    expect(await runToEnd(service, jobId, 1000)).toBe('unknown')
    expect(job(jobId).error).toMatchObject({ code: 'retries_exhausted', message: 'AuthenticationError' })
  })

  it('unknown results with external jobs recheck and fill using the original job without resubmitting', async () => {
    const { service, submits } = setup({ faults: { getTaskTransient: 6 } }, { queryFailureWindowMs: 0 })
    const { slotId } = await seedImageSlot('recheck')
    const { jobId } = service.submit(agent, { requestId: 'r', kind: 'image', prompt: 'p', targets: [{ kind: 'slot', slotId, outputIndex: 0 }] })
    expect(await runToEnd(service, jobId, 30_000)).toBe('unknown')
    expect(await service.get({ jobId })).toMatchObject({ status: 'unknown', recheckable: true, targets: [{ status: 'no_output' }] })

    const resumed = service.recheck(agent, { requestId: 'recheck-1', jobId })
    expect(resumed).toMatchObject({ status: 'running', targets: [{ status: 'pending' }] })
    expect(resumed).not.toHaveProperty('error')
    expect(await runToEnd(service, jobId)).toBe('succeeded')
    expect(submits).toHaveLength(1)
    expect(attempts(jobId)).toHaveLength(1)
    expect((await service.get({ jobId })).targets).toMatchObject([{ status: 'delivered' }])
    expect(() => service.recheck(agent, { requestId: 'recheck-2', jobId })).toThrow(/rechecked/)
  })

  it('recheckable jobs targeting new nodes remain in refreshed snapshots and create nodes on delivery after rechecking', async () => {
    const { service, submits } = setup({ faults: { getTaskTransient: 6 } }, { queryFailureWindowMs: 0 })
    const { jobId } = service.submit(agent, { requestId: 'r', kind: 'image', prompt: 'p' })
    expect(await runToEnd(service, jobId, 30_000)).toBe('unknown')
    expect(readActiveJobViews(db).map(view => view.jobId)).toContain(jobId)
    service.recheck(agent, { requestId: 'recheck', jobId })
    expect(await runToEnd(service, jobId)).toBe('succeeded')
    expect(submits).toHaveLength(1)
    expect(readActiveJobViews(db).map(view => view.jobId)).not.toContain(jobId)
  })

  it('unknown without an external job ID cannot recheck and can only regenerate after confirmation', async () => {
    const { service } = setup({ faults: { lostSubmitResponse: 1 } }, { withoutFind: true })
    const { jobId } = service.submit(agent, { requestId: 'r', kind: 'image', prompt: 'p' })
    expect(await runToEnd(service, jobId)).toBe('unknown')
    expect(await service.get({ jobId })).not.toHaveProperty('recheckable')
    expect(() => service.recheck(agent, { requestId: 'recheck', jobId })).toThrow(VisError)
  })
})

describe('Text input sources', () => {
  it('prompt, storyboard, and code slots all pin revisions and pass them to the Provider', async () => {
    const { service, submits } = setup()
    db.insert(s.operations).values({ id: 'texts', actorKind: 'user', createdAt: clock }).run()
    const texts = ['提示词来源', '分镜内容', '<html>代码</html>']
    for (const [i, text] of texts.entries()) {
      db.insert(s.nodes).values({ id: `text_${i}`, kind: 'text', x: 0, y: 0, w: 100, h: 100, z: i, createdAt: clock }).run()
      db.insert(s.slots).values({ id: `text_slot_${i}`, nodeId: `text_${i}`, slotKey: 'main', contentType: 'text', currentRevision: 1 }).run()
      db.insert(s.slotRevisions).values({ slotId: `text_slot_${i}`, revision: 1, textBody: text, operationId: 'texts', createdAt: clock }).run()
    }
    const { jobId } = service.submit(agent, { requestId: 'text-inputs', kind: 'video', prompt: '', inputs: texts.map((_, i) => ({ slotId: `text_slot_${i}` })) })
    expect(db.select().from(s.jobInputs).where(eq(s.jobInputs.jobId, jobId)).all().map(input => [input.slotId, input.slotRevision])).toEqual(texts.map((_, i) => [`text_slot_${i}`, 1]))
    await service.pump()
    expect(submits[0]!.inputs).toEqual(texts.map(text => ({ type: 'text', text })))
    await runToEnd(service, jobId)
    await service.stop()
  })
})
