import { chromePath, removeTempDir } from './platform'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
// Real studiod + web host + Chrome; Ark and SecretStore stay inside the test process without accessing real services or Keychain.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import { inspect } from 'node:util'
import { type Browser, chromium, type Page } from 'playwright-core'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { builtinProviderTypes, createMockProvider, createRenderProvider } from '../../../packages/generation/src/index'
import { exampleService, EXAMPLE_SECRET } from './fixtures/example-provider'
import { createMemorySecretStore } from '../../../services/studiod/src/secret-store'
import { startStudiod, type Studiod } from '../../../services/studiod/src/studiod'
import { createWebHost, type WebHost } from '../src/host/server'
import { openStudiodLink, type StudiodLink } from '../src/host/studiod-link'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const CHROME = chromePath()
const ready = existsSync(CHROME) && existsSync(join(root, 'apps/web/dist/client/index.html'))
const artifacts = process.env.VIS_E2E_ARTIFACTS ?? join(tmpdir(), 'vis-0028-b/provider-settings-ui')
const SECRET = 'e2e-fake-ark-key-never-persist-9e47b1'
const IMAGE_MODEL = 'ep-e2e-image-model'
const SECOND_IMAGE_MODEL = 'ep-e2e-second-image-model'
const VIDEO_MODEL = 'ep-e2e-video-model'
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=', 'base64')

let dir: string
let studiod: Studiod
let host: WebHost
let admin: StudiodLink
let server: Server
let browser: Browser
let page: Page
let origin: string
let spaceId: string
let providerId: string
let imageNodeId: string
const requests: { path: string; body: Record<string, unknown>; authenticated: boolean }[] = []
const network: string[] = []
const logs: string[] = []
const pageErrors: string[] = []
let keyWrites = 0

async function assertNoSecret() {
  expect(await page.content()).not.toContain(SECRET)
  expect(await page.locator('input').evaluateAll(inputs => inputs.map(input => (input as HTMLInputElement).value))).not.toContain(SECRET)
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage }))).not.toContain(SECRET)
  expect(readFileSync(join(dir, 'providers.json'), 'utf8')).not.toContain(SECRET)
  expect(network.join('\n')).not.toContain(SECRET)
  expect(logs.join('\n')).not.toContain(SECRET)
  expect(JSON.stringify(requests)).not.toContain(SECRET)
}

