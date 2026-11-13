import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright-core'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockProvider } from '../../../packages/generation/src/index'
import type { CanvasOp, MethodParams, NodeView, SlotVersionView } from '../../../packages/protocol/src/index'
import { eq, spaceSchema as s } from '../../../packages/storage/src/index'
import { createMemorySecretStore } from '../../../services/studiod/src/secret-store'
import { startStudiod, type Studiod } from '../../../services/studiod/src/studiod'
import { createWebHost, type WebHost } from '../src/host/server'
import { openStudiodLink, type StudiodLink } from '../src/host/studiod-link'
import { chromePath, removeTempDir } from './platform'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const chrome = chromePath()
const ready = existsSync(chrome) && existsSync(join(root, 'apps/web/dist/client/index.html'))
const hint = 'Regenerate with the same prompt and settings (new version)'
let dir: string
let studiod: Studiod
let host: WebHost
let admin: StudiodLink
let browser: Browser
let page: Page
let spaceId: string
let targetId: string
let submissionGate: Promise<void> | undefined
let releaseSubmission: (() => void) | undefined
const errors: string[] = []
const requests: MethodParams<'generation.regenerate'>[] = []
const apply = (ops: CanvasOp[]) => admin.call('canvas.apply', { requestId: crypto.randomUUID(), ops })
const nodes = async (): Promise<NodeView[]> => (await admin.call('canvas.get', {})).nodes
const target = async () => (await nodes()).find(node => node.nodeId === targetId)!
const main = async () => (await target()).slots.find(slot => slot.slotKey === 'main')!
const db = () => studiod.spaces.get(spaceId)!.db
const jobs = () => db().select().from(s.generationJobs).all()
const job = (jobId: string) => db().select().from(s.generationJobs).where(eq(s.generationJobs.id, jobId)).get()!
const regenerate = () => page.getByRole('button', { name: hint, exact: true })
const history = async (): Promise<SlotVersionView[]> => (await admin.call('slot.history', { slotId: (await main()).slotId })).versions

async function selectTarget() {
  await page.getByRole('button', { name: 'Fit canvas', exact: true }).click()
  let previous = ''
  await expect.poll(async () => {
    const transform = await page.locator('.react-flow__viewport').evaluate(element => getComputedStyle(element).transform)
    const settled = transform === previous
    previous = transform
    return settled
  }, { intervals: [100] }).toBe(true)
  await page.locator(`.react-flow__node[data-id="${targetId}"] .vis-node-label`).click()
  await page.getByRole('toolbar', { name: 'Node operations', exact: true }).waitFor()
}

async function generateFromPanel() {
  expect(await regenerate().count()).toBe(0)
  await page.getByRole('textbox', { name: 'Prompt', exact: true }).fill('A red kite above a quiet river')
  await page.getByRole('button', { name: 'Generate', exact: true }).click()
  await expect.poll(async () => (await main()).revision, { timeout: 10_000 }).toBe(1)
  await regenerate().waitFor()
  return (await main()).source!.jobId
}

