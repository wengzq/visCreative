import { execFile, execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createAssetStore, detectVideoEncoder, probeTimelineSource, renderTimeline, type RenderedTimeline, type VideoEncoder } from '@vis/assets'
import { createCanvasService } from '@vis/canvas-core'
import { createNodeWithSlot, insertOperation, writeSlotRevision } from '../../../packages/canvas/core/src/write'
import { VisError } from '@vis/domain'
import type { MediaTaskProgress, TimelineClip, TimelineDoc, TimelineTrack } from '@vis/protocol'
import { eq, openSpaceDb, readEventsAfter, spaceSchema as s } from '@vis/storage'
import { createMediaTaskService, MediaScheduler, readActiveMediaTasks } from './media-tasks'
import type { TimelineExportTools } from './timeline-export'

const exec = promisify(execFile)
const encoder: VideoEncoder = { name: 'libx264', hardware: false, args: ['-preset', 'ultrafast', '-crf', '23', '-pix_fmt', 'yuv420p'] }
const user = { kind: 'user' } as const
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const clip = (assetVersionId: string, overrides: Partial<TimelineClip> = {}): TimelineClip => ({
  id: `clip-${assetVersionId}`, source: { nodeId: 'original-source', assetVersionId },
  startMs: 0, inMs: 0, outMs: 1000, volume: 1, fadeInMs: 0, fadeOutMs: 0, ...overrides,
})
const track = (clips: TimelineClip[], overrides: Partial<TimelineTrack> = {}): TimelineTrack => ({
  id: 'video', kind: 'video', muted: false, volume: 1, clips, ...overrides,
})
const document = (...tracks: TimelineTrack[]): TimelineDoc => ({ version: 1, tracks })

async function fixture(options: { timeline?: TimelineExportTools; timeoutMs?: number; now?: () => number; onProgress?: (event: MediaTaskProgress) => void } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'vis-export-task-'))
  const db = openSpaceDb(':memory:')
  const assets = createAssetStore({ blobsDir: join(dir, 'blobs') })
  const canvas = createCanvasService({ db })
  const source = assets.registerVersion(db, { staged: await assets.stageBytes(Buffer.from('fake video source')), kind: 'video', mime: 'video/mp4', origin: 'import', width: 320, height: 240, durationMs: 1000 })
  const doc = document(track([clip(source.assetVersionId)]))
  insertOperation(db, { id: 'seed', actor: user }, 1)
  const node = createNodeWithSlot(db, { kind: 'timeline', x: 0, y: 0, w: 320, h: 200, title: 'Rough cut', content: { timeline: doc } }, 'seed', 1)
  const pending: { doc: TimelineDoc; progress(value: number): void; complete(): void; disposed: ReturnType<typeof vi.fn> }[] = []
  const render: typeof renderTimeline = vi.fn(async (submitted, _sources, opts) => await new Promise<RenderedTimeline>((resolve, reject) => {
    const path = join(dir, `output-${pending.length}.mp4`)
    writeFileSync(path, `fake export ${pending.length}`)
    const disposed = vi.fn(async () => {})
    const abort = () => reject(opts.signal!.reason)
    opts.signal!.addEventListener('abort', abort, { once: true })
    pending.push({
      doc: submitted, disposed,
      progress(value) { opts.onProgress?.(value) },
      complete() {
        opts.signal!.removeEventListener('abort', abort)
        resolve({ path, kind: 'video', mime: 'video/mp4', width: 320, height: 240, durationMs: 1000, mode: 'encode', dispose: disposed })
      },
    })
  }))
  const detectEncoder = vi.fn(async () => encoder)
  const service = createMediaTaskService({ db, assets, scheduler: new MediaScheduler(), ...options, timeline: { render, detectEncoder, ...options.timeline } })
  const params = { requestId: 'export', operation: 'timeline.export' as const, params: {}, nodeId: node.nodeId, slotId: node.slotId, expectedRevision: 1 }
  cleanups.push(async () => {
    await service.stop()
    db.$client.close()
    rmSync(dir, { recursive: true, force: true })
  })
  function revise(next: TimelineDoc) {
    const current = db.select().from(s.slots).where(eq(s.slots.id, node.slotId)).get()!
    writeSlotRevision(db, node.slotId, current.currentRevision, { timeline: next }, 'seed', 2)
  }
  return { dir, db, assets, canvas, source, doc, node, pending, render, detectEncoder, service, params, revise }
}

