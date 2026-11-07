import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
// Alias: the bundled entry already declares createRequire, so the same name would conflict
import { createRequire as moduleRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { chromium, type Route } from 'playwright-core'
import { promisify } from 'node:util'
import { RenderVideoParams, RENDER_MAX_DURATION_MS } from '@vis/protocol'
import type { z } from 'zod'
import { ProviderError } from '../types'
import type { ProviderAdapter, ProviderInput, ProviderRequest, ProviderTaskState } from '../types'
import { canInstallRenderLibrary, readRenderLibrary } from './render-libs'

/** Virtual origin for the page: all requests are answered locally and all other addresses blocked */
export const RENDER_ORIGIN = 'https://vis.local'
export { RENDER_MAX_DURATION_MS } from '@vis/protocol'
const exec = promisify(execFile)

export type RenderProviderOptions = {
  /** Render output directory keyed by idempotency key; completed jobs remain recoverable after restart */
  workDir: string
  chromePath?: string
  ffmpegPath?: string
  /** Libraries available to pages: name -> local file, accessed through https://vis.local/lib/<name> */
  libs?: Record<string, string>
  /** Author-managed libraries outside project and session work directories; read for each request */
  userLibDir?: string
  /** Maximum wait for page readiness (window.vis definition) */
  loadTimeoutMs?: number
}

const paramsSchema = RenderVideoParams
type Params = z.infer<typeof paramsSchema>

type Meta = { width: number; height: number; durationMs: number; fps?: number; transparent?: boolean; hasAlpha?: boolean }
type Task =
  | { state: 'running'; progress: number }
  | { state: 'cancelled' }
  | { state: 'succeeded'; meta: Meta }
  | Extract<ProviderTaskState, { state: 'failed' }>

export const DEFAULT_CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  ...(process.platform === 'win32'
    ? [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]
      .filter((root): root is string => !!root)
      .flatMap(root => [join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'), join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe')])
    : []),
]

/** Find libraries in dependencies when running from source; callers pass libs after bundling */
export function defaultRenderLibs(): Record<string, string> {
  const require = moduleRequire(import.meta.url)
  return {
    'anime.js': join(dirname(require.resolve('animejs/package.json')), 'dist', 'bundles', 'anime.umd.min.js'),
    'rough.js': require.resolve('roughjs/bundled/rough.js'),
    'three.module.js': join(require.resolve('three'), '..', 'three.module.js'),
    'three.core.js': join(require.resolve('three'), '..', 'three.core.js'),
  }
}

/**
 * Code rendering: the agent writes an HTML animation into a canvas text node as the first text input;
 * local headless Chrome opens the page and calls window.vis.seek(t) for frame screenshots, which ffmpeg combines into mp4.
 * Pages cannot access the network, only libraries under /lib/ and asset inputs at /input/<n>.
 */
