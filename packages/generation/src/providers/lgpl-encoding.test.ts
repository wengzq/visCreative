import { execFile, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { createFfmpegMedia, detectVideoEncoder, SOFTWARE_FIRST_H264_ENCODERS, type EncoderRunner } from '@vis/assets'
import { afterAll, expect, it, vi } from 'vitest'
import { createMockProvider } from './mock'
import { createRenderProvider } from './render'

vi.mock('node:child_process', async importOriginal => {
  const original = await importOriginal<typeof import('node:child_process')>()
  return {
    ...original,
    execFile: Object.assign(vi.fn(), {
      [Symbol.for('nodejs.util.promisify.custom')]: vi.fn(async (command: string, args: string[]) => {
        if (command === 'probe') return { stdout: JSON.stringify({ streams: [{ codec_type: 'video', width: 256, height: 256, duration: '1', avg_frame_rate: '10/1' }], format: { duration: '1', format_name: 'mov,mp4' } }) }
        writeFileSync(args.at(-1)!, 'encoded video')
        return { stdout: '' }
      }),
    }),
    spawn: vi.fn((_command: string, args: string[], options: { stdio: string[] }) => {
      const child = new EventEmitter() as any
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      const finish = () => {
        writeFileSync(args.at(-1)!, 'encoded video')
        child.emit('exit', 0)
        child.emit('close', 0)
      }
      child.stdin = new Writable({
        write(_chunk, _encoding, callback) { callback() },
        final(callback) {
          callback()
          setImmediate(finish)
        },
      })
      child.kill = vi.fn()
      if (options.stdio[0] === 'ignore') setImmediate(finish)
      return child
    }),
  }
})

vi.mock('playwright-core', () => ({ chromium: { launch: async () => ({
  close: async () => {},
  newPage: async () => ({ on() {}, route: async () => {}, goto: async () => {}, waitForFunction: async () => {}, evaluate: async (code: string) => code === 'window.vis.duration' ? 1 : true, screenshot: async () => Buffer.from('png') }),
}) } }))

const dir = mkdtempSync(join(tmpdir(), 'vis-lgpl-unit-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const runner = (listed = ['libopenh264']) => vi.fn<EncoderRunner>(async (_command, args) => ({ stdout: args.includes('-encoders') ? listed.map(name => ` V..... ${name} H.264 encoder`).join('\n') : '' }))
const assertEncoder = (args: string[]) => {
  expect(args).toEqual(expect.arrayContaining(['-c:v', 'libopenh264', '-b:v', '8M', '-pix_fmt', 'yuv420p']))
  expect(args).not.toContain('libx264')
  expect(args).not.toContain('-crf')
}

it('trims with the available LGPL encoder and caches its trial for subsequent segments', async () => {
  const exec = runner()
  const media = createFfmpegMedia({ ffmpegPath: 'lgpl-trim', ffprobePath: 'probe', encoderRunner: exec })
  for (const [startMs, endMs] of [[0, 500], [500, 1000]]) {
    const output = await media.process('source.mp4', 'video.trim', { startMs, endMs })
    await output.dispose()
  }
  const calls = vi.mocked(spawn).mock.calls.filter(([command]) => command === 'lgpl-trim')
  expect(calls).toHaveLength(2)
  for (const [, args] of calls) assertEncoder(args as string[])
  expect(exec).toHaveBeenCalledTimes(2)
  expect(exec.mock.calls[0]![0]).toBe('lgpl-trim')
})

it('encodes mock video operations with OpenH264 when neither x264 nor VideoToolbox is listed', async () => {
  const exec = runner()
  const provider = createMockProvider({ latencyMs: 0, ffmpegPath: 'lgpl-mock', encoderRunner: exec })
  const { externalTaskId } = await provider.submit({ operation: 'video.removeSubtitles', kind: 'video', model: 'mock-video-1', prompt: '', inputs: [], params: {} }, { idempotencyKey: 'mock' })
  expect(await provider.download({ ref: externalTaskId, outputIndex: 0 })).toMatchObject({ mime: 'video/mp4' })
  const mocked = (execFile as any)[Symbol.for('nodejs.util.promisify.custom')]
  const call = mocked.mock.calls.find(([command]: string[]) => command === 'lgpl-mock')
  assertEncoder(call[1])
  expect(exec).toHaveBeenCalledTimes(2)
})

it('renders opaque video with the LGPL encoder options and faststart', async () => {
  const exec = runner()
  const provider = createRenderProvider({ workDir: dir, ffmpegPath: 'lgpl-render', chromePath: process.execPath, encoderRunner: exec })
  const { externalTaskId } = await provider.submit({ operation: 'generate', kind: 'video', model: 'html', prompt: 'Render', params: { width: 256, height: 256, fps: 1, durationMs: 1000 }, inputs: [{ type: 'text', text: '<script>window.vis={duration:1,seek(){}}</script>' }] }, { idempotencyKey: 'render' })
  await expect.poll(async () => (await provider.getTask(externalTaskId)).state).toBe('succeeded')
  const call = vi.mocked(spawn).mock.calls.find(([command]) => command === 'lgpl-render')!
  assertEncoder(call[1] as string[])
  expect(call[1]).toEqual(expect.arrayContaining(['-movflags', '+faststart']))
  expect(exec.mock.calls[0]![0]).toBe('lgpl-render')
})

it.each(['trim', 'mock', 'render'])('%s prefers x264 over listed hardware and preserves its quality profile', async kind => {
  const exec = runner(['h264_nvenc', 'h264_videotoolbox', 'libx264', 'libopenh264'])
  const ffmpegPath = `software-first-${kind}`
  let args: string[]
  if (kind === 'trim') {
    const result = await createFfmpegMedia({ ffmpegPath, ffprobePath: 'probe', encoderRunner: exec }).process('source.mp4', 'video.trim', { startMs: 0, endMs: 500 })
    await result.dispose()
    args = vi.mocked(spawn).mock.calls.find(([command]) => command === ffmpegPath)![1] as string[]
  } else if (kind === 'mock') {
    const provider = createMockProvider({ ffmpegPath, encoderRunner: exec, latencyMs: 0 })
    const { externalTaskId } = await provider.submit({ operation: 'video.removeSubtitles', kind: 'video', model: 'mock-video-1', prompt: '', inputs: [], params: {} }, { idempotencyKey: 'software-first' })
    await provider.download({ ref: externalTaskId, outputIndex: 0 })
    args = (execFile as any)[Symbol.for('nodejs.util.promisify.custom')].mock.calls.find(([command]: string[]) => command === ffmpegPath)[1]
  } else {
    const provider = createRenderProvider({ workDir: dir, ffmpegPath, encoderRunner: exec, chromePath: process.execPath })
    const { externalTaskId } = await provider.submit({ operation: 'generate', kind: 'video', model: 'html', prompt: 'Small render', params: { width: 64, height: 64, fps: 1, durationMs: 1000 }, inputs: [{ type: 'text', text: '<script>window.vis={duration:1,seek(){}}</script>' }] }, { idempotencyKey: 'software-first' })
    await expect.poll(async () => (await provider.getTask(externalTaskId)).state).toBe('succeeded')
    args = vi.mocked(spawn).mock.calls.find(([command]) => command === ffmpegPath)![1] as string[]
  }
  expect(args).toEqual(expect.arrayContaining(['-c:v', 'libx264', '-crf', kind === 'render' ? '18' : '20']))
  expect(exec.mock.calls[1]![1]).toEqual(expect.arrayContaining(['-c:v', 'libx264']))
  const cached = await detectVideoEncoder({ ffmpegPath, priority: SOFTWARE_FIRST_H264_ENCODERS })
  expect(cached.args).toEqual(expect.arrayContaining(['-crf', '20']))
})
