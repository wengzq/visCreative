import { chromePath, removeTempDir } from './platform'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
// Real studiod + web host + Chrome; Mock and a local fake Ark service cover cancellation, retries, and agent-only quotas.
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import { type Browser, chromium, type Page } from 'playwright-core'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createMockProvider, type ProviderAdapter } from '../../../packages/generation/src/index'
import type { JobView, ProviderConfig } from '../../../packages/protocol/src/index'
import { createMemorySecretStore } from '../../../services/studiod/src/secret-store'
import { startStudiod, type Studiod } from '../../../services/studiod/src/studiod'
import { createWebHost, type WebHost } from '../src/host/server'
import { openStudiodLink, type StudiodLink } from '../src/host/studiod-link'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const CHROME = chromePath()
const ready = existsSync(CHROME) && existsSync(join(root, 'apps/web/dist/client/index.html'))
const artifacts = join(tmpdir(), 'vis-o')
const PROVIDER = 'e2e-quota-ark'
const MODEL = 'ep-e2e-quota-image'
const SECRET = 'e2e-local-ark-fake-key'
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=', 'base64')

let dir: string
let studiod: Studiod
let host: WebHost
let admin: StudiodLink
let server: Server
let browser: Browser
let page: Page
let origin: string
let config: ProviderConfig
const jobs = new Map<string, JobView>()
const submissions: Record<string, unknown>[] = []
const arkRequests: { body: Record<string, unknown>; authenticated: boolean }[] = []
const pageErrors: string[] = []

async function imageNode(prompt: string, x: number) {
  const { idMap } = await admin.call('canvas.apply', {
    requestId: `guardrails-${crypto.randomUUID()}`,
    ops: [{ op: 'node.create', tempId: 'image', kind: 'image', x, y: 0, w: 320, h: 320, prompt }],
  })
  const nodeId = idMap.image as string
  const node = page.locator(`.react-flow__node[data-id="${nodeId}"]`)
  await node.waitFor()
  await page.getByRole('button', { name: '适应画布', exact: true }).click()
  await node.locator('.vis-node-label').click()
  return { nodeId, node }
}

const nodeJobs = (nodeId: string) => [...jobs.values()].filter(job => job.targets.some(target => target.nodeId === nodeId))