export function createRenderProvider(opts: RenderProviderOptions): ProviderAdapter {
  const chromePath = opts.chromePath ?? process.env.VIS_CHROME_PATH ?? DEFAULT_CHROME_PATHS.find(p => existsSync(p))
  const ffmpeg = opts.ffmpegPath ?? 'ffmpeg'
  const libs = opts.libs ?? defaultRenderLibs()
  const loadTimeoutMs = opts.loadTimeoutMs ?? 15_000
  const tasks = new Map<string, Task>()
  const controllers = new Map<string, AbortController>()
  const rendering = new Map<string, Promise<void>>()
  // Render only one job at a time to avoid saturating the CPU
  let queue = Promise.resolve()

  const dirOf = (key: string) => join(opts.workDir, encodeURIComponent(key))
  const outOf = (key: string) => join(dirOf(key), existsSync(join(dirOf(key), 'out.webm')) ? 'out.webm' : 'out.mp4')

  async function readMeta(key: string): Promise<Meta | null> {
    try {
      return JSON.parse(await readFile(join(dirOf(key), 'meta.json'), 'utf8')) as Meta
    } catch {
      return null
    }
  }

  async function render(key: string, req: ProviderRequest, params: Params, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return
    const html = req.inputs.find((i): i is Extract<ProviderInput, { type: 'text' }> => i.type === 'text')!.text
    const assets = req.inputs.filter((i): i is Extract<ProviderInput, { type: 'asset' }> => i.type === 'asset')
    const dir = dirOf(key)
    await mkdir(dir, { recursive: true })
    const ext = params.transparent ? 'webm' : 'mp4'
    const part = join(dir, `out.part.${ext}`)

    const errors: string[] = []
    let missingLibrary: string | undefined
    let rejectMissingLibrary = () => {}
    const libraryFailure = new Promise<never>((_resolve, reject) => {
      rejectMissingLibrary = () => reject(new RenderError(''))
    })
    void libraryFailure.catch(() => {})
    const orLibraryFailure = <T>(work: Promise<T>) => Promise.race([work, libraryFailure])
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
    const closeBrowser = () => { void browser?.close().catch(() => {}) }
    signal.addEventListener('abort', closeBrowser, { once: true })
    try {
      signal.throwIfAborted()
      if (params.transparent) {
        const { stdout } = await exec(ffmpeg, ['-hide_banner', '-encoders'], { timeout: 30_000, windowsHide: true })
        if (!/\blibvpx-vp9\b/.test(stdout)) throw new RenderError('This ffmpeg lacks libvpx-vp9; transparent WebM rendering is unavailable', 'generation.render_alpha_encoder_missing')
      }
      browser = await chromium.launch({ executablePath: chromePath!, headless: true })
      signal.throwIfAborted()
      const page = await browser.newPage({ viewport: { width: params.width, height: params.height }, deviceScaleFactor: 1 })
      page.on('pageerror', e => errors.push(`Page error: ${e.message}`))
      page.on('console', m => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`) })
      const serve = async (route: Route) => {
        const url = new URL(route.request().url())
        if (url.origin !== RENDER_ORIGIN) {
          errors.push(`External address access is not allowed: ${url.href}`)
          return route.abort()
        }
        if (url.pathname === '/' || url.pathname === '/index.html') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html })
        if (url.pathname.startsWith('/lib/')) {
          let name = url.pathname.slice('/lib/'.length)
          try { name = decodeURIComponent(name) } catch {}
          const body = await readRenderLibrary(name, libs, opts.userLibDir)
          if (body) return route.fulfill({ contentType: 'text/javascript; charset=utf-8', body })
          missingLibrary ??= name
          errors.push(`Render library "${name}" is unavailable`)
          rejectMissingLibrary()
          return route.fulfill({ status: 404, body: '' })
        }
        const n = url.pathname.match(/^\/input\/(\d+)$/)?.[1]
        const asset = n !== undefined ? assets[Number(n)] : undefined
        if (asset) return route.fulfill({ contentType: asset.mime, path: asset.path })
        errors.push(`Page requested a nonexistent address: ${url.pathname}`)
        return route.fulfill({ status: 404, body: '' })
      }
      // Closing the browser during a library read rejects fulfill, and nothing above this handler would catch that.
      await page.route('**/*', route => serve(route).catch(() => {}))

      await page.goto(`${RENDER_ORIGIN}/`, { waitUntil: 'load', timeout: loadTimeoutMs })
      if (missingLibrary !== undefined) throw new RenderError('')
      try {
        await orLibraryFailure(page.waitForFunction(`typeof window.vis === 'object' && typeof window.vis.seek === 'function'`, null, { timeout: loadTimeoutMs }))
      } catch {
        throw new RenderError(`Page did not define window.vis = { duration, seek(t) } within ${loadTimeoutMs / 1000} seconds`)
      }
      await orLibraryFailure(page.evaluate('document.fonts.ready.then(() => true)'))
      const pageDuration = Number(await orLibraryFailure(page.evaluate('window.vis.duration')))
      const durationMs = params.durationMs ?? Math.round(pageDuration * 1000)
      if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > RENDER_MAX_DURATION_MS) {
        throw new RenderError(`Invalid duration: window.vis.duration must be a number from 0 to ${RENDER_MAX_DURATION_MS / 1000} seconds; got ${pageDuration}`)
      }
      if (errors.length) throw new RenderError('')

      const frames = Math.max(1, Math.round((durationMs / 1000) * params.fps))
      const encoder = spawn(ffmpeg, [
        '-v', 'error', '-y', '-f', 'image2pipe', '-framerate', String(params.fps), '-i', '-',
        ...(params.transparent
          ? ['-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-crf', '18', '-b:v', '0', '-auto-alt-ref', '0']
          : ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-movflags', '+faststart']), part,
      ], { stdio: ['pipe', 'ignore', 'pipe'] })
      const killEncoder = () => { encoder.kill('SIGKILL') }
      signal.addEventListener('abort', killEncoder, { once: true })
      let stderr = ''
      encoder.stderr.setEncoding('utf8').on('data', (c: string) => { stderr += c })
      const encoded = new Promise<void>((resolve, reject) => {
        encoder.stdin.once('error', reject)
        encoder.once('error', error => reject((error as { code?: string }).code === 'ENOENT' ? new RenderError(`Cannot find ${ffmpeg}; install ffmpeg first`, 'render_unavailable') : error))
        encoder.once('exit', code => code === 0 ? resolve() : reject(new RenderError(`ffmpeg encoding failed: ${stderr.trim()}`, 'render_unavailable')))
      })
      encoded.catch(() => {})
      try {
        for (let i = 0; i < frames; i++) {
          signal.throwIfAborted()
          // Paused animation objects can be thenable without ever completing.
          // A loader may wait forever for script.onload after a 404; fail that seek as soon as its library is missing.
          await orLibraryFailure(page.evaluate(`(async () => { const r = window.vis.seek(${i / params.fps}); if (r instanceof Promise) await r; return true })()`))
          if (errors.length) throw new RenderError(`Error at frame ${i} (${(i / params.fps).toFixed(2)} seconds)`)
          const png = await page.screenshot({ type: 'png', omitBackground: params.transparent })
          signal.throwIfAborted()
          if (!encoder.stdin.write(png)) await once(encoder.stdin, 'drain', { signal })
          signal.throwIfAborted()
          tasks.set(key, { state: 'running', progress: (i + 1) / frames })
        }
      } catch (error) {
        encoder.kill('SIGKILL')
        await encoded.catch(() => {})
        signal.removeEventListener('abort', killEncoder)
        throw error
      } finally {
        encoder.stdin.end()
      }
      try { await encoded } finally { signal.removeEventListener('abort', killEncoder) }
      // The video is finished: a failed close must not discard it, and only a late library request can still invalidate it.
      await browser.close().catch(() => {})
      browser = undefined
      if (missingLibrary !== undefined) throw new RenderError('')
      signal.throwIfAborted()
      const meta: Meta = { width: params.width, height: params.height, durationMs: Math.round((frames / params.fps) * 1000), fps: params.fps, transparent: params.transparent, hasAlpha: params.transparent }
      await writeFile(join(dir, 'meta.json'), JSON.stringify(meta))
      await rename(part, join(dir, `out.${ext}`))
      signal.throwIfAborted()
      tasks.set(key, { state: 'succeeded', meta })
    } catch (error) {
      await rm(part, { force: true })
      // An environment failure stays itself: installing the library would not fix it.
      const libraryError = missingLibrary !== undefined && !(error instanceof RenderError && error.code === 'render_unavailable')
      const failure = !libraryError ? error
        : canInstallRenderLibrary(missingLibrary!)
          ? new RenderError(`Render library "${missingLibrary}" is missing or unavailable. Add the library to the render-libs folder and retry`, 'render.lib_missing', { name: missingLibrary! })
          : new RenderError(`Render library "${missingLibrary}" cannot be provided. Author libraries must be single .js files that do not use a built-in library name`, 'render.lib_name_refused', { name: missingLibrary! })
      // A missing library cascades into page errors that would bury the cause.
      const message = [failure instanceof Error ? failure.message : String(failure), ...(libraryError ? [] : errors.slice(0, 10))].filter(Boolean).join('\n')
      tasks.set(key, signal.aborted ? { state: 'cancelled' } : { state: 'failed', error: {
        code: failure instanceof RenderError ? failure.code : 'render_failed',
        message,
        ...(failure instanceof RenderError && failure.params ? { data: { reason: failure.code, params: failure.params } } : {}),
      } })
    } finally {
      signal.removeEventListener('abort', closeBrowser)
      await browser?.close().catch(() => {})
    }
  }

  return {
    id: 'render',
    type: 'render',
    kinds: ['video'],
    models: ['html'],
    defaultModels: { video: 'html' },
    paramsSchema,
    async submit(req, { idempotencyKey, signal }) {
      signal?.throwIfAborted()
      if (tasks.has(idempotencyKey) || existsSync(outOf(idempotencyKey))) return { externalTaskId: idempotencyKey }
      if (!chromePath || !existsSync(chromePath)) throw new ProviderError('rejected', 'Cannot find Chrome for rendering; install Google Chrome')
      if (!req.inputs.some(i => i.type === 'text')) throw new ProviderError('rejected', 'inputs requires a text slot containing HTML')
      const parsed = paramsSchema.safeParse(req.params)
      if (!parsed.success) throw new ProviderError('rejected', parsed.error.message)
      tasks.set(idempotencyKey, { state: 'running', progress: 0 })
      const controller = new AbortController()
      controllers.set(idempotencyKey, controller)
      queue = queue.then(async () => {
        const operation = render(idempotencyKey, req, parsed.data, controller.signal)
        rendering.set(idempotencyKey, operation)
        try { await operation } finally { rendering.delete(idempotencyKey) }
      })
      return { externalTaskId: idempotencyKey }
    },
    async getTask(key) {
      const task = tasks.get(key)
      if (!task) {
        if (existsSync(outOf(key))) return { state: 'succeeded', outputs: [{ outputIndex: 0, ref: key }] }
        throw new ProviderError('not_found', 'Render job does not exist (possibly restarted during rendering)')
      }
      if (task.state === 'running') return { state: 'running', progress: task.progress }
      if (task.state === 'cancelled') return { state: 'cancelled' }
      if (task.state === 'failed') return { state: 'failed', error: task.error }
      return { state: 'succeeded', outputs: [{ outputIndex: 0, ref: key }] }
    },
    async findTaskByIdempotencyKey(key) {
      return tasks.has(key) || existsSync(outOf(key)) ? { externalTaskId: key } : null
    },
    async cancel(key) {
      controllers.get(key)?.abort()
      tasks.set(key, { state: 'cancelled' })
      await rendering.get(key)
      return { cancelled: true }
    },
    async download(output, options) {
      options?.signal?.throwIfAborted()
      if (tasks.get(output.ref)?.state === 'cancelled') throw new ProviderError('rejected', 'Render job cancelled')
      if (output.outputIndex !== 0) throw new ProviderError('rejected', 'Output index out of range')
      const meta = await readMeta(output.ref)
      let data: Buffer
      try {
        data = await readFile(outOf(output.ref), options?.signal ? { signal: options.signal } : {})
      } catch {
        throw new ProviderError('not_found', 'Render output does not exist')
      }
      return { data, mime: meta?.transparent || outOf(output.ref).endsWith('.webm') ? 'video/webm' : 'video/mp4', ...(meta ?? {}) }
    },
  }
}

class RenderError extends Error {
  constructor(message: string, readonly code = 'render_failed', readonly params?: Record<string, string | number>) {
    super(message)
  }
}
