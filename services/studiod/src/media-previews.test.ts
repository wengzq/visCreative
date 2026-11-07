import * as childProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createFfmpegMedia, type MediaTools } from '@vis/assets'
import { media } from '@vis/protocol'
import { openAppDb, spaceSchema as s } from '@vis/storage'
import { createSpaceRegistry, openSpaceHost, type SpaceHost } from './space-host'
import { MediaScheduler } from './media-tasks'
import { exportTimeline } from './timeline-export'

vi.mock('node:child_process', async importOriginal => {
  const original = await importOriginal<typeof childProcess>()
  return { ...original, spawn: vi.fn(original.spawn) }
})
vi.mock('./timeline-export', { spy: true })

const defaults = { image: { provider: 'mock' }, video: { provider: 'mock' }, audio: { provider: 'mock' } }
const user = { kind: 'user' } as const
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.clearAllMocks()
})

async function version(host: SpaceHost, path: string, kind: 'audio' | 'video' | 'image', durationMs = 10000) {
  return host.assets.registerVersion(host.db, {
    staged: await host.assets.stageFile(path), kind, mime: kind === 'audio' ? 'audio/wav' : kind === 'video' ? 'video/mp4' : 'image/png',
    origin: 'import', durationMs, ...(kind !== 'audio' ? { width: 160, height: 90 } : {}),
  }).assetVersionId
}

function fixture(media?: MediaTools) {
  const dir = mkdtempSync(join(tmpdir(), 'vis previews \u6d4b\u8bd5-'))
  const host = openSpaceHost('preview-space', dir, { runtimes: {}, providers: [], defaults, ...(media ? { media } : {}) }, join(dir, 'user project'))
  cleanups.push(async () => { await host.close(); rmSync(dir, { recursive: true, force: true }) })
  return { dir, host, cacheDir: join(dir, 'cache', 'previews') }
}

it('resolves only registered project versions and rejects unsupported preview kinds before spawning tools', async () => {
  const f = fixture()
  const image = join(f.dir, 'image.png')
  writeFileSync(image, 'fake still')
  const id = await version(f.host, image, 'image')
  await expect(f.host.mediaPreviews.get({ assetVersionId: 'unknown', kind: 'peaks' })).rejects.toMatchObject({ code: 'not_found', details: { reason: 'asset.version_not_found' } })
  for (const kind of ['peaks', 'filmstrip', 'poster'] as const) {
    await expect(f.host.mediaPreviews.get({ assetVersionId: id, kind })).rejects.toMatchObject({ code: 'invalid_params', details: { reason: 'media.kind_mismatch' } })
  }
  const audio = await version(f.host, image, 'audio')
  for (const kind of ['filmstrip', 'poster', 'thumbnail'] as const) {
    await expect(f.host.mediaPreviews.get({ assetVersionId: audio, kind })).rejects.toMatchObject({ code: 'invalid_params', details: { reason: 'media.kind_mismatch' } })
  }
  expect(childProcess.spawn).not.toHaveBeenCalled()
})

it('forwards configured ffmpeg and ffprobe paths from the media tools into timeline export', async () => {
  const tools = createFfmpegMedia({ ffmpegPath: 'C:/custom tools/ffmpeg.exe', ffprobePath: 'C:/custom probe/ffprobe.exe' })
  const f = fixture(tools)
  const file = join(f.dir, 'source.mp4')
  writeFileSync(file, 'fake video')
  const assetVersionId = await version(f.host, file, 'video')
  const source = f.host.canvas.apply(user, { requestId: 'source', ops: [{ op: 'node.create', tempId: 'source', kind: 'video', content: { assetVersionId } }] })
  f.host.canvas.apply(user, { requestId: 'timeline', ops: [{ op: 'node.create', tempId: 'timeline', kind: 'timeline', content: { timelineFrom: [source.idMap.source!] } }] })
  const node = f.host.canvas.get({}).nodes.find(node => node.kind === 'timeline')!
  const slot = node.slots[0]!
  vi.mocked(exportTimeline).mockResolvedValueOnce({
    outputs: [{ path: file, kind: 'video', mime: 'video/mp4', durationMs: 1000, width: 160, height: 90 }],
    dispose: async () => {},
  })
  const task = await f.host.mediaTasks.process(user, { requestId: 'export', operation: 'timeline.export', nodeId: node.nodeId, slotId: slot.slotId, expectedRevision: slot.revision, params: {}, waitMs: 1000 })
  expect(task.status).toBe('succeeded')
  expect(exportTimeline).toHaveBeenCalledWith(f.host.db, f.host.assets, expect.anything(), expect.anything(), tools.paths)
})

