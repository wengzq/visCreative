import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright-core'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createFfmpegMedia } from '../../../packages/assets/src/index'
import type { NodeView } from '@vis/protocol'
import { createMockProvider, createRenderProvider } from '../../../packages/generation/src/index'
import { codexRuntime } from '../../../services/studiod/src/codex'
import { createMemorySecretStore } from '../../../services/studiod/src/secret-store'
import { startStudiod, type Studiod } from '../../../services/studiod/src/studiod'
import { studiodEndpoint } from '../../../runtime/studiod-endpoint'
import { createWebHost, type WebHost } from '../src/host/server'
import { openStudiodLink, type StudiodLink } from '../src/host/studiod-link'
import { chromePath, removeTempDir } from './platform'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const cli = join(root, 'apps/cli/dist/vis.mjs')
const ready = existsSync(chromePath()) && existsSync(cli)
const screenshots = process.platform === 'win32' ? join(tmpdir(), 'vis-next/rfc36') : '/tmp/vis-next/rfc36'
const ffmpeg = process.platform === 'darwin' ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg'
let dir: string
let daemon: Studiod
let host: WebHost
let admin: StudiodLink
let browser: Browser
let page: Page
let video: NodeView
let assetVersionId: string
let sessionId: string
let holdMov = false
const nodes = async (): Promise<NodeView[]> => (await admin.call('canvas.get', {})).nodes

