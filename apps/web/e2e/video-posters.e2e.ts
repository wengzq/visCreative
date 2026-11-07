import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright-core'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockProvider } from '../../../packages/generation/src/index'
import { createFfmpegMedia } from '../../../packages/assets/src/index'
import { createMemorySecretStore } from '../../../services/studiod/src/secret-store'
import { startStudiod, type Studiod } from '../../../services/studiod/src/studiod'
import { createWebHost, type WebHost } from '../src/host/server'
import { openStudiodLink, type StudiodLink } from '../src/host/studiod-link'
import { chromePath, removeTempDir } from './platform'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const ready = existsSync(chromePath()) && existsSync(join(root, 'apps/web/dist/client/index.html'))

describe.skipIf(!ready)('Canvas video posters', () => {
  let dir: string
  let daemon: Studiod
  let host: WebHost
  let admin: StudiodLink
  let browser: Browser
  let page: Page
  let nodeId: string
  let imageAssetId: string
  const errors: string[] = []
  const node = () => page.locator('.react-flow__node').filter({ hasText: 'Video poster fixture' })
  const player = () => node().locator('.vis-video-player')
  const video = () => player().locator('video')
  const loadedPoster = () => expect.poll(() => player().locator('img').evaluate(image => (image as HTMLImageElement).naturalWidth), { timeout: 10_000 }).toBe(320)
  const leave = async () => {
    await page.mouse.move(1550, 950)
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'vis-video-posters-'))
    vi.stubEnv('VIS_PROJECTS_DIR', join(dir, 'projects'))
    daemon = await startStudiod({ dataDir: dir, studiodVersion: 'e2e', runtimes: {}, secretStore: createMemorySecretStore(), providers: [createMockProvider({ latencyMs: 0 })], defaults: { image: { provider: 'mock' }, video: { provider: 'mock' }, audio: { provider: 'mock' } } })
    const { spaceId } = daemon.spaces.create('Video posters')
    const path = join(dir, 'fixture.mp4')
    execFileSync('ffmpeg', ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=15:duration=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path])
    const info = await createFfmpegMedia().probe(path)
    const space = daemon.spaces.get(spaceId)!
    const { assetVersionId } = space.assets.registerVersion(space.db, { staged: await space.assets.stageFile(path), kind: info.kind, mime: info.mime, origin: 'import', width: 320, height: 180, durationMs: 6000 })
    const still = join(dir, 'still.png')
    execFileSync('ffmpeg', ['-v', 'error', '-nostdin', '-i', path, '-frames:v', '1', still])
    imageAssetId = space.assets.registerVersion(space.db, { staged: await space.assets.stageFile(still), kind: 'image', mime: 'image/png', origin: 'import', width: 320, height: 180 }).assetVersionId
    admin = await openStudiodLink({ socketPath: daemon.socketPath, tokenPath: daemon.tokenPath })
    await admin.call('events.subscribe', { spaceId })
    const result = await admin.call('canvas.apply', { requestId: crypto.randomUUID(), ops: [{ op: 'node.create', tempId: 'video', title: 'Video poster fixture', kind: 'video', x: 300, y: 200, w: 480, h: 270, content: { assetVersionId } }] })
    nodeId = result.idMap.video
    host = await createWebHost({ socketPath: daemon.socketPath, tokenPath: daemon.tokenPath, staticDir: join(root, 'apps/web/dist/client') })
    browser = await chromium.launch({ executablePath: chromePath(), headless: true })
  })

  beforeEach(async () => {
    page = await browser.newPage({ locale: 'en-US', viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 })
    page.setDefaultTimeout(10_000)
    page.on('pageerror', error => errors.push(error.message))
    await page.mouse.move(1550, 950)
    await page.goto(host.url)
    await node().waitFor()
  })

  afterEach(async () => { await page?.close() })
  afterAll(async () => {
    await browser?.close()
    admin?.close()
    await host?.close()
    await daemon?.stop('user_quit')
    vi.unstubAllEnvs()
    removeTempDir(dir)
  })

  it('keeps idle nodes decoder-free, plays on demand, and releases paused idle players', async () => {
    await loadedPoster()
    expect(await video().count()).toBe(0)
    expect(await player().locator('img').getAttribute('src')).toContain('/poster?t=')
    await page.screenshot({ path: '/tmp/vis-video-posters-idle.png', animations: 'disabled' })
    await node().hover()
    await expect.poll(() => video().evaluate(v => (v as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2)
    await player().getByRole('button', { name: 'Play', exact: true }).click()
    await expect.poll(() => video().evaluate(v => (v as HTMLVideoElement).currentTime)).toBeGreaterThan(0.1)
    await leave()
    await new Promise(resolve => setTimeout(resolve, 3200))
    expect(await video().evaluate(v => (v as HTMLVideoElement).paused)).toBe(false)
    await page.locator('.react-flow__pane').click({ position: { x: 20, y: 400 } })
    await leave()
    await video().evaluate(v => (v as HTMLVideoElement).pause())
    await expect.poll(() => video().count(), { timeout: 5000 }).toBe(0)
    await loadedPoster()
    expect(errors).toEqual([])
  })

  it('shows the video while the poster is stuck in the preview queue and releases it only once the poster arrives', async () => {
    let release = () => {}
    const held = new Promise<void>(resolve => { release = resolve })
    await page.route('**/poster?*', async route => {
      await held
      await route.continue().catch(() => {})
    })
    await page.reload()
    await node().waitFor()
    await leave()
    await expect.poll(() => video().evaluate(v => (v as HTMLVideoElement).readyState).catch(() => 0), { timeout: 8000 }).toBeGreaterThanOrEqual(2)
    await new Promise(resolve => setTimeout(resolve, 3500))
    expect(await video().isVisible()).toBe(true)
    release()
    await expect.poll(() => video().count(), { timeout: 8000 }).toBe(0)
    await loadedPoster()
  })

  it('honors play on the first click while the video is still mounting and keeps the poster until a frame arrives', async () => {
    await loadedPoster()
    await page.route('**/assets/**', async route => {
      await new Promise(resolve => setTimeout(resolve, 400))
      await route.continue()
    })
    await player().getByRole('button', { name: 'Play', exact: true }).evaluate(button => (button as HTMLButtonElement).click())
    await expect.poll(() => video().count()).toBe(1)
    expect(await player().locator('img').isVisible()).toBe(true)
    await expect.poll(() => video().evaluate(v => (v as HTMLVideoElement).currentTime)).toBeGreaterThan(0.1)
    await expect.poll(() => player().locator('img').isVisible()).toBe(false)
  })

  it('activates on keyboard focus and selection, then releases immediately when off screen', async () => {
    await loadedPoster()
    await player().getByRole('button', { name: 'Play', exact: true }).focus()
    await expect.poll(() => video().count()).toBe(1)
    await leave()
    await expect.poll(() => video().count(), { timeout: 5000 }).toBe(0)
    await node().click({ position: { x: 100, y: 80 } })
    await leave()
    await new Promise(resolve => setTimeout(resolve, 3200))
    expect(await video().count()).toBe(1)
    await video().evaluate(v => { void (v as HTMLVideoElement).play() })
    await expect.poll(() => video().evaluate(v => (v as HTMLVideoElement).paused)).toBe(false)
    await admin.call('canvas.apply', { requestId: crypto.randomUUID(), ops: [{ op: 'node.layout', nodeId, x: 10000, y: 10000 }] })
    await expect.poll(() => video().count()).toBe(0)
    await admin.call('canvas.apply', { requestId: crypto.randomUUID(), ops: [{ op: 'node.layout', nodeId, x: 300, y: 200 }] })
  })

  it('keeps an image clip visible after its source node has been deleted', async () => {
    const source = await admin.call('canvas.apply', { requestId: crypto.randomUUID(), ops: [{ op: 'node.create', tempId: 'image', kind: 'image', x: 50, y: 50, content: { assetVersionId: imageAssetId } }] })
    const timeline = await admin.call('canvas.apply', { requestId: crypto.randomUUID(), ops: [{ op: 'node.create', tempId: 'timeline', kind: 'timeline', title: 'Frozen image clip', x: 850, y: 200, w: 300, h: 260, content: { timelineFrom: [source.idMap.image] } }] })
    try {
      await admin.call('canvas.apply', { requestId: crypto.randomUUID(), ops: [{ op: 'node.delete', nodeId: source.idMap.image }] })
      const preview = page.getByRole('region', { name: /^Timeline Frozen image clip,/ }).getByRole('group', { name: 'First clip preview', exact: true })
      await expect.poll(() => preview.locator('img').evaluate(image => (image as HTMLImageElement).naturalWidth), { timeout: 10_000 }).toBe(320)
      expect(await preview.locator('img').getAttribute('src')).toContain('/assets/')
      expect(await preview.locator('video').count()).toBe(0)
    } finally {
      await admin.call('canvas.apply', { requestId: crypto.randomUUID(), ops: [{ op: 'node.delete', nodeId: timeline.idMap.timeline }] })
    }
  })

  it('falls back to the live metadata player if the poster fails', async () => {
    await page.route('**/previews/**/poster?*', route => route.fulfill({ status: 503, body: 'Preview unavailable' }))
    await page.reload()
    await expect.poll(() => video().evaluate(v => (v as HTMLVideoElement).videoWidth)).toBe(320)
    expect(await video().getAttribute('preload')).toBe('metadata')
    await leave()
    await new Promise(resolve => setTimeout(resolve, 3200))
    expect(await video().count()).toBe(1)
  })
})
