import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MediaTools } from '@vis/assets'
import { createArkProvider, createMockProvider, type ProviderAdapter } from '@vis/generation'
import { BATCH_APPROVAL_TTL_MS, EntityView, EMPTY_PREVIZ, emptyPrevizPanel, type BatchView, type NodeView, type ScriptDoc } from '@vis/protocol'
import { eq, spaceSchema as s } from '@vis/storage'
import { openSpaceHost, type SpaceHost } from './space-host'
import { currentShotNode, planScriptBatch, type BatchCatalog } from './script-batch-plan'

const defaults = { image: { provider: 'mock' }, video: { provider: 'mock' }, audio: { provider: 'mock' } }
const catalog: BatchCatalog = {
  defaults,
  providers: [{ id: 'mock', paid: false, models: [
    { id: 'mock-image-1', kind: 'image', frameModes: [] },
    { id: 'mock-video-1', kind: 'video', frameModes: ['first', 'first_last'] },
  ] }],
}
const doc: ScriptDoc = { version: 1, rev: 1, assets: [], shots: [
  { id: 'a', rev: 1, transition: 'cut', description: 'Start', framePrompt: 'First A', endState: 'End', endFramePrompt: 'Last A', characterIds: [], propIds: [] },
  { id: 'b', rev: 1, transition: 'continuous', description: 'Continue', framePrompt: 'First B', characterIds: [], propIds: [] },
  { id: 'c', rev: 1, transition: 'cut', description: 'Elsewhere', framePrompt: 'First C', characterIds: [], propIds: [] },
] }
const imageNode = (shotId: string, role: 'first' | 'last'): NodeView => ({
  nodeId: `node_${shotId}_${role}`, kind: 'image', x: 0, y: 0, w: 100, h: 100, z: 1, layoutRevision: 1,
  shot: { scriptNodeId: 'script', shotId, role },
  slots: [{ slotId: `${shotId}_${role}`, slotKey: 'main', contentType: 'image', revision: 1, content: { type: 'asset', assetVersionId: `asset_${shotId}`, mime: 'image/png' } }],
})

