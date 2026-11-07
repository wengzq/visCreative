import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createFfmpegMedia, type ProcessedMedia } from './media'

const available = (() => {
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true } catch { return false }
})()

describe.skipIf(!available)('Local media operations', () => {
  const media = createFfmpegMedia()
  let dir: string
  let image: string
  let video: string
  let silentVideo: string
  let audio: string
  const results: ProcessedMedia[] = []
  const ffmpeg = (args: string[]) => execFileSync('ffmpeg', ['-v', 'error', '-nostdin', ...args], { stdio: 'pipe' })

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'vis-local-media-'))
    image = join(dir, 'image.png')
    video = join(dir, 'video.mp4')
    silentVideo = join(dir, 'silent.mp4')
    audio = join(dir, 'audio.wav')
    ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=65x35', '-frames:v', '1', '-y', image])
    ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=64x48:rate=20:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-y', video])
    ffmpeg(['-i', video, '-an', '-c:v', 'copy', '-y', silentVideo])
    ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-y', audio])
  }, 20_000)
  afterAll(async () => {
    await Promise.all(results.map(result => result.dispose()))
    rmSync(dir, { recursive: true, force: true })
  })
  async function process(...args: Parameters<typeof media.process>) {
    const result = await media.process(...args)
    results.push(result)
    return result.outputs
  }

  it('crops exact pixels and splits odd-sized images into row-major cells without dropping edge pixels', async () => {
    expect(await process(image, 'image.crop', { x: 3, y: 4, w: 31, h: 17 })).toMatchObject([{ kind: 'image', width: 31, height: 17 }])
    const cells = await process(image, 'image.gridSplit', { rows: 2, cols: 3 })
    expect(cells.map(cell => [cell.width, cell.height])).toEqual([[21, 17], [22, 17], [22, 17], [21, 18], [22, 18], [22, 18]])
    await expect(process(image, 'image.crop', { x: 60, y: 0, w: 6, h: 5 })).rejects.toMatchObject({ code: 'invalid_params', details: { reason: 'media.crop_out_of_bounds' } })
    await expect(process(image, 'image.gridSplit', { rows: 4, cols: 2 })).rejects.toMatchObject({ details: { reason: 'media.invalid_params' } })
  }, 20_000)

  it('exports ordinary video to ProRes 4444 with opaque pixels and its original audio', async () => {
    const [output] = await process(video, 'video.exportMov', {})
    expect(output).toMatchObject({ kind: 'video', mime: 'video/quicktime', width: 64, height: 48, fps: 20, hasAlpha: true })
    const streams = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', output!.path], { encoding: 'utf8' })).streams
    expect(streams[0]).toMatchObject({ codec_name: 'prores', profile: '4444' })
    expect(streams[1]).toMatchObject({ codec_name: 'pcm_s24le' })
    const pixels = ffmpeg(['-i', output!.path, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'])
    expect(pixels[3]).toBe(255)
    expect(pixels[4 * (24 * 64 + 32) + 3]).toBe(255)
  })

  it('trims video, extracts a full-size frame and extracts audio; video without audio has a reason-coded error', async () => {
    const progress: number[] = []
    const trimmed = await process(video, 'video.trim', { startMs: 250, endMs: 1250 }, { onProgress: value => progress.push(value) })
    expect(trimmed[0]).toMatchObject({ kind: 'video', width: 64, height: 48, fps: 20 })
    expect(trimmed[0]!.durationMs).toBeCloseTo(1000, -2)
    expect(progress.at(-1)).toBe(1)
    expect(await process(video, 'video.frame', { atMs: 800 })).toMatchObject([{ kind: 'image', width: 64, height: 48 }])
    expect(await process(video, 'video.frame', { atMs: 1999 })).toMatchObject([{ kind: 'image', width: 64, height: 48 }])
    expect(await process(video, 'video.extractAudio', {})).toMatchObject([{ kind: 'audio', mime: 'audio/wav' }])
    await expect(process(silentVideo, 'video.extractAudio', {})).rejects.toMatchObject({ code: 'invalid_params', details: { reason: 'media.no_audio' } })
    await expect(process(video, 'video.frame', { atMs: 2051 })).rejects.toMatchObject({ details: { reason: 'media.time_out_of_bounds' } })
  }, 20_000)

  it('extracts the actual last decoded frame at a non-frame-aligned media end and tolerated overruns', async () => {
    const path = join(dir, 'uneven-end.mp4')
    ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=64x48:rate=7:duration=1.3', '-f', 'lavfi', '-i', 'sine=duration=1.37', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-y', path])
    const info = await media.probe(path)
    const expected = join(dir, 'expected-last.png')
    ffmpeg(['-i', path, '-an', '-update', '1', '-y', expected])
    for (const overrun of [0, 50]) {
      const outputs = await process(path, 'video.frame', { atMs: info.durationMs! + overrun })
      expect(readFileSync(outputs[0]!.path)).toEqual(readFileSync(expected))
    }
  }, 20_000)

  it('trims, splits and changes audio speed with pitch-preserving atempo', async () => {
    expect((await process(audio, 'audio.trim', { startMs: 300, endMs: 1100 }))[0]!.durationMs).toBeCloseTo(800, -1)
    const parts = await process(audio, 'audio.split', { pointsMs: [400, 1000, 1400] })
    expect(parts.map(part => part.durationMs)).toEqual([400, 600, 400, 600])
    expect((await process(audio, 'audio.speed', { rate: 2 }))[0]!.durationMs).toBeCloseTo(1000, -2)
    expect((await process(audio, 'audio.speed', { rate: 0.5 }))[0]!.durationMs).toBeCloseTo(4000, -2)
    await expect(process(audio, 'audio.trim', { startMs: 0, endMs: 2051 })).rejects.toMatchObject({ details: { reason: 'media.time_out_of_bounds' } })
    await expect(process(audio, 'audio.split', { pointsMs: [2000] })).rejects.toMatchObject({ details: { reason: 'media.time_out_of_bounds' } })
    await expect(process(audio, 'audio.speed', { rate: 1.1 })).rejects.toMatchObject({ details: { reason: 'media.invalid_params' } })
  }, 20_000)

  it('detects silence midpoints including leading and trailing silence', async () => {
    const path = join(dir, 'silences.wav')
    ffmpeg(['-f', 'lavfi', '-i', 'aevalsrc=if(between(t\\,0.5\\,1.0)\\,0.5*sin(2*PI*440*t)\\,0):s=44100:d=2', '-y', path])
    const result = await media.analyzeSilence(path, { minSilenceMs: 200, thresholdDb: -40 })
    expect(result.durationMs).toBe(2000)
    expect(result.pointsMs).toHaveLength(2)
    expect(result.pointsMs[0]).toBeCloseTo(250, -1)
    expect(result.pointsMs[1]).toBeCloseTo(1500, -1)
    await expect(media.analyzeSilence(image)).rejects.toMatchObject({ details: { reason: 'media.kind_mismatch' } })
  })

  it('honors abort and timeout before processing and reports mismatched source kinds', async () => {
    await expect(process(audio, 'image.crop', { x: 0, y: 0, w: 1, h: 1 })).rejects.toMatchObject({ details: { reason: 'media.kind_mismatch' } })
    const controller = new AbortController()
    controller.abort()
    await expect(process(video, 'video.trim', { startMs: 0, endMs: 1000 }, { signal: controller.signal })).rejects.toBeDefined()
    await expect(process(video, 'video.trim', { startMs: 0, endMs: 1000 }, { signal: AbortSignal.timeout(1) })).rejects.toBeDefined()
  })

  it.each([10, 49, 50])('clamps a %s ms browser duration overrun for trim and frame operations', async overrun => {
    expect((await process(audio, 'audio.trim', { startMs: 1000, endMs: 2000 + overrun }))[0]!.durationMs).toBe(1000)
    expect((await process(video, 'video.trim', { startMs: 1000, endMs: 2000 + overrun }))[0]!.durationMs).toBeCloseTo(1000, -2)
    expect(await process(video, 'video.frame', { atMs: 2000 + overrun })).toMatchObject([{ width: 64, height: 48 }])
    await expect(process(audio, 'audio.trim', { startMs: 2000, endMs: 2000 + overrun })).rejects.toMatchObject({ details: { reason: 'media.time_out_of_bounds' } })
  }, 20_000)

  it('uses the caller signal without creating a second timeout for processing or analysis', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    try {
      await process(image, 'image.crop', { x: 0, y: 0, w: 10, h: 10 })
      await media.analyzeSilence(audio)
      expect(timeout).not.toHaveBeenCalled()
    } finally { timeout.mockRestore() }
  })

  it('crops and splits EXIF orientation 6 in browser-oriented pixel coordinates into upright PNGs', async () => {
    const jpeg = join(dir, 'oriented.jpg')
    ffmpeg(['-f', 'lavfi', '-i', 'color=red:size=60x40', '-vf', 'drawbox=x=30:y=0:w=30:h=40:color=blue:t=fill', '-frames:v', '1', '-y', jpeg])
    const bytes = readFileSync(jpeg)
    // A little-endian TIFF IFD with orientation=6, embedded as a JPEG APP1 segment.
    const exif = Buffer.from('45786966000049492a0008000000010012010300010000000600000000000000', 'hex')
    const header = Buffer.alloc(4)
    header.writeUInt16BE(0xffe1)
    header.writeUInt16BE(exif.length + 2, 2)
    writeFileSync(jpeg, Buffer.concat([bytes.subarray(0, 2), header, exif, bytes.subarray(2)]))
    expect(await media.probe(jpeg)).toMatchObject({ width: 40, height: 60 })
    const cropped = await process(jpeg, 'image.crop', { x: 0, y: 40, w: 40, h: 20 })
    expect(cropped[0]).toMatchObject({ mime: 'image/png', width: 40, height: 20 })
    const pixel = ffmpeg(['-i', cropped[0]!.path, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'])
    expect(pixel[2]).toBeGreaterThan(200)
    expect(pixel[0]).toBeLessThan(30)
    const cells = await process(jpeg, 'image.gridSplit', { rows: 3, cols: 2 })
    expect(cells.map(cell => [cell.width, cell.height])).toEqual(Array.from({ length: 6 }, () => [20, 20]))
    await expect(process(jpeg, 'image.crop', { x: 40, y: 0, w: 1, h: 1 })).rejects.toMatchObject({ details: { reason: 'media.crop_out_of_bounds' } })
  }, 20_000)

  it('kills an active ffmpeg process when its caller aborts from a progress callback', async () => {
    const controller = new AbortController()
    let sawProgress = false
    await expect(process(video, 'video.trim', { startMs: 0, endMs: 2000 }, {
      signal: controller.signal,
      onProgress() { sawProgress = true; controller.abort() },
    })).rejects.toMatchObject({ details: { reason: 'media.interrupted' } })
    expect(sawProgress).toBe(true)
  })
})
