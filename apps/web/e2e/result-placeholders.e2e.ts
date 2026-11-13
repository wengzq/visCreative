import { chromePath, removeTempDir } from './platform'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
// Real studiod + web host + Chrome with a slow Mock provider: result nodes appear at submission (RFC 0047).
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, chromium, type Page } from 'playwright-core'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockProvider, type ProviderAdapter } from '../../../packages/generation/src/index'
import { ProviderError } from '../../../packages/generation/src/providers/types'
import type { NodeView } from '../../../packages/protocol/src/index'
import { createMemorySecretStore } from '../../../services/studiod/src/secret-store'
import { startStudiod, type Studiod } from '../../../services/studiod/src/studiod'
import { createWebHost, type WebHost } from '../src/host/server'
import { openStudiodLink, type StudiodLink } from '../src/host/studiod-link'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const CHROME = chromePath()
const ready = existsSync(CHROME) && existsSync(join(root, 'apps/web/dist/client/index.html'))
const artifacts = join(tmpdir(), 'vis-result-placeholders')

let dir: string
let studiod: Studiod
let host: WebHost
let admin: StudiodLink
let browser: Browser
let page: Page
const pageErrors: string[] = []
const nodes = async () => (await admin.call('canvas.get')).nodes as NodeView[]
const node = (id: string) => page.locator(`.react-flow__node[data-id="${id}"]`)
const submit = (prompt: string) => admin.call('generation.submit', { requestId: crypto.randomUUID(), kind: 'image', prompt }) as Promise<{ jobId: string; bindings: { target: { nodeId?: string } }[] }>

describe.skipIf(!ready)('Result placeholder nodes', () => {
  beforeAll(async () => {
    mkdirSync(artifacts, { recursive: true })
    dir = mkdtempSync(join(tmpdir(), 'vis-placeholders-e2e-'))
    vi.stubEnv('VIS_PROJECTS_DIR', join(dir, 'projects'))
    const mock = createMockProvider({ latencyMs: 3000 })
    const provider: ProviderAdapter = {
      ...mock,
      async submit(request, options) {
        if (request.prompt.includes('reject')) throw new ProviderError('rejected', 'Simulated rejection')
        return mock.submit(request, options)
      },
    }
    studiod = await startStudiod({
      dataDir: dir, studiodVersion: 'e2e', runtimes: {}, secretStore: createMemorySecretStore(),
      providers: [provider], defaults: { image: { provider: 'mock' }, video: { provider: 'mock' }, audio: { provider: 'mock' } },
    })
    const { spaceId } = studiod.spaces.create('结果占位节点')
    admin = await openStudiodLink({ socketPath: studiod.socketPath, tokenPath: studiod.tokenPath })
    await admin.call('events.subscribe', { spaceId })
    host = await createWebHost({ socketPath: studiod.socketPath, tokenPath: studiod.tokenPath, staticDir: join(root, 'apps/web/dist/client') })
    browser = await chromium.launch({ executablePath: CHROME, headless: true })
    page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 })
    page.setDefaultTimeout(5000)
    page.on('pageerror', error => pageErrors.push(error.message))
    await page.goto(host.url)
    await page.waitForSelector('.react-flow__pane')
  }, 30_000)

  beforeEach(async () => {
    const existing = await nodes()
    if (existing.length) await admin.call('canvas.apply', { requestId: crypto.randomUUID(), ops: existing.map(item => ({ op: 'node.delete', nodeId: item.nodeId })) })
    pageErrors.length = 0
  })

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

  it('shows the result node as generating right after submission and fills that same node', async () => {
    const { jobId, bindings } = await submit('晨雾中的灯塔')
    const nodeId = bindings[0]!.target.nodeId!
    expect((await nodes()).map(item => item.nodeId)).toEqual([nodeId])
    await node(nodeId).getByText('生成中', { exact: true }).waitFor()
    expect((await admin.call('generation.get', { jobId })).status).not.toBe('succeeded')
    expect(await node(nodeId).locator('img').count()).toBe(0)
    await page.screenshot({ path: join(artifacts, 'generating.png'), animations: 'disabled' })
    await expect.poll(() => node(nodeId).locator('img').evaluate(image => (image as HTMLImageElement).naturalWidth), { timeout: 15_000 }).toBe(512)
    expect((await nodes()).map(item => item.nodeId)).toEqual([nodeId])
    expect(pageErrors).toEqual([])
  })

  it('cancelling from the node removes the still-empty placeholder', async () => {
    const { jobId, bindings } = await submit('等待取消的海湾')
    const nodeId = bindings[0]!.target.nodeId!
    await node(nodeId).hover()
    await node(nodeId).getByRole('button', { name: '取消生成', exact: true }).click()
    await expect.poll(async () => (await admin.call('generation.get', { jobId })).status).toBe('cancelled')
    await expect.poll(() => node(nodeId).count()).toBe(0)
    expect(await nodes()).toEqual([])
  })

  it('a rejected job shows its problem on the placeholder, which stays for the author', async () => {
    const { jobId, bindings } = await submit('reject this one')
    const nodeId = bindings[0]!.target.nodeId!
    await expect.poll(async () => (await admin.call('generation.get', { jobId })).status, { timeout: 10_000 }).toBe('failed')
    await node(nodeId).locator('.vis-node-problem').waitFor()
    expect((await nodes()).map(item => item.nodeId)).toEqual([nodeId])
  })
})