describe.skipIf(!ready)('Regenerate from the node toolbar', () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'vis-toolbar-regenerate-'))
    vi.stubEnv('VIS_PROJECTS_DIR', join(dir, 'projects'))
    const mock = createMockProvider({ latencyMs: 0 })
    studiod = await startStudiod({
      dataDir: dir, studiodVersion: 'toolbar-regenerate-e2e', secretStore: createMemorySecretStore(), runtimes: {},
      providers: [{ ...mock, submit: async (request, options) => { await submissionGate; return mock.submit(request, options) } }],
      defaults: { image: { provider: 'mock' }, video: { provider: 'mock' }, audio: { provider: 'mock' } },
    })
    spaceId = studiod.spaces.create('Toolbar regeneration').spaceId
    admin = await openStudiodLink({ socketPath: studiod.socketPath, tokenPath: studiod.tokenPath })
    await admin.call('events.subscribe', { spaceId })
    host = await createWebHost({ socketPath: studiod.socketPath, tokenPath: studiod.tokenPath, staticDir: join(root, 'apps/web/dist/client') })
    browser = await chromium.launch({ executablePath: chrome, headless: true })
  })

  beforeEach(async () => {
    const existing = await nodes()
    if (existing.length) await apply(existing.map(node => ({ op: 'node.delete', nodeId: node.nodeId })))
    const { idMap } = await apply([{ op: 'node.create', tempId: 'target', kind: 'image', x: 0, y: 0, w: 320, h: 240, prompt: '' }])
    targetId = idMap.target
    errors.length = 0
    requests.length = 0
    submissionGate = undefined
    releaseSubmission = undefined
    page = await browser.newPage({ locale: 'en-US', viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2, reducedMotion: 'reduce' })
    page.setDefaultTimeout(10_000)
    page.on('pageerror', error => errors.push(error.message))
    page.on('websocket', socket => socket.on('framesent', ({ payload }) => {
      const frame = JSON.parse(String(payload))
      if (frame.method === 'generation.regenerate') requests.push(frame.params)
    }))
    await page.goto(host.url)
    await selectTarget()
  })

  afterEach(async ({ task }) => {
    releaseSubmission?.()
    try {
      if (task.result?.state === 'fail') await page.screenshot({ path: join(tmpdir(), 'vis-toolbar-regenerate-failure.png'), animations: 'disabled' })
      expect(errors).toEqual([])
    } finally { await page?.close() }
  })

  afterAll(async () => {
    await browser?.close()
    admin?.close()
    await host?.close()
    await studiod?.stop('user_quit')
    vi.unstubAllEnvs()
    removeTempDir(dir)
  })

  it('adds a version to the same node using the displayed settings, preserves the draft, and keeps the first version reachable', async () => {
    const originalId = await generateFromPanel()
    const first = await main()
    const beforeNodes = (await nodes()).length
    const original = job(originalId)
    await page.getByRole('textbox', { name: 'Prompt', exact: true }).fill('A different draft for a later picture')
    await page.getByRole('button', { name: 'Parameter summary', exact: true }).click()
    const params = page.getByRole('dialog', { name: 'Generation parameters', exact: true })
    await params.getByRole('group', { name: 'Count', exact: true }).getByRole('button', { name: '3', exact: true }).click()
    await params.press('Escape')
    await expect.poll(async () => (await target()).generation?.params?.n).toBe(3)
    await expect.poll(async () => (await target()).slots.find(slot => slot.slotKey === 'prompt')?.content).toEqual({ type: 'text', body: 'A different draft for a later picture' })
    const draft = await target()
    await regenerate().click()
    await expect.poll(async () => (await main()).revision, { timeout: 10_000 }).toBe(2)
    const second = await main()
    expect(requests).toEqual([{ requestId: expect.any(String), jobId: originalId, targetNodeId: targetId }])
    expect(job(second.source!.jobId)).toMatchObject({ provider: original.provider, model: original.model, params: original.params })
    expect((await target()).slots.find(slot => slot.slotKey === 'prompt')).toEqual(draft.slots.find(slot => slot.slotKey === 'prompt'))
    expect((await target()).generation).toEqual(draft.generation)
    expect(await nodes()).toHaveLength(beforeNodes)
    expect((await history()).map(version => version.content)).toEqual([second.content, first.content])
    const versionOne = page.getByRole('button', { name: 'View version v1', exact: true })
    await versionOne.click()
    await page.mouse.move(30, 900)
    const image = page.locator(`.react-flow__node[data-id="${targetId}"] .vis-version-media > img:last-child`)
    await expect.poll(() => image.getAttribute('src')).toContain(first.content.type === 'asset' ? first.content.assetVersionId : 'missing')
    expect((await main()).revision).toBe(2)
    await expect.poll(() => regenerate().isEnabled()).toBe(true)
    await regenerate().click()
    await expect.poll(async () => (await main()).revision, { timeout: 10_000 }).toBe(3)
    expect(requests[1]).toMatchObject({ jobId: originalId, targetNodeId: targetId })
    expect(requests[1]!.requestId).not.toBe(requests[0]!.requestId)
    expect(await nodes()).toHaveLength(beforeNodes)
    expect(await history()).toHaveLength(3)
  })

  it('disables a rapid double press until the receipt and hides regeneration while that node is running', async () => {
    await generateFromPanel()
    const count = jobs().length
    await page.evaluate(() => {
      const send = WebSocket.prototype.send
      WebSocket.prototype.send = function (data) {
        if (typeof data === 'string' && JSON.parse(data).method === 'generation.regenerate') {
          Object.assign(window, { releaseRegenerate: () => send.call(this, data) })
          return
        }
        send.call(this, data)
      }
    })
    await regenerate().dblclick({ delay: 0 })
    await expect.poll(() => regenerate().isDisabled()).toBe(true)
    await expect.poll(() => page.evaluate(() => typeof Reflect.get(window, 'releaseRegenerate'))).toBe('function')
    expect(jobs()).toHaveLength(count)
    submissionGate = new Promise(resolve => { releaseSubmission = resolve })
    await page.evaluate(() => Reflect.get(window, 'releaseRegenerate')())
    await expect.poll(() => jobs().length).toBe(count + 1)
    await expect.poll(() => regenerate().count()).toBe(0)
    await expect.poll(() => jobs().filter(entry => entry.status === 'running')).toHaveLength(1)
    releaseSubmission!()
    await expect.poll(async () => (await main()).revision, { timeout: 10_000 }).toBe(2)
    expect(jobs()).toHaveLength(count + 1)
    expect(requests).toHaveLength(1)
    await regenerate().waitFor()
  })

  it('regenerates only the chosen node from an n=3 job with a single output and unchanged siblings', async () => {
    const original = await admin.call('generation.submit', {
      requestId: crypto.randomUUID(), kind: 'image', prompt: 'Three distinct river views',
      params: { n: 3, width: 128, height: 128 },
    })
    await expect.poll(async () => (await admin.call('generation.get', { jobId: original.jobId })).status, { timeout: 10_000 }).toBe('succeeded')
    const delivered = (await nodes()).filter(node => node.slots.some(slot => slot.source?.jobId === original.jobId))
    expect(delivered).toHaveLength(3)
    targetId = delivered[1]!.nodeId
    const siblings = delivered.filter(node => node.nodeId !== targetId)
    const count = (await nodes()).length
    await selectTarget()
    await regenerate().click()
    await expect.poll(async () => (await main()).revision, { timeout: 10_000 }).toBe(2)
    const nextId = (await main()).source!.jobId
    const next = await admin.call('generation.get', { jobId: nextId })
    expect(job(nextId).params).toEqual({ ...(job(original.jobId).params as Record<string, unknown>), n: 1 })
    expect(next.outputs).toHaveLength(1)
    expect(next.targets).toEqual([{ outputIndex: 0, kind: 'slot', status: 'delivered', nodeId: targetId, slotId: (await main()).slotId }])
    const after = await nodes()
    expect(after).toHaveLength(count)
    for (const sibling of siblings) expect(after.find(node => node.nodeId === sibling.nodeId)).toEqual(sibling)
  })

  it('asks before regenerating an unknown job and creates no job when the author dismisses the confirmation', async () => {
    const originalId = await generateFromPanel()
    db().update(s.generationJobs).set({ status: 'unknown' }).where(eq(s.generationJobs.id, originalId)).run()
    const count = jobs().length
    const dialogEvent = page.waitForEvent('dialog')
    const press = regenerate().click()
    const dialog = await dialogEvent
    expect(dialog.type()).toBe('confirm')
    expect(dialog.message()).toBe('The previous request may have completed and been charged by the provider. Generate again?')
    await dialog.dismiss()
    await press
    await expect.poll(() => regenerate().isEnabled()).toBe(true)
    expect(jobs()).toHaveLength(count)
    expect(requests).toEqual([])
    expect((await main()).revision).toBe(1)
  })

  it('shows the approved English and Chinese tooltip, accessible name and button label after a locale switch', async () => {
    await generateFromPanel()
    expect(await regenerate().getAttribute('title')).toBe(hint)
    expect(await regenerate().innerText()).toBe('Regenerate')
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
    await settings.getByRole('button', { name: 'Language', exact: true }).click()
    await page.getByRole('combobox', { name: 'Language', exact: true }).selectOption('zh-CN')
    await expect.poll(() => page.locator('html').getAttribute('lang')).toBe('zh-CN')
    await page.getByRole('button', { name: '关闭设置', exact: true }).click()
    const chinese = page.getByRole('button', { name: '用相同的提示词和设置重新生成（新版本）', exact: true })
    await chinese.waitFor()
    expect(await chinese.getAttribute('title')).toBe('用相同的提示词和设置重新生成（新版本）')
    expect(await chinese.innerText()).toBe('重新生成')
  })
})