describe.skipIf(!ready)('Generation service settings and model parameters', () => {
  beforeAll(async () => {
    mkdirSync(artifacts, { recursive: true })
    mkdirSync(join(tmpdir(), 'vis-p'), { recursive: true })
    // Socket paths have length limits; screenshots are saved outside the temporary data directory.
    dir = mkdtempSync(join(tmpdir(), 'vis-provider-e2e-'))
    vi.stubEnv('VIS_PROJECTS_DIR', join(dir, 'projects'))
    for (const method of ['log', 'info', 'warn', 'error'] as const) {
      vi.spyOn(console, method).mockImplementation((...args) => { logs.push(inspect(args)) })
    }
    server = createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown> : {}
      requests.push({ path: req.url!, body, authenticated: req.headers.authorization === `Bearer ${SECRET}` })
      res.setHeader('Content-Type', 'application/json')
      if (req.url === '/api/v3/images/generations') {
        res.end(JSON.stringify({ data: [{ url: `${origin}/image.png`, size: '1x1' }] }))
      } else if (req.method === 'POST' && req.url === '/api/v3/contents/generations/tasks') {
        res.end(JSON.stringify({ id: 'e2e-video-task' }))
      } else if (req.url === '/api/v3/contents/generations/tasks/e2e-video-task') {
        res.end(JSON.stringify({ status: 'succeeded', content: { video_url: `${origin}/video.mp4` } }))
      } else if (req.url === '/image.png') {
        res.setHeader('Content-Type', 'image/png')
        res.end(PNG)
      } else if (req.url === '/video.mp4') {
        res.setHeader('Content-Type', 'video/mp4')
        res.end(readFileSync(join(root, 'packages/generation/src/providers/mock/fixtures/sample.mp4')))
      } else res.writeHead(404).end('{}')
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Test Ark service has not started')
    origin = `http://127.0.0.1:${address.port}`
    studiod = await startStudiod({
      dataDir: dir, studiodVersion: 'e2e', runtimes: {}, secretStore: createMemorySecretStore(),
      providers: [createMockProvider({ latencyMs: 0 }), createRenderProvider({ workDir: join(dir, 'render') })],
      defaults: { image: { provider: 'mock' }, video: { provider: 'mock' }, audio: { provider: 'mock' } },
    })
    spaceId = studiod.spaces.create('生成服务测试').spaceId
    admin = await openStudiodLink({ socketPath: studiod.socketPath, tokenPath: studiod.tokenPath, onMessage: line => network.push(line) })
    await admin.call('events.subscribe', { spaceId })
    host = await createWebHost({ socketPath: studiod.socketPath, tokenPath: studiod.tokenPath, staticDir: join(root, 'apps/web/dist/client') })
    browser = await chromium.launch({ executablePath: CHROME, headless: true })
    page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 })
    page.setDefaultTimeout(5000)
    page.on('console', message => logs.push(message.text()))
    page.on('pageerror', error => pageErrors.push(error.message))
    page.on('request', request => network.push(JSON.stringify({ url: request.url(), headers: request.headers(), body: request.postData() })))
    page.on('response', response => network.push(JSON.stringify({ url: response.url(), status: response.status(), headers: response.headers() })))
    page.on('websocket', socket => {
      socket.on('framereceived', frame => network.push(String(frame.payload)))
      socket.on('framesent', frame => {
        const payload = String(frame.payload)
        const message = JSON.parse(payload)
        if (message.method === 'providers.setKey') {
          expect(message.params.apiKey).toBe(SECRET)
          keyWrites++
        } else network.push(payload)
      })
    })
    await page.goto(host.url)
    await page.waitForSelector('.react-flow__pane')
    await page.evaluate(() => document.fonts.ready)
  }, 30_000)

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail' && page) {
      const keyEntered = await page.locator('input[type="password"]').evaluateAll(inputs => inputs.some(input => (input as HTMLInputElement).value))
      if (!keyEntered && !(await page.content()).includes(SECRET)) await page.screenshot({ path: join(artifacts, 'failure.png') })
    }
  })

  afterAll(async () => {
    await browser?.close()
    admin?.close()
    await host?.close()
    await studiod?.stop('user_quit')
    server?.closeAllConnections()
    if (server) await new Promise<void>(resolve => server.close(() => resolve()))
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    removeTempDir(dir)
  }, 30_000)

  it('configures models, saves keys separately and selects defaults; refresh reads settings without echoing keys', async () => {
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '设置', exact: true })
    await dialog.getByRole('button', { name: '+ 添加服务', exact: true }).click()
    // Any other settings page closes the chooser instead of leaving it on top.
    await dialog.getByRole('button', { name: '语言', exact: true }).click()
    await dialog.getByRole('dialog', { name: '选择生成服务' }).waitFor({ state: 'detached' })
    // The chooser covers a longer page without letting it scroll into view.
    const viewport = page.viewportSize()!
    await page.setViewportSize({ width: viewport.width, height: 600 })
    await dialog.getByRole('button', { name: '默认模型与额度', exact: true }).click()
    await dialog.getByRole('button', { name: '+ 添加服务', exact: true }).click()
    const chooser = dialog.getByRole('dialog', { name: '选择生成服务' })
    const chooserTop = (await chooser.boundingBox())!.y
    const pageBelow = page.locator('.provider-settings-content')
    expect(await pageBelow.evaluate(content => content.scrollHeight > content.clientHeight)).toBe(true)
    await pageBelow.evaluate(content => { content.scrollTop = content.scrollHeight })
    expect((await chooser.boundingBox())!.y).toBe(chooserTop)
    expect(await dialog.getByRole('heading', { name: '默认模型', exact: true }).isVisible()).toBe(false)
    await page.keyboard.press('Escape')
    await page.setViewportSize(viewport)
    await dialog.getByRole('button', { name: '+ 添加服务', exact: true }).click()
    await dialog.getByRole('dialog', { name: '选择生成服务' }).getByRole('button', { name: /火山方舟/ }).click()
    await dialog.getByLabel('名称', { exact: true }).fill('本机测试方舟')
    const catalog = await admin.call('providers.list')
    const isolationNotice = dialog.getByText('Windows 上 Agent 没有隔离沙箱，理论上能读取本机保存的 API Key。只在信任的项目里使用 Agent。', { exact: true })
    if (process.platform === 'win32') expect(catalog.agentIsolation).toBe('none')
    if (catalog.agentIsolation === 'none') {
      expect(await isolationNotice.filter({ visible: true }).count()).toBe(1)
      await dialog.getByRole('button', { name: '安全与额度', exact: true }).click()
      expect(await isolationNotice.filter({ visible: true }).count()).toBe(1)
      await dialog.getByRole('button', { name: /^本机测试方舟/ }).click()
      expect(await isolationNotice.filter({ visible: true }).count()).toBe(1)
    } else {
      expect(await isolationNotice.count()).toBe(0)
    }
    await dialog.getByLabel('区域', { exact: true }).selectOption('custom')
    await dialog.getByLabel('Base URL', { exact: true }).fill(`${origin}/api/v3`)
    for (const [kind, label, id] of [['图片', 'E2E 图片模型', IMAGE_MODEL], ['图片', 'E2E 备用图片模型', SECOND_IMAGE_MODEL], ['视频', 'E2E 视频模型', VIDEO_MODEL]]) {
      const group = dialog.getByRole('group', { name: `${kind}模型`, exact: true })
      await group.getByRole('button', { name: '自定义模型 ID', exact: true }).click()
      await group.getByLabel('显示名称', { exact: true }).last().fill(label!)
      await group.getByLabel('模型 ID', { exact: true }).last().fill(id!)
    }
    const imagePath = dialog.getByLabel('图片生成', { exact: true })
    expect(await imagePath.getAttribute('placeholder')).toBe('例如 /images/generations')
    await imagePath.fill('/images/generations?ak=fake')
    await dialog.getByRole('button', { name: '保存配置', exact: true }).click()
    await dialog.getByText('路径必须以 / 开头，不能包含查询参数、片段或 ..', { exact: true }).waitFor()
    await imagePath.fill('/images/generations')
    await dialog.getByRole('button', { name: '保存配置', exact: true }).click()
    await dialog.getByText('请填写当前模型需要的任务路径', { exact: false }).first().waitFor()
    await dialog.getByLabel('视频和音频提交', { exact: true }).fill('/contents/generations/tasks')
    await dialog.getByLabel('任务查询和取消', { exact: true }).fill('/contents/generations/tasks/{id}')
    await dialog.getByRole('button', { name: '保存配置', exact: true }).click()
    await expect.poll(async () => (await admin.call('providers.list')).providers.some((p: any) => p.label === '本机测试方舟')).toBe(true)
    const configured = (await admin.call('providers.list')).providers.find((p: any) => p.label === '本机测试方舟')
    providerId = configured.id
    expect(configured.hasKey).toBe(false)
    const key = dialog.getByLabel('API Key', { exact: true })
    expect(await key.getAttribute('type')).toBe('password')
    // After saving configuration, the UI must reread the provider before enabling key input; heavy load can exceed the default 5-second fill timeout
    await expect.poll(() => key.isEnabled(), { timeout: 10_000 }).toBe(true)
    await key.fill(SECRET)
    await dialog.getByRole('button', { name: '保存密钥', exact: true }).click()
    await expect.poll(() => key.inputValue()).toBe('')
    await expect.poll(async () => (await admin.call('providers.list')).providers.find((p: any) => p.id === providerId)?.hasKey).toBe(true)
    await dialog.getByRole('button', { name: '默认模型与额度', exact: true }).click()
    await dialog.getByLabel('默认图片模型', { exact: true }).selectOption({ label: 'E2E 图片模型' })
    await dialog.getByLabel('默认视频模型', { exact: true }).selectOption({ label: 'E2E 视频模型' })
    await dialog.getByRole('button', { name: '保存配置', exact: true }).click()
    await expect.poll(async () => (await admin.call('providers.list')).defaults).toEqual({
      image: { provider: providerId, model: IMAGE_MODEL }, video: { provider: providerId, model: VIDEO_MODEL }, audio: { provider: 'mock', model: 'mock-music-1' },
    })
    await dialog.getByText('配置已保存', { exact: true }).waitFor()
    await assertNoSecret()
    await dialog.locator('.provider-settings-content').evaluate(content => { content.scrollTop = 0 })
    await page.screenshot({ path: join(artifacts, 'settings.png') })
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    await page.reload()
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await dialog.getByRole('button', { name: /^本机测试方舟/ }).click()
    expect(await key.inputValue()).toBe('')
    expect(await dialog.getByLabel('Base URL', { exact: true }).inputValue()).toBe(`${origin}/api/v3`)
    expect(await dialog.getByLabel('图片生成', { exact: true }).inputValue()).toBe('/images/generations')
    expect(await dialog.getByLabel('默认图片模型', { exact: true }).inputValue()).toContain(IMAGE_MODEL)
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
  })

  it('image generation selects the configured model by default, sends 4K parameters, and fills outputs', async () => {
    await page.getByRole('button', { name: '生图', exact: true }).click()
    await expect.poll(async () => (await admin.call('canvas.get')).nodes.length).toBe(1)
    const [created] = (await admin.call('canvas.get')).nodes
    imageNodeId = created.nodeId
    const node = page.locator(`.react-flow__node[data-id="${imageNodeId}"]`)
    await node.locator('.vis-node-label').click()
    const generate = page.getByRole('button', { name: '生成', exact: true })
    expect(await generate.isDisabled()).toBe(true)
    await page.getByRole('textbox', { name: '提示词', exact: true }).fill('清晨的蓝色花园')
    await page.getByRole('button', { name: '模型与参数', exact: true }).click()
    const popup = page.getByRole('dialog', { name: '选择模型与参数', exact: true })
    expect(await popup.getByRole('button', { name: /E2E 图片模型/ }).getAttribute('aria-pressed')).toBe('true')
    expect(await popup.getByRole('button', { name: /E2E 视频模型/ }).count()).toBe(0)
    await popup.getByLabel('尺寸自定义', { exact: true }).fill('2048x1152')
    expect(await popup.getByLabel('尺寸自定义', { exact: true }).inputValue()).toBe('2048x1152')
    await popup.getByRole('button', { name: '4K', exact: true }).click()
    expect(await popup.getByLabel('尺寸自定义', { exact: true }).inputValue()).toBe('')
    const count = popup.getByRole('group', { name: '数量', exact: true })
    expect(await count.getByRole('button').allTextContents()).toEqual(['1', '2', '3', '4'])
    const watermark = popup.getByRole('switch', { name: '水印', exact: true })
    await watermark.click()
    expect(await watermark.getAttribute('aria-checked')).toBe('true')
    await watermark.click()
    const modelRow = popup.getByRole('button', { name: /E2E 图片模型/ })
    expect(await modelRow.evaluate(row => ({ height: row.getBoundingClientRect().height, border: getComputedStyle(row).borderTopWidth }))).toEqual({ height: 30, border: '0px' })
    expect(await modelRow.locator('svg').count()).toBe(1)
    const popupBox = (await popup.boundingBox())!
    const generateBox = (await generate.boundingBox())!
    expect(popupBox.height).toBeLessThanOrEqual(520)
    expect(popupBox.y).toBeGreaterThanOrEqual(8)
    expect(popupBox.y + popupBox.height).toBeLessThanOrEqual(generateBox.y)
    await page.screenshot({ path: join(artifacts, 'image-model-popover.png') })
    await popup.press('Escape')
    await generate.click()
    await expect.poll(() => requests.find(request => request.path === '/api/v3/images/generations')?.body).toMatchObject({ model: IMAGE_MODEL, prompt: '清晨的蓝色花园', size: '4K' })
    expect(requests.find(request => request.path === '/api/v3/images/generations')?.authenticated).toBe(true)
    await node.locator('img').waitFor({ timeout: 10_000 })
    await expect.poll(() => node.locator('img').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(1)
    const [saved] = (await admin.call('canvas.get', { nodeIds: [imageNodeId] })).nodes
    expect(saved.slots.find((slot: any) => slot.slotKey === 'main').content.type).toBe('asset')
    await page.reload()
    await node.locator('.vis-node-label').click()
    expect(await page.getByRole('button', { name: '参数摘要', exact: true }).textContent()).toContain('4K')
    await assertNoSecret()
  })

  it('video generation shows model parameters; clearing the key immediately blocks generation without leaking the key', async () => {
    await page.getByRole('button', { name: '生视频', exact: true }).click()
    await expect.poll(async () => (await admin.call('canvas.get')).nodes.some((node: any) => node.kind === 'video')).toBe(true)
    const video = (await admin.call('canvas.get')).nodes.find((node: any) => node.kind === 'video')
    const node = page.locator(`.react-flow__node[data-id="${video.nodeId}"]`)
    await node.locator('.vis-node-label').click()
    await page.getByRole('textbox', { name: '提示词', exact: true }).fill('雨中的蓝色街道')
    await page.getByRole('button', { name: '模型与参数', exact: true }).click()
    const popup = page.getByRole('dialog', { name: '选择模型与参数', exact: true })
    expect(await popup.getByRole('button', { name: /E2E 视频模型/ }).getAttribute('aria-pressed')).toBe('true')
    expect(await popup.getByRole('button', { name: /E2E 图片模型/ }).count()).toBe(0)
    expect(await popup.getByRole('button', { name: '1080p', exact: true }).isVisible()).toBe(true)
    expect(await popup.getByRole('group', { name: '数量', exact: true }).count()).toBe(0)
    expect(await popup.getByRole('switch').count()).toBe(3)
    const normalViewport = page.viewportSize()!
    // Force overflow even with the runner's smaller fallback font metrics, then wait for the resize handler.
    await page.setViewportSize({ width: 1600, height: 500 })
    const params = popup.locator('.vis-model-params')
    await expect.poll(() => params.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true)
    const shortBox = (await popup.boundingBox())!
    const generateBox = (await page.getByRole('button', { name: '生成', exact: true }).boundingBox())!
    expect(shortBox.y).toBeGreaterThanOrEqual(8)
    expect(shortBox.y + shortBox.height).toBeLessThanOrEqual(generateBox.y)
    expect(await params.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true)
    await popup.getByRole('switch', { name: '水印', exact: true }).click()
    await popup.getByRole('switch', { name: '水印', exact: true }).click()
    await page.setViewportSize(normalViewport)
    await expect.poll(() => popup.evaluate(element => getComputedStyle(element).maxHeight)).toContain('520px')
    await params.evaluate(element => { element.scrollTop = 0 })
    await page.screenshot({ path: join(artifacts, 'video-model-popover.png') })
    await popup.press('Escape')
    await page.getByRole('button', { name: '生成', exact: true }).click()
    await node.hover()
    await node.locator('video').waitFor({ timeout: 10_000 })
    await expect.poll(() => node.locator('video').evaluate(video => (video as HTMLVideoElement).videoWidth)).toBeGreaterThan(0)
    expect(requests.find(request => request.path === '/api/v3/contents/generations/tasks')).toMatchObject({ authenticated: true, body: { model: VIDEO_MODEL } })
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '设置', exact: true })
    await dialog.getByRole('button', { name: /^本机测试方舟/ }).click()
    page.once('dialog', dialog => dialog.accept())
    await dialog.getByRole('button', { name: '清除密钥', exact: true }).click()
    await expect.poll(async () => (await admin.call('providers.list')).providers.find((p: any) => p.id === providerId)?.hasKey).toBe(false)
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    await expect.poll(() => page.getByRole('button', { name: '生成', exact: true }).isDisabled()).toBe(true)
    await page.locator(`.react-flow__node[data-id="${imageNodeId}"] .vis-node-label`).click()
    expect(await page.getByRole('button', { name: '生成', exact: true }).isDisabled()).toBe(true)
    await page.getByRole('button', { name: '模型与参数', exact: true }).click()
    expect(await popup.getByRole('button', { name: /E2E 图片模型/ }).getByText('未配置密钥', { exact: true }).isVisible()).toBe(true)
    expect(await popup.getByRole('button', { name: /E2E 图片模型/ }).getAttribute('class')).toBe('is-unconfigured')
    expect(await page.locator('.vis-model-warning').isVisible()).toBe(true)
    await popup.press('Escape')
    expect(keyWrites).toBe(1)
    expect(pageErrors).toEqual([])
    await assertNoSecret()
  })

  it('updates from another window preserve the current draft; confirmation loads the latest configuration', async () => {
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '设置', exact: true })
    await dialog.getByRole('button', { name: /^本机测试方舟/ }).click()
    await dialog.getByLabel('名称', { exact: true }).fill('当前窗口未保存的草稿')
    const other = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1600, height: 1000 } })
    try {
      await other.goto(host.url)
      await other.getByRole('button', { name: '设置', exact: true }).click()
      const otherDialog = other.getByRole('dialog', { name: '设置', exact: true })
      await otherDialog.getByRole('button', { name: /^本机测试方舟/ }).click()
      await otherDialog.getByLabel('名称', { exact: true }).fill('其他窗口已保存的配置')
      await otherDialog.getByRole('button', { name: '保存配置', exact: true }).click()
      await dialog.getByText('服务配置已在其他地方更新，当前草稿已保留。', { exact: true }).waitFor()
      expect(await dialog.getByLabel('名称', { exact: true }).inputValue()).toBe('当前窗口未保存的草稿')
      page.once('dialog', dialog => dialog.accept())
      await dialog.getByRole('button', { name: '载入最新配置', exact: true }).click()
      await expect.poll(() => dialog.getByLabel('名称', { exact: true }).inputValue()).toBe('其他窗口已保存的配置')
      await dialog.getByRole('button', { name: '取消', exact: true }).click()
      await assertNoSecret()
    } finally {
      await other.close()
    }
  })

  it('node models and parameters are saved to the canvas and read from the backend after refresh or in a fresh browser context', async () => {
    const node = page.locator(`.react-flow__node[data-id="${imageNodeId}"]`)
    await node.locator('.vis-node-label').click()
    await page.getByRole('button', { name: '模型与参数', exact: true }).click()
    const popup = page.getByRole('dialog', { name: '选择模型与参数', exact: true })
    // Delay settings requests; successive edits must preserve local pending values instead of reusing an old node snapshot.
    await page.evaluate(() => {
      const send = WebSocket.prototype.send
      WebSocket.prototype.send = function (data) {
        if (typeof data === 'string') {
          const message = JSON.parse(data)
          if (message.method === 'canvas.apply' && message.params?.ops?.some((op: any) => op.op === 'node.setGeneration')) {
            setTimeout(() => send.call(this, data), 120)
            return
          }
        }
        send.call(this, data)
      }
    })
    await popup.getByRole('button', { name: /E2E 备用图片模型/ }).click()
    await popup.getByRole('button', { name: '1K', exact: true }).click()
    await popup.getByRole('group', { name: '数量', exact: true }).getByRole('button', { name: '3', exact: true }).click()
    await popup.getByRole('switch', { name: '水印', exact: true }).click()
    const generation = { provider: providerId, model: SECOND_IMAGE_MODEL, params: { size: '1K', n: 3, watermark: true } }
    const saved = async () => (await admin.call('canvas.get', { nodeIds: [imageNodeId] })).nodes[0].generation
    await expect.poll(saved).toEqual(generation)
    await page.reload()

    const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 })
    try {
      const fresh = await context.newPage()
      fresh.setDefaultTimeout(5000)
      fresh.on('pageerror', error => pageErrors.push(error.message))
      await fresh.goto(host.url)
      for (const current of [page, fresh]) {
        await current.locator(`.react-flow__node[data-id="${imageNodeId}"] .vis-node-label`).click()
        await current.getByRole('button', { name: '模型与参数', exact: true }).click()
        const picker = current.getByRole('dialog', { name: '选择模型与参数', exact: true })
        expect(await picker.getByRole('button', { name: /E2E 备用图片模型/ }).getAttribute('aria-pressed')).toBe('true')
        expect(await picker.getByRole('button', { name: '1K', exact: true }).getAttribute('aria-pressed')).toBe('true')
        expect(await picker.getByRole('group', { name: '数量', exact: true }).getByRole('button', { name: '3', exact: true }).getAttribute('aria-pressed')).toBe('true')
        expect(await picker.getByRole('switch', { name: '水印', exact: true }).getAttribute('aria-checked')).toBe('true')
        expect(await current.evaluate(key => localStorage.getItem(key), `vis.gen.${spaceId}.${imageNodeId}`)).toBeNull()
        expect(await saved()).toEqual(generation)
        if (current === page) {
          await current.evaluate(() => document.fonts.ready)
          await current.screenshot({ path: join(tmpdir(), 'vis-p/db-selected-picker.png') })
        }
        await picker.press('Escape')
      }
    } finally {
      await context.close()
    }
    await assertNoSecret()
  })

  it('node parameters support keyboard undo; external canvas.apply immediately updates the current model and parameters', async () => {
    await page.getByRole('button', { name: '模型与参数', exact: true }).click()
    const popup = page.getByRole('dialog', { name: '选择模型与参数', exact: true })
    const saved = async () => (await admin.call('canvas.get', { nodeIds: [imageNodeId] })).nodes[0].generation
    const before = await saved()
    await popup.getByRole('button', { name: '4K', exact: true }).click()
    await expect.poll(saved).toEqual({ ...before, params: { ...before.params, size: '4K' } })
    await popup.press('Escape')
    await page.keyboard.press('ControlOrMeta+Z')
    await expect.poll(saved).toEqual(before)
    await expect.poll(() => page.getByRole('button', { name: '参数摘要', exact: true }).textContent()).toContain('1K')

    const generation = { provider: providerId, model: IMAGE_MODEL, params: { size: '2K', n: 2, watermark: false } }
    await admin.call('canvas.apply', { requestId: `external-generation-${Date.now()}`, ops: [{ op: 'node.setGeneration', nodeId: imageNodeId, generation }] })
    await expect.poll(() => page.getByRole('button', { name: '模型与参数', exact: true }).textContent()).toContain('E2E 图片模型')
    await expect.poll(() => page.getByRole('button', { name: '参数摘要', exact: true }).textContent()).toContain('2K · 数量 2')
    expect(await saved()).toEqual(generation)
    await page.getByRole('button', { name: '模型与参数', exact: true }).click()
    expect(await popup.getByRole('button', { name: /E2E 图片模型/ }).getAttribute('aria-pressed')).toBe('true')
    expect(await popup.getByRole('group', { name: '数量', exact: true }).getByRole('button', { name: '2', exact: true }).getAttribute('aria-pressed')).toBe('true')
    await popup.press('Escape')
  })

  it('legacy browser settings migrate existing nodes only, delete old keys on success, and never overwrite backend settings', async () => {
    const authoritative = { provider: providerId, model: IMAGE_MODEL, params: { size: '2K', n: 2, watermark: false } }
    const created = await admin.call('canvas.apply', { requestId: `legacy-generation-${Date.now()}`, ops: [
      { op: 'node.create', tempId: 'legacy', kind: 'image', x: 1600, y: 100, w: 320, h: 320, prompt: '旧浏览器设置' },
      { op: 'node.create', tempId: 'malformed', kind: 'image', x: 2000, y: 100, w: 320, h: 320, prompt: '无效旧设置' },
      { op: 'node.create', tempId: 'persisted', kind: 'image', x: 1600, y: 500, w: 320, h: 320, prompt: '已有后台设置', generation: authoritative },
    ] })
    const legacyId = created.idMap.legacy
    const malformedId = created.idMap.malformed
    const persistedId = created.idMap.persisted
    const generation = { provider: providerId, model: SECOND_IMAGE_MODEL, params: { size: '1K', n: 2, watermark: true } }
    const entries = {
      [`vis.gen.${spaceId}.${legacyId}`]: JSON.stringify(generation),
      [`vis.gen.${spaceId}.${malformedId}`]: '{invalid',
      [`vis.gen.${spaceId}.${persistedId}`]: JSON.stringify(generation),
      [`vis.gen.${spaceId}.deleted-node`]: JSON.stringify(generation),
      [`vis.gen.other-space.${legacyId}`]: JSON.stringify(generation),
    }
    await page.evaluate(entries => { for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, value) }, entries)
    await page.reload()
    await page.waitForSelector('.react-flow__pane')
    await expect.poll(async () => (await admin.call('canvas.get', { nodeIds: [legacyId] })).nodes[0].generation).toEqual(generation)
    await expect.poll(() => page.evaluate(key => localStorage.getItem(key), `vis.gen.${spaceId}.${legacyId}`)).toBeNull()
    const remaining = await page.evaluate(keys => Object.fromEntries(keys.map(key => [key, localStorage.getItem(key)])), Object.keys(entries))
    expect(remaining).toEqual({ ...entries, [`vis.gen.${spaceId}.${legacyId}`]: null, [`vis.gen.${spaceId}.${persistedId}`]: null })
    expect((await admin.call('canvas.get', { nodeIds: [malformedId] })).nodes[0].generation).toBeUndefined()
    expect((await admin.call('canvas.get', { nodeIds: [persistedId] })).nodes[0].generation).toEqual(authoritative)
    expect((await admin.call('canvas.get', { nodeIds: ['deleted-node'] })).nodes).toEqual([])
    await admin.call('canvas.apply', { requestId: `legacy-cleanup-${Date.now()}`, ops: [legacyId, malformedId, persistedId].map(nodeId => ({ op: 'node.delete', nodeId })) })
  })

  it('removing the selected node model shows a removal notice and default model while the backend preserves the original settings', async () => {
    const generation = { provider: providerId, model: SECOND_IMAGE_MODEL, params: { size: '4K', n: 3, watermark: true } }
    await admin.call('canvas.apply', { requestId: `removed-generation-${Date.now()}`, ops: [{ op: 'node.setGeneration', nodeId: imageNodeId, generation }] })
    await page.getByRole('button', { name: '适应画布', exact: true }).click()
    await page.locator(`.react-flow__node[data-id="${imageNodeId}"] .vis-node-label`).click()
    await expect.poll(() => page.getByRole('button', { name: '模型与参数', exact: true }).textContent()).toContain('E2E 备用图片模型')
    const config = JSON.parse(readFileSync(join(dir, 'providers.json'), 'utf8'))
    config.providers.find((provider: any) => provider.id === providerId).imageModels = [{ id: IMAGE_MODEL, label: 'E2E 图片模型' }]
    await admin.call('providers.update', { config })
    await page.getByRole('status').filter({ hasText: '模型已移除' }).waitFor()
    await expect.poll(() => page.getByRole('button', { name: '模型与参数', exact: true }).textContent()).toContain('E2E 图片模型')
    await expect.poll(() => page.getByRole('button', { name: '参数摘要', exact: true }).textContent()).toContain('2K · 数量 1')
    expect((await admin.call('canvas.get', { nodeIds: [imageNodeId] })).nodes[0].generation).toEqual(generation)
    await page.reload()
    await page.locator(`.react-flow__node[data-id="${imageNodeId}"] .vis-node-label`).click()
    await page.getByRole('status').filter({ hasText: '模型已移除' }).waitFor()
    await page.getByRole('button', { name: '模型与参数', exact: true }).click()
    const popup = page.getByRole('dialog', { name: '选择模型与参数', exact: true })
    expect(await popup.getByRole('button', { name: /E2E 图片模型/ }).getAttribute('aria-pressed')).toBe('true')
    expect(await popup.getByRole('button', { name: /E2E 备用图片模型/ }).count()).toBe(0)
    await page.evaluate(() => document.fonts.ready)
    await page.screenshot({ path: join(tmpdir(), 'vis-p/removed-model-fallback.png') })
    await popup.press('Escape')
    expect(pageErrors).toEqual([])
    await assertNoSecret()
  })
})