it('deduplicates exports, records a null single source, publishes progress, and creates one undoable derived node', async () => {
  let clock = 1000
  const progress: MediaTaskProgress[] = []
  const f = await fixture({ now: () => clock, onProgress: event => progress.push(event) })
  const task = await f.service.process(user, f.params)
  await expect.poll(() => f.pending.length).toBe(1)
  expect((await f.service.process(user, { ...f.params, waitMs: 1 })).taskId).toBe(task.taskId)
  expect(f.render).toHaveBeenCalledTimes(1)
  expect(f.db.select().from(s.mediaTasks).get()).toMatchObject({ sourceAssetVersionId: null, expectedRevision: 1, sourceLayoutRevision: 1 })
  f.pending[0]!.progress(0.5)
  clock += 100
  f.pending[0]!.progress(0.6)
  clock += 200
  f.pending[0]!.progress(0.7)
  f.pending[0]!.progress(0.1)
  expect(progress.map(event => event.progress)).toEqual([0.5, 0.7])
  expect((await f.service.get({ taskId: task.taskId })).progress).toBe(0.7)
  expect(f.db.select().from(s.mediaTasks).get()!.progress).toBeNull()
  f.pending[0]!.complete()
  const result = await f.service.get({ taskId: task.taskId, waitMs: 1000 })
  expect(result).toMatchObject({ status: 'succeeded', nodeIds: [expect.any(String)], operationId: expect.any(String) })
  const output = f.canvas.get({ nodeIds: result.nodeIds! }).nodes[0]!
  expect(output).toMatchObject({ kind: 'video', title: 'Rough cut \u00b7 r1', inputs: [f.node.nodeId], exportOf: { timelineNodeId: f.node.nodeId, timelineRevision: 1 } })
  expect(output.x >= 320 || output.y >= 200 || output.x + output.w <= 0 || output.y + output.h <= 0).toBe(true)
  const version = f.assets.getVersion(f.db, result.assetVersionIds![0]!)!
  expect(f.db.select().from(s.assets).where(eq(s.assets.id, version.assetId)).get()!.origin).toBe('derived')
  expect(version).toMatchObject({ width: 320, height: 240, durationMs: 1000 })
  expect(readEventsAfter(f.db, 0).filter(event => event.type === 'mediaTask.stateChanged').map(event => (event.payload as { status: string }).status)).toEqual(['queued', 'running', 'succeeded'])
  f.canvas.undo({ requestId: 'undo-export' })
  expect(f.canvas.get({}).nodes.map(node => node.nodeId)).toEqual([f.node.nodeId])
  f.canvas.redo({ requestId: 'redo-export' })
  expect(f.canvas.get({ nodeIds: result.nodeIds! }).nodes[0]!.exportOf).toEqual(output.exportOf)
})

it('rejects stale revisions, empty documents, and non-timeline slots before enqueueing', async () => {
  const f = await fixture()
  await expect(f.service.process(user, { ...f.params, expectedRevision: 2 })).rejects.toMatchObject({ code: 'revision_conflict', details: { reason: 'media.revision_conflict' } })
  f.revise(document())
  await expect(f.service.process(user, { ...f.params, expectedRevision: 2 })).rejects.toMatchObject({ code: 'invalid_params', details: { reason: 'timeline.empty' } })
  const image = createNodeWithSlot(f.db, { kind: 'text', x: 400, y: 0, w: 200, h: 100, content: { text: 'Content' } }, 'seed', 1)
  await expect(f.service.process(user, { ...f.params, nodeId: image.nodeId, slotId: image.slotId })).rejects.toMatchObject({ code: 'invalid_params', details: { reason: 'media.kind_mismatch' } })
  expect(f.db.select().from(s.mediaTasks).all()).toEqual([])
})

