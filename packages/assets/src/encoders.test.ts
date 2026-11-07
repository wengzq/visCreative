import { execFileSync } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { detectVideoEncoder, type EncoderRunner } from './encoders'

let sequence = 0
const all = ['h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_mf', 'h264_videotoolbox', 'h264_vaapi', 'libx264', 'libopenh264']
function runner(listed: string[], failing: string[] = []) {
  return vi.fn<EncoderRunner>(async (_path, args) => {
    if (args.includes('-encoders')) return { stdout: listed.map(name => ` V..... ${name} H.264 encoder`).join('\n') }
    if (failing.includes(args[args.indexOf('-c:v') + 1]!)) throw new Error('Device unavailable')
    return { stdout: '' }
  })
}
function options(exec: EncoderRunner, platform: NodeJS.Platform = 'win32') {
  return { ffmpegPath: `fake-ffmpeg-${sequence++}`, platform, exec }
}
const trials = (exec: ReturnType<typeof runner>) => exec.mock.calls.filter(([, args]) => !args.includes('-encoders')).map(([, args]) => args[args.indexOf('-c:v') + 1])

describe('Video encoder selection', () => {
  it.each([
    ['win32', ['h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_mf', 'libx264', 'libopenh264']],
    ['darwin', ['h264_videotoolbox', 'libx264', 'libopenh264']],
    ['linux', ['h264_vaapi', 'libx264', 'libopenh264']],
    ['freebsd', ['libx264', 'libopenh264']],
  ] as [NodeJS.Platform, string[]][])('tries usable encoders in %s priority order', async (platform, expected) => {
    const exec = runner(all, expected.slice(0, -1))
    expect(await detectVideoEncoder(options(exec, platform))).toMatchObject({ name: 'libopenh264', hardware: false })
    expect(trials(exec)).toEqual(expected)
    for (const [, args, opts] of exec.mock.calls.slice(1)) {
      expect(opts.timeoutMs).toBe(5000)
      expect(args).toEqual(expect.arrayContaining(['lavfi', '-frames:v', '1', '-f', 'null', '-']))
      expect(args).toContain('color=black:size=256x256:rate=30')
    }
  })

  it('skips a listed encoder with a failed trial and returns the next device', async () => {
    const exec = runner(all, ['h264_nvenc'])
    expect(await detectVideoEncoder(options(exec))).toMatchObject({ name: 'h264_qsv', hardware: true, args: expect.arrayContaining(['-global_quality', '20']) })
    expect(trials(exec)).toEqual(['h264_nvenc', 'h264_qsv'])
  })

  it('uses VAAPI device initialization and upload filters in the trial and the profile', async () => {
    const exec = runner(['h264_vaapi'])
    const result = await detectVideoEncoder(options(exec, 'linux'))
    expect(result).toMatchObject({ inputArgs: ['-vaapi_device', '/dev/dri/renderD128'], filter: 'format=nv12,hwupload' })
    expect(exec.mock.calls[1]![1]).toEqual(expect.arrayContaining(['-vaapi_device', '/dev/dri/renderD128', '-vf', 'format=nv12,hwupload']))
  })

  it('falls back to OpenH264 without requiring GPL encoders', async () => {
    const exec = runner(['libopenh264'])
    const result = await detectVideoEncoder(options(exec))
    expect(result.name).toBe('libopenh264')
    expect(result.args).toContain('-b:v')
    expect(result.args).not.toContain('-crf')
    expect(trials(exec)).toEqual(['libopenh264'])
  })

  it.each([[[]], [all]] as [string[]][])('rejects when no encoder can be used: %j', async listed => {
    const exec = runner(listed, all)
    await expect(detectVideoEncoder(options(exec))).rejects.toMatchObject({ code: 'unavailable', details: { reason: 'media.encoder_missing' } })
  })

  it('uses a reason-coded error when ffmpeg is missing', async () => {
    const exec = vi.fn<EncoderRunner>().mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))
    await expect(detectVideoEncoder(options(exec))).rejects.toMatchObject({ code: 'unavailable', details: { reason: 'media.encoder_missing' } })
  })

  it('shares concurrent detection and caches the result by ffmpeg path', async () => {
    const exec = runner(all)
    const opts = options(exec)
    const first = detectVideoEncoder(opts)
    expect(detectVideoEncoder(opts)).toBe(first)
    expect(await first).toMatchObject({ name: 'h264_nvenc' })
    await detectVideoEncoder({ ...opts, platform: 'linux' })
    expect(exec).toHaveBeenCalledTimes(2)
    await detectVideoEncoder(options(exec))
    expect(exec).toHaveBeenCalledTimes(4)
  })
})

const available = (() => {
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true } catch { return false }
})()

it.skipIf(!available)('detects and trials a usable real video encoder', async () => {
  const encoder = await detectVideoEncoder()
  expect(all).toContain(encoder.name)
  console.info(`Usable video encoder: ${encoder.name}`)
}, 40_000)