describe('Pure script batch planning', () => {
  it('prioritizes composition over continuity, cast and style and reports every dropped panel', () => {
    const previz: NodeView = { ...imageNode('a', 'first'), nodeId: 'previz', kind: 'previz', slots: [{ slotId: 'panels', slotKey: 'main', contentType: 'previz', revision: 1,
      content: { type: 'previz', doc: { ...EMPTY_PREVIZ, panels: [
        { ...emptyPrevizPanel('one'), image: 'drawing', blockout: 'render', shot: { scriptNodeId: 'script', shotId: 'b' } },
        { ...emptyPrevizPanel('two'), image: 'extra', shot: { scriptNodeId: 'script', shotId: 'b' } },
      ] } } }] }
    delete previz.shot
    const providers = structuredClone(catalog)
    providers.providers[0]!.models[0]!.referenceImageLimit = 2
    const plan = planScriptBatch(doc, [previz, imageNode('a', 'last')], { scriptNodeId: 'script', media: 'frames', shotIds: ['b'] }, providers, null)
    expect(plan.steps[0]!.inputs).toEqual([{ assetVersionId: 'render' }, { assetVersionId: 'extra' }])
    expect(plan.view.estimate.compositionRefsUsed).toBe(2)
    const setting = (id: string, kind: 'character' | 'style', refs: string[]) => EntityView.parse({ id, kind, name: id, description: '', revision: 1, createdAt: 1, updatedAt: 1, refs: refs.map(assetVersionId => ({ assetVersionId })), members: [], usage: { scriptNodeIds: [], shotCount: 0 } })
    const single = structuredClone(previz)
    if (single.slots[0]!.content.type === 'previz') single.slots[0]!.content.doc.panels.splice(1)
    providers.providers[0]!.models[0]!.referenceImageLimit = 3
    // Include the preceding shot so the continuity input is available by its document position.
    const continuity = planScriptBatch({ ...doc, styleId: 'style', shots: [doc.shots[0]!, { ...doc.shots[1]!, characterIds: ['hero'] }] }, [single, imageNode('a', 'last')], { scriptNodeId: 'script', media: 'frames', shotIds: ['b'] }, providers, null, [setting('hero', 'character', ['cast-one', 'cast-two']), setting('style', 'style', ['style-one'])])
    expect(continuity.steps[0]!.inputs).toEqual([{ assetVersionId: 'render' }, { assetVersionId: 'cast-one' }, { nodeId: 'node_a_last' }])
    expect(continuity.view.estimate).toMatchObject({ compositionRefsUsed: 1, castRefsDropped: 1, styleRefsDropped: 1 })

    providers.providers[0]!.models[0]!.referenceImageLimit = 0
    const dropped = planScriptBatch(doc, [previz], { scriptNodeId: 'script', media: 'frames', shotIds: ['b'] }, providers, null)
    expect(dropped.steps[0]!.inputs).toEqual([])
    expect(dropped.view.estimate.compositionRefsDropped).toEqual([
      { previzNodeId: 'previz', panelId: 'one', panelNumber: 1, shotId: 'b', reason: 'unsupported' },
      { previzNodeId: 'previz', panelId: 'two', panelNumber: 2, shotId: 'b', reason: 'unsupported' },
    ])
    providers.providers[0]!.models[0]!.referenceImageLimit = 1
    const limited = planScriptBatch(doc, [previz], { scriptNodeId: 'script', media: 'frames', shotIds: ['b'] }, providers, null)
    expect(limited.steps[0]!.inputs).toEqual([{ assetVersionId: 'render' }])
    expect(limited.view.estimate.compositionRefsDropped).toEqual([{ previzNodeId: 'previz', panelId: 'two', panelNumber: 2, shotId: 'b', reason: 'limit' }])
  })
  it('reuses materialized first and last panel frames without generating replacements', () => {
    const first = imageNode('a', 'first')
    const last = imageNode('a', 'last')
    const previz: NodeView = { ...first, nodeId: 'previz', kind: 'previz', slots: [{ slotId: 'panels', slotKey: 'main', contentType: 'previz', revision: 1,
      content: { type: 'previz', doc: { ...EMPTY_PREVIZ, panels: [
        { ...emptyPrevizPanel('first'), image: 'asset_a', use: 'frame', frameRole: 'first', shot: { scriptNodeId: 'script', shotId: 'a' } },
        { ...emptyPrevizPanel('last'), image: 'asset_a', use: 'frame', frameRole: 'last', shot: { scriptNodeId: 'script', shotId: 'a' } },
      ] } } }] }
    delete previz.shot
    const frames = planScriptBatch(doc, [previz, first, last], { scriptNodeId: 'script', media: 'frames', shotIds: ['a'] }, catalog, null)
    expect(frames.steps).toEqual([])
    expect(frames.view.estimate).toMatchObject({ jobs: 0, billedJobs: 0, panelFramesUsed: 2 })
    expect(frames.view.shots[0]!.steps).toEqual([
      { role: 'first', source: 'panel', status: 'skipped', nodeId: first.nodeId },
      { role: 'last', source: 'panel', status: 'skipped', nodeId: last.nodeId },
    ])
    const video = planScriptBatch(doc, [previz, first, last], { scriptNodeId: 'script', media: 'video', shotIds: ['a'] }, catalog, null)
    expect(video.steps).toHaveLength(1)
    expect(video.steps[0]!.frames).toEqual({ first: { nodeId: first.nodeId }, last: { nodeId: last.nodeId } })
  })

  it('ignores previz links in current outputs, frame batches and video batches', () => {
    const previz: NodeView = { ...imageNode('a', 'first'), nodeId: 'node_zzzzzzzzzz_pre', kind: 'video', shot: { scriptNodeId: 'script', shotId: 'a', role: 'previz' }, slots: [
      { slotId: 'previz-main', slotKey: 'main', contentType: 'video', revision: 1, content: { type: 'asset', assetVersionId: 'blockout', mime: 'video/mp4' } },
    ] }
    for (const role of ['first', 'last', 'video'] as const) expect(currentShotNode([previz], 'script', 'a', role)).toBeUndefined()
    const first = imageNode('a', 'first')
    expect(currentShotNode([first, previz], 'script', 'a', 'first')).toBe(first)
    for (const media of ['frames', 'video'] as const) {
      const params = { scriptNodeId: 'script', media, missingFirstFrames: 'generate' as const }
      expect(planScriptBatch(doc, [previz], params, catalog, null)).toEqual(planScriptBatch(doc, [], params, catalog, null))
      expect(planScriptBatch(doc, [first, previz], params, catalog, null)).toEqual(planScriptBatch(doc, [first], params, catalog, null))
    }
  })
  it('rejects a missing default instead of silently selecting an available service', () => {
    expect(() => planScriptBatch(doc, [], { scriptNodeId: 'script', media: 'frames' }, { ...catalog, defaults: {} }, null))
      .toThrow(expect.objectContaining({ message: 'No default generation service is available for image', details: { reason: 'generation.default_provider_unavailable', params: { kind: 'image' } } }))
  })
  it('uses setting versions after source nodes disappear and drops style samples before cast or continuity images', () => {
    const setting = (id: string, kind: 'character' | 'scene' | 'prop' | 'style', refs: string[]) => EntityView.parse({
      id, kind, name: id, description: kind === 'style' ? 'Ink' : '', revision: 1, createdAt: 1, updatedAt: 1,
      refs: refs.map(assetVersionId => ({ assetVersionId })), members: [], usage: { scriptNodeIds: [], shotCount: 0 },
    })
    const settings = [
      setting('hero', 'character', ['hero-front', 'hero-side']), setting('park', 'scene', ['park']),
      setting('key', 'prop', ['key']), setting('style', 'style', ['style-one', 'style-two']),
    ]
    const document = { ...doc, castIds: ['hero', 'park', 'key'], styleId: 'style', shots: [
      { ...doc.shots[0]!, characterIds: ['hero'], sceneId: 'park', propIds: ['key'] },
    ] }
    const providers = structuredClone(catalog)
    providers.providers[0]!.models[0]!.referenceImageLimit = 5
    const plan = planScriptBatch(document, [], { scriptNodeId: 'script', media: 'frames' }, providers, null, settings)
    expect(plan.steps[0]!.inputs).toEqual([
      { assetVersionId: 'hero-front' }, { assetVersionId: 'hero-side' }, { assetVersionId: 'park' }, { assetVersionId: 'key' },
      { assetVersionId: 'style-one', style: true },
    ])
    expect(plan.steps[1]!.inputs).toEqual([
      { assetVersionId: 'hero-front' }, { assetVersionId: 'hero-side' }, { assetVersionId: 'park' }, { assetVersionId: 'key' }, { step: 'a:first' },
    ])
    expect(plan.steps.map(step => step.prompt)).toEqual(['First A\nInk', 'Last A\nInk'])
    expect(plan.view.estimate).toMatchObject({ shotsMissingAssetImages: 0, styleRefsDropped: 3 })
    providers.providers[0]!.models[0]!.referenceImageLimit = 3
    const limited = planScriptBatch(document, [], { scriptNodeId: 'script', media: 'frames' }, providers, null, settings)
    expect(limited.steps.every(step => step.inputs.length <= 3)).toBe(true)
    expect(limited.view.estimate).toMatchObject({ styleRefsDropped: 4, castRefsDropped: 3 })
  })
  it('falls back from stale saved models and uses an explicit provider default without the saved model', () => {
    const providers = structuredClone(catalog)
    providers.providers.push({ id: 'other', paid: true, models: [{ id: 'other-video', kind: 'video', frameModes: [] }] })
    const script = { ...imageNode('a', 'first'), nodeId: 'script', kind: 'script' as const, generation: { provider: 'mock', model: 'mock-image-1' } }
    const params = { scriptNodeId: 'script', media: 'video' as const }
    expect(planScriptBatch(doc, [script], params, providers, null).view.estimate).toMatchObject({ provider: 'mock', model: 'mock-video-1' })
    script.generation = { provider: 'deleted', model: 'gone' }
    expect(planScriptBatch(doc, [script], params, providers, null).view.estimate.model).toBe('mock-video-1')
    script.generation = { provider: 'mock', model: 'mock-video-1' }
    expect(planScriptBatch(doc, [script], { ...params, provider: 'other' }, providers, null).view.estimate.model).toBe('other-video')
    expect(() => planScriptBatch(doc, [script], { ...params, provider: 'other', model: 'missing' }, providers, null)).toThrow()
  })
  it.each(['generate', 'skip'] as const)('plans only video jobs for prompt-only models with missing frames (%s)', missingFirstFrames => {
    const promptOnly = structuredClone(catalog)
    promptOnly.providers[0]!.paid = true
    promptOnly.providers[0]!.models[1]!.frameModes = []
    const plan = planScriptBatch(doc, [], { scriptNodeId: 'script', media: 'video', missingFirstFrames, strictShotIds: ['b'] }, promptOnly, null)
    expect(plan.steps.map(step => [step.key, step.dependencies, step.frames])).toEqual([
      ['a:video', [], undefined], ['b:video', [], undefined], ['c:video', [], undefined],
    ])
    expect(plan.view.estimate).toMatchObject({ jobs: 3, billedJobs: 3, shotsMissingFirstFrame: 0, frameMode: null })
  })
  it('keeps asset references on prompt-only video and sends only frames in frame modes', () => {
    const reference = { ...imageNode('ref', 'first'), nodeId: 'reference' }
    delete reference.shot
    const document = { ...doc, assets: [{ id: 'asset', rev: 1, kind: 'character' as const, name: 'Actor', description: '', imageNodeId: reference.nodeId }],
      shots: [{ ...doc.shots[0]!, characterIds: ['asset'] }] }
    const nodes = [reference, imageNode('a', 'first')]
    const params = { scriptNodeId: 'script', media: 'video' as const }
    expect(planScriptBatch(document, nodes, params, catalog, null).steps[0]!.inputs).toEqual([])
    const promptOnly = structuredClone(catalog)
    promptOnly.providers[0]!.models[1]!.frameModes = []
    expect(planScriptBatch(document, nodes, params, promptOnly, null).steps[0]!.inputs).toEqual([{ nodeId: 'reference' }])
  })
  it('uses explicit settings, saved script settings, then catalog defaults like single-node generation', () => {
    const providers = structuredClone(catalog)
    providers.providers.push({ id: 'other', paid: true, models: [{ id: 'other-image', kind: 'image', frameModes: [] }] })
    const script = { ...imageNode('a', 'first'), nodeId: 'script', kind: 'script' as const, generation: { provider: 'other', model: 'other-image' } }
    const params = { scriptNodeId: 'script', media: 'frames' as const }
    expect(planScriptBatch(doc, [script], params, providers, 4).view.estimate).toMatchObject({ provider: 'other', model: 'other-image', billedJobs: 4 })
    expect(planScriptBatch(doc, [script], { ...params, provider: 'mock', model: 'mock-image-1' }, providers, 4).view.estimate).toMatchObject({ provider: 'mock', model: 'mock-image-1', billedJobs: 0 })
    expect(planScriptBatch(doc, [], params, providers, 4).view.estimate).toMatchObject({ provider: 'mock', model: 'mock-image-1' })
  })
  it('orders continuous frames within chains and leaves cut chains independent', () => {
    const plan = planScriptBatch(doc, [], { scriptNodeId: 'script', media: 'frames' }, catalog, 5)
    expect(plan.steps.map(step => [step.key, step.dependencies])).toEqual([
      ['a:first', []], ['a:last', ['a:first']], ['b:first', ['a:last']], ['c:first', []],
    ])
    expect(plan.steps.map(step => step.prompt)).toEqual(['First A', 'Last A', 'First B', 'First C'])
    expect(plan.view.estimate).toMatchObject({ jobs: 4, billedJobs: 0, quotaRemaining: 5, shots: 3 })
    expect(doc.shots[0]!.rev).toBe(1)
  })
  it('uses first/last frames, reports fallback and skips or generates missing frames', () => {
    const nodes = [imageNode('a', 'first'), imageNode('a', 'last')]
    const params = { scriptNodeId: 'script', media: 'video' as const, missingFirstFrames: 'skip' as const }
    const plan = planScriptBatch(doc, nodes, params, catalog, null)
    expect(plan.steps).toHaveLength(1)
    expect(plan.steps[0]!.frames).toEqual({ first: { nodeId: 'node_a_first' }, last: { nodeId: 'node_a_last' } })
    expect(plan.view.shots[1]!.steps[0]!.status).toBe('skipped')
    expect(plan.view.estimate).toMatchObject({ frameMode: 'first_last', shotsMissingFirstFrame: 2 })
    const firstOnly = structuredClone(catalog)
    firstOnly.providers[0]!.models[1]!.frameModes = ['first']
    expect(planScriptBatch(doc, nodes, params, firstOnly, null).view.estimate.frameMode).toBe('first')
    firstOnly.providers[0]!.models[1]!.frameModes = []
    expect(planScriptBatch(doc, nodes, params, firstOnly, null).steps[0]!.frames).toBeUndefined()
    expect(planScriptBatch(doc, nodes, { ...params, missingFirstFrames: 'generate' }, catalog, null).view.estimate.jobs).toBe(5)
  })
  it('strict video waits for previous video then extraction, while ordinary video is parallel', () => {
    const plan = planScriptBatch(doc, doc.shots.map(shot => imageNode(shot.id, 'first')), { scriptNodeId: 'script', media: 'video', strictShotIds: ['b'] }, catalog, null)
    expect(plan.steps.map(step => [step.key, step.source, step.dependencies])).toEqual([
      ['a:video', 'generate', []], ['b:first', 'extract', ['a:video']], ['b:video', 'generate', ['b:first']], ['c:video', 'generate', []],
    ])
    expect(plan.view.estimate.jobs).toBe(3)
    expect(() => planScriptBatch(doc, [], { scriptNodeId: 'script', media: 'video', strictShotIds: ['a'] }, catalog, null)).toThrow(expect.objectContaining({ details: { reason: 'script.batch_strict_invalid', params: {} } }))
  })
})