describe.skipIf(!ready)('Transparent local video', () => {
  beforeAll(async () => {
    mkdirSync(screenshots, { recursive: true })
    dir = mkdtempSync(join(tmpdir(), 'vis-transparent-'))
    vi.stubEnv('VIS_PROJECTS_DIR', join(dir, 'projects'))
    const media = createFfmpegMedia({ ffmpegPath: ffmpeg, ...(process.platform === 'darwin' ? { ffprobePath: '/opt/homebrew/bin/ffprobe' } : {}) })
    daemon = await startStudiod({ dataDir: dir, studiodVersion: 'transparent-e2e', secretStore: createMemorySecretStore(),
      providers: [createMockProvider({ latencyMs: 0 }), createRenderProvider({ workDir: join(dir, 'render'), chromePath: chromePath(), ffmpegPath: ffmpeg })],
      media: { ...media, async process(path, operation, params, options) {
        if (holdMov && operation === 'video.exportMov') {
          await new Promise<void>((_resolve, reject) => {
            const signal = options!.signal!
            const stop = () => { holdMov = false; reject(signal.reason) }
            if (signal.aborted) stop()
            else signal.addEventListener('abort', stop, { once: true })
          })
        }
        return media.process(path, operation, params, options)
      } },
      defaults: { image: { provider: 'mock' }, video: { provider: 'mock' } },
      runtimes: { codex: codexRuntime({ dataDir: dir, socketPath: studiodEndpoint(dir), codexPath: join(root, 'apps/web/e2e/fake-codex.mjs'), visMcp: { command: process.execPath, args: [cli, 'mcp'] } }) },
    })
    const { spaceId } = daemon.spaces.create('Transparent video')
    admin = await openStudiodLink({ socketPath: daemon.socketPath, tokenPath: daemon.tokenPath })
    await admin.call('events.subscribe', { spaceId })
    sessionId = (await admin.call('session.create', { requestId: crypto.randomUUID(), agentKind: 'codex' })).sessionId
    await admin.call('session.sendMessage', { requestId: crypto.randomUUID(), sessionId, text: 'transparent-render', refs: [] })
    await vi.waitFor(async () => expect(JSON.stringify((await admin.call('session.getTranscript', { sessionId })).items)).toContain('Completed transparent-render'), { timeout: 30_000 })
    video = (await nodes()).find(node => node.kind === 'video')!
    const content = video.slots.find(slot => slot.slotKey === 'main')!.content
    if (content.type !== 'asset') throw new Error('Expected a rendered video')
    assetVersionId = content.assetVersionId
    expect(content).toMatchObject({ mime: 'video/webm', hasAlpha: true })
    const asset = await admin.call('asset.get', { assetVersionId })
    expect(asset).toMatchObject({ hasAlpha: true, mime: 'video/webm' })
    // Reimport exercises ffprobe on an extensionless blob through a named copy.
    const imported = join(dir, 'imported.webm')
    const { copyFileSync } = await import('node:fs')
    copyFileSync(asset.path!, imported)
    expect(await admin.call('asset.import', { requestId: crypto.randomUUID(), path: imported })).toMatchObject({ hasAlpha: true })
    const opaqueFile = join(dir, 'opaque.mp4')
    execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=4:d=1', '-c:v', 'libx264', '-y', opaqueFile])
    const opaque = await admin.call('asset.import', { requestId: crypto.randomUUID(), path: opaqueFile })
    await admin.call('canvas.apply', { requestId: crypto.randomUUID(), ops: [
      { op: 'node.layout', nodeId: video.nodeId, x: 0, y: 0, w: 480, h: 310 },
      { op: 'node.create', tempId: 'opaque', kind: 'video', title: 'Opaque card', x: 520, y: 0, content: { assetVersionId: opaque.assetVersionId } },
    ] })
    host = await createWebHost({ socketPath: daemon.socketPath, tokenPath: daemon.tokenPath, staticDir: join(root, 'apps/web/dist/client') })
    browser = await chromium.launch({ executablePath: chromePath(), headless: true })
    page = await browser.newPage({ locale: 'en-US', viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 })
    page.setDefaultTimeout(8000)
    await page.goto(host.url, { waitUntil: 'domcontentloaded' })
    await page.getByText('Codex 1', { exact: true }).click()
    await page.getByRole('button', { name: 'Fit canvas', exact: true }).click()
  }, 60_000)
  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail') {
      await page.screenshot({ path: join(screenshots, `failure-${task.name.slice(0, 40).replace(/[^a-z0-9]/gi, '-')}.png`), animations: 'disabled' })
      await page.keyboard.press('Escape')
    }
  })
  afterAll(async () => {
    await browser?.close(); admin?.close(); await host?.close(); await daemon?.stop('user_quit')
    vi.unstubAllEnvs(); removeTempDir(dir)
  })

  it('shows checkerboards only for alpha cards, results and full previews and decodes browser alpha', async () => {
    const card = page.locator('.react-flow__node').filter({ hasText: 'Transparent card' })
    const opaque = page.locator('.react-flow__node').filter({ hasText: 'Opaque card' })
    await card.waitFor()
    expect(await card.locator('.vis-alpha-media').count()).toBe(1)
    expect(await opaque.locator('.vis-alpha-media').count()).toBe(0)
    await card.hover()
    await card.locator('video').waitFor()
    await expect.poll(() => card.locator('video').evaluate(v => {
      if (v.readyState < 2) return []
      const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180
      const ctx = canvas.getContext('2d')!; ctx.drawImage(v, 0, 0)
      return [ctx.getImageData(4, 4, 1, 1).data[3], ctx.getImageData(160, 90, 1, 1).data[3]]
    })).toEqual([0, 255])
    expect(await card.locator('.vis-alpha-media').evaluate(el => getComputedStyle(el).backgroundImage)).toContain('conic-gradient')
    await page.mouse.move(20, 950)
    await page.screenshot({ path: join(screenshots, 'canvas-card.png'), animations: 'disabled' })
    await card.dblclick()
    const preview = page.getByRole('dialog', { name: 'Media preview', exact: true })
    await preview.waitFor()
    expect(await preview.locator('.vis-alpha-media').count()).toBe(1)
    await preview.locator('video').evaluate(async v => { if (v.readyState < 2) await new Promise(resolve => v.addEventListener('loadeddata', resolve, { once: true })); v.pause() })
    await page.screenshot({ path: join(screenshots, 'preview.png'), animations: 'disabled' })
    await page.keyboard.press('Escape')
    const result = page.locator('.vis-generation-result.is-succeeded')
    await result.waitFor()
    expect(await result.locator('.vis-alpha-media').count()).toBe(1)
    await result.getByRole('button', { name: /^Preview / }).click()
    const attachment = page.getByRole('dialog', { name: /^Attachment preview/ })
    await attachment.waitFor()
    expect(await attachment.locator('video.vis-alpha-media').count()).toBe(1)
    expect(await attachment.locator('video').evaluate(el => getComputedStyle(el).backgroundImage)).toContain('conic-gradient')
    await page.keyboard.press('Escape')
  })

  it('exports transparent and ordinary videos from the download menu without changing assets or canvas content', async () => {
    const before = await nodes()
    const library = (await admin.call('asset.list', {})).items.map(item => [item.assetId, item.versionCount])
    for (const [title, transparent] of [['Transparent card', true], ['Opaque card', false]] as const) {
      const card = page.locator('.react-flow__node').filter({ hasText: title })
      await card.click({ position: { x: 50, y: 60 } })
      await page.getByRole('toolbar', { name: 'Node operations', exact: true }).getByRole('button', { name: 'Download', exact: true }).click()
      await page.getByRole('menuitem', { name: 'Export MOV ProRes 4444', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'Export MOV ProRes 4444', exact: true })
      const estimate = dialog.getByText(/^Expected size:/)
      await estimate.waitFor()
      const start = dialog.getByRole('button', { name: 'Export and download', exact: true })
      expect((await estimate.boundingBox())!.y).toBeLessThan((await start.boundingBox())!.y)
      const downloadPromise = page.waitForEvent('download')
      await start.click()
      const download = await downloadPromise
      const path = join(screenshots, transparent ? 'delivery-transparent.mov' : 'delivery-opaque.mov')
      await download.saveAs(path)
      const pixels = execFileSync(ffmpeg, ['-v', 'error', '-i', path, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'])
      expect(pixels[4 * (4 * 320 + 4) + 3]).toBe(transparent ? 0 : 255)
      expect(pixels[4 * (90 * 320 + 160) + 3]).toBe(255)
      const streams = JSON.parse(execFileSync(process.platform === 'darwin' ? '/opt/homebrew/bin/ffprobe' : 'ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', path], { encoding: 'utf8' })).streams
      expect(streams[0]).toMatchObject({ codec_name: 'prores', profile: '4444' })
      expect(await nodes()).toEqual(before)
      expect((await admin.call('asset.list', {})).items.map(item => [item.assetId, item.versionCount])).toEqual(library)
      await dialog.getByRole('button', { name: 'Done and remove temporary file', exact: true }).click()
      await expect.poll(async () => (await page.request.get(download.url())).status()).toBe(404)
    }
  })


  it('cancels an active export and can retry from the same source', async () => {
    const card = page.locator('.react-flow__node').filter({ hasText: 'Transparent card' })
    const open = async () => {
      await card.click({ position: { x: 50, y: 60 } })
      await page.getByRole('toolbar', { name: 'Node operations', exact: true }).getByRole('button', { name: 'Download', exact: true }).click()
      await page.getByRole('menuitem', { name: 'Export MOV ProRes 4444', exact: true }).click()
    }
    holdMov = true
    await open()
    const dialog = page.getByRole('dialog', { name: 'Export MOV ProRes 4444', exact: true })
    await dialog.getByText(/^Expected size:/).waitFor()
    await dialog.getByRole('button', { name: 'Export and download', exact: true }).click()
    const cancel = dialog.getByRole('button', { name: 'Cancel export', exact: true })
    await expect.poll(() => cancel.isEnabled()).toBe(true)
    await cancel.click()
    await expect.poll(() => dialog.count()).toBe(0)
    await expect.poll(() => holdMov).toBe(false)
    await open()
    await dialog.getByText(/^Expected size:/).waitFor()
    const download = page.waitForEvent('download')
    await dialog.getByRole('button', { name: 'Export and download', exact: true }).click()
    await (await download).saveAs(join(screenshots, 'delivery-retry.mov'))
    await dialog.getByRole('button', { name: 'Done and remove temporary file', exact: true }).click()
  })

  it('previews transparent video over the main timeline picture', async () => {
    const opaque = (await nodes()).find(node => node.title === 'Opaque card')!
    const base = opaque.slots.find(slot => slot.slotKey === 'main')!.content
    if (base.type !== 'asset') throw new Error('Expected an opaque video')
    const created = await admin.call('canvas.apply', { requestId: crypto.randomUUID(), ops: [{ op: 'node.create', tempId: 'timeline', kind: 'timeline', title: 'Alpha overlay cut', x: 0, y: 500 }] })
    const timeline = (await nodes()).find(node => node.nodeId === created.idMap.timeline)!
    const slot = timeline.slots.find(slot => slot.slotKey === 'main')!
    const clip = (id: string, source: { nodeId: string; assetVersionId: string }) => ({ id, source, startMs: 0, inMs: 0, outMs: 1000, volume: 1, fadeInMs: 0, fadeOutMs: 0 })
    await admin.call('canvas.apply', { requestId: crypto.randomUUID(), ops: [{ op: 'timeline.set', slotId: slot.slotId, expectedRevision: slot.revision, doc: { version: 1, output: { width: 320, height: 180, fps: 4 }, tracks: [
      { id: 'main', kind: 'video', muted: false, volume: 1, clips: [clip('base', { nodeId: opaque.nodeId, assetVersionId: base.assetVersionId })] },
      { id: 'overlay', kind: 'overlay', muted: false, volume: 1, clips: [{ ...clip('alpha', { nodeId: video.nodeId, assetVersionId }), overlay: { x: 0.5, y: 0.5, width: 1, opacity: 1 } }] },
    ] } }] })
    await page.getByRole('button', { name: 'Fit canvas', exact: true }).click()
    await page.getByRole('region', { name: /^Timeline Alpha overlay cut,/ }).dblclick()
    const editor = page.getByRole('dialog', { name: 'Alpha overlay cut', exact: true })
    const frame = editor.locator('.vis-tl-output-frame')
    await frame.waitFor()
    const sampleFrame = async () => {
      const png = await frame.screenshot({ animations: 'disabled', scale: 'css' })
      const probe = JSON.parse(execFileSync(process.platform === 'darwin' ? '/opt/homebrew/bin/ffprobe' : 'ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'json', '-i', 'pipe:0'], { input: png, encoding: 'utf8' })).streams[0]
      const rgba = execFileSync(ffmpeg, ['-v', 'error', '-i', 'pipe:0', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { input: png, maxBuffer: 20 * 1024 * 1024 })
      const sample = (x: number, y: number) => [...rgba.subarray(4 * (Math.floor(y * probe.height) * probe.width + Math.floor(x * probe.width)), 4 * (Math.floor(y * probe.height) * probe.width + Math.floor(x * probe.width)) + 4)]
      return { corner: sample(0.1, 0.1), center: sample(0.5, 0.5) }
    }
    const overlays = frame.locator('.vis-tl-overlays')
    await overlays.evaluate(el => { el.style.display = 'none' })
    let baseline: Awaited<ReturnType<typeof sampleFrame>>
    await expect.poll(async () => {
      baseline = await sampleFrame()
      return baseline.corner[2]! > 240 && baseline.corner[2]! > baseline.corner[0]! * 4
    }).toBe(true)
    await overlays.evaluate(el => { el.style.display = '' })
    await expect.poll(async () => {
      const composite = await sampleFrame()
      return { corner: composite.corner, red: composite.center[0]! > 240 && composite.center[1]! < 115 }
    }, { timeout: 10_000 }).toEqual({ corner: baseline!.corner, red: true })
    await page.screenshot({ path: join(screenshots, 'timeline-preview.png'), animations: 'disabled' })
    await page.keyboard.press('Escape')
  })

})