const available = (() => {
  try { childProcess.execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true } catch { return false }
})()

describe.skipIf(!available)('Project previews with real ffmpeg', { timeout: 30_000 }, () => {
  let sources: string
  let audio: string
  let video: string
  let silent: string
  beforeAll(() => {
    sources = mkdtempSync(join(tmpdir(), 'vis-preview-sources-'))
    audio = join(sources, 'three minutes stereo.wav')
    video = join(sources, 'ten seconds.mp4')
    silent = join(sources, 'silent.mp4')
    const ffmpeg = (args: string[]) => childProcess.execFileSync('ffmpeg', ['-v', 'error', '-nostdin', ...args], { windowsHide: true, shell: false })
    ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=180', '-ac', '2', '-c:a', 'pcm_s16le', '-y', audio])
    ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=10:duration=10', '-i', audio, '-t', '10', '-c:v', 'mpeg4', '-c:a', 'aac', '-y', video])
    ffmpeg(['-i', video, '-an', '-c:v', 'copy', '-y', silent])
  }, 30_000)
  afterAll(() => { if (sources) rmSync(sources, { recursive: true, force: true }) })

  it('caches an image thumbnail through the thumbnail route without changing its source version', async () => {
    const f = fixture()
    const image = join(f.dir, 'panel.png')
    childProcess.execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=red:size=1280x720', '-frames:v', '1', '-y', image], { shell: false })
    const id = await version(f.host, image, 'image')
    const result = await f.host.mediaPreviews.get({ assetVersionId: id, kind: 'thumbnail' })
    expect(result).toMatchObject({ kind: 'thumbnail', width: 960, height: 540 })
    expect(media.preview.result.safeParse(result).success).toBe(true)
    expect(await f.host.mediaPreviews.get({ assetVersionId: id, kind: 'thumbnail' })).toEqual(result)
    expect(childProcess.spawn).toHaveBeenCalledTimes(1)
  })

  it('generates contract-valid stereo peaks once, shares concurrent requests and isolates version IDs', async () => {
    const f = fixture()
    const firstId = await version(f.host, audio, 'audio', 180000)
    const secondId = await version(f.host, audio, 'audio', 180000)
    const params = { assetVersionId: firstId, kind: 'peaks' } as const
    const [first, concurrent] = await Promise.all([f.host.mediaPreviews.get(params), f.host.mediaPreviews.get(params)])
    expect(first).toEqual(concurrent)
    expect(media.preview.result.safeParse(first).success).toBe(true)
    expect(first).toMatchObject({ kind: 'peaks', durationMs: 180000, binsPerSecond: 50 })
    if (first.kind === 'peaks') expect(first.peaks).toHaveLength(9000)
    expect(childProcess.spawn).toHaveBeenCalledTimes(1)
    expect(await f.host.mediaPreviews.get(params)).toEqual(first)
    expect(childProcess.spawn).toHaveBeenCalledTimes(1)
    await f.host.mediaPreviews.get({ ...params, assetVersionId: secondId })
    expect(childProcess.spawn).toHaveBeenCalledTimes(2)
    expect(readdirSync(f.cacheDir)).toHaveLength(2)
    expect(existsSync(join(f.host.rootPath, 'cache'))).toBe(false)
    expect(f.host.db.select().from(s.mediaTasks).all()).toEqual([])
  })

  it('returns a ten-second JPEG strip, peaks from video audio, and media.no_audio for silent video', async () => {
    const f = fixture()
    const id = await version(f.host, video, 'video')
    const strip = await f.host.mediaPreviews.get({ assetVersionId: id, kind: 'filmstrip' })
    expect(media.preview.result.safeParse(strip).success).toBe(true)
    expect(strip).toMatchObject({ kind: 'filmstrip', frames: 10, durationMs: 10000 })
    if (strip.kind === 'filmstrip') expect(existsSync(strip.path!)).toBe(true)
    await f.host.mediaPreviews.get({ assetVersionId: id, kind: 'filmstrip' })
    expect(childProcess.spawn).toHaveBeenCalledTimes(1)
    const peaks = await f.host.mediaPreviews.get({ assetVersionId: id, kind: 'peaks' })
    expect(peaks.kind).toBe('peaks')
    if (peaks.kind === 'peaks') {
      expect(peaks.durationMs).toBeGreaterThanOrEqual(10000)
      expect(peaks.durationMs).toBeLessThan(10050)
    }
    const silentId = await version(f.host, silent, 'video')
    await expect(f.host.mediaPreviews.get({ assetVersionId: silentId, kind: 'peaks' })).rejects.toMatchObject({ details: { reason: 'media.no_audio' } })
  })

  it('generates contract-valid posters once per immutable video version through the preview queue', async () => {
    const enqueue = vi.spyOn(MediaScheduler.prototype, 'enqueue')
    cleanups.push(async () => { enqueue.mockRestore() })
    const f = fixture()
    const id = await version(f.host, video, 'video')
    const params = { assetVersionId: id, kind: 'poster' } as const
    const [first, concurrent] = await Promise.all([f.host.mediaPreviews.get(params), f.host.mediaPreviews.get(params)])
    expect(first).toEqual(concurrent)
    expect(media.preview.result.safeParse(first).success).toBe(true)
    expect(first).toMatchObject({ kind: 'poster', width: 160, height: 90 })
    if (first.kind === 'poster') expect(existsSync(first.path!)).toBe(true)
    expect(childProcess.spawn).toHaveBeenCalledTimes(1)
    expect(enqueue).toHaveBeenCalledTimes(1)
    expect(await f.host.mediaPreviews.get(params)).toEqual(first)
    expect(enqueue).toHaveBeenCalledTimes(1)
    const secondId = await version(f.host, video, 'video')
    const second = await f.host.mediaPreviews.get({ ...params, assetVersionId: secondId })
    expect(second).toMatchObject({ kind: 'poster', width: 160, height: 90 })
    expect(second).not.toEqual(first)
    expect(childProcess.spawn).toHaveBeenCalledTimes(2)
    expect(enqueue).toHaveBeenCalledTimes(2)
    expect(readdirSync(f.cacheDir)).toHaveLength(4)
    await f.host.mediaPreviews.clear()
    expect(existsSync(f.cacheDir)).toBe(false)
    await f.host.mediaPreviews.close()
    await expect(f.host.mediaPreviews.get(params)).rejects.toMatchObject({ details: { reason: 'media.interrupted' } })
  })

  it('finishes preview misses while both local media slots are busy and cache hits avoid the queue', async () => {
    const enqueue = vi.spyOn(MediaScheduler.prototype, 'enqueue')
    cleanups.push(async () => { enqueue.mockRestore() })
    const started: (() => void)[] = []
    const media: MediaTools = {
      probe: async () => { throw new Error('Unexpected probe') },
      extractFrames: async () => [],
      analyzeSilence: async () => ({ durationMs: 0, pointsMs: [] }),
      process: async (path, _op, _params, opts) => {
        await new Promise<void>((resolve, reject) => {
          const abort = () => reject(opts!.signal!.reason)
          opts!.signal!.addEventListener('abort', abort, { once: true })
          started.push(() => { opts!.signal!.removeEventListener('abort', abort); resolve() })
        })
        return { outputs: [{ path, kind: 'image', mime: 'image/png', width: 160, height: 90 }], dispose: async () => {} }
      },
    }
    const f = fixture(media)
    const cachedId = await version(f.host, audio, 'audio', 180000)
    const freshId = await version(f.host, audio, 'audio', 180000)
    const params = { assetVersionId: cachedId, kind: 'peaks' } as const
    const cached = await f.host.mediaPreviews.get(params)
    const imageId = await version(f.host, video, 'image')
    f.host.canvas.apply(user, { requestId: 'image', ops: [{ op: 'node.create', tempId: 'image', kind: 'image', content: { assetVersionId: imageId } }] })
    const node = f.host.canvas.get({}).nodes[0]!
    const slot = node.slots[0]!
    for (const requestId of ['crop-a', 'crop-b']) {
      await f.host.mediaTasks.process(user, { requestId, operation: 'image.crop', nodeId: node.nodeId, slotId: slot.slotId, expectedRevision: slot.revision, params: { x: 0, y: 0, w: 80, h: 45 } })
    }
    await expect.poll(() => started.length).toBe(2)
    const fresh = f.host.mediaPreviews.get({ ...params, assetVersionId: freshId })
    await expect.poll(() => enqueue.mock.calls.length).toBe(4)
    expect(await f.host.mediaPreviews.get(params)).toEqual(cached)
    expect(await fresh).toEqual(cached)
    expect(childProcess.spawn).toHaveBeenCalledTimes(2)
    expect(f.host.db.select().from(s.mediaTasks).all().map(task => task.status)).toEqual(['running', 'running'])
    started[0]!()
    started[1]!()
  })

  function holdDecoding() {
    const children: { finish(): void; kill: ReturnType<typeof vi.fn> }[] = []
    const spawn = vi.mocked(childProcess.spawn)
    const original = spawn.getMockImplementation()!
    spawn.mockImplementation((() => {
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true) })
      let finished = false
      children.push({
        kill: child.kill,
        finish() {
          if (finished) return
          finished = true
          child.stdout.end(Buffer.alloc(16000))
          child.emit('close', 0)
        },
      })
      return child
    }) as unknown as typeof childProcess.spawn)
    cleanups.push(async () => { for (const child of children) child.finish(); spawn.mockImplementation(original) })
    return children
  }

  it('queues poster misses behind active peaks on the shared single preview slot', async () => {
    const f = fixture()
    const audioId = await version(f.host, audio, 'audio')
    const videoId = await version(f.host, video, 'video')
    const original = vi.mocked(childProcess.spawn).getMockImplementation()!
    const children = holdDecoding()
    const enqueue = vi.spyOn(MediaScheduler.prototype, 'enqueue')
    cleanups.push(async () => { enqueue.mockRestore() })
    const peaks = f.host.mediaPreviews.get({ assetVersionId: audioId, kind: 'peaks' })
    await expect.poll(() => children.length).toBe(1)
    const poster = f.host.mediaPreviews.get({ assetVersionId: videoId, kind: 'poster' })
    await expect.poll(() => enqueue.mock.calls.length).toBe(2)
    expect(childProcess.spawn).toHaveBeenCalledTimes(1)
    vi.mocked(childProcess.spawn).mockImplementation(original)
    children[0]!.finish()
    await peaks
    expect(await poster).toMatchObject({ kind: 'poster', width: 160, height: 90 })
    expect(childProcess.spawn).toHaveBeenCalledTimes(2)
  })

  it('runs a single preview at a time in FIFO order across projects without holding local media slots', async () => {
    const tools = createFfmpegMedia()
    vi.spyOn(tools, 'process').mockResolvedValue({ outputs: [{ path: audio, kind: 'image', mime: 'image/png', width: 160, height: 90 }], dispose: async () => {} })
    const first = fixture(tools)
    const second = fixture()
    const children = holdDecoding()
    const enqueue = vi.spyOn(MediaScheduler.prototype, 'enqueue')
    cleanups.push(async () => { enqueue.mockRestore() })
    const ids = [await version(first.host, audio, 'audio'), await version(second.host, audio, 'audio'), await version(first.host, audio, 'audio')]
    const a = first.host.mediaPreviews.get({ assetVersionId: ids[0]!, kind: 'peaks' })
    await expect.poll(() => children.length, { timeout: 5000 }).toBe(1)
    const b = second.host.mediaPreviews.get({ assetVersionId: ids[1]!, kind: 'peaks' })
    await expect.poll(() => enqueue.mock.calls.length, { timeout: 5000 }).toBe(2)
    const c = first.host.mediaPreviews.get({ assetVersionId: ids[2]!, kind: 'peaks' })
    await expect.poll(() => enqueue.mock.calls.length, { timeout: 5000 }).toBe(3)
    expect(children).toHaveLength(1)
    const imageId = await version(first.host, audio, 'image')
    first.host.canvas.apply(user, { requestId: 'image', ops: [{ op: 'node.create', tempId: 'image', kind: 'image', content: { assetVersionId: imageId } }] })
    const node = first.host.canvas.get({}).nodes[0]!
    const slot = node.slots[0]!
    const local = await first.host.mediaTasks.process(user, { requestId: 'crop', operation: 'image.crop', nodeId: node.nodeId, slotId: slot.slotId, expectedRevision: slot.revision, params: { x: 0, y: 0, w: 80, h: 45 }, waitMs: 5000 })
    expect(local.status).toBe('succeeded')
    children[0]!.finish()
    await a
    await expect.poll(() => children.length, { timeout: 5000 }).toBe(2)
    children[1]!.finish()
    await b
    await expect.poll(() => children.length, { timeout: 5000 }).toBe(3)
    children[2]!.finish()
    await c
    expect(first.host.db.select().from(s.mediaTasks).all()).toHaveLength(1)
    expect(second.host.db.select().from(s.mediaTasks).all()).toEqual([])
  }, 20_000)

  it('drops only the closing project previews and waits for its aborted decoding while preserving the other project FIFO', async () => {
    const first = fixture()
    const second = fixture()
    const children = holdDecoding()
    const enqueue = vi.spyOn(MediaScheduler.prototype, 'enqueue')
    cleanups.push(async () => { enqueue.mockRestore() })
    const firstIds = [await version(first.host, audio, 'audio'), await version(first.host, audio, 'audio')]
    const secondIds = [await version(second.host, audio, 'audio'), await version(second.host, audio, 'audio')]
    const a = first.host.mediaPreviews.get({ assetVersionId: firstIds[0]!, kind: 'peaks' })
    const aborted = expect(a).rejects.toMatchObject({ code: 'unavailable', details: { reason: 'media.interrupted' } })
    await expect.poll(() => children.length, { timeout: 5000 }).toBe(1)
    const b = second.host.mediaPreviews.get({ assetVersionId: secondIds[0]!, kind: 'peaks' })
    await expect.poll(() => enqueue.mock.calls.length, { timeout: 5000 }).toBe(2)
    const dropped = first.host.mediaPreviews.get({ assetVersionId: firstIds[1]!, kind: 'peaks' })
    const rejected = expect(dropped).rejects.toMatchObject({ code: 'unavailable', details: { reason: 'media.interrupted' } })
    await expect.poll(() => enqueue.mock.calls.length, { timeout: 5000 }).toBe(3)
    const c = second.host.mediaPreviews.get({ assetVersionId: secondIds[1]!, kind: 'peaks' })
    await expect.poll(() => enqueue.mock.calls.length, { timeout: 5000 }).toBe(4)
    let closed = false
    const closing = first.host.mediaPreviews.close().then(() => { closed = true })
    await rejected
    expect(children[0]!.kill).toHaveBeenCalledOnce()
    expect(closed).toBe(false)
    expect(children).toHaveLength(1)
    children[0]!.finish()
    await aborted
    await closing
    await expect(first.host.mediaPreviews.get({ assetVersionId: firstIds[0]!, kind: 'peaks' })).rejects.toMatchObject({ code: 'unavailable', details: { reason: 'media.interrupted' } })
    await expect.poll(() => children.length, { timeout: 5000 }).toBe(2)
    children[1]!.finish()
    await b
    await expect.poll(() => children.length, { timeout: 5000 }).toBe(3)
    children[2]!.finish()
    await c
    expect(children).toHaveLength(3)
  }, 20_000)

  it('removes the cache on project deletion while retaining project data and blobs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vis-preview-delete-'))
    const db = openAppDb(join(dir, 'app.db'))
    const registry = createSpaceRegistry({ appDb: db, dataDir: dir, host: { runtimes: {}, providers: [], defaults } })
    cleanups.push(async () => { await registry.closeAll(); db.$client.close(); rmSync(dir, { recursive: true, force: true }) })
    const space = registry.create({ requestId: 'project', name: 'Preview deletion', rootPath: join(dir, 'project') })
    const host = registry.get(space.spaceId)!
    const id = await version(host, video, 'video')
    const strip = await host.mediaPreviews.get({ assetVersionId: id, kind: 'filmstrip' })
    expect(strip.kind).toBe('filmstrip')
    const cacheDir = join(dir, 'spaces', space.spaceId, 'cache', 'previews')
    expect(existsSync(cacheDir)).toBe(true)
    const pending = host.mediaPreviews.get({ assetVersionId: id, kind: 'peaks' })
    const settled = pending.catch(error => error)
    await registry.delete({ requestId: 'delete', spaceId: space.spaceId })
    await settled
    expect(existsSync(cacheDir)).toBe(false)
    expect(existsSync(join(dir, 'spaces', space.spaceId, 'space.db'))).toBe(true)
    await expect(host.mediaPreviews.get({ assetVersionId: id, kind: 'filmstrip' })).rejects.toMatchObject({ details: { reason: 'media.interrupted' } })
  })
})