it.each(['version', 'blob'] as const)('rejects a missing source %s in the project before rendering', async missing => {
  const f = await fixture()
  if (missing === 'version') {
    f.doc.tracks[0]!.clips[0]!.source.assetVersionId = 'version-from-another-project'
    f.revise(f.doc)
  } else unlinkSync(f.assets.blobPath(f.assets.getVersion(f.db, f.source.assetVersionId)!.blobHash))
  const task = await f.service.process(user, { ...f.params, expectedRevision: missing === 'version' ? 2 : 1 })
  expect(await f.service.get({ taskId: task.taskId, waitMs: 1000 })).toMatchObject({ status: 'failed', error: { code: 'timeline.source_missing' } })
  expect(f.render).not.toHaveBeenCalled()
})

it.each(['running', 'queued', 'staging'] as const)('exports the submitted revision despite %s edits and layout changes', async phase => {
  const f = await fixture()
  const tasks = phase === 'queued'
    ? await Promise.all(['first', 'second'].map(requestId => f.service.process(user, { ...f.params, requestId })))
    : []
  const task = await f.service.process(user, f.params)
  await expect.poll(() => f.pending.length).toBe(phase === 'queued' ? 2 : 1)
  const edit = () => {
    f.revise(document())
    f.canvas.apply(user, { requestId: 'layout', ops: [{ op: 'node.layout', nodeId: f.node.nodeId, x: 1000 }] })
  }
  if (phase === 'staging') {
    const stage = f.assets.stageFile.bind(f.assets)
    vi.spyOn(f.assets, 'stageFile').mockImplementation(async path => { const blob = await stage(path); edit(); return blob })
  } else edit()
  if (phase === 'queued') {
    f.pending[0]!.complete()
    await f.service.get({ taskId: tasks[0]!.taskId, waitMs: 1000 })
    await expect.poll(() => f.pending.length).toBe(3)
    f.pending[1]!.complete()
  }
  const pending = f.pending.at(-1)!
  expect(pending.doc).toEqual(f.doc)
  pending.complete()
  const result = await f.service.get({ taskId: task.taskId, waitMs: 1000 })
  expect(result.status).toBe('succeeded')
  expect(f.canvas.get({ nodeIds: result.nodeIds! }).nodes[0]!.exportOf).toEqual({ timelineNodeId: f.node.nodeId, timelineRevision: 1 })
})

it.each(['running', 'staging'] as const)('creates an output without inputs when the timeline is deleted during %s', async phase => {
  const f = await fixture()
  const task = await f.service.process(user, f.params)
  await expect.poll(() => f.pending.length).toBe(1)
  const remove = () => f.canvas.apply(user, { requestId: 'delete', ops: [{ op: 'node.delete', nodeId: f.node.nodeId }] })
  if (phase === 'staging') {
    const stage = f.assets.stageFile.bind(f.assets)
    vi.spyOn(f.assets, 'stageFile').mockImplementation(async path => { const blob = await stage(path); remove(); return blob })
  } else remove()
  f.pending[0]!.complete()
  const result = await f.service.get({ taskId: task.taskId, waitMs: 1000 })
  expect(result.status).toBe('succeeded')
  const output = f.canvas.get({ nodeIds: result.nodeIds! }).nodes[0]!
  expect(output.inputs ?? []).toEqual([])
  expect(f.db.select().from(s.nodeInputs).where(eq(s.nodeInputs.nodeId, output.nodeId)).all()).toEqual([])
  expect(output.exportOf).toEqual({ timelineNodeId: f.node.nodeId, timelineRevision: 1 })
})