describe.skipIf(!ready)('Generation job guardrails', () => {
  beforeAll(async () => {
    mkdirSync(artifacts, { recursive: true })
    dir = mkdtempSync(join(tmpdir(), 'vis-o-e2e-'))
    vi.stubEnv('VIS_PROJECTS_DIR', join(dir, 'projects'))
    const mock = createMockProvider({ latencyMs: 0 })
    const modes = new Map<string, 'running' | 'failed'>()
    let failedOnce = false
    const provider: ProviderAdapter = {
      ...mock,
      type: 'mock',
      async submit(request, options) {
        const result = await mock.submit(request, options)
        if (request.prompt === '等待取消的花园') modes.set(result.externalTaskId, 'running')
        if (request.prompt === '重试后绽放的花园' && !failedOnce) {
          failedOnce = true
          modes.set(result.externalTaskId, 'failed')
        }
        return result
      },
      async getTask(id, options) {
        const mode = modes.get(id)
        if (mode === 'running') return { state: 'running' }
        if (mode === 'failed') return { state: 'failed', error: { code: 'e2e_failed', message: 'Simulated generation failure; please retry' } }
        return mock.getTask(id, options)
      },
    }
    server = createServer(async (request, response) => {
      if (request.url === '/image.png') {
        response.setHeader('Content-Type', 'image/png')
        response.end(PNG)
        return
      }
      if (request.method === 'POST' && request.url === '/api/v3/images/generations') {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        arkRequests.push({ body: JSON.parse(Buffer.concat(chunks).toString()), authenticated: request.headers.authorization === `Bearer ${SECRET}` })
        response.setHeader('Content-Type', 'application/json')
        response.end(JSON.stringify({ data: [{ url: `${origin}/image.png`, size: '1x1' }] }))
        return
      }
      response.writeHead(404).end('{}')
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Local fake Ark service has not started')
    origin = `http://127.0.0.1:${address.port}`
    studiod = await startStudiod({
      dataDir: dir, studiodVersion: 'e2e', runtimes: {}, secretStore: createMemorySecretStore(),
      providers: [provider], defaults: { image: { provider: 'mock' }, video: { provider: 'mock' }, audio: { provider: 'mock' } },
    })
    const { spaceId } = studiod.spaces.create('生成任务护栏')
    admin = await openStudiodLink({ socketPath: studiod.socketPath, tokenPath: studiod.tokenPath, onMessage: line => {
      const message = JSON.parse(line)
      if (message.method === 'events.event' && message.params.type === 'job.stateChanged') {
        const job = message.params.payload.job as JobView
        jobs.set(job.jobId, job)
      }
    } })
    await admin.call('events.subscribe', { spaceId })
    config = {
      providers: [{ id: PROVIDER, type: 'volcengine-ark', label: '本机额度测试', baseUrl: `${origin}/api/v3`, imageModels: [{ id: MODEL, label: 'E2E 配额图片' }], videoModels: [], audioModels: [] }],
      defaults: { image: { provider: 'mock', model: 'mock-image-1' }, video: { provider: 'mock', model: 'mock-video-1' }, audio: { provider: 'mock', model: 'mock-music-1' } },
      limits: { maxConcurrent: 3, dailyImage: 1, dailyVideo: 10, dailyAudio: 20 },
    }
    await admin.call('providers.update', { config })
    await admin.call('providers.setKey', { providerId: PROVIDER, apiKey: SECRET })
    host = await createWebHost({ socketPath: studiod.socketPath, tokenPath: studiod.tokenPath, staticDir: join(root, 'apps/web/dist/client') })
    browser = await chromium.launch({ executablePath: CHROME, headless: true })
    page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 })
    page.setDefaultTimeout(5000)
    page.on('pageerror', error => pageErrors.push(error.message))
    page.on('websocket', socket => socket.on('framesent', frame => {
      const message = JSON.parse(String(frame.payload))
      if (message.method === 'generation.submit' || message.method === 'generation.regenerate') submissions.push({ method: message.method, ...message.params })
    }))
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
    server?.closeAllConnections()
    if (server) await new Promise<void>(resolve => server.close(() => resolve()))
    vi.unstubAllEnvs()
    removeTempDir(dir)
  }, 30_000)

  it('hover-cancelling a running job confirms cancellation and does not fill outputs', async () => {
    const { nodeId, node } = await imageNode('等待取消的花园', 0)
    await page.getByRole('button', { name: '生成', exact: true }).click()
    await expect.poll(() => nodeJobs(nodeId).at(-1)?.status).toBe('running')
    const jobId = nodeJobs(nodeId).at(-1)!.jobId
    await node.hover()
    const cancel = node.getByRole('button', { name: '取消生成', exact: true })
    await expect.poll(() => cancel.evaluate(button => getComputedStyle(button).opacity)).toBe('1')
    await page.screenshot({ path: join(artifacts, 'hover-cancel.png'), animations: 'disabled' })
    await cancel.click()
    await expect.poll(async () => (await admin.call('generation.get', { jobId })).status).toBe('cancelled')
    expect(await admin.call('generation.get', { jobId })).toMatchObject({ providerCancelled: true, outputs: [], targets: [{ status: 'no_output' }] })
    await expect.poll(() => node.locator('.vis-node-problem').textContent()).toContain('已取消生成')
    expect(await node.getByRole('button', { name: '取消生成', exact: true }).count()).toBe(0)
    expect(await node.locator('img').count()).toBe(0)
    expect((await admin.call('generation.usage')).image).toBe(0)
    await node.getByRole('button', { name: '关闭', exact: true }).click()
  })

  it('retrying a failed job on its node delivers successfully to the original slot', async () => {
    const { nodeId, node } = await imageNode('重试后绽放的花园', 400)
    await page.getByRole('button', { name: '生成', exact: true }).click()
    await expect.poll(() => nodeJobs(nodeId).at(-1)?.status, { timeout: 10_000 }).toBe('failed')
    const failed = nodeJobs(nodeId).at(-1)!
    await node.getByRole('button', { name: '重新生成', exact: true }).waitFor()
    await page.screenshot({ path: join(artifacts, 'failure-retry.png'), animations: 'disabled' })
    await node.getByRole('button', { name: '重新生成', exact: true }).click()
    await expect.poll(() => nodeJobs(nodeId).length).toBe(2)
    await expect.poll(() => nodeJobs(nodeId).at(-1)?.status, { timeout: 10_000 }).toBe('succeeded')
    const retried = nodeJobs(nodeId).at(-1)!
    expect(retried.jobId).not.toBe(failed.jobId)
    expect(retried.targets[0]?.slotId).toBe(failed.targets[0]?.slotId)
    expect(retried.outputs[0]?.delivery.status).toBe('delivered')
    await expect.poll(() => node.locator('img').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(512)
    expect(await node.locator('.vis-node-problem').count()).toBe(0)
    expect(submissions.find(submission => submission.method === 'generation.regenerate' && submission.jobId === failed.jobId)).toBeDefined()
  })

  it('with the agent daily image limit set to 1, the UI generates twice without confirmation or counting toward agent usage', async () => {
    config.defaults.image = { provider: PROVIDER, model: MODEL }
    await admin.call('providers.update', { config })
    await page.reload()
    await page.waitForSelector('.react-flow__pane')
    const { nodeId, node } = await imageNode('本机方舟的清晨花园', -400)
    await page.getByRole('button', { name: '生成', exact: true }).click()
    await expect.poll(() => nodeJobs(nodeId).at(-1)?.status, { timeout: 10_000 }).toBe('succeeded')
    expect(arkRequests).toEqual([{ authenticated: true, body: expect.objectContaining({ model: MODEL, prompt: '本机方舟的清晨花园' }) }])
    await page.getByRole('button', { name: '生成', exact: true }).click()
    const quota = page.getByRole('dialog', { name: '超过每日生成上限', exact: true })
    await expect.poll(() => arkRequests.length).toBe(2)
    await expect.poll(() => nodeJobs(nodeId).length).toBe(2)
    await expect.poll(() => nodeJobs(nodeId).at(-1)?.status, { timeout: 10_000 }).toBe('succeeded')
    expect(await quota.count()).toBe(0)
    expect(nodeJobs(nodeId)).toHaveLength(2)
    expect(submissions.at(-1)).toMatchObject({ method: 'generation.submit', kind: 'image' })
    expect(submissions.every(submission => !Object.hasOwn(submission, 'overrideQuota'))).toBe(true)
    expect(await admin.call('generation.usage')).toMatchObject({ image: 2, video: 0, audio: 0, agent: { image: 0, video: 0, audio: 0 }, limits: { dailyImage: 1 } })
    await expect.poll(() => page.getByRole('button', { name: '今日用量（全部项目）', exact: true }).getAttribute('title')).toContain('图片 2 · 视频 0 · 音频 0')
    await page.getByRole('button', { name: '今日用量（全部项目）', exact: true }).click()
    const usage = page.getByRole('dialog', { name: '今日用量（全部项目）', exact: true })
    await usage.getByText(/全部付费提交：图片 2 · 视频 0 · 音频 0/).waitFor()
    await usage.getByText('Agent 已用 / 上限：图片 0 / 1 · 视频 0 / 10 · 音频 0 / 20', { exact: true }).waitFor()
    expect(await usage.getByRole('listitem').count()).toBe(2)
    expect(await usage.getByRole('button', { name: '再来一版', exact: true }).count()).toBe(2)
    await page.screenshot({ path: join(artifacts, 'usage-panel.png'), animations: 'disabled' })
    await usage.getByRole('button', { name: '关闭今日用量', exact: true }).click()
    await expect.poll(() => node.locator('img:not(.is-previous)').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(1)
    expect(pageErrors).toEqual([])
  })
})
