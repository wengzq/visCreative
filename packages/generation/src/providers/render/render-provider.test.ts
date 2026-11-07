import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chromium } from 'playwright-core'
import { createFfmpegMedia, poster, filmstrip, renderTimeline } from '@vis/assets'
import { ProviderError } from '../types'
import type { ProviderAdapter, ProviderRequest, ProviderTaskState } from '../types'
import { createRenderProvider, defaultRenderLibs, DEFAULT_CHROME_PATHS, RENDER_ORIGIN } from './index'

const chromePath = process.env.VIS_CHROME_PATH ?? DEFAULT_CHROME_PATHS.find(p => existsSync(p))
const hasChrome = !!chromePath && existsSync(chromePath)
const hasFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true } catch { return false } })()

/** One-second paused anime.js timeline with explicit endpoints and no automatic main loop */
const ANIME_PAGE = `<!doctype html><html><body style="margin:0;background:#fff">
<div id="box" style="position:absolute;top:40px;left:0;width:40px;height:40px;background:#c33"></div>
<script src="/lib/anime.js"></script>
<script>
  anime.engine.useDefaultMainLoop = false
  anime.engine.pause()
  anime.engine.timeUnit = 'ms'
  const timeline = anime.createTimeline({ autoplay: false })
    .add('#box', { x: [0, 260], duration: 1000, ease: 'linear' }, 0)
  window.vis = { duration: 1, seek(t) { timeline.seek(t * 1000, true) } }
  window.timeline = timeline
</script></body></html>`

const request = (html: string, params: Record<string, unknown> = {}): ProviderRequest => ({
  operation: 'generate',
  kind: 'video', model: 'html', prompt: '方块平移', params: { width: 320, height: 180, fps: 10, ...params }, inputs: [{ type: 'text', text: html }],
})

