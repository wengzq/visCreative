import { chromePath, removeTempDir } from './platform'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
// Real studiod + web host + Chrome; uploads and generation use only local WAV files and Mock.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, chromium, type Page } from 'playwright-core'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createMockProvider, type ProviderAdapter, type ProviderRequest } from '../../../packages/generation/src/index'
import type { NodeView } from '../../../packages/protocol/src/index'
import { createMemorySecretStore } from '../../../services/studiod/src/secret-store'
import { startStudiod, type Studiod } from '../../../services/studiod/src/studiod'
import { createWebHost, type WebHost } from '../src/host/server'
import { openStudiodLink, type StudiodLink } from '../src/host/studiod-link'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const CHROME = chromePath()
const ready = existsSync(CHROME) && existsSync(join(root, 'apps/web/dist/client/index.html'))
const artifacts = join(tmpdir(), 'vis-audio')

let dir: string
let studiod: Studiod
let host: WebHost
let admin: StudiodLink
let browser: Browser
let page: Page

/** Fit-to-canvas animates for 300ms: wait for the viewport to stop before interacting, or right-clicks and drags will hit moving nodes */
async function fitCanvas() {
  await page.getByRole('button', { name: '适应画布', exact: true }).click()
  const viewport = page.locator('.react-flow__viewport')
  let last = ''
  await expect.poll(async () => {
    const now = await viewport.evaluate(el => getComputedStyle(el).transform)
    const settled = now === last
    last = now
    return settled
  }, { intervals: [100], timeout: 5_000 }).toBe(true)
}
let uploaded: NodeView
const requests: ProviderRequest[] = []
const pageErrors: string[] = []
const peaksRequests: string[] = []
const nodes = async () => (await admin.call('canvas.get')).nodes as NodeView[]