let host: SpaceHost
let dir: string
let clock: number
let provider: ProviderAdapter
let scriptNodeId: string
let shotIds: string[]
let slotId: string
let media: MediaTools
const submitRequests: { key: string; kind: string }[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vis-batch-'))
  clock = 1_800_000_000_000
  submitRequests.length = 0
  const mock = createMockProvider({ latencyMs: 0, clock: () => clock })
  provider = { ...mock, submit: (request, options) => { submitRequests.push({ key: options.idempotencyKey, kind: request.kind }); return mock.submit(request, options) } }
  const frame = join(dir, 'frame.png')
  writeFileSync(frame, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=', 'base64'))
  media = {
    probe: vi.fn(), extractFrames: vi.fn(), analyzeSilence: vi.fn(),
    process: vi.fn(async () => ({ outputs: [{ kind: 'image' as const, mime: 'image/png', width: 1, height: 1, path: frame }], dispose: async () => {} })),
  }
  host = open()
  scriptNodeId = host.canvas.apply({ kind: 'user' }, { requestId: 'script', ops: [{ op: 'node.create', kind: 'script', tempId: 'script' }] }).idMap.script!
  slotId = host.canvas.get({ nodeIds: [scriptNodeId] }).nodes[0]!.slots.find(slot => slot.slotKey === 'main')!.slotId
  host.canvas.apply({ kind: 'user' }, { requestId: 'document', ops: [{ op: 'script.replace', slotId, expectedRevision: 1, doc: {
    shots: doc.shots.map(({ id, rev: _rev, ...shot }) => ({ ...shot, tempId: id })), assets: [],
  } }] })
  const content = host.canvas.get({ nodeIds: [scriptNodeId] }).nodes[0]!.slots.find(slot => slot.slotKey === 'main')!.content
  shotIds = content.type === 'script' ? content.doc.shots.map(shot => shot.id) : []
})
function open() {
  return openSpaceHost('space_batch', dir, { providers: [provider], defaults, runtimes: {}, now: () => clock, suspended: true, pollIntervalMs: 1, media })
}
afterEach(async () => {
  await host.close()
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})
function start(media: 'frames' | 'video' = 'frames', extra = {}) {
  return host.scriptBatches.start({ requestId: `start-${clock++}`, scriptNodeId, media, ...extra })
}
async function finish(batchId: string) {
  let batch: BatchView
  for (let i = 0; i < 100; i++) {
    clock += 10
    await host.generation.pump()
    await host.scriptBatches.pump()
    batch = await host.scriptBatches.get({ batchId })
    if (!['running', 'pending_approval'].includes(batch.status)) return batch
    await new Promise(resolve => setImmediate(resolve))
  }
  throw new Error('Batch did not finish')
}
function agent() {
  const sessionId = 'session_batch'
  host.db.insert(s.sessions).values({ id: sessionId, title: 'Batch agent', agentKind: 'codex', createdAt: clock }).run()
  host.db.insert(s.messages).values({ id: 'message_batch', sessionId, text: 'Generate frames', deliveryState: 'delivered', createdAt: clock }).run()
  host.db.insert(s.turns).values({ id: 'turn_batch', sessionId, messageId: 'message_batch', status: 'completed', startedAt: clock, endedAt: clock }).run()
  return { sessionId, turnId: 'turn_batch' }
}