it.skipIf(!ready)('registers Example without UI changes, preserves legacy Ark, gates models by key and generates through its fake server', async () => {
  const example = await exampleService()
  const dataDir = mkdtempSync(join(tmpdir(), 'vis-example-e2e-'))
  const screenshots = join(tmpdir(), 'vis-0028-b')
  mkdirSync(screenshots, { recursive: true })
  const legacy = {
    providers: [
      { id: 'legacy-ark', type: 'volcengine-ark', label: 'Legacy Ark', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', imageModels: [], videoModels: [], audioModels: [] },
      { id: 'retired', type: 'removed-community', label: 'Retired service', baseUrl: 'https://retired.invalid', imageModels: [], videoModels: [], audioModels: [] },
    ],
    defaults: {}, limits: { maxConcurrent: 3, dailyImage: 50, dailyVideo: 10, dailyAudio: 20 },
  }
  const legacyBytes = JSON.stringify(legacy)
  writeFileSync(join(dataDir, 'providers.json'), legacyBytes)
  const daemon = await startStudiod({
    dataDir, studiodVersion: 'example-e2e', runtimes: {}, secretStore: createMemorySecretStore(),
    // Ark and Example only, so chooser keyboard order stays fixed as more built-in types are registered
    providerTypes: [...builtinProviderTypes.filter(type => type.type === 'volcengine-ark'), example.type],
    providers: [createMockProvider({ latencyMs: 0 }), createRenderProvider({ workDir: join(dataDir, 'render') })],
    defaults: { image: { provider: 'mock' }, video: { provider: 'mock' }, audio: { provider: 'mock' } },
  })
  const exampleSpace = daemon.spaces.create({ name: 'Example registry', rootPath: join(dataDir, 'project') }).spaceId
  const link = await openStudiodLink({ socketPath: daemon.socketPath, tokenPath: daemon.tokenPath })
  await link.call('events.subscribe', { spaceId: exampleSpace })
  const web = await createWebHost({ socketPath: daemon.socketPath, tokenPath: daemon.tokenPath, staticDir: join(root, 'apps/web/dist/client') })
  const chrome = await chromium.launch({ executablePath: CHROME, headless: true })
  try {
    const view = await chrome.newPage({ locale: 'zh-CN', viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 })
    view.setDefaultTimeout(10_000)
    await view.goto(web.url)
    await view.getByRole('button', { name: '设置', exact: true }).click()
    const settings = view.getByRole('dialog', { name: '设置', exact: true })
    expect(readFileSync(join(dataDir, 'providers.json'), 'utf8')).toBe(legacyBytes)
    await settings.getByRole('button', { name: /^Retired service/ }).click()
    expect(await settings.getByLabel('名称', { exact: true }).isDisabled()).toBe(true)
    expect(await settings.getByText(/此服务不可用，仅可删除/).isVisible()).toBe(true)
    expect(await settings.getByRole('button', { name: '删除服务', exact: true }).isEnabled()).toBe(true)
    await settings.getByRole('button', { name: /^Legacy Ark/ }).click()
    await settings.getByLabel('名称', { exact: true }).fill('Legacy Ark edited')
    await settings.getByRole('button', { name: '保存配置', exact: true }).click()
    await expect.poll(async () => (await link.call('providers.list')).providers.find((p: any) => p.id === 'legacy-ark')?.label).toBe('Legacy Ark edited')
    expect(JSON.parse(readFileSync(join(dataDir, 'providers.json'), 'utf8')).providers[0]).toEqual({ ...legacy.providers[0], label: 'Legacy Ark edited' })

    await settings.getByRole('button', { name: '+ 添加服务', exact: true }).click()
    const chooser = settings.getByRole('dialog', { name: '选择生成服务' })
    expect(await chooser.getByRole('button', { name: /火山方舟/ }).isVisible()).toBe(true)
    expect(await chooser.getByText('未经真实接口验证', { exact: true }).isVisible()).toBe(true)
    await chooser.getByRole('button', { name: /火山方舟/ }).press('ArrowDown')
    expect(await chooser.getByRole('button', { name: /示例服务/ }).evaluate(element => element === document.activeElement)).toBe(true)
    await view.keyboard.press('Enter')
    await settings.getByLabel('名称', { exact: true }).fill('Example service')
    await settings.getByLabel('区域', { exact: true }).selectOption('west')
    await settings.getByLabel('项目', { exact: true }).fill('demo-project')
    await settings.getByRole('button', { name: '添加模型 Example Image', exact: true }).click()
    expect(await settings.getByRole('button', { name: '添加模型 Example Image', exact: true }).count()).toBe(0)
    const models = settings.getByRole('group', { name: '图片模型', exact: true })
    await models.getByRole('button', { name: '自定义模型 ID', exact: true }).click()
    await models.getByLabel('显示名称', { exact: true }).last().fill('Custom Example')
    await models.getByLabel('模型 ID', { exact: true }).last().fill('custom-example')
    await settings.getByRole('button', { name: '保存配置', exact: true }).click()
    await expect.poll(async () => (await link.call('providers.list')).providers.some((p: any) => p.label === 'Example service')).toBe(true)
    const saved = (await link.call('providers.list')).providers.find((p: any) => p.type === 'example')
    expect(saved).toMatchObject({ region: 'west', baseUrl: `${example.origin}/west`, settings: { project: 'demo-project' }, needsKey: true, hasKey: false })
    await settings.getByRole('button', { name: '取消', exact: true }).click()
    await view.reload()
    await view.getByRole('button', { name: '生图', exact: true }).click()
    await expect.poll(async () => (await link.call('canvas.get')).nodes.length).toBe(1)
    const nodeId = (await link.call('canvas.get')).nodes[0].nodeId
    const node = view.locator(`.react-flow__node[data-id="${nodeId}"]`)
    await node.locator('.vis-node-label').click()
    await view.getByRole('textbox', { name: '提示词', exact: true }).fill('A tiny test image')
    await view.getByRole('button', { name: '模型与参数', exact: true }).click()
    const picker = view.getByRole('dialog', { name: '选择模型与参数', exact: true })
    expect(await picker.getByRole('button', { name: /Example Image/ }).getByText('未配置密钥', { exact: true }).isVisible()).toBe(true)
    expect(await picker.getByRole('button', { name: /Custom Example/ }).isVisible()).toBe(true)
    await picker.getByRole('button', { name: /Example Image/ }).click()
    await picker.press('Escape')
    expect(await view.getByRole('button', { name: '生成', exact: true }).isDisabled()).toBe(true)
    await view.getByRole('button', { name: '设置', exact: true }).click()
    await settings.getByRole('button', { name: /^Example service/ }).click()
    expect(await settings.getByLabel('区域', { exact: true }).inputValue()).toBe('west')
    expect(await settings.getByLabel('项目', { exact: true }).inputValue()).toBe('demo-project')
    await settings.getByLabel('API Key', { exact: true }).fill(EXAMPLE_SECRET)
    await settings.getByRole('button', { name: '保存密钥', exact: true }).click()
    await expect.poll(async () => (await link.call('providers.list')).providers.find((p: any) => p.id === saved.id)?.hasKey).toBe(true)
    await settings.getByRole('button', { name: '取消', exact: true }).click()
    await expect.poll(() => view.getByRole('button', { name: '生成', exact: true }).isEnabled()).toBe(true)
    await view.getByRole('button', { name: '生成', exact: true }).click()
    await node.locator('img').waitFor()
    await expect.poll(() => node.locator('img').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(1)
    expect(example.creates()).toBe(1)
    expect(example.authenticated()).toBeGreaterThan(0)
    expect(readFileSync(join(dataDir, 'providers.json'), 'utf8')).not.toContain(EXAMPLE_SECRET)

    await view.getByRole('button', { name: '设置', exact: true }).click()
    for (const locale of ['zh', 'en'] as const) {
      if (locale === 'en') {
        await settings.getByRole('button', { name: '语言', exact: true }).click()
        await settings.getByLabel('语言', { exact: true }).selectOption('en')
      }
      const dialog = view.getByRole('dialog', { name: locale === 'zh' ? '设置' : 'Settings', exact: true })
      await dialog.getByRole('button', { name: /^Mock/ }).click()
      await view.evaluate(() => document.fonts.ready)
      await view.screenshot({ animations: 'disabled', path: join(screenshots, `services-list-${locale}.png`) })
      const add = dialog.getByRole('button', { name: locale === 'zh' ? '+ 添加服务' : '+ Add service', exact: true })
      await add.click()
      await view.screenshot({ animations: 'disabled', path: join(screenshots, `services-chooser-${locale}.png`) })
      await view.keyboard.press('Escape')
      expect(await add.evaluate(element => element === document.activeElement)).toBe(true)
      await dialog.getByRole('button', { name: /^Example service/ }).click()
      await view.screenshot({ animations: 'disabled', path: join(screenshots, `services-example-${locale}.png`) })
      await dialog.getByRole('button', { name: /^Retired service/ }).click()
      await view.screenshot({ animations: 'disabled', path: join(screenshots, `services-unavailable-${locale}.png`) })
    }
  } finally {
    await chrome.close()
    link.close()
    await web.close()
    await daemon.stop('user_quit')
    await example.close()
    removeTempDir(dataDir)
  }
}, 60_000)
