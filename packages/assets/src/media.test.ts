import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createFfmpegMedia, mimeOf } from './media'

it.each([
  ['mp3', 'audio/mpeg'], ['wav', 'audio/wav'], ['m4a', 'audio/mp4'],
  ['aac', 'audio/aac'], ['ogg', 'audio/ogg'], ['flac', 'audio/flac'],
] as const)('recognizes the %s audio extension', (ext, mime) => {
  expect(mimeOf(`/素材/声音.${ext.toUpperCase()}`)).toBe(mime)
})

it('missing ffprobe returns an English error with a translatable reason and tool name', async () => {
  const tool = '/not-installed/vis-ffprobe'
  await expect(createFfmpegMedia({ ffprobePath: tool }).probe('/not-read.png')).rejects.toMatchObject({
    code: 'invalid_params',
    message: `Cannot read media file: ${tool} not found; install ffmpeg first`,
    details: { reason: 'asset.media_probe_tool_missing', params: { tool } },
  })
})

const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' })
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore' })
    return true
  } catch { return false }
})()

describe.skipIf(!hasFfmpeg)('Media stream probing', () => {
  const media = createFfmpegMedia()
  let dir: string
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'vis-media-')) })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  function audio(ext: string) {
    const path = join(dir, `audio.${ext}`)
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-y', path])
    return path
  }

  it.each([
    ['mp3', 'audio/mpeg'], ['wav', 'audio/wav'], ['m4a', 'audio/mp4'],
    ['aac', 'audio/aac'], ['ogg', 'audio/ogg'], ['flac', 'audio/flac'],
    ['mp4', 'audio/mp4'], ['webm', 'audio/webm'],
  ] as const)('registers audio-only %s as audio without visual dimensions', async (ext, mime) => {
    const info = await media.probe(audio(ext))
    expect(info).toMatchObject({ kind: 'audio', mime, durationMs: expect.any(Number) })
    expect(info.durationMs).toBeGreaterThanOrEqual(1000)
    expect(info.durationMs).toBeLessThan(1100)
    expect(info).not.toHaveProperty('width')
    expect(info).not.toHaveProperty('height')
    expect(info).not.toHaveProperty('fps')
  })

  it('MP3 with ID3 album art remains audio', async () => {
    const cover = join(dir, 'cover.png')
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=size=32x32', '-frames:v', '1', '-y', cover])
    const path = join(dir, 'covered.mp3')
    execFileSync('ffmpeg', ['-v', 'error', '-i', audio('mp3'), '-i', cover, '-map', '0:a', '-map', '1:v', '-c', 'copy', '-id3v2_version', '3', '-disposition:v', 'attached_pic', '-y', path])
    expect(await media.probe(path)).toMatchObject({ kind: 'audio', mime: 'audio/mpeg', durationMs: expect.any(Number) })
    expect(await media.probe(path)).not.toHaveProperty('width')
    await expect(media.extractFrames(path, 1)).rejects.toMatchObject({ code: 'invalid_params' })
  })

  it('rejects media kind mismatches between content and extension', async () => {
    const disguisedImage = join(dir, 'disguised.png')
    copyFileSync(audio('wav'), disguisedImage)
    await expect(media.probe(disguisedImage)).rejects.toMatchObject({ code: 'invalid_params', message: 'File content does not match its extension' })
    const disguisedAudio = join(dir, 'disguised.wav')
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=size=32x32', '-frames:v', '1', '-f', 'image2', '-vcodec', 'png', '-y', disguisedAudio])
    await expect(media.probe(disguisedAudio)).rejects.toMatchObject({ code: 'invalid_params', message: 'File content does not match its extension' })
  })

  it('audio cannot provide extracted frames; reading extensionless blobs also returns invalid_params', async () => {
    const path = join(dir, 'blob')
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=duration=1', '-f', 'wav', '-y', path])
    await expect(media.extractFrames(path, 3)).rejects.toMatchObject({ code: 'invalid_params' })
  })

  // This case starts fourteen ffmpeg/ffprobe processes; Windows full-suite validation exceeded its 5 s budget.
  it('files with video and audio tracks remain video and frame extraction preserves visual dimensions', async () => {
    const path = join(dir, 'video.mp4')
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=160x90:rate=10', '-f', 'lavfi', '-i', 'sine=duration=1', '-pix_fmt', 'yuv420p', '-y', path])
    expect(await media.probe(path)).toEqual({ kind: 'video', mime: 'video/mp4', width: 160, height: 90, durationMs: 1000, fps: 10, hasAlpha: false })
    const blob = join(dir, 'video-blob')
    copyFileSync(path, blob)
    expect(await media.probe(blob, 'video/mp4')).toEqual({ kind: 'video', mime: 'video/mp4', width: 160, height: 90, durationMs: 1000, fps: 10, hasAlpha: false })
    const frames = await media.extractFrames(path, 1)
    expect(frames).toHaveLength(1)
    expect(frames[0]).toMatchObject({ mime: 'image/jpeg', width: 160, height: 90, atMs: 500 })
    expect(frames[0]!.data.byteLength).toBeGreaterThan(0)
    const explicit = await media.extractFrames(path, [0, 700, 200])
    expect(explicit.map(frame => frame.atMs)).toEqual([0, 700, 200])
    expect(explicit.map(frame => [frame.width, frame.height])).toEqual([[160, 90], [160, 90], [160, 90]])
    expect(Buffer.compare(explicit[0]!.data, explicit[1]!.data)).not.toBe(0)
    await expect(media.extractFrames(path, [1000])).rejects.toMatchObject({ code: 'invalid_params', details: { reason: 'asset.frame_time_invalid' } })
  }, process.platform === 'win32' ? 20_000 : undefined)

  it('animated PNG retains image kind', async () => {
    const path = join(dir, 'animated.png')
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=32x32:rate=2', '-f', 'apng', '-y', path])
    expect(await media.probe(path)).toEqual({ kind: 'image', mime: 'image/png', width: 32, height: 32 })
  })

  it('images retain original dimensions without duration', async () => {
    const path = join(dir, 'image.png')
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=64x32', '-frames:v', '1', '-y', path])
    expect(await media.probe(path)).toEqual({ kind: 'image', mime: 'image/png', width: 64, height: 32 })
  })

  it('files without media streams, unreadable files and unsupported extensions return invalid_params', async () => {
    const empty = join(dir, 'empty.mp4')
    writeFileSync(empty, ';FFMETADATA1\ntitle=empty\n')
    await expect(media.probe(empty)).rejects.toMatchObject({ code: 'invalid_params', message: 'File contains no image, video or audio streams' })
    const path = join(dir, 'invalid.wav')
    writeFileSync(path, '没有媒体流')
    await expect(media.probe(path)).rejects.toMatchObject({ code: 'invalid_params' })
    await expect(media.probe(join(dir, 'file.txt'))).rejects.toMatchObject({ code: 'invalid_params' })
  })
})