async function settle(provider: ProviderAdapter, id: string, timeoutMs = 30_000): Promise<ProviderTaskState> {
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline;) {
    const state = await provider.getTask(id)
    if (state.state === 'succeeded' || state.state === 'failed' || state.state === 'cancelled') return state
    await new Promise(r => setTimeout(r, 50))
  }
  throw new Error('Rendering did not finish')
}

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'vis-render-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('render provider', () => {
  it('no HTML text input: rejects immediately', async () => {
    const provider = createRenderProvider({ workDir: dir, chromePath: process.execPath })
    const promise = provider.submit({ ...request(''), inputs: [] }, { idempotencyKey: 'k' })
    await expect(promise).rejects.toBeInstanceOf(ProviderError)
    await expect(promise).rejects.toMatchObject({ kind: 'rejected' })
  })

  it('cancelling a render before it starts keeps the job cancelled', async () => {
    const provider = createRenderProvider({ workDir: dir, chromePath: process.execPath })
    await provider.submit(request(ANIME_PAGE), { idempotencyKey: 'queued' })
    await expect(provider.cancel!('queued')).resolves.toEqual({ cancelled: true })
    expect(await provider.getTask('queued')).toEqual({ state: 'cancelled' })
    await expect(provider.download({ outputIndex: 0, ref: 'queued' })).rejects.toMatchObject({ kind: 'rejected' })
  })

  describe.skipIf(!hasChrome || !hasFfmpeg)('Local Chrome + ffmpeg', () => {
    it('keeps real Chrome alpha through WebM decoding, probing, frame extraction, posters and timeline composition', async () => {
      const provider = createRenderProvider({ workDir: dir })
      const html = '<body style="margin:0"><div style="position:absolute;left:16px;top:16px;width:32px;height:32px;background:red"></div><script>window.vis={duration:1,seek(){}}</script>'
      await provider.submit(request(html, { width: 64, height: 64, fps: 4, transparent: true }), { idempotencyKey: 'alpha' })
      expect(await settle(provider, 'alpha')).toMatchObject({ state: 'succeeded' })
      const output = await provider.download({ outputIndex: 0, ref: 'alpha' })
      expect(output).toMatchObject({ mime: 'video/webm', hasAlpha: true, fps: 4 })
      const file = join(dir, 'alpha.webm')
      writeFileSync(file, output.data)
      const rgba = (path: string, decoder: string[] = []) => execFileSync('ffmpeg', ['-v', 'error', ...decoder, '-i', path, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'])
      const pixel = (data: Buffer, x: number, y: number) => [...data.subarray((y * 64 + x) * 4, (y * 64 + x) * 4 + 4)]
      const decoded = rgba(file, ['-c:v', 'libvpx-vp9'])
      expect(pixel(decoded, 4, 4)[3]).toBe(0)
      expect(pixel(decoded, 32, 32)[3]).toBe(255)
      expect(pixel(decoded, 32, 32)[0]).toBeGreaterThan(240)
      const restarted = createRenderProvider({ workDir: dir })
      expect(await restarted.findTaskByIdempotencyKey!('alpha')).toEqual({ externalTaskId: 'alpha' })
      expect(await restarted.download({ outputIndex: 0, ref: 'alpha' })).toMatchObject({ mime: 'video/webm', hasAlpha: true })
      const media = createFfmpegMedia()
      expect(await media.probe(file)).toMatchObject({ hasAlpha: true, mime: 'video/webm' })
      const mov = await media.process(file, 'video.exportMov', {})
      try {
        const data = rgba(mov.outputs[0]!.path)
        expect(pixel(data, 4, 4)[3]).toBe(0)
        expect(pixel(data, 32, 32)[3]).toBe(255)
        expect(pixel(data, 32, 32)[0]).toBeGreaterThan(240)
        expect(mov.outputs[0]).toMatchObject({ mime: 'video/quicktime', hasAlpha: true })
      } finally { await mov.dispose() }
      const frame = await media.process(file, 'video.frame', { atMs: 100 })
      try { expect(pixel(rgba(frame.outputs[0]!.path), 4, 4)[3]).toBe(0) } finally { await frame.dispose() }
      const jpg = join(dir, 'poster.jpg')
      await poster(file, jpg)
      const image = rgba(jpg)
      expect(pixel(image, 4, 4)[0]).toBeGreaterThan(210)
      expect(pixel(image, 16, 4)[0]).toBeGreaterThan(180)
      expect(pixel(image, 16, 4)[0]).toBeLessThan(200)
      expect(pixel(image, 32, 32)[0]).toBeGreaterThan(240)
      await filmstrip(file, join(dir, 'strip.jpg'))
      const background = join(dir, 'blue.mp4')
      execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=4:d=1', '-c:v', 'libx264', '-y', background])
      const clip = (id: string, overlay = false) => ({ id, source: { nodeId: id, assetVersionId: id }, startMs: 0, inMs: 0, outMs: 1000, volume: 1, fadeInMs: 0, fadeOutMs: 0, ...(overlay ? { overlay: { x: 0.5, y: 0.5, width: 1, opacity: 1 } } : {}) })
      for (const overlay of [true, false]) {
        const result = await renderTimeline({ version: 1, output: { width: 64, height: 64, fps: 4 }, tracks: overlay
          ? [{ id: 'base', kind: 'video', muted: false, volume: 1, clips: [clip('blue')] }, { id: 'over', kind: 'overlay', muted: false, volume: 1, clips: [clip('alpha', true)] }]
          : [{ id: 'base', kind: 'video', muted: false, volume: 1, clips: [clip('alpha')] }] },
        new Map([['alpha', { kind: 'video', path: file, durationMs: 1000 }], ['blue', { kind: 'video', path: background, durationMs: 1000 }]]),
        { encoder: { name: 'libx264', args: ['-crf', '18'], hardware: false } })
        try {
          const data = rgba(result.path)
          const corner = pixel(data, 4, 4)
          expect(corner[0]).toBeLessThan(12)
          expect(corner[1]).toBeLessThan(12)
          if (overlay) expect(corner[2]).toBeGreaterThan(240)
          else expect(corner[2]).toBeLessThan(12)
          expect(pixel(data, 32, 32)[0]).toBeGreaterThan(230)
        } finally { await result.dispose() }
      }
    }, 60_000)

    it('renders the seek-only blockout with WebGL 2, two input textures and changing frames', async () => {
      const provider = createRenderProvider({ workDir: dir })
      const html = readFileSync(new URL('./fixtures/blockout.html', import.meta.url), 'utf8')
      const req = request(html, { fps: 8 })
      for (const [index, color] of ['#e94936', '#2866cf'].entries()) {
        const path = join(dir, `texture-${index}.svg`)
        writeFileSync(path, `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="${color}"/><path d="M0 0L64 64M0 64L64 0" stroke="white" stroke-width="8"/></svg>`)
        req.inputs.push({ type: 'asset', path, mime: 'image/svg+xml', kind: 'image' })
      }
      const { externalTaskId } = await provider.submit(req, { idempotencyKey: 'blockout' })
      // The sample throws unless every seek has an active WebGL 2 context; a WebGL failure must fail this test.
      expect(await settle(provider, externalTaskId, 45_000)).toEqual({ state: 'succeeded', outputs: [{ outputIndex: 0, ref: externalTaskId }] })
      const out = await provider.download({ outputIndex: 0, ref: externalTaskId })
      expect(out).toMatchObject({ width: 320, height: 180, durationMs: 1000, fps: 8, mime: 'video/mp4' })
      const file = join(dir, 'blockout.mp4')
      writeFileSync(file, out.data)
      expect(execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,nb_read_frames', '-of', 'csv=p=0', file], { encoding: 'utf8' }).trim()).toBe('320,180,8')
      const hashes = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'framemd5', '-'], { encoding: 'utf8' })
        .split('\n').filter(line => line && !line.startsWith('#')).map(line => line.split(',').at(-1)!.trim())
      expect(hashes).toHaveLength(8)
      expect(hashes[0]).not.toBe(hashes.at(-1))
      expect(new Set(hashes).size).toBe(8)
    }, 60_000)

    it('cancelling an active render whose seek never returns closes Chrome and the encoder, then continues the queue', async () => {
      const provider = createRenderProvider({ workDir: dir })
      const html = '<script>window.vis = { duration: 10, seek: t => t > 0 ? new Promise(() => {}) : undefined }</script>'
      await provider.submit(request(html), { idempotencyKey: 'stuck' })
      let started = false
      // Chrome starts slowly under heavy load; wait until a deadline instead of a fixed number of attempts
      for (const deadline = Date.now() + 20_000; Date.now() < deadline;) {
        const state = await provider.getTask('stuck')
        if (state.state === 'running' && (state.progress ?? 0) > 0) { started = true; break }
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      expect(started).toBe(true)
      await expect(provider.cancel!('stuck')).resolves.toEqual({ cancelled: true })
      expect(await provider.getTask('stuck')).toEqual({ state: 'cancelled' })
      expect(existsSync(join(dir, 'stuck', 'out.mp4'))).toBe(false)
      await provider.submit(request(ANIME_PAGE), { idempotencyKey: 'next' })
      expect((await settle(provider, 'next')).state).toBe('succeeded')
    }, 30_000)

    it('frame-by-frame seek screenshots produce mp4; repeated keys return the same job, recoverable and downloadable after restart', async () => {
      const provider = createRenderProvider({ workDir: dir })
      const { externalTaskId } = await provider.submit(request(ANIME_PAGE), { idempotencyKey: 'att_1' })
      expect(await provider.submit(request(ANIME_PAGE), { idempotencyKey: 'att_1' })).toEqual({ externalTaskId })
      expect(await settle(provider, externalTaskId)).toEqual({ state: 'succeeded', outputs: [{ outputIndex: 0, ref: externalTaskId }] })

      const out = await provider.download({ outputIndex: 0, ref: externalTaskId })
      expect(out).toMatchObject({ mime: 'video/mp4', width: 320, height: 180, durationMs: 1000, fps: 10 })
      const file = join(dir, 'probe.mp4')
      writeFileSync(file, out.data)
      const probed = execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,nb_read_frames', '-of', 'csv=p=0', file], { encoding: 'utf8' }).trim()
      expect(probed).toBe('320,180,10')
      const frames = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'framemd5', '-'], { encoding: 'utf8' })
        .split('\n').filter(line => line && !line.startsWith('#')).map(line => line.split(',').at(-1)!.trim())
      expect(new Set(frames).size).toBe(10)

      const restarted = createRenderProvider({ workDir: dir })
      expect(await restarted.findTaskByIdempotencyKey!('att_1')).toEqual({ externalTaskId })
      expect(await restarted.download({ outputIndex: 0, ref: externalTaskId })).toMatchObject({ width: 320, durationMs: 1000, fps: 10 })
    }, 60_000)

    it('uses newly added and replaced author libraries without restarting the provider', async () => {
      const userLibDir = join(dir, 'render-libs')
      const provider = createRenderProvider({ workDir: join(dir, 'render'), userLibDir })
      const html = '<script src="/lib/gsap.js"></script><script>const version = gsap.version\nwindow.vis = { duration: 0.1, seek() { if (version !== 1) throw new Error("Wrong author library") } }</script>'
      await provider.submit(request(html), { idempotencyKey: 'missing' })
      expect(await settle(provider, 'missing')).toMatchObject({ state: 'failed', error: {
        code: 'render.lib_missing', message: expect.stringContaining('gsap.js'),
        data: { reason: 'render.lib_missing', params: { name: 'gsap.js' } },
      } })
      mkdirSync(userLibDir)
      writeFileSync(join(userLibDir, 'gsap.js'), 'window.gsap = { version: 1 }')
      await provider.submit(request(html), { idempotencyKey: 'installed' })
      expect(await settle(provider, 'installed')).toMatchObject({ state: 'succeeded' })
      writeFileSync(join(userLibDir, 'gsap.js'), 'window.gsap = { version: 2 }')
      await provider.submit(request(html.replace('!== 1', '!== 2')), { idempotencyKey: 'updated' })
      expect(await settle(provider, 'updated')).toMatchObject({ state: 'succeeded' })
    }, 60_000)

    it('keeps the built-in anime.js when an author file has the same name', async () => {
      const userLibDir = join(dir, 'render-libs')
      mkdirSync(userLibDir)
      writeFileSync(join(userLibDir, 'anime.js'), 'throw new Error("Author library replaced built-in")')
      const provider = createRenderProvider({ workDir: join(dir, 'render'), userLibDir })
      await provider.submit(request(ANIME_PAGE, { fps: 2 }), { idempotencyKey: 'builtin' })
      expect(await settle(provider, 'builtin')).toMatchObject({ state: 'succeeded' })
    }, 30_000)

    it('reports missing libraries requested inside an asynchronous seek with their stable reason', async () => {
      const provider = createRenderProvider({ workDir: dir })
      const html = '<script>window.vis = { duration: 0.1, async seek() { await fetch("/lib/optional.js") } }</script>'
      await provider.submit(request(html), { idempotencyKey: 'seek-library' })
      expect(await settle(provider, 'seek-library')).toMatchObject({ state: 'failed', error: {
        code: 'render.lib_missing', data: { reason: 'render.lib_missing', params: { name: 'optional.js' } },
      } })
    }, 30_000)

    it('fails a seek waiting for a missing script load instead of leaving the render running', async () => {
      const provider = createRenderProvider({ workDir: dir })
      const html = `<script>
        window.vis = { duration: 0.1, seek() {
          return new Promise(resolve => {
            const script = document.createElement('script')
            script.src = '/lib/missing.js'
            script.onload = resolve
            document.head.append(script)
          })
        } }
      </script>`
      await provider.submit(request(html), { idempotencyKey: 'waiting-script' })
      expect(await settle(provider, 'waiting-script')).toMatchObject({ state: 'failed', error: {
        code: 'render.lib_missing', data: { reason: 'render.lib_missing', params: { name: 'missing.js' } },
      } })
    }, 30_000)

    it('fails as soon as a library requested after load is missing, without waiting for the readiness timeout', async () => {
      const provider = createRenderProvider({ workDir: dir })
      const html = '<script>addEventListener("load", () => setTimeout(() => import("/lib/late.js").catch(() => {}), 0))</script>'
      const started = Date.now()
      await provider.submit(request(html), { idempotencyKey: 'late-library' })
      expect(await settle(provider, 'late-library')).toMatchObject({ state: 'failed', error: {
        code: 'render.lib_missing', data: { reason: 'render.lib_missing', params: { name: 'late.js' } },
      } })
      expect(Date.now() - started).toBeLessThan(10_000)
    }, 30_000)

    it('does not advise installing a library whose name can never be installed', async () => {
      const provider = createRenderProvider({ workDir: dir })
      await provider.submit(request('<script src="/lib/three.addons.js"></script>'), { idempotencyKey: 'refused-library' })
      expect(await settle(provider, 'refused-library')).toMatchObject({ state: 'failed', error: {
        code: 'render.lib_name_refused', data: { reason: 'render.lib_name_refused', params: { name: 'three.addons.js' } },
      } })
    }, 30_000)

    it('keeps a finished render when the page logs an error after its last frame', async () => {
      const provider = createRenderProvider({ workDir: dir })
      const html = '<script>window.vis = { duration: 0.1, seek() { setTimeout(() => console.error("late diagnostic"), 10) } }</script>'
      await provider.submit(request(html, { fps: 10, durationMs: 100 }), { idempotencyKey: 'late-diagnostic' })
      expect(await settle(provider, 'late-diagnostic')).toMatchObject({ state: 'succeeded' })
    }, 30_000)

    it('pages without window.vis fail and explain the contract', async () => {
      // Navigation and contract readiness share this budget; allow both to finish under load.
      const provider = createRenderProvider({ workDir: dir })
      await provider.submit(request('<p>hi</p>'), { idempotencyKey: 'k' })
      const state = await settle(provider, 'k', 45_000)
      expect(state).toMatchObject({ state: 'failed', error: { code: 'render_failed', message: expect.stringContaining('window.vis') } })
    }, 60_000)

    it('page errors or external requests fail with reasons to help the agent edit', async () => {
      const provider = createRenderProvider({ workDir: dir })
      const html = `<script src="https://cdn.example.com/x.js"></script><script>window.vis = { duration: 1, seek: t => { if (t > 0.5) throw new Error('坏了') } }</script>`
      await provider.submit(request(html), { idempotencyKey: 'k' })
      const state = await settle(provider, 'k')
      expect(state.state).toBe('failed')
      if (state.state !== 'failed') return
      expect(state.error.message).toContain('External address access is not allowed: https://cdn.example.com/x.js')
      await expect(provider.findTaskByIdempotencyKey!('k')).resolves.toEqual({ externalTaskId: 'k' })
    }, 30_000)

    it('asset inputs are served to the page through /input/<n>', async () => {
      const provider = createRenderProvider({ workDir: dir })
      const svg = join(dir, 'a.svg')
      writeFileSync(svg, '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>')
      const html = `<img id="i" src="/input/0"><script>window.vis = { duration: 0.2, seek: () => { if (!document.getElementById('i').naturalWidth) throw new Error('图片没加载') } }</script>`
      await provider.submit({ ...request(html), inputs: [{ type: 'text', text: html }, { type: 'asset', kind: 'image', mime: 'image/svg+xml', path: svg }] }, { idempotencyKey: 'k' })
      expect(await settle(provider, 'k')).toMatchObject({ state: 'succeeded' })
    }, 30_000)
  })

  describe.skipIf(!hasChrome)('Local Chrome determinism', () => {
    it('keeps paused anime.js frames identical across out-of-order seeks and elapsed timers and animation frames', async () => {
      const browser = await chromium.launch({ executablePath: chromePath!, headless: true })
      try {
        const page = await browser.newPage({ viewport: { width: 320, height: 180 }, deviceScaleFactor: 1 })
        await page.addInitScript(`(() => {
          window.animationScheduling = { timer: 0, frame: 0 }
          for (const method of ['setTimeout', 'setInterval', 'requestAnimationFrame']) {
            const original = window[method].bind(window)
            window[method] = (...args) => {
              window.animationScheduling[method === 'requestAnimationFrame' ? 'frame' : 'timer']++
              return original(...args)
            }
          }
        })()`)
        await page.route('**/*', route => route.fulfill(route.request().url().endsWith('/lib/anime.js')
          ? { contentType: 'text/javascript', path: defaultRenderLibs()['anime.js']! }
          : { contentType: 'text/html', body: ANIME_PAGE }))
        await page.goto(`${RENDER_ORIGIN}/`)
        const snapshot = async (time: number) => {
          await page.evaluate(`window.vis.seek(${time})`)
          expect(await page.evaluate('window.timeline.paused')).toBe(true)
          expect(await page.evaluate('document.getElementById("box").getBoundingClientRect().x')).toBeCloseTo(time * 260, 5)
          return page.screenshot({ type: 'png' })
        }
        const expected = new Map<number, Buffer>()
        for (const time of [0, 0.25, 0.5, 0.75, 1]) expected.set(time, await snapshot(time))
        expect(new Set([...expected.values()].map(frame => frame.toString('base64'))).size).toBe(5)
        for (const time of [0.75, 0, 1, 0.25, 0.5, 0.25, 1, 0]) expect(await snapshot(time)).toEqual(expected.get(time))
        expect(await page.evaluate('window.animationScheduling')).toEqual({ timer: 0, frame: 0 })
        const held = await snapshot(0.5)
        // Let both browser scheduling mechanisms run while the timeline receives no seeks.
        await page.evaluate('new Promise(resolve => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(resolve)), 250))')
        expect(await page.screenshot({ type: 'png' })).toEqual(held)
        expect(await page.evaluate('window.timeline.currentTime')).toBe(500)
        expect(await page.evaluate('window.animationScheduling')).toEqual({ timer: 1, frame: 2 })
      } finally {
        await browser.close()
      }
    }, 30_000)
  })
})