describe('Script batch scheduling', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }) })

  it('materializes frame panels only at confirmation and reuses identical newest shot nodes', async () => {
    const asset = host.assets.registerVersion(host.db, { staged: await host.assets.stageBytes(Buffer.from('frame')), kind: 'image', mime: 'image/png', origin: 'import' })
    const previz = host.canvas.apply({ kind: 'user' }, { requestId: 'previz', ops: [{ op: 'node.create', kind: 'previz', tempId: 'p' }] }).idMap.p!
    const slot = host.canvas.get({ nodeIds: [previz] }).nodes[0]!.slots[0]!
    host.canvas.apply({ kind: 'user' }, { requestId: 'panel', ops: [{ op: 'previz.set', slotId: slot.slotId, expectedRevision: slot.revision,
      doc: { ...EMPTY_PREVIZ, panels: [{ ...emptyPrevizPanel('finished'), image: asset.assetVersionId, underlay: asset.assetVersionId, use: 'frame', frameRole: 'first', shot: { scriptNodeId, shotId: shotIds[2]! } },
        { ...emptyPrevizPanel('last-finished'), image: asset.assetVersionId, underlay: asset.assetVersionId, use: 'frame', frameRole: 'last', shot: { scriptNodeId, shotId: shotIds[2]! } }] } }] })
    const params = { scriptNodeId, media: 'frames' as const, shotIds: [shotIds[2]!] }
    const before = host.canvas.get({}).nodes.length
    expect(host.scriptBatches.plan(params).estimate).toMatchObject({ jobs: 0, panelFramesUsed: 2 })
    expect(host.canvas.get({}).nodes).toHaveLength(before)
    const first = host.scriptBatches.start({ requestId: 'first-panels', ...params })
    expect(first.estimate).toMatchObject({ jobs: 0, panelFramesUsed: 2 })
    expect(host.canvas.get({}).nodes).toHaveLength(before + 2)
    const materialized = host.canvas.get({}).nodes.filter(node => node.kind === 'image')
    const [a, b] = materialized
    expect(a!.x + a!.w <= b!.x || b!.x + b!.w <= a!.x || a!.y + a!.h <= b!.y || b!.y + b!.h <= a!.y).toBe(true)
    const reused = first.shots[0]!.steps[0]!.nodeId
    const next = host.scriptBatches.start({ requestId: 'second-panels', ...params })
    expect(host.canvas.get({}).nodes).toHaveLength(before + 2)
    expect(next.shots[0]!.steps[0]!.nodeId).toBe(reused)
    expect((await finish(first.batchId)).status).toBe('succeeded')
    expect((await finish(next.batchId)).status).toBe('succeeded')
    expect(submitRequests).toEqual([])
    host.canvas.apply({ kind: 'user' }, { requestId: 'remove-frame', ops: materialized.map(node => ({ op: 'node.delete', nodeId: node.nodeId })) })
    const pending = host.scriptBatches.start({ requestId: 'agent-panels', ...params }, agent())
    expect(pending.status).toBe('pending_approval')
    expect(host.canvas.get({}).nodes.filter(node => node.kind === 'image')).toHaveLength(0)
    const approved = host.scriptBatches.approve({ requestId: 'approve-panels', batchId: pending.batchId })
    expect(approved.estimate).toMatchObject({ jobs: 0, panelFramesUsed: 2 })
    expect(host.canvas.get({}).nodes.filter(node => node.kind === 'image')).toHaveLength(2)
    expect((await finish(pending.batchId)).status).toBe('succeeded')
    expect(submitRequests).toEqual([])
  })
  it('re-arms the fallback timer when a pump query fails once', async () => {
    host.scriptBatches.startScheduler()
    await host.scriptBatches.pump()
    start()
    const failure = new Error('Temporary batch query failure')
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(host.db, 'select').mockImplementationOnce(() => { throw failure })
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(log).toHaveBeenCalledWith('[script-batch] scheduling failed', failure)
      expect(vi.getTimerCount()).toBe(1)
      await vi.advanceTimersByTimeAsync(99)
      expect(host.db.select().from(s.generationJobs).all()).toHaveLength(0)
      await vi.advanceTimersByTimeAsync(1)
      expect(host.db.select().from(s.generationJobs).all()).toHaveLength(2)
    } finally { log.mockRestore() }
  })

  it('re-arms the fallback timer when a schedule query fails once', async () => {
    host.scriptBatches.startScheduler()
    await host.scriptBatches.pump()
    const failure = new Error('Temporary schedule query failure')
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const prepare = host.db.$client.prepare.bind(host.db.$client)
    let failed = false
    const query = vi.spyOn(host.db.$client, 'prepare').mockImplementation((...args) => {
      if (!failed && args[0].includes("'$.createdAt'")) { failed = true; throw failure }
      return prepare(...args)
    })
    try {
      expect(() => start()).not.toThrow()
      expect(failed).toBe(true)
      expect(log).toHaveBeenCalledWith('[script-batch] scheduling failed', failure)
      expect(vi.getTimerCount()).toBe(1)
      expect(host.db.select().from(s.generationJobs).all()).toHaveLength(0)
      await vi.advanceTimersByTimeAsync(0)
      expect(host.db.select().from(s.generationJobs).all()).toHaveLength(2)
    } finally { query.mockRestore(); log.mockRestore() }
  })

  it('waits 100 ms after a plain schedule query failure without an immediate wake', async () => {
    const pending = host.scriptBatches.start({ requestId: 'plain-schedule', scriptNodeId, media: 'frames' }, agent())
    host.scriptBatches.startScheduler()
    await host.scriptBatches.pump()
    clock += BATCH_APPROVAL_TTL_MS
    const failure = new Error('Schedule failed after a completed pump')
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const prepare = host.db.$client.prepare.bind(host.db.$client)
    let failed = false
    const query = vi.spyOn(host.db.$client, 'prepare').mockImplementation((...args) => {
      if (!failed && args[0].includes("'$.createdAt'")) { failed = true; throw failure }
      return prepare(...args)
    })
    try {
      expect((await host.scriptBatches.get({ batchId: pending.batchId })).status).toBe('expired')
      expect(failed).toBe(true)
      expect(log).toHaveBeenCalledWith('[script-batch] scheduling failed', failure)
      expect(vi.getTimerCount()).toBe(1)
      const select = vi.spyOn(host.db, 'select')
      await vi.advanceTimersByTimeAsync(99)
      expect(select).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(select).toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    } finally { query.mockRestore(); log.mockRestore() }
  })

  it('retains scheduling when a wake arrives between pump failure and cleanup', async () => {
    host.scriptBatches.startScheduler()
    await host.scriptBatches.pump()
    start()
    const log = vi.spyOn(console, 'error').mockImplementationOnce(() => { queueMicrotask(() => start()) })
    vi.spyOn(host.db, 'select').mockImplementationOnce(() => { throw new Error('Pump query failed during a concurrent wake') })
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(vi.getTimerCount()).toBe(1)
      await vi.advanceTimersByTimeAsync(100)
      expect(host.db.select().from(s.generationJobs).all().length).toBeGreaterThan(0)
    } finally { log.mockRestore() }
  })

  it('honors approval immediately after an in-flight generation read finishes', async () => {
    host.scriptBatches.startScheduler()
    await host.scriptBatches.pump()
    start()
    await vi.advanceTimersByTimeAsync(0)
    const pending = host.scriptBatches.start({ requestId: 'slow-approval', scriptNodeId, media: 'frames' }, agent())
    let release!: () => void
    let entered!: () => void
    const waiting = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const original = host.generation.get
    const get = vi.spyOn(host.generation, 'get').mockImplementationOnce(async params => { entered(); await gate; return original(params) })
    const pumping = host.scriptBatches.pump()
    await waiting
    host.scriptBatches.approve({ requestId: 'approve-slow', batchId: pending.batchId })
    release()
    await pumping
    const calls = get.mock.calls.length
    await vi.advanceTimersByTimeAsync(0)
    expect(get.mock.calls.length).toBeGreaterThan(calls)
  })

  it('honors approval immediately after an in-flight pump rejects', async () => {
    host.scriptBatches.startScheduler()
    await host.scriptBatches.pump()
    start()
    await vi.advanceTimersByTimeAsync(0)
    const pending = host.scriptBatches.start({ requestId: 'failing-approval', scriptNodeId, media: 'frames' }, agent())
    let release!: () => void
    let entered!: () => void
    const waiting = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const original = host.generation.get
    const get = vi.spyOn(host.generation, 'get').mockImplementationOnce(async params => {
      const result = await original(params)
      entered()
      await gate
      return result
    })
    const pumping = host.scriptBatches.pump()
    await waiting
    host.scriptBatches.approve({ requestId: 'approve-failing', batchId: pending.batchId })
    const failure = new Error('Pump failed after a concurrent approval')
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const query = vi.spyOn(host.db, 'select').mockImplementation(() => { throw failure })
    try {
      const rejected = expect(pumping).rejects.toThrow(failure)
      release()
      await rejected
      query.mockRestore()
      expect(log).toHaveBeenCalledWith('[script-batch] scheduling failed', failure)
      const calls = get.mock.calls.length
      await vi.advanceTimersByTimeAsync(0)
      expect(get.mock.calls.length).toBeGreaterThan(calls)
      const nextCalls = get.mock.calls.length
      await vi.advanceTimersByTimeAsync(99)
      expect(get.mock.calls.length).toBe(nextCalls)
      await vi.advanceTimersByTimeAsync(1)
      expect(get.mock.calls.length).toBeGreaterThan(nextCalls)
    } finally { query.mockRestore(); log.mockRestore() }
  })

  it('uses pump results to schedule without rescanning active statuses', async () => {
    start()
    host.scriptBatches.startScheduler()
    await host.scriptBatches.pump()
    const query = vi.spyOn(host.db.$client, 'prepare')
    try {
      await host.scriptBatches.pump()
      expect(query.mock.calls.filter(([text]) => text.includes('json_extract') && text.includes("'$.status'"))).toHaveLength(1)
      expect(vi.getTimerCount()).toBe(1)
    } finally { query.mockRestore() }
  })

  it('has no idle timer, wakes on start, and stops again on cancellation', async () => {
    host.scriptBatches.startScheduler()
    await host.scriptBatches.pump()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(1000)
    expect(host.db.select().from(s.generationJobs).all()).toHaveLength(0)
    const batch = start()
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(0)
    expect(host.db.select().from(s.generationJobs).all()).toHaveLength(2)
    await host.scriptBatches.cancel({ requestId: 'stop-scheduler-batch', batchId: batch.batchId })
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['reject', 'cancelSession'] as const)('clears the last pending timer on %s', async decision => {
    host.scriptBatches.startScheduler()
    await host.scriptBatches.pump()
    const caller = agent()
    const batch = host.scriptBatches.start({ requestId: 'pending-scheduler', scriptNodeId, media: 'frames' }, caller)
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBe(1)
    if (decision === 'reject') host.scriptBatches.reject({ requestId: 'reject-scheduler', batchId: batch.batchId })
    else await host.scriptBatches.cancelSession(caller.sessionId)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('expires at the earliest approval deadline, including a deadline between active polling ticks', async () => {
    const batch = host.scriptBatches.start({ requestId: 'expiry-scheduler', scriptNodeId, media: 'frames' }, agent())
    clock = batch.createdAt + BATCH_APPROVAL_TTL_MS - 25
    host.scriptBatches.startScheduler()
    await host.scriptBatches.pump()
    clock += 24
    await vi.advanceTimersByTimeAsync(24)
    expect(host.db.select().from(s.scriptBatches).where(eq(s.scriptBatches.id, batch.batchId)).get()!.view.status).toBe('pending_approval')
    clock++
    await vi.advanceTimersByTimeAsync(1)
    expect(host.db.select().from(s.scriptBatches).where(eq(s.scriptBatches.id, batch.batchId)).get()!.view.status).toBe('expired')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('wakes approved batches and observes generation completion while active', async () => {
    host.scriptBatches.startScheduler()
    await host.scriptBatches.pump()
    const batch = host.scriptBatches.start({ requestId: 'approval-scheduler', scriptNodeId, media: 'frames' }, agent())
    await vi.advanceTimersByTimeAsync(0)
    host.scriptBatches.approve({ requestId: 'approve-scheduler', batchId: batch.batchId })
    await vi.advanceTimersByTimeAsync(0)
    expect(host.db.select().from(s.generationJobs).all()).toHaveLength(2)
    host.db.update(s.generationJobs).set({ status: 'failed', error: { code: 'test_failure', message: 'Test failure' } }).run()
    await vi.advanceTimersByTimeAsync(100)
    expect((await host.scriptBatches.get({ batchId: batch.batchId })).status).toBe('failed')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('recovers running batches on scheduler startup without resubmitting existing jobs', async () => {
    const batch = start()
    await host.scriptBatches.pump()
    const jobs = host.db.select().from(s.generationJobs).all().map(job => job.id)
    await host.close()
    host = open()
    host.scriptBatches.startScheduler()
    await host.scriptBatches.pump()
    expect(host.db.select().from(s.generationJobs).all().map(job => job.id)).toEqual(jobs)
    expect((await host.scriptBatches.get({ batchId: batch.batchId })).status).toBe('running')
    const get = vi.spyOn(host.generation, 'get')
    await vi.advanceTimersByTimeAsync(100)
    expect(get).toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(1)
  })

  it('leaves paused-only projects asleep across restart and wakes immediately on resume', async () => {
    provider = { ...provider, type: 'volcengine-ark' }
    host.generation.configure([provider], defaults, { maxConcurrent: 3, dailyImage: 1, dailyVideo: 10, dailyAudio: 20 })
    host.scriptBatches.configure([provider], defaults)
    host.scriptBatches.startScheduler()
    await host.scriptBatches.pump()
    const batch = start()
    await vi.advanceTimersByTimeAsync(0)
    expect((await host.scriptBatches.get({ batchId: batch.batchId })).status).toBe('paused')
    expect(vi.getTimerCount()).toBe(0)
    await host.close()
    host = open()
    host.scriptBatches.startScheduler()
    await host.scriptBatches.pump()
    expect(vi.getTimerCount()).toBe(0)
    host.generation.configure([provider], defaults, { maxConcurrent: 3, dailyImage: 10, dailyVideo: 10, dailyAudio: 20 })
    host.scriptBatches.resume({ requestId: 'resume-scheduler', batchId: batch.batchId })
    await vi.advanceTimersByTimeAsync(0)
    expect(host.db.select().from(s.generationJobs).all()).toHaveLength(2)
  })
})

describe('Persisted script batch execution', () => {
  it('rereads a pending script only when its main revision changes', async () => {
    const batch = host.scriptBatches.start({ requestId: 'pending-cache', scriptNodeId, media: 'frames' }, agent())
    await host.scriptBatches.pump()
    const get = vi.spyOn(host.canvas, 'get')
    await host.scriptBatches.pump()
    await host.scriptBatches.get({ batchId: batch.batchId })
    host.scriptBatches.list({ activeOnly: true })
    expect(get).not.toHaveBeenCalled()
    host.canvas.apply({ kind: 'user' }, { requestId: 'edit-pending-cache', ops: [{ op: 'script.patch', slotId, ops: [
      { kind: 'shot.update', shotId: shotIds[0]!, rev: 1, fields: { framePrompt: 'New prompt' } },
    ] }] })
    get.mockClear()
    await host.scriptBatches.pump()
    expect(get).toHaveBeenCalledTimes(1)
    expect((await host.scriptBatches.get({ batchId: batch.batchId })).changedShotIds).toEqual([shotIds[0]])
  })
  it('does not load finished batch records or read scripts while pumping running batches', async () => {
    const finished = start()
    await host.scriptBatches.cancel({ requestId: 'finished-before-pump', batchId: finished.batchId })
    // Invalid archived execution would throw during JSON decoding if the scheduler loaded it.
    host.db.$client.prepare('UPDATE script_batches SET execution = ? WHERE id = ?').run('not-json', finished.batchId)
    const running = start()
    const canvasGet = vi.spyOn(host.canvas, 'get')
    await expect(host.scriptBatches.pump()).resolves.toBeUndefined()
    expect((await host.scriptBatches.get({ batchId: running.batchId })).status).toBe('running')
    // Target creation needs the script; polling the submitted jobs does not.
    canvasGet.mockClear()
    await host.scriptBatches.pump()
    expect(canvasGet).not.toHaveBeenCalled()
  })
  it.each(['approve', 'reject', 'cancel'] as const)('keeps %s while the pump awaits an earlier generation job', async decision => {
    const running = start()
    const pending = host.scriptBatches.start({ requestId: 'interleaved-agent', scriptNodeId, media: 'frames' }, agent())
    await host.scriptBatches.pump()
    let release!: () => void
    let entered!: () => void
    const waiting = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const get = host.generation.get
    vi.spyOn(host.generation, 'get').mockImplementationOnce(async params => { entered(); await gate; return get(params) })
    const pumping = host.scriptBatches.pump()
    await waiting
    const params = { requestId: 'interleaved-decision', batchId: pending.batchId }
    if (decision === 'cancel') await host.scriptBatches.cancel(params)
    else host.scriptBatches[decision](params)
    clock += BATCH_APPROVAL_TTL_MS
    release()
    await pumping
    expect((await host.scriptBatches.get({ batchId: pending.batchId })).status).toBe({ approve: 'running', reject: 'rejected', cancel: 'cancelled' }[decision])
    expect((await host.scriptBatches.get({ batchId: running.batchId })).status).toBe('running')
  })

  it('does not persist a stale running batch when generation.get fails after cancellation', async () => {
    const batch = start()
    await host.scriptBatches.pump()
    let release!: () => void
    let entered!: () => void
    const waiting = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    vi.spyOn(host.generation, 'get').mockImplementationOnce(async () => { entered(); await gate; throw new Error('Delayed read failed') })
    const pumping = host.scriptBatches.pump()
    await waiting
    await host.scriptBatches.cancel({ requestId: 'cancel-during-get', batchId: batch.batchId })
    release()
    await pumping
    expect((await host.scriptBatches.get({ batchId: batch.batchId })).status).toBe('cancelled')
    expect(host.db.select().from(s.generationJobs).all()).toHaveLength(2)
  })
  it('plans Agent videos using the video default when the script saved an image model', () => {
    host.canvas.apply({ kind: 'user' }, { requestId: 'saved-image', ops: [{ op: 'node.setGeneration', nodeId: scriptNodeId, generation: { provider: 'mock', model: 'mock-image-1' } }] })
    const batch = host.scriptBatches.start({ requestId: 'agent-video-default', scriptNodeId, media: 'video' }, agent())
    expect(batch).toMatchObject({ status: 'pending_approval', estimate: { model: 'mock-video-1' } })
    expect(host.db.select().from(s.generationJobs).all()).toHaveLength(0)
  })
  it('submits video with asset references to an adapter enforcing Ark frame constraints', async () => {
    const ark = createArkProvider({ id: 'test', dataDir: dir, baseUrl: 'https://unused.invalid',
      imageModels: [], videoModels: [{ id: 'unused', label: 'Unused' }], getKey: async () => { throw new Error('No real provider calls') } })
    provider = { ...provider, validateInputs: ark.validateInputs! }
    host.generation.configure([provider], defaults)
    expect((await finish(start().batchId)).status).toBe('succeeded')
    const reference = host.canvas.get({}).nodes.find(node => node.shot?.role === 'first' && node.shot.shotId === shotIds[2])!
    host.canvas.apply({ kind: 'user' }, { requestId: 'asset-reference', ops: [{ op: 'script.patch', slotId, ops: [
      { kind: 'asset.insert', tempId: 'actor', asset: { kind: 'character', name: 'Actor', description: '', imageNodeId: reference.nodeId } },
      { kind: 'shot.update', shotId: shotIds[0]!, rev: 1, fields: { characterIds: ['actor'], videoPrompt: `Follow {{ref:${reference.nodeId}}}` } },
    ] }] })
    const batch = start('video')
    const result = await finish(batch.batchId)
    expect(result.status).toBe('succeeded')
    const video = result.shots[0]!.steps.find(step => step.role === 'video')!
    expect(host.db.select().from(s.generationJobs).where(eq(s.generationJobs.id, video.jobId!)).get()!.params).toMatchObject({ prompt: 'Follow Actor' })
  })
  it('user start executes immediately, chains frames, and persists metadata and events', async () => {
    expect(host.scriptBatches.plan({ scriptNodeId, media: 'frames' }).estimate.jobs).toBe(4)
    expect(host.db.select().from(s.scriptBatches).all()).toHaveLength(0)
    const batch = start()
    expect(batch.status).toBe('running')
    await host.scriptBatches.pump()
    const queued = (await host.scriptBatches.get({ batchId: batch.batchId })).shots
    expect(queued[0]!.steps[0]!.jobId).toBeDefined()
    expect(queued[1]!.steps[0]!.jobId).toBeUndefined()
    expect(queued[2]!.steps[0]!.jobId).toBeDefined()
    const result = await finish(batch.batchId)
    expect(result.status).toBe('succeeded')
    expect(submitRequests).toHaveLength(4)
    const firstA = result.shots[0]!.steps[0]!
    const lastA = result.shots[0]!.steps[1]!
    const firstB = result.shots[1]!.steps[0]!
    const nodes = host.canvas.get({}).nodes
    expect(nodes.find(node => node.nodeId === lastA.nodeId)!.inputs).toContain(firstA.nodeId)
    expect(nodes.find(node => node.nodeId === firstB.nodeId)!.inputs).toContain(lastA.nodeId)
    expect(nodes.find(node => node.nodeId === firstB.nodeId)!.shot).toEqual({ scriptNodeId, shotId: shotIds[1], role: 'first' })
    expect(host.db.select().from(s.events).all().some(event => event.type === 'scriptBatch.stateChanged')).toBe(true)
  })

  it('Agent batches submit nothing before approval; rejection and expiry never submit', async () => {
    const caller = agent()
    const make = (requestId: string) => host.scriptBatches.start({ requestId, scriptNodeId, media: 'frames' }, caller)
    const rejected = make('reject')
    const expired = make('expire')
    expect(rejected.status).toBe('pending_approval')
    await host.scriptBatches.pump()
    expect(submitRequests).toHaveLength(0)
    expect(host.db.select().from(s.generationJobs).all()).toHaveLength(0)
    const entry = host.sessions.getTranscript({ sessionId: caller.sessionId, limit: 50 }).items.find(item => item.kind === 'approval')!
    expect(entry.payload).toMatchObject({ kind: 'generation_batch', batchId: rejected.batchId, status: 'pending' })
    expect(() => host.sessions.respondApproval({ requestId: 'generic', approvalId: entry.itemId, decision: 'allow_once' })).toThrow(expect.objectContaining({ code: 'invalid_params' }))
    expect(host.scriptBatches.reject({ requestId: 'rejected', batchId: rejected.batchId }).status).toBe('rejected')
    clock += BATCH_APPROVAL_TTL_MS
    expect((await host.scriptBatches.get({ batchId: expired.batchId })).status).toBe('expired')
    expect(submitRequests).toHaveLength(0)
    expect(host.db.select().from(s.generationJobs).all()).toHaveLength(0)
  })

  it('approval recomputes edited rows, runs after the Agent turn ends, and survives pending restart', async () => {
    const caller = agent()
    const batch = host.scriptBatches.start({ requestId: 'approval', scriptNodeId, media: 'frames' }, caller)
    await host.close()
    host = open()
    host.sessions.recover()
    const content = host.canvas.get({ nodeIds: [scriptNodeId] }).nodes[0]!.slots.find(slot => slot.slotKey === 'main')!.content
    if (content.type !== 'script') throw new Error('Expected script')
    const shot = content.doc.shots[0]!
    host.canvas.apply({ kind: 'user' }, { requestId: 'edit', ops: [{ op: 'script.patch', slotId, ops: [{ kind: 'shot.update', shotId: shot.id, rev: shot.rev, fields: { framePrompt: 'Changed prompt' } }] }] })
    expect((await host.scriptBatches.get({ batchId: batch.batchId })).changedShotIds).toEqual([shot.id])
    expect(host.scriptBatches.list({ activeOnly: true }).batches[0]!.changedShotIds).toEqual([shot.id])
    expect(host.db.select().from(s.generationJobs).all()).toHaveLength(0)
    const approved = host.scriptBatches.approve({ requestId: 'approve', batchId: batch.batchId })
    expect(approved.changedShotIds).toEqual([shot.id])
    expect((await finish(batch.batchId)).status).toBe('succeeded')
    expect(host.sessions.getTranscript({ sessionId: caller.sessionId, limit: 50 }).items.find(item => item.kind === 'approval')!.payload).toMatchObject({ status: 'approved' })
    expect(host.db.select().from(s.generationJobs).all().every(job => job.sessionId === null)).toBe(true)
  })

  it('pending reads and events expose edits and deleted shots without planning or submitting work', async () => {
    const caller = agent()
    const batch = host.scriptBatches.start({ requestId: 'pending-edits', scriptNodeId, media: 'frames', shotIds: [shotIds[0]!, shotIds[1]!] }, caller)
    const content = host.canvas.get({ nodeIds: [scriptNodeId] }).nodes[0]!.slots.find(slot => slot.slotKey === 'main')!.content
    if (content.type !== 'script') throw new Error('Expected script')
    const [first, second] = content.doc.shots
    host.canvas.apply({ kind: 'user' }, { requestId: 'pending-row-edits', ops: [{ op: 'script.patch', slotId, ops: [
      { kind: 'shot.update', shotId: first!.id, rev: first!.rev, fields: { framePrompt: 'Edited while pending' } },
      { kind: 'shot.delete', shotId: second!.id, rev: second!.rev },
    ] }] })
    const before = host.db.select().from(s.events).all().length
    expect((await host.scriptBatches.get({ batchId: batch.batchId })).changedShotIds).toEqual([first!.id, second!.id])
    expect(host.scriptBatches.list({ activeOnly: true }).batches[0]!.changedShotIds).toEqual([first!.id, second!.id])
    expect(host.db.select().from(s.events).all()).toHaveLength(before)
    await host.scriptBatches.pump()
    const event = host.db.select().from(s.events).all().filter(event => event.type === 'scriptBatch.stateChanged').at(-1)!
    expect(event.payload).toMatchObject({ status: 'pending_approval', changedShotIds: [first!.id, second!.id] })
    expect(host.db.select().from(s.generationJobs).all()).toHaveLength(0)
    expect(host.db.select().from(s.mediaTasks).all()).toHaveLength(0)
    expect(host.scriptBatches.approve({ requestId: 'approve-current-rows', batchId: batch.batchId }).shots.map(shot => shot.shotId)).toEqual([first!.id])
  })

  it('replays deterministic submission after a crash between job commit and batch save', async () => {
    const batch = start()
    await host.scriptBatches.pump()
    await host.generation.pump()
    const saved = host.db.select().from(s.scriptBatches).where(eq(s.scriptBatches.id, batch.batchId)).get()!
    const view = saved.view
    delete view.shots[0]!.steps[0]!.jobId
    view.shots[0]!.steps[0]!.status = 'queued'
    host.db.update(s.scriptBatches).set({ view }).where(eq(s.scriptBatches.id, batch.batchId)).run()
    await host.close()
    host = open()
    host.generation.start()
    await host.generation.stop()
    expect((await finish(batch.batchId)).status).toBe('succeeded')
    expect(host.db.select().from(s.generationJobs).all()).toHaveLength(4)
    expect(new Set(submitRequests.map(request => request.key)).size).toBe(4)
    expect(submitRequests).toHaveLength(4)
  })

  it('strict videos extract after the previous video and before the next video', async () => {
    expect((await finish(start().batchId)).status).toBe('succeeded')
    const batch = start('video', { strictShotIds: [shotIds[1]] })
    await host.scriptBatches.pump()
    expect(media.process).not.toHaveBeenCalled()
    const result = await finish(batch.batchId)
    expect(result.status).toBe('succeeded')
    expect(media.process).toHaveBeenCalledTimes(1)
    expect(result.shots[1]!.steps[0]).toMatchObject({ role: 'first', source: 'extract', status: 'succeeded' })
    const video = result.shots[1]!.steps[1]!
    const job = host.db.select().from(s.generationJobs).where(eq(s.generationJobs.id, video.jobId!)).get()!
    expect(job.params).toHaveProperty('frameRefs')
    expect(result.estimate.jobs).toBe(3)
  })

  it('pauses paid batches at the total daily limit and resumes without consuming Agent quota', async () => {
    provider = { ...provider, type: 'volcengine-ark' }
    host.generation.configure([provider], defaults, { maxConcurrent: 3, dailyImage: 1, dailyVideo: 10, dailyAudio: 20 })
    host.scriptBatches.configure([provider], defaults)
    const batch = start()
    expect((await finish(batch.batchId)).status).toBe('paused')
    expect(host.generation.usage()).toMatchObject({ image: 1, agent: { image: 0 } })
    host.generation.configure([provider], defaults, { maxConcurrent: 3, dailyImage: 10, dailyVideo: 10, dailyAudio: 20 })
    expect(host.scriptBatches.resume({ requestId: 'resume', batchId: batch.batchId }).status).toBe('running')
    expect((await finish(batch.batchId)).status).toBe('succeeded')
    expect(host.generation.usage()).toMatchObject({ image: 4, agent: { image: 0 } })
  })

  it('cancels queued and submitted work, preserves provider cancellation and enforces ownership', async () => {
    const caller = agent()
    const pending = host.scriptBatches.start({ requestId: 'cancel-agent', scriptNodeId, media: 'frames' }, caller)
    await expect(host.scriptBatches.cancel({ requestId: 'wrong-session', batchId: pending.batchId }, 'session_other')).rejects.toMatchObject({ code: 'forbidden' })
    expect((await host.scriptBatches.cancel({ requestId: 'cancel-pending', batchId: pending.batchId }, caller.sessionId)).status).toBe('cancelled')
    const batch = start()
    await host.scriptBatches.pump()
    await host.generation.pump()
    const cancelled = await host.scriptBatches.cancel({ requestId: 'cancel-user', batchId: batch.batchId })
    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.shots.every(shot => shot.steps.every(step => step.status === 'cancelled'))).toBe(true)
    await host.scriptBatches.pump()
    const jobs = host.db.select().from(s.generationJobs).all()
    expect(jobs).toHaveLength(2)
    expect(jobs.every(job => job.status === 'cancelled' && job.providerCancelled === true)).toBe(true)
  })

  it('fails dependants without stopping independent chains', async () => {
    const batch = start()
    await host.scriptBatches.pump()
    const first = (await host.scriptBatches.get({ batchId: batch.batchId })).shots[0]!.steps[0]!
    host.db.update(s.generationJobs).set({ status: 'failed', error: { code: 'test_failure', message: 'Test failure' } }).where(eq(s.generationJobs.id, first.jobId!)).run()
    const result = await finish(batch.batchId)
    expect(result.status).toBe('failed')
    expect(result.shots[0]!.steps[1]!.status).toBe('skipped')
    expect(result.shots[1]!.steps[0]!.status).toBe('skipped')
    expect(result.shots[2]!.steps[0]!.status).toBe('succeeded')
  })
})