it('leaves untitled exports without a title', async () => {
  const f = await fixture()
  f.db.update(s.nodes).set({ title: null }).where(eq(s.nodes.id, f.node.nodeId)).run()
  const task = await f.service.process(user, f.params)
  await expect.poll(() => f.pending.length).toBe(1)
  f.pending[0]!.complete()
  const result = await f.service.get({ taskId: task.taskId, waitMs: 1000 })
  expect(f.canvas.get({ nodeIds: result.nodeIds! }).nodes[0]!.title).toBeNull()
})

it('maps a failed encoder detection without calling the renderer', async () => {
  const f = await fixture({ timeline: { detectEncoder: async () => { throw VisError.of('unavailable', 'media.encoder_missing', {}, 'No usable H.264 encoder was found') } } })
  const task = await f.service.process(user, f.params)
  expect(await f.service.get({ taskId: task.taskId, waitMs: 1000 })).toMatchObject({ status: 'failed', error: { code: 'media.encoder_missing' } })
  expect(f.render).not.toHaveBeenCalled()
})

it('times out and aborts the timeline renderer without registering output assets', async () => {
  const f = await fixture({ timeoutMs: 100 })
  const task = await f.service.process(user, f.params)
  expect(await f.service.get({ taskId: task.taskId, waitMs: 1000 })).toMatchObject({ status: 'failed', error: { code: 'media.timeout' } })
  expect(f.db.select().from(s.assetVersions).all()).toHaveLength(1)
  expect(await f.assets.findOrphanBlobs(f.db)).toEqual([])
})

it('cancels queued and running exports when their agent session stops', async () => {
  const f = await fixture()
  f.db.insert(s.sessions).values({ id: 'agent', agentKind: 'codex', title: 'Agent', createdAt: 1 }).run()
  f.db.insert(s.agentInstances).values({ id: 'instance', sessionId: 'agent', status: 'ready', tokenHash: 'fake', startedAt: 1 }).run()
  f.db.insert(s.messages).values({ id: 'message', sessionId: 'agent', text: 'Export', deliveryState: 'submitted', createdAt: 1 }).run()
  f.db.insert(s.turns).values({ id: 'turn', sessionId: 'agent', instanceId: 'instance', messageId: 'message', status: 'running', startedAt: 1 }).run()
  const tasks = await Promise.all(['first', 'second', 'third'].map(requestId => f.service.process({ kind: 'agent', sessionId: 'agent' }, { ...f.params, requestId })))
  await expect.poll(() => f.pending.length).toBe(2)
  f.service.cancelSession('agent')
  for (const task of tasks) expect(await f.service.get({ taskId: task.taskId, waitMs: 1000 })).toMatchObject({ status: 'failed', error: { code: 'media.cancelled' } })
  expect(f.db.select().from(s.assetVersions).all()).toHaveLength(1)
  expect(readActiveMediaTasks(f.db)).toEqual([])
})

it('recovers queued and running timeline exports as interrupted without rendering again', async () => {
  const f = await fixture()
  const task = await f.service.process(user, f.params)
  await expect.poll(() => f.pending.length).toBe(1)
  await f.service.stop()
  const row = f.db.select().from(s.mediaTasks).get()!
  f.db.update(s.mediaTasks).set({ status: 'running', error: null }).where(eq(s.mediaTasks.id, task.taskId)).run()
  f.db.insert(s.mediaTasks).values({ ...row, id: 'queued', requestId: 'queued', status: 'queued', error: null }).run()
  const recovered = createMediaTaskService({ db: f.db, assets: f.assets })
  try {
    expect(f.db.select().from(s.mediaTasks).all().map(task => task.error?.code)).toEqual(['media.interrupted', 'media.interrupted'])
    expect(f.render).toHaveBeenCalledTimes(1)
  } finally { await recovered.stop() }
})