describe.skipIf(!ready)('Audio assets and generation', () => {
  beforeAll(async () => {
    mkdirSync(artifacts, { recursive: true })
    dir = mkdtempSync(join(tmpdir(), 'vis-audio-e2e-'))
    vi.stubEnv('VIS_PROJECTS_DIR', join(dir, 'projects'))
    const mock = createMockProvider({ latencyMs: 0 })
    const provider: ProviderAdapter = {
      ...mock,
      async submit(request, options) {
        requests.push(request)
        return mock.submit(request, options)
      },
    }
    studiod = await startStudiod({
      dataDir: dir, studiodVersion: 'e2e', runtimes: {}, secretStore: createMemorySecretStore(),
      providers: [provider], defaults: { image: { provider: 'mock' }, video: { provider: 'mock' }, audio: { provider: 'mock' } },
    })
    const { spaceId } = studiod.spaces.create('音频素材与生成')
    admin = await openStudiodLink({ socketPath: studiod.socketPath, tokenPath: studiod.tokenPath })
    await admin.call('events.subscribe', { spaceId })
    host = await createWebHost({ socketPath: studiod.socketPath, tokenPath: studiod.tokenPath, staticDir: join(root, 'apps/web/dist/client') })
    browser = await chromium.launch({ executablePath: CHROME, headless: true })
    page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 })
    page.on('websocket', socket => socket.on('framesent', event => {
      const request = JSON.parse(String(event.payload))
      if (request.method === 'media.preview' && request.params?.kind === 'peaks') peaksRequests.push(request.params.assetVersionId)
    }))
    page.setDefaultTimeout(5000)
    page.on('pageerror', error => pageErrors.push(error.message))
    await page.goto(host.url)
    await page.waitForSelector('.react-flow__pane')
    await page.evaluate(() => document.fonts.ready)
  }, 30_000)

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail' && page) await page.screenshot({ path: join(artifacts, 'failure.png'), animations: 'disabled' })
  })

  afterAll(async () => {
    await browser?.close()
    admin?.close()
    await host?.close()
    await studiod?.stop('user_quit')
    vi.unstubAllEnvs()
    removeTempDir(dir)
  }, 30_000)

  it('uploading WAV creates an audio node with play, pause, Space toggling, and seek dragging', async () => {
    const wav = join(dir, 'tone.wav')
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=22050:duration=3', '-c:a', 'pcm_s16le', wav])
    expect(await page.getByLabel('上传图片、视频或音频', { exact: true }).getAttribute('accept')).toContain('audio/*')
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.getByRole('button', { name: '上传', exact: true }).click(),
    ])
    await chooser.setFiles(wav)
    await expect.poll(nodes, { timeout: 5000 }).toHaveLength(1)
    uploaded = (await nodes())[0]!
    expect(uploaded).toMatchObject({ kind: 'audio', w: 360, h: 140, slots: [{ content: { type: 'asset', mime: 'audio/wav' } }] })
    const node = page.locator(`.react-flow__node-audio[data-id="${uploaded.nodeId}"]`)
    const content = uploaded.slots.find(slot => slot.slotKey === 'main')!.content
    if (content.type !== 'asset') throw new Error('Expected an uploaded audio asset')
    await expect.poll(() => peaksRequests).toContain(content.assetVersionId)
    await node.locator('canvas.vis-audio-waveform').waitFor()
    await expect.poll(() => node.locator('audio').evaluate(audio => (audio as HTMLAudioElement).duration), { timeout: 10_000 }).toBeCloseTo(3, 1)
    await node.getByRole('button', { name: '播放', exact: true }).click()
    await expect.poll(() => node.locator('audio').evaluate(audio => (audio as HTMLAudioElement).currentTime), { timeout: 10_000 }).toBeGreaterThan(.1)
    await node.getByRole('button', { name: '暂停', exact: true }).click()
    expect(await node.locator('audio').evaluate(audio => (audio as HTMLAudioElement).paused), { timeout: 10_000 }).toBe(true)
    await node.locator('.vis-node-label').click()
    await page.locator('.vis-canvas-wrap').focus()
    await page.keyboard.press('Space')
    await expect.poll(() => node.locator('audio').evaluate(audio => (audio as HTMLAudioElement).paused), { timeout: 10_000 }).toBe(false)
    expect(await page.getByRole('dialog', { name: '媒体预览', exact: true }).count(), { timeout: 10_000 }).toBe(0)
    await page.keyboard.press('Space')
    await expect.poll(() => node.locator('audio').evaluate(audio => (audio as HTMLAudioElement).paused), { timeout: 10_000 }).toBe(true)
    const progress = (await node.getByRole('slider', { name: '播放进度', exact: true }).boundingBox())!
    await page.mouse.click(progress.x + progress.width * .75, progress.y + progress.height / 2)
    await expect.poll(() => node.locator('audio').evaluate(audio => (audio as HTMLAudioElement).currentTime / (audio as HTMLAudioElement).duration), { timeout: 10_000 }).toBeGreaterThan(.6)
    await page.screenshot({ path: join(tmpdir(), 'vis-rfc0012-audio.png'), animations: 'disabled' })
  })

  it('the toolbar generates audio with Mock sound effects and fills the current node', async () => {
    const before = new Set((await nodes()).map(node => node.nodeId))
    await page.getByRole('button', { name: '生音频', exact: true }).click()
    await expect.poll(nodes, { timeout: 5000 }).toHaveLength(before.size + 1)
    const created = (await nodes()).find(node => !before.has(node.nodeId))!
    expect(created).toMatchObject({ kind: 'audio', w: 360, h: 140 })
    const node = page.locator(`.react-flow__node-audio[data-id="${created.nodeId}"]`)
    await node.locator('.vis-node-label').click()
    const generate = page.getByRole('button', { name: '生成', exact: true })
    expect(await generate.isDisabled()).toBe(true)
    await page.getByRole('textbox', { name: '提示词', exact: true }).fill('清脆的玻璃风铃声')
    await page.getByRole('button', { name: '模型与参数', exact: true }).click()
    const picker = page.getByRole('dialog', { name: '选择模型与参数', exact: true })
    await picker.getByRole('button', { name: 'Mock 音效', exact: true }).click()
    await picker.press('Escape')
    await generate.click()
    await expect.poll(() => requests.find(request => request.kind === 'audio')).toMatchObject({ kind: 'audio', model: 'mock-sfx-1', prompt: '清脆的玻璃风铃声', params: { duration: 2 } })
    await expect.poll(() => node.locator('audio').count(), { timeout: 10_000 }).toBe(1)
    await expect.poll(() => node.locator('audio').evaluate(audio => (audio as HTMLAudioElement).duration), { timeout: 10_000 }).toBeCloseTo(2, 1)
    const saved = (await nodes()).find(node => node.nodeId === created.nodeId)!
    expect(saved.generation).toMatchObject({ provider: 'mock', model: 'mock-sfx-1' })
    expect(saved.slots.find(slot => slot.slotKey === 'main')).toMatchObject({ content: { type: 'asset', mime: 'audio/wav' }, source: { jobId: expect.any(String) } })
  })

  it('connecting an audio reference to video includes the audio input in the Mock video job and delivers it', async () => {
    await fitCanvas()
    const source = page.locator(`.react-flow__node-audio[data-id="${uploaded.nodeId}"]`)
    await source.locator('.vis-node-label').click()
    await source.getByRole('button', { name: '延伸节点', exact: true }).click()
    await page.getByRole('button', { name: '延伸生视频', exact: true }).click()
    await expect.poll(async () => (await nodes()).filter(node => node.kind === 'video'), { timeout: 5000 }).toHaveLength(1)
    const video = (await nodes()).find(node => node.kind === 'video')!
    expect(video.inputs).toEqual([uploaded.nodeId])
    await page.locator(`.react-flow__edge[data-id="input-${uploaded.nodeId}-${video.nodeId}"]`).waitFor()
    await page.getByRole('textbox', { name: '提示词', exact: true }).fill('风铃声中的夏日庭院')
    await page.getByRole('button', { name: '生成', exact: true }).click()
    await expect.poll(() => requests.find(request => request.kind === 'video')).toMatchObject({
      kind: 'video', model: 'mock-video-1', prompt: '风铃声中的夏日庭院',
      inputs: expect.arrayContaining([{ type: 'asset', kind: 'audio', mime: 'audio/wav', path: expect.any(String), durationMs: expect.any(Number) }]),
    })
    const node = page.locator(`.react-flow__node-video[data-id="${video.nodeId}"]`)
    await node.hover()
    await node.locator('video').waitFor({ timeout: 10_000 })
    await expect.poll(() => node.locator('video').evaluate(video => (video as HTMLVideoElement).videoWidth)).toBeGreaterThan(0)
    expect(pageErrors).toEqual([])
  })
})
