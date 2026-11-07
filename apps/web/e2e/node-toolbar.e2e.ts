import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright-core'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { NodeView } from '@vis/protocol'
import { createMockProvider } from '../../../packages/generation/src/index'
import { createMemorySecretStore } from '../../../services/studiod/src/secret-store'
import { startStudiod, type Studiod } from '../../../services/studiod/src/studiod'
import { createWebHost, type WebHost } from '../src/host/server'
import { openStudiodLink, type StudiodLink } from '../src/host/studiod-link'
import { chromePath, removeTempDir } from './platform'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const ready = existsSync(chromePath()) && existsSync(join(root, 'apps/web/dist/client/index.html'))
const screenshots = join(tmpdir(), 'vis-n2-node-toolbar')

for (const mock of [false, true]) describe.skipIf(!ready)(`Node toolbar with ${mock ? 'Mock' : 'no providers'}`, () => {
  let dir: string
  let daemon: Studiod
  let host: WebHost
  let admin: StudiodLink
  let browser: Browser
  let page: Page
  let source: NodeView
  const pageErrors: string[] = []
  const nodes = async (): Promise<NodeView[]> => (await admin.call('canvas.get')).nodes
  const main = async () => (await nodes()).find(node => node.nodeId === source.nodeId)!.slots.find(slot => slot.slotKey === 'main')!
  const select = async () => {
    await page.getByRole('button', { name: 'Fit canvas', exact: true }).click()
    const viewport = page.locator('.react-flow__viewport')
    let last = ''
    await expect.poll(async () => {
      const current = await viewport.evaluate(element => getComputedStyle(element).transform)
      const settled = current === last
      last = current
      return settled
    }, { intervals: [100] }).toBe(true)
    await page.locator(`.react-flow__node[data-id="${source.nodeId}"] .vis-node-body`).click()
    await page.getByRole('toolbar', { name: 'Node operations' }).waitFor()
  }
  beforeAll(async () => {
    mkdirSync(screenshots, { recursive: true })
    dir = mkdtempSync(join(tmpdir(), 'vis-node-toolbar-'))
    vi.stubEnv('VIS_PROJECTS_DIR', join(dir, 'projects'))
    daemon = await startStudiod({
      dataDir: dir, studiodVersion: 'e2e', runtimes: {}, secretStore: createMemorySecretStore(),
      providers: mock ? [createMockProvider({ latencyMs: 0 })] : [],
      defaults: mock ? { image: { provider: 'mock' } } : {},
    })
    const { spaceId } = daemon.spaces.create('Node toolbar acceptance')
    admin = await openStudiodLink({ socketPath: daemon.socketPath, tokenPath: daemon.tokenPath })
    await admin.call('events.subscribe', { spaceId })
    host = await createWebHost({ socketPath: daemon.socketPath, tokenPath: daemon.tokenPath, staticDir: join(root, 'apps/web/dist/client') })
    browser = await chromium.launch({ executablePath: chromePath(), headless: true })
    page = await browser.newPage({ locale: 'en-US', viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 })
    page.setDefaultTimeout(5000)
    page.on('pageerror', error => pageErrors.push(error.message))
    await page.goto(host.url, { waitUntil: 'domcontentloaded', timeout: 15_000 })
    await page.locator('.react-flow__pane').waitFor()
    const file = join(dir, 'source.png')
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x90', '-frames:v', '1', file])
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'Upload', exact: true }).click()])
    await chooser.setFiles(file)
    await page.locator('.react-flow__node-image').waitFor()
    source = (await nodes())[0]!
  }, 30_000)
  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail' && page) await page.screenshot({ path: join(screenshots, `${mock ? 'mock' : 'local'}-${task.name.replaceAll(/[^a-z0-9]+/gi, '-')}.png`), animations: 'disabled' })
  })
  afterAll(async () => {
    await browser?.close()
    admin?.close()
    await host?.close()
    await daemon?.stop('user_quit')
    vi.unstubAllEnvs()
    removeTempDir(dir)
  }, 30_000)

  if (!mock) {
    it('shows local image operations without providers and supports toolbar keyboard navigation', async () => {
      await select()
      const toolbar = page.getByRole('toolbar', { name: 'Node operations' })
      expect(await toolbar.getByRole('button', { name: 'Crop', exact: true }).count()).toBe(1)
      expect(await toolbar.getByRole('button', { name: 'Grid split', exact: true }).count()).toBe(1)
      expect(await toolbar.getByRole('button', { name: 'Upscale', exact: true }).count()).toBe(0)
      await toolbar.getByRole('button', { name: 'Crop', exact: true }).focus()
      await page.keyboard.press('ArrowRight')
      expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('Grid split')
      await toolbar.getByRole('button', { name: 'More operations', exact: true }).click()
      const customize = page.getByRole('menuitem', { name: 'Customize toolbar' })
      expect(await customize.isDisabled()).toBe(true)
      expect(await customize.getAttribute('title')).toBe('Coming soon')
      await page.keyboard.press('Escape')
      await page.screenshot({ path: join(screenshots, 'local-toolbar.png'), animations: 'disabled' })
    })
    it('cancels crop with Escape, then crops in source pixels and supports undo and redo', async () => {
      await select()
      await page.getByRole('button', { name: 'Crop', exact: true }).click()
      await page.getByLabel('Crop aspect ratio', { exact: true }).selectOption('1')
      await page.screenshot({ path: join(screenshots, 'crop-preview.png'), animations: 'disabled' })
      await page.keyboard.press('Escape')
      expect(await page.getByRole('group', { name: 'Crop image', exact: true }).count()).toBe(0)
      const before = await main()
      await page.getByRole('button', { name: 'Crop', exact: true }).click()
      await page.getByLabel('Crop aspect ratio', { exact: true }).selectOption('1')
      await page.keyboard.press('Enter')
      await expect.poll(async () => (await main()).revision, { timeout: 10_000 }).toBeGreaterThan(before.revision)
      const cropped = await main()
      expect(cropped.content).not.toEqual(before.content)
      const image = page.locator(`.react-flow__node[data-id="${source.nodeId}"] img.vis-node-media:not(.is-previous)`)
      await expect.poll(() => image.evaluate(element => [(element as HTMLImageElement).naturalWidth, (element as HTMLImageElement).naturalHeight])).toEqual([90, 90])
      await page.keyboard.press('ControlOrMeta+Z')
      await expect.poll(async () => (await main()).content).toEqual(before.content)
      await page.keyboard.press('ControlOrMeta+Shift+Z')
      await expect.poll(async () => (await main()).content).toEqual(cropped.content)
      // Leave the source as later cases expect it: uncropped
      await page.keyboard.press('ControlOrMeta+Z')
      await expect.poll(async () => (await main()).content).toEqual(before.content)
    })
    it('previews crop dragging, resizing and grid lines without changing the asset', async () => {
      await select()
      const before = await main()
      await page.getByRole('button', { name: 'Crop', exact: true }).click()
      await page.getByLabel('Crop aspect ratio', { exact: true }).selectOption('1')
      const selection = page.getByRole('group', { name: 'Crop selection', exact: true })
      const previous = await selection.evaluate(element => parseFloat((element as HTMLElement).style.left))
      const box = (await selection.boundingBox())!
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.mouse.down()
      await page.mouse.move(box.x + box.width / 2 + 20, box.y + box.height / 2)
      await page.mouse.up()
      expect(await selection.evaluate(element => parseFloat((element as HTMLElement).style.left))).toBeGreaterThan(previous)
      const handle = page.getByRole('button', { name: 'Resize crop selection', exact: true })
      await handle.focus()
      const width = await selection.evaluate(element => parseFloat((element as HTMLElement).style.width))
      await page.keyboard.press('ArrowLeft')
      expect(await selection.evaluate(element => parseFloat((element as HTMLElement).style.width))).toBeLessThan(width)
      await page.keyboard.press('Escape')
      await page.getByRole('button', { name: 'Grid split', exact: true }).click()
      await page.getByLabel('Grid size', { exact: true }).selectOption('3')
      const grid = page.getByRole('group', { name: 'Split image into a grid', exact: true })
      await expect.poll(() => grid.locator('.vis-image-grid i').count()).toBe(2)
      await expect.poll(() => grid.locator('.vis-image-grid b').count()).toBe(2)
      await page.screenshot({ path: join(screenshots, 'grid-preview.png'), animations: 'disabled' })
      await page.keyboard.press('Escape')
      expect((await main()).content).toEqual(before.content)
    })
    it('splits into four linked image nodes in a single undo step', async () => {
      await select()
      const before = (await nodes()).length
      await page.getByRole('button', { name: 'Grid split', exact: true }).click()
      await page.getByLabel('Grid size', { exact: true }).selectOption('2')
      await page.getByRole('button', { name: 'Confirm processing', exact: true }).click()
      await expect.poll(nodes, { timeout: 10_000 }).toHaveLength(before + 4)
      const linked = (await nodes()).filter(node => node.inputs?.includes(source.nodeId))
      expect(linked).toHaveLength(4)
      expect(linked.every(node => node.kind === 'image' && node.slots.some(slot => slot.content.type === 'asset'))).toBe(true)
      await page.keyboard.press('ControlOrMeta+Z')
      await expect.poll(nodes).toHaveLength(before)
      await page.keyboard.press('ControlOrMeta+Shift+Z')
      await expect.poll(nodes).toHaveLength(before + 4)
    })
    it('renames the title through an undoable metadata edit', async () => {
      await select()
      const node = page.locator(`.react-flow__node[data-id="${source.nodeId}"]`)
      await node.getByText('Image 1', { exact: true }).dblclick()
      await node.getByRole('textbox', { name: 'Rename node', exact: true }).fill('Hero image')
      await page.keyboard.press('Enter')
      await expect.poll(async () => (await nodes()).find(node => node.nodeId === source.nodeId)?.title).toBe('Hero image')
      // The canvas ignores shortcuts typed into inputs; undo once the editor has closed, as a user would
      await expect.poll(() => node.getByRole('textbox', { name: 'Rename node', exact: true }).count()).toBe(0)
      await page.keyboard.press('ControlOrMeta+Z')
      await expect.poll(async () => (await nodes()).find(node => node.nodeId === source.nodeId)?.title ?? null).toBeNull()
      expect(pageErrors).toEqual([])
    })
  } else {
    it('shows the mock upscale entry and delivers a new node linked to the source', async () => {
      await select()
      await page.getByRole('toolbar', { name: 'Node operations' }).getByRole('button', { name: 'Upscale', exact: true }).click()
      await expect.poll(nodes, { timeout: 10_000 }).toHaveLength(2)
      const result = (await nodes()).find(node => node.nodeId !== source.nodeId)!
      expect(result.inputs).toEqual([source.nodeId])
      expect(result.slots.find(slot => slot.slotKey === 'main')?.content.type).toBe('asset')
      const jobId = result.slots.find(slot => slot.slotKey === 'main')?.source?.jobId
      expect(jobId).toBeTruthy()
      const job = await admin.call('generation.get', { jobId })
      expect(job.operation).toBe('image.upscale')
      expect(pageErrors).toEqual([])
    })
  }
})