const available = (() => {
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true } catch { return false }
})()

describe.skipIf(!available)('Timeline media tasks with real ffmpeg', () => {
  let dir: string
  let one: string
  let two: string
  let music: string
  const ffmpeg = (args: string[]) => exec('ffmpeg', ['-hide_banner', '-v', 'error', '-nostdin', ...args], { windowsHide: true, shell: false })
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "vis-export space \u526a\u8f91's-"))
    one = join(dir, 'one.mp4')
    two = join(dir, 'two.mp4')
    music = join(dir, 'music.wav')
    await ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30:duration=1', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-y', one])
    await ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=1', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-an', '-y', two])
    await ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=660:duration=2', '-y', music])
  }, 20_000)
  afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

  async function realFixture(detectEncoder: typeof detectVideoEncoder = detectVideoEncoder) {
    const render = vi.fn(renderTimeline)
    const f = await fixture({ timeline: { render, detectEncoder } })
    async function register(path: string, kind: 'video' | 'audio', durationMs: number) {
      return f.assets.registerVersion(f.db, { staged: await f.assets.stageFile(path), kind, mime: kind === 'video' ? 'video/mp4' : 'audio/wav', origin: 'import', durationMs }).assetVersionId
    }
    const ids = { one: await register(one, 'video', 1000), two: await register(two, 'video', 1000), music: await register(music, 'audio', 2000) }
    async function exportDoc(doc: TimelineDoc) {
      f.revise(doc)
      const task = await f.service.process(user, { ...f.params, expectedRevision: 2 })
      const result = await f.service.get({ taskId: task.taskId, waitMs: 30_000 })
      expect(result, JSON.stringify(result.error)).toMatchObject({ status: 'succeeded' })
      const output = f.canvas.get({ nodeIds: result.nodeIds! }).nodes[0]!
      const version = f.assets.getVersion(f.db, result.assetVersionIds![0]!)!
      const info = await probeTimelineSource(f.assets.blobPath(version.blobHash))
      return { result, output, version, info }
    }
    return { ...f, ids, exportDoc, realRender: render }
  }

  it('exports mixed video sizes, a missing soundtrack, and music fades to the requested resolution', async () => {
    const f = await realFixture()
    const { output, version, info } = await f.exportDoc({
      ...document(
        track([clip(f.ids.one), clip(f.ids.two, { startMs: 1000 })]),
        track([clip(f.ids.music, { outMs: 2000, fadeInMs: 200, fadeOutMs: 400 })], { id: 'music', kind: 'audio', volume: 0.4 }),
      ),
      output: { width: 480, height: 270, fps: 30 },
    })
    expect(output).toMatchObject({ kind: 'video', inputs: [f.node.nodeId], exportOf: { timelineNodeId: f.node.nodeId, timelineRevision: 2 } })
    expect(version).toMatchObject({ mime: 'video/mp4', width: 480, height: 270, fps: 30 })
    expect(Math.abs(info.probedDurationMs! - 2000)).toBeLessThanOrEqual(100)
    expect(info.video).toMatchObject({ width: 480, height: 270 })
    expect(info.audio).toMatchObject({ codec: 'aac', channels: 2, sampleRate: 48000 })
  }, 30_000)

  it('exports an audio-only timeline to an m4a audio asset', async () => {
    const f = await realFixture()
    const { output, version, info } = await f.exportDoc(document(track([clip(f.ids.music, { outMs: 2000, fadeOutMs: 200 })], { kind: 'audio' })))
    expect(output.kind).toBe('audio')
    expect(version.mime).toBe('audio/mp4')
    expect(info.video).toBeUndefined()
    expect(info.audio).toMatchObject({ codec: 'aac', channels: 2 })
    expect((await f.realRender.mock.results[0]!.value).path).toMatch(/\.m4a$/)
  }, 30_000)

  it('exports audio-only timelines without an H.264 encoder', async () => {
    const detect = vi.fn(async () => { throw VisError.of('unavailable', 'media.encoder_missing', {}, 'No usable H.264 encoder was found') })
    const f = await realFixture(detect)
    const { output } = await f.exportDoc(document(track([clip(f.ids.music, { outMs: 2000 })], { kind: 'audio' })))
    expect(output.kind).toBe('audio')
    expect(detect).not.toHaveBeenCalled()
  }, 30_000)

  it('copies identical whole-asset videos and derives dimensions from the first clip', async () => {
    const f = await realFixture()
    const { output, version, info } = await f.exportDoc(document(track([clip(f.ids.one), clip(f.ids.one, { id: 'again', startMs: 1000 })])))
    expect(output.kind).toBe('video')
    expect(version).toMatchObject({ width: 320, height: 240 })
    expect((await f.realRender.mock.results[0]!.value).mode).toBe('copy')
    expect(Math.abs(info.probedDurationMs! - 2000)).toBeLessThanOrEqual(100)
  }, 30_000)

  it.skipIf(!process.env.VIS_A2_BENCHMARK)('measures two ten-second 1080p clips plus music with the detected real encoder', async () => {
    const f = await realFixture()
    const paths = [join(dir, 'benchmark-one.mp4'), join(dir, 'benchmark-two.mp4'), join(dir, 'benchmark-music.wav')]
    for (const [i, path] of paths.entries()) {
      await ffmpeg(i < 2
        ? ['-f', 'lavfi', '-i', `testsrc2=size=1920x1080:rate=30:duration=10`, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-an', '-y', path]
        : ['-f', 'lavfi', '-i', 'sine=frequency=660:duration=20', '-y', path])
    }
    const ids: string[] = []
    for (const [i, path] of paths.entries()) {
      ids.push(f.assets.registerVersion(f.db, { staged: await f.assets.stageFile(path), kind: i < 2 ? 'video' : 'audio', mime: i < 2 ? 'video/mp4' : 'audio/wav', origin: 'import', durationMs: i < 2 ? 10_000 : 20_000 }).assetVersionId)
    }
    const selected = await detectVideoEncoder()
    const start = performance.now()
    const { version } = await f.exportDoc({
      ...document(track([clip(ids[0]!, { outMs: 10_000 }), clip(ids[1]!, { startMs: 10_000, outMs: 10_000 })]),
        track([clip(ids[2]!, { outMs: 20_000, fadeOutMs: 500 })], { id: 'music', kind: 'audio', volume: 0.4 })),
      output: { width: 1920, height: 1080, fps: 30 },
    })
    const measurement = { clips: 2, durationMs: version.durationMs, width: version.width, height: version.height, encoder: selected.name, wallTimeMs: performance.now() - start }
    writeFileSync(join(tmpdir(), 'vis-A2-timeline-benchmark.json'), JSON.stringify(measurement, null, 2))
    expect(version.durationMs).toBe(20_000)
  }, 300_000)
})

it('retains the found ffmpeg version and requirement when a background export fails', async () => {
  const { VisError } = await import('@vis/domain')
  const f = await fixture({ timeline: { render: async () => {
    throw VisError.of('unavailable', 'media.ffmpeg_version_unsupported', { version: '6.1.2', required: 7 }, 'Found ffmpeg 6.1.2. Timeline export requires ffmpeg 7 or newer. Update ffmpeg and restart visCreative to export.')
  } } })
  const task = await f.service.process(user, { ...f.params, waitMs: 1000 })
  expect(task).toMatchObject({ status: 'failed', error: { code: 'media.ffmpeg_version_unsupported', message: 'Found ffmpeg 6.1.2. Timeline export requires ffmpeg 7 or newer. Update ffmpeg and restart visCreative to export.' } })
  expect(f.canvas.get({}).nodes).toHaveLength(1)
})
