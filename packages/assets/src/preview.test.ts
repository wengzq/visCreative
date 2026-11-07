import * as childProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { audioPeaks, createPreviewCache, filmstrip, poster } from './preview'

vi.mock('node:child_process', async importOriginal => {
  const original = await importOriginal<typeof childProcess>()
  return { ...original, spawn: vi.fn(original.spawn) }
})

const available = (() => {
  try { childProcess.execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true } catch { return false }
})()
const ffmpeg = (args: string[]) => childProcess.execFileSync('ffmpeg', ['-v', 'error', '-nostdin', ...args], { stdio: 'pipe' })
function dimensions(path: string) {
  return JSON.parse(childProcess.execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'json', path], { encoding: 'utf8' })).streams[0] as { width: number; height: number }
}

describe.skipIf(!available)('Streaming media previews', () => {
  let dir: string
  let audio: string
  let video: string
  let short: string
  let silent: string
  let image: string
  let cacheSequence = 0
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'vis preview \u6d4b\u8bd5-'))
    audio = join(dir, 'tone and silence.wav')
    video = join(dir, 'video with audio.mp4')
    short = join(dir, 'short.mp4')
    silent = join(dir, 'silent.mp4')
    image = join(dir, 'still.png')
    ffmpeg(['-f', 'lavfi', '-i', 'aevalsrc=if(lt(t\\,1)\\,sin(2*PI*440*t)\\,0):s=8000:d=2', '-y', audio])
    ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=10:duration=3.2', '-i', audio, '-c:v', 'mpeg4', '-c:a', 'aac', '-y', video])
    ffmpeg(['-i', video, '-t', '0.2', '-an', '-c:v', 'copy', '-y', short])
    ffmpeg(['-i', video, '-an', '-c:v', 'copy', '-y', silent])
    ffmpeg(['-f', 'lavfi', '-i', 'color=red:size=80x40', '-frames:v', '1', '-y', image])
  }, 20_000)
  afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })
  beforeEach(() => vi.clearAllMocks())
  const newCache = () => {
    const cacheDir = join(dir, `cache-${cacheSequence++}`)
    const limit = vi.fn()
    return { cache: createPreviewCache({ dir: cacheDir, limit: <T>(task: () => Promise<T>) => { limit(); return task() } }), cacheDir, limit }
  }

  it('streams full-scale tone and silence into normalized peaks with the expected bin count', async () => {
    const result = await audioPeaks(audio)
    expect(result).toMatchObject({ durationMs: 2000, binsPerSecond: 50 })
    expect(result.peaks).toHaveLength(100)
    expect(result.peaks.slice(0, 50).every(peak => peak >= 0.99 && peak <= 1)).toBe(true)
    expect(result.peaks.slice(50).every(peak => peak === 0)).toBe(true)
    expect(result.peaks.every(peak => Number(peak.toFixed(3)) === peak)).toBe(true)
  })

  it('reduces bin density to keep long inputs within the requested storage bound', async () => {
    const result = await audioPeaks(audio, { maxBins: 7 })
    expect(result.peaks).toHaveLength(7)
    expect(result.binsPerSecond).toBeLessThanOrEqual(3.5)
    expect(result.durationMs).toBe(2000)
  })

  it('handles split PCM samples and bounds peaks when decoded audio exceeds the container duration', async () => {
    vi.mocked(childProcess.spawn).mockImplementationOnce((() => {
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() })
      queueMicrotask(() => {
        const bytes = Buffer.alloc(64000)
        for (let offset = 0; offset < bytes.length; offset += 2) bytes.writeInt16LE(-32768, offset)
        child.stdout.write(bytes.subarray(0, 1))
        child.stdout.write(bytes.subarray(1, 17))
        child.stdout.end(bytes.subarray(17))
        child.emit('close', 0)
      })
      return child
    }) as unknown as typeof childProcess.spawn)
    const result = await audioPeaks(audio, { maxBins: 7 })
    expect(result.durationMs).toBe(4000)
    expect(result.peaks).toHaveLength(7)
    expect(result.peaks.every(peak => peak === 1)).toBe(true)
    expect(result.binsPerSecond).toBeLessThan(2)
  })

  it('reads only the first audio stream of a video and rejects video without audio', async () => {
    const result = await audioPeaks(video)
    expect(result.durationMs).toBeGreaterThanOrEqual(2000)
    expect(result.durationMs).toBeLessThan(2200)
    expect(Math.max(...result.peaks)).toBeGreaterThan(0.9)
    await expect(audioPeaks(silent)).rejects.toMatchObject({ code: 'invalid_params', details: { reason: 'media.no_audio' } })
  })

  it('honors abort before probing and while decoding PCM', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(audioPeaks(audio, { signal: controller.signal })).rejects.toMatchObject({ details: { reason: 'media.interrupted' } })
    const active = new AbortController()
    const original = vi.mocked(childProcess.spawn).getMockImplementation()!
    vi.mocked(childProcess.spawn).mockImplementationOnce(((...args: Parameters<typeof childProcess.spawn>) => {
      const child = original(...args)
      child.stdout?.once('data', () => active.abort())
      return child
    }) as typeof childProcess.spawn)
    await expect(audioPeaks(audio, { signal: active.signal })).rejects.toMatchObject({ details: { reason: 'media.interrupted' } })
  })

  it('tiles evenly spaced frames with even widths into one JPEG', async () => {
    const out = join(dir, 'strip.jpg')
    const result = await filmstrip(video, out)
    expect(result).toEqual({ durationMs: 3200, frameWidth: 96, frameHeight: 54, intervalMs: 1000, frames: 4 })
    expect(dimensions(out)).toEqual({ width: result.frameWidth * result.frames, height: result.frameHeight })
    const limited = await filmstrip(video, out, { maxFrames: 2 })
    expect(limited).toMatchObject({ frames: 2, intervalMs: 1600 })
    expect(dimensions(out)).toEqual({ width: limited.frameWidth * 2, height: 54 })
  })

  it('returns one frame for a short video, rejects audio and images, and honors abort', async () => {
    const out = join(dir, 'short strip.jpg')
    expect(await filmstrip(short, out)).toMatchObject({ frames: 1, intervalMs: 1000, durationMs: 200 })
    expect(dimensions(out)).toEqual({ width: 96, height: 54 })
    await expect(filmstrip(audio, out)).rejects.toMatchObject({ details: { reason: 'media.kind_mismatch' } })
    await expect(filmstrip(image, out)).rejects.toMatchObject({ details: { reason: 'media.kind_mismatch' } })
    const signal = AbortSignal.abort()
    await expect(filmstrip(video, out, { signal })).rejects.toMatchObject({ details: { reason: 'media.interrupted' } })
  })

  it('extracts a JPEG at the canvas start time without upscaling and bounds landscape and rotated portrait posters', async () => {
    const out = join(dir, 'poster.jpg')
    expect(await poster(video, out)).toEqual({ width: 160, height: 90 })
    expect(dimensions(out)).toEqual({ width: 160, height: 90 })
    expect(readFileSync(out).subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]))
    expect(vi.mocked(childProcess.spawn).mock.calls[0]![1]).toEqual(expect.arrayContaining(['-ss', '0.001']))
    const firstFrame = join(dir, 'first frame.jpg')
    ffmpeg(['-i', video, '-vf', 'scale=160:90,setsar=1', '-frames:v', '1', '-pix_fmt', 'yuvj420p', '-q:v', '3', '-y', firstFrame])
    expect(readFileSync(out)).toEqual(readFileSync(firstFrame))
    const large = join(dir, 'large.mp4')
    const rotated = join(dir, 'rotated.mp4')
    ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=1:duration=1', '-c:v', 'mpeg4', '-y', large])
    expect(await poster(large, out)).toEqual({ width: 960, height: 540 })
    expect(dimensions(out)).toEqual({ width: 960, height: 540 })
    ffmpeg(['-display_rotation:v:0', '90', '-i', large, '-c', 'copy', '-y', rotated])
    expect(await poster(rotated, out)).toEqual({ width: 540, height: 960 })
    expect(dimensions(out)).toEqual({ width: 540, height: 960 })
  }, 20_000)

  it('creates bounded still-image thumbnails without seeking and shares their immutable cache', async () => {
    const out = join(dir, 'image thumbnail.jpg')
    expect(await poster(image, out, { stillImage: true })).toEqual({ width: 80, height: 40 })
    expect(dimensions(out)).toEqual({ width: 80, height: 40 })
    const large = join(dir, 'large panel.png')
    ffmpeg(['-f', 'lavfi', '-i', 'color=blue:size=1280x720', '-frames:v', '1', '-y', large])
    const { cache } = newCache()
    const thumbnail = await cache.poster('panel', large, true)
    expect(thumbnail).toMatchObject({ width: 960, height: 540 })
    expect(await cache.poster('panel', join(dir, 'missing.png'), true)).toEqual(thumbnail)
    expect(dimensions(thumbnail.path)).toEqual({ width: 960, height: 540 })
  })

  it('preserves anamorphic display dimensions before applying rotation and the poster bound', async () => {
    const source = join(dir, 'anamorphic.mp4')
    const large = join(dir, 'large anamorphic.mp4')
    const rotated = join(dir, 'rotated anamorphic.mp4')
    const narrow = join(dir, 'narrow anamorphic.mp4')
    const out = join(dir, 'anamorphic poster.jpg')
    ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=720x576:rate=10:duration=0.2', '-vf', 'setsar=16/15', '-c:v', 'mpeg4', '-y', source])
    expect(await poster(source, out)).toEqual({ width: 768, height: 576 })
    expect(dimensions(out)).toEqual({ width: 768, height: 576 })
    ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=1080x720:rate=10:duration=0.2', '-vf', 'setsar=16/9', '-c:v', 'mpeg4', '-y', large])
    expect(await poster(large, out)).toEqual({ width: 960, height: 360 })
    expect(dimensions(out)).toEqual({ width: 960, height: 360 })
    ffmpeg(['-display_rotation:v:0', '90', '-i', large, '-c', 'copy', '-y', rotated])
    expect(await poster(rotated, out)).toEqual({ width: 360, height: 960 })
    expect(dimensions(out)).toEqual({ width: 360, height: 960 })
    ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=720x576:rate=10:duration=0.2', '-vf', 'setsar=8/9', '-c:v', 'mpeg4', '-y', narrow])
    expect(await poster(narrow, out)).toEqual({ width: 640, height: 576 })
    expect(dimensions(out)).toEqual({ width: 640, height: 576 })
  }, 20_000)

  it('generates a poster for a short video, rejects non-video sources, and honors abort and missing tools', async () => {
    const out = join(dir, 'short poster.jpg')
    expect(await poster(short, out)).toEqual({ width: 160, height: 90 })
    for (const source of [audio, image]) {
      await expect(poster(source, out)).rejects.toMatchObject({ code: 'invalid_params', details: { reason: 'media.kind_mismatch' } })
    }
    await expect(poster(video, out, { signal: AbortSignal.abort() })).rejects.toMatchObject({ details: { reason: 'media.interrupted' } })
    await expect(poster(video, out, { ffmpegPath: join(dir, 'missing ffmpeg'), ffprobePath: 'ffprobe' })).rejects.toMatchObject({ code: 'unavailable', details: { reason: 'media.tool_missing' } })
  })

  it('rejects invalid preview options without invoking ffmpeg', async () => {
    const spawn = vi.mocked(childProcess.spawn)
    for (const opts of [{ binsPerSecond: 0 }, { binsPerSecond: NaN }, { maxBins: 0 }, { maxBins: 1.5 }]) {
      await expect(audioPeaks(audio, opts)).rejects.toMatchObject({ details: { reason: 'media.invalid_params' } })
    }
    await expect(filmstrip(video, join(dir, 'invalid.jpg'), { maxFrames: 0 })).rejects.toMatchObject({ details: { reason: 'media.invalid_params' } })
    expect(spawn).not.toHaveBeenCalled()
  })

  it('caches peaks, shares a generation, uses the injected limiter and sanitizes IDs without collisions', async () => {
    const { cache, cacheDir, limit } = newCache()
    const spawn = vi.mocked(childProcess.spawn)
    const [first, concurrent] = await Promise.all([cache.peaks('../a/b', audio), cache.peaks('../a/b', audio)])
    expect(first).toEqual(concurrent)
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(limit).toHaveBeenCalledTimes(1)
    expect(await cache.peaks('../a/b', audio)).toEqual(first)
    expect(spawn).toHaveBeenCalledTimes(1)
    await cache.peaks('.._a_b', audio)
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(readdirSync(cacheDir)).toHaveLength(2)
    expect(readdirSync(cacheDir).every(name => /^[a-zA-Z0-9_.-]+$/.test(name))).toBe(true)
  })

  it('regenerates partial or corrupt peak entries and retries failed generation', async () => {
    const { cache, cacheDir, limit } = newCache()
    await expect(cache.peaks('missing', join(dir, 'missing.wav'))).rejects.toBeDefined()
    await cache.peaks('missing', audio)
    const cached = join(cacheDir, readdirSync(cacheDir)[0]!)
    for (const content of ['{', 'null', '{"durationMs":2000,"binsPerSecond":50,"peaks":[2]}', '{"durationMs":2000,"binsPerSecond":50,"peaks":[0]}']) {
      writeFileSync(cached, content)
      expect((await cache.peaks('missing', audio)).peaks).toHaveLength(100)
    }
    const tampered = JSON.parse(readFileSync(cached, 'utf8'))
    tampered.peaks[0] = 0
    writeFileSync(cached, JSON.stringify(tampered))
    expect((await cache.peaks('missing', audio)).peaks[0]).toBeGreaterThan(0.99)
    expect(limit).toHaveBeenCalledTimes(7)
  })

  it('caches filmstrips without running ffmpeg again and detects damaged JPEGs and metadata', async () => {
    const { cache, cacheDir, limit } = newCache()
    const spawn = vi.mocked(childProcess.spawn)
    const [first, concurrent] = await Promise.all([cache.filmstrip('video', video), cache.filmstrip('video', video)])
    expect(first).toEqual(concurrent)
    expect(dimensions(first.path)).toEqual({ width: 384, height: 54 })
    expect(await cache.filmstrip('video', video)).toEqual(first)
    expect(spawn).toHaveBeenCalledTimes(1)
    writeFileSync(first.path, readFileSync(first.path).subarray(0, 50))
    expect(await cache.filmstrip('video', video)).toEqual(first)
    expect(spawn).toHaveBeenCalledTimes(2)
    const meta = join(cacheDir, readdirSync(cacheDir).find(name => name.endsWith('.json'))!)
    const tampered = JSON.parse(readFileSync(meta, 'utf8'))
    tampered.frameWidth = 100
    writeFileSync(meta, JSON.stringify(tampered))
    expect(await cache.filmstrip('video', video)).toEqual(first)
    writeFileSync(meta, '{}')
    expect(await cache.filmstrip('video', video)).toEqual(first)
    expect(limit).toHaveBeenCalledTimes(4)
  })

  it('caches posters by immutable version through the limiter and regenerates damaged JPEGs and metadata', async () => {
    const { cache, cacheDir, limit } = newCache()
    const spawn = vi.mocked(childProcess.spawn)
    const [first, concurrent] = await Promise.all([cache.poster('../video', video), cache.poster('../video', video)])
    expect(first).toEqual(concurrent)
    expect(dimensions(first.path)).toEqual({ width: 160, height: 90 })
    expect(await cache.poster('../video', join(dir, 'unavailable-source.mp4'))).toEqual(first)
    expect(spawn).toHaveBeenCalledTimes(1)
    writeFileSync(first.path, readFileSync(first.path).subarray(0, 50))
    expect(await cache.poster('../video', video)).toEqual(first)
    const metadata = join(cacheDir, readdirSync(cacheDir).find(name => name.endsWith('.json'))!)
    const tampered = JSON.parse(readFileSync(metadata, 'utf8'))
    tampered.width = 80
    writeFileSync(metadata, JSON.stringify(tampered))
    expect(await cache.poster('../video', video)).toEqual(first)
    writeFileSync(metadata, '{}')
    expect(await cache.poster('../video', video)).toEqual(first)
    await cache.poster('.._video', video)
    expect(spawn).toHaveBeenCalledTimes(5)
    expect(limit).toHaveBeenCalledTimes(5)
    expect(readdirSync(cacheDir)).toHaveLength(4)
    expect(readdirSync(cacheDir).every(name => /^[a-zA-Z0-9_.-]+$/.test(name))).toBe(true)
  })

  it('waits for poster generation before clearing and retries a failed poster generation', async () => {
    const { cache, cacheDir } = newCache()
    await expect(cache.poster('video', join(dir, 'missing.mp4'))).rejects.toBeDefined()
    const generation = cache.poster('video', video)
    const clearing = cache.clear()
    await generation
    await clearing
    expect(existsSync(cacheDir)).toBe(false)
    expect(await cache.poster('video', video)).toMatchObject({ width: 160, height: 90 })
    await cache.close()
    await expect(cache.poster('video', video)).rejects.toMatchObject({ details: { reason: 'media.interrupted' } })
  })

  it('aborts active poster extraction and waits for ffmpeg to exit before close resolves', async () => {
    const { cache, cacheDir } = newCache()
    let finish: (() => void) | undefined
    const kill = vi.fn(() => true)
    vi.mocked(childProcess.spawn).mockImplementationOnce((() => {
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill })
      finish = () => child.emit('close', null)
      return child
    }) as unknown as typeof childProcess.spawn)
    const generation = cache.poster('video', video)
    const interrupted = expect(generation).rejects.toMatchObject({ details: { reason: 'media.interrupted' } })
    await expect.poll(() => finish).toBeDefined()
    let closed = false
    const closing = cache.close().then(() => { closed = true })
    expect(kill).toHaveBeenCalledWith('SIGKILL')
    expect(closed).toBe(false)
    finish!()
    await interrupted
    await closing
    await cache.clear()
    expect(existsSync(cacheDir)).toBe(false)
  })

  it('waits for active generation before clearing the cache directory', async () => {
    const { cache, cacheDir } = newCache()
    const generation = cache.peaks('audio', audio)
    const clearing = cache.clear()
    expect(cache.clear()).toBe(clearing)
    await generation
    await clearing
    expect(existsSync(cacheDir)).toBe(false)
    expect((await cache.peaks('audio', audio)).peaks).toHaveLength(100)
    await cache.clear()
    expect(existsSync(cacheDir)).toBe(false)
  })

  it('aborts active decoding on close and refuses subsequent requests without recreating files', async () => {
    const { cache, cacheDir } = newCache()
    let closing: Promise<void> | undefined
    const original = vi.mocked(childProcess.spawn).getMockImplementation()!
    vi.mocked(childProcess.spawn).mockImplementationOnce(((...args: Parameters<typeof childProcess.spawn>) => {
      const child = original(...args)
      child.stdout?.once('data', () => { closing = cache.close() })
      return child
    }) as typeof childProcess.spawn)
    await expect(cache.peaks('audio', audio)).rejects.toMatchObject({ details: { reason: 'media.interrupted' } })
    expect(closing).toBeDefined()
    await closing
    await cache.clear()
    expect(existsSync(cacheDir)).toBe(false)
    await expect(cache.peaks('audio', audio)).rejects.toMatchObject({ details: { reason: 'media.interrupted' } })
    await expect(cache.filmstrip('video', video)).rejects.toMatchObject({ details: { reason: 'media.interrupted' } })
    await expect(cache.poster('video', video)).rejects.toMatchObject({ details: { reason: 'media.interrupted' } })
    expect(childProcess.spawn).toHaveBeenCalledTimes(1)
    expect(existsSync(cacheDir)).toBe(false)
  })
})
