import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { chromium } from 'playwright-core'
import { expect, it, vi } from 'vitest'
import type { ProviderRequest } from '../types'
import { createRenderProvider } from './index'

vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(), spawn: vi.fn(),
}))
vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return { ...original, rm: vi.fn(original.rm) }
})
vi.mock('playwright-core', () => ({ chromium: { launch: vi.fn() } }))

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

it.each([false, true])('waits for encoder and Chrome closure before cancellation cleanup, and continues after cleanup failure: %s', async cleanupFails => {
  vi.clearAllMocks()
  const dir = mkdtempSync(join(tmpdir(), 'vis-render-cancel-'))
  const chromeClosed = deferred()
  const seek = deferred()
  void seek.promise.catch(() => {})
  let active: ChildProcessWithoutNullStreams | undefined
  let kills = 0
  vi.mocked(spawn).mockImplementation(((_command: string, args: string[]) => {
    const child = new EventEmitter() as ChildProcessWithoutNullStreams
    const stuck = !active
    let killed = false
    Object.assign(child, {
      stdout: new PassThrough(), stderr: new PassThrough(),
      stdin: new Writable({
        write(_chunk, _encoding, done) { done() },
        final(done) {
          done()
          if (!stuck) setImmediate(() => {
            writeFileSync(args.at(-1)!, 'video')
            child.emit('exit', 0)
            child.emit('close', 0)
          })
        },
      }),
      kill() {
        kills++
        // A killed encoder can report a broken input pipe well before its close event.
        if (!killed) {
          killed = true
          child.stdin.emit('error', Object.assign(new Error('Encoder pipe closed'), { code: 'EPIPE' }))
          child.emit('exit', null, 'SIGKILL')
        }
        return true
      },
    })
    if (stuck) {
      active = child
      writeFileSync(args.at(-1)!, 'partial video')
    }
    return child
  }) as typeof spawn)
  let launches = 0
  vi.mocked(chromium.launch).mockImplementation(async () => {
    const stuck = launches++ === 0
    return {
      close: () => {
        if (!stuck) return Promise.resolve()
        seek.reject(new Error('Browser closed during seek'))
        return chromeClosed.promise
      },
      newPage: async () => ({
        on() {}, route: async () => {}, goto: async () => {}, waitForFunction: async () => {},
        evaluate: async (code: string) => code === 'window.vis.duration' ? 1 : stuck && code.includes('window.vis.seek(0.5)') ? seek.promise : true,
        screenshot: async () => Buffer.from('png'),
      }),
    } as unknown as Awaited<ReturnType<typeof chromium.launch>>
  })
  const provider = createRenderProvider({
    workDir: dir, chromePath: process.execPath, ffmpegPath: 'cancel-fixture', libs: {},
    encoderRunner: async () => ({ stdout: ' V..... libx264 H.264 encoder' }),
  })
  const request: ProviderRequest = { operation: 'generate', kind: 'video', model: 'html', prompt: '', params: { width: 64, height: 64, fps: 2 }, inputs: [{ type: 'text', text: 'Render fixture' }] }
  try {
    await provider.submit(request, { idempotencyKey: 'stuck' })
    await expect.poll(() => provider.getTask('stuck')).toEqual({ state: 'running', progress: 0.5 })
    await provider.submit(request, { idempotencyKey: 'next' })
    let settled = false
    const cancellation = provider.cancel!('stuck').then(result => { settled = true; return result })
    await expect.poll(() => kills).toBeGreaterThan(0)
    await new Promise(resolve => setImmediate(resolve))
    expect(vi.mocked(rm)).not.toHaveBeenCalled()
    expect(settled).toBe(false)
    if (cleanupFails) chromeClosed.resolve()
    else active!.emit('close', null, 'SIGKILL')
    await new Promise(resolve => setImmediate(resolve))
    expect(vi.mocked(rm)).not.toHaveBeenCalled()
    expect(settled).toBe(false)
    expect(launches).toBe(1)
    if (cleanupFails) vi.mocked(rm).mockRejectedValueOnce(Object.assign(new Error('Output remains locked'), { code: 'EBUSY' }))
    if (cleanupFails) active!.emit('close', null, 'SIGKILL')
    else chromeClosed.resolve()
    await expect(cancellation).resolves.toEqual({ cancelled: true })
    expect(await provider.getTask('stuck')).toEqual({ state: 'cancelled' })
    expect(existsSync(join(dir, 'stuck', 'out.part.mp4'))).toBe(cleanupFails)
    await expect.poll(async () => (await provider.getTask('next')).state).toBe('succeeded')
  } finally {
    chromeClosed.resolve()
    active?.emit('close', null, 'SIGKILL')
    rmSync(dir, { recursive: true, force: true })
  }
})
