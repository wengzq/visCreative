import { existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright-core'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockProvider } from '../../../packages/generation/src/index'
import { promptRef, type CanvasOp, type NodeView } from '../../../packages/protocol/src/index'
import { createMemorySecretStore } from '../../../services/studiod/src/secret-store'
import { startStudiod, type Studiod } from '../../../services/studiod/src/studiod'
import { createWebHost, type WebHost } from '../src/host/server'
import { openStudiodLink, type StudiodLink } from '../src/host/studiod-link'
import { chromePath, removeTempDir } from './platform'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const screenshots = join(process.platform === 'win32' ? tmpdir() : '/tmp', 'vis-at-canvas')
const ready = existsSync(chromePath()) && existsSync(join(root, 'apps/web/dist/client/index.html'))
const documentEnd = process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End'
let dir: string
let studiod: Studiod
let host: WebHost
let admin: StudiodLink
let browser: Browser
let page: Page
let spaceId: string
let imageAsset: string
let videoAsset: string
let ids: Record<string, string>
let targetId: string
const errors: string[] = []
const apply = (ops: CanvasOp[]) => admin.call('canvas.apply', { requestId: crypto.randomUUID(), ops })
const nodes = async () => (await admin.call('canvas.get')).nodes as NodeView[]
const target = async () => (await nodes()).find(node => node.nodeId === targetId)!
const storedPrompt = async () => (await target()).slots.find(slot => slot.slotKey === 'prompt')?.content
const prompt = () => page.getByRole('textbox', { name: 'Prompt', exact: true })
const list = () => page.getByRole('listbox', { name: 'Insert reference', exact: true })
const canvas = () => list().getByRole('group', { name: 'On canvas', exact: true })
const attached = () => list().getByRole('group', { name: 'Attached references', exact: true })
async function search(query = '') {
  await prompt().fill(`Use @${query}`)
  await prompt().press(documentEnd)
  await list().waitFor()
}
async function commit() {
  await prompt().press('ControlOrMeta+Enter')
  await expect.poll(() => prompt().isEditable()).toBe(true)
}
async function screenshot(name: string) {
  mkdirSync(screenshots, { recursive: true })
  await page.screenshot({ path: join(screenshots, name), animations: 'disabled' })
}

describe.skipIf(!ready)('Pick unattached canvas media with @', () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'vis-at-canvas-'))
    vi.stubEnv('VIS_PROJECTS_DIR', join(dir, 'projects'))
    const mock = createMockProvider({ latencyMs: 0 })
    const limits = mock.referenceLimitsFor!
    // The image count fixture and video limits are catalog-only; every provider stays local.
    mock.referenceLimitsFor = (kind, model) => kind === 'image' ? { image: 2 } : limits(kind, model)
    studiod = await startStudiod({ dataDir: dir, studiodVersion: 'e2e', runtimes: {}, secretStore: createMemorySecretStore(), providers: [mock], defaults: { image: { provider: 'mock' }, video: { provider: 'mock' } } })
    spaceId = studiod.spaces.create('Canvas reference picker').spaceId
    admin = await openStudiodLink({ socketPath: studiod.socketPath, tokenPath: studiod.tokenPath })
    await admin.call('events.subscribe', { spaceId })
    await admin.call('preferences.set', { locale: 'en' })
    const space = studiod.spaces.get(spaceId)!
    imageAsset = space.assets.registerVersion(space.db, { staged: await space.assets.stageBytes(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="60"><rect width="80" height="60" fill="steelblue"/></svg>')), kind: 'image', mime: 'image/svg+xml', origin: 'import', width: 80, height: 60 }).assetVersionId
    videoAsset = space.assets.registerVersion(space.db, { staged: await space.assets.stageFile(join(root, 'packages/generation/src/providers/mock/fixtures/sample.mp4')), kind: 'video', mime: 'video/mp4', origin: 'import', width: 320, height: 180, durationMs: 1000 }).assetVersionId
    host = await createWebHost({ socketPath: studiod.socketPath, tokenPath: studiod.tokenPath, staticDir: join(root, 'apps/web/dist/client') })
    browser = await chromium.launch({ executablePath: chromePath(), headless: true })
  })
  beforeEach(async () => {
    const existing = await nodes()
    if (existing.length) await apply(existing.map(node => ({ op: 'node.delete', nodeId: node.nodeId })))
    const { idMap } = await apply([
      { op: 'node.create', tempId: 'attached', kind: 'image', title: 'Attached blue source', x: 0, y: 0, w: 180, h: 140, content: { assetVersionId: imageAsset } },
      { op: 'node.create', tempId: 'image', kind: 'image', title: 'Blue skyline', x: 0, y: 220, w: 180, h: 140, content: { assetVersionId: imageAsset } },
      { op: 'node.create', tempId: 'hidden', kind: 'image', title: 'Hidden garden', purpose: 'working', content: { assetVersionId: imageAsset } },
      { op: 'node.create', tempId: 'video', kind: 'video', title: 'Hidden camera motion', purpose: 'working', content: { assetVersionId: videoAsset } },
      { op: 'node.create', tempId: 'empty', kind: 'image', title: 'Empty image', x: 0, y: 440 },
      { op: 'node.create', tempId: 'text', kind: 'text', title: 'Text source', x: 0, y: 660, content: { text: 'Words' } },
      { op: 'node.create', tempId: 'target', kind: 'image', title: 'Image draft', x: 400, y: 0, w: 320, h: 240, prompt: 'Use ', inputNodeIds: ['attached'] },
    ])
    ids = idMap
    targetId = ids.target!
    errors.length = 0
    page = await browser.newPage({ locale: 'en', viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2, reducedMotion: 'reduce' })
    page.setDefaultTimeout(10_000)
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(host.url)
    await page.getByText('Image draft', { exact: true }).click()
    await prompt().waitFor()
  })
  afterEach(async ({ task }) => {
    try {
      if (task.result?.state === 'fail') await screenshot('failure.png')
      expect(errors).toEqual([])
    } finally { await page?.close() }
  })
  afterAll(async () => {
    await browser?.close()
    admin?.close()
    await host?.close()
    await studiod?.stop('user_quit')
    vi.unstubAllEnvs()
    if (dir) removeTempDir(dir)
  })

  it('searches both groups, attaches before inserting, preserves markers and keeps attachments after chip deletion and prompt undo', async () => {
    await search()
    expect(await attached().getByRole('option').getAttribute('aria-label')).toBe('Image 1')
    expect(await canvas().getByRole('option').evaluateAll(options => options.map(option => option.getAttribute('aria-label')))).toEqual(['Hidden garden', 'Blue skyline'])
    expect(await list().getByRole('option').count()).toBe(3)
    await screenshot('image-groups.png')
    await prompt().pressSequentially('bLuE')
    expect(await attached().getByRole('option').count()).toBe(1)
    expect(await canvas().getByRole('option').getAttribute('aria-label')).toBe('Blue skyline')
    await prompt().press('Escape')
    expect(await prompt().textContent()).toBe('Use @bLuE')
    expect((await target()).inputs).toEqual([ids.attached])
    await search('sKy')
    await canvas().getByRole('option', { name: 'Blue skyline', exact: true }).click()
    await expect.poll(() => prompt().textContent()).toBe('Use Image 2')
    expect((await target()).inputs).toEqual([ids.attached, ids.image])
    expect(await page.getByRole('button', { name: 'Insert Image 2', exact: true }).getByText('2', { exact: true }).count()).toBe(1)
    await commit()
    await expect.poll(storedPrompt).toEqual({ type: 'text', body: `Use ${promptRef(ids.image!)}` })
    await screenshot('image-chip.png')
    await prompt().press('ControlOrMeta+z')
    expect(await prompt().textContent()).toBe('Use @sKy')
    expect((await target()).inputs).toEqual([ids.attached, ids.image])
    await prompt().press('ControlOrMeta+Shift+z')
    expect(await prompt().textContent()).toBe('Use Image 2')
    await prompt().press(documentEnd)
    await prompt().press('Backspace')
    expect(await prompt().getByText('Image 2', { exact: true }).count()).toBe(0)
    await commit()
    await expect.poll(storedPrompt).toEqual({ type: 'text', body: 'Use ' })
    expect((await target()).inputs).toEqual([ids.attached, ids.image])
    await search('garden')
    const disabled = canvas().getByRole('option', { name: 'Hidden garden', exact: true })
    expect(await disabled.getAttribute('aria-disabled')).toBe('true')
    await disabled.getByText('At most 2 image references are allowed.', { exact: true }).waitFor()
    expect(await prompt().getAttribute('aria-activedescendant')).toBe(await disabled.getAttribute('id'))
    await prompt().press('Enter')
    expect(await prompt().textContent()).toBe('Use @garden')
    await screenshot('image-limit.png')
    await prompt().press('Escape')
    expect((await target()).inputs).toEqual([ids.attached, ids.image])
    await page.getByRole('button', { name: `Remove reference ${ids.image}`, exact: true }).click()
    await expect.poll(async () => (await target()).inputs).toEqual([ids.attached])
    await search('garden')
    await prompt().press('Enter')
    await expect.poll(() => prompt().textContent()).toBe('Use Image 2')
    expect((await target()).inputs).toEqual([ids.attached, ids.hidden])
  })

  it('offers hidden working video in a compatible video panel and inserts a numbered video marker', async () => {
    const { idMap } = await apply([{ op: 'node.delete', nodeId: targetId }, { op: 'node.create', tempId: 'draft', kind: 'video', title: 'Video draft', x: 400, y: 0, w: 320, h: 180, prompt: '' }])
    targetId = idMap.draft
    await page.getByText('Video draft', { exact: true }).click()
    await search('CAMERA')
    const option = canvas().getByRole('option', { name: 'Hidden camera motion', exact: true })
    expect(await option.getAttribute('aria-disabled')).toBe('false')
    await screenshot('video-choice.png')
    await prompt().press('Enter')
    await expect.poll(() => prompt().textContent()).toBe('Use Video 1')
    expect((await target()).inputs).toEqual([ids.video])
    await page.getByRole('button', { name: 'Insert Video 1', exact: true }).waitFor()
    await commit()
    await expect.poll(storedPrompt).toEqual({ type: 'text', body: `Use ${promptRef(ids.video!)}` })
    await screenshot('video-chip.png')
  })

  it('preserves typed search and inserts nothing when attaching fails, then allows a successful retry', async () => {
    let rejectAttach = true
    await page.routeWebSocket(/\/ws(?:\?|$)/, route => {
      const server = route.connectToServer()
      route.onMessage(message => {
        const request = JSON.parse(String(message))
        if (rejectAttach && request.method === 'canvas.apply' && request.params.ops.some((op: CanvasOp) => op.op === 'node.setInputs')) {
          route.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'Stale input revision', data: { code: 'revision_conflict', reason: 'canvas.revision_conflict' } } }))
        } else server.send(message)
      })
    })
    await page.reload()
    await page.getByText('Image draft', { exact: true }).click()
    await search('sky')
    await prompt().press('Enter')
    await page.getByText('This content has changed. Refresh and try again', { exact: true }).waitFor()
    expect(await prompt().textContent()).toBe('Use @sky')
    expect((await target()).inputs).toEqual([ids.attached])
    expect(await prompt().getByText('Image 2', { exact: true }).count()).toBe(0)
    await screenshot('attachment-failure.png')
    rejectAttach = false
    await canvas().getByRole('option', { name: 'Blue skyline', exact: true }).click()
    await expect.poll(() => prompt().textContent()).toBe('Use Image 2')
    expect((await target()).inputs).toEqual([ids.attached, ids.image])
  })

  it('caps canvas choices at 50 and filters the complete set before applying the cap', async () => {
    await apply(Array.from({ length: 51 }, (_, index) => ({ op: 'node.create', tempId: `extra-${index}`, kind: 'image', title: index === 0 ? 'Rare beacon' : `Pool ${index}`, purpose: 'working', content: { assetVersionId: imageAsset } })))
    await search()
    expect(await canvas().getByRole('option').count()).toBe(50)
    expect(await attached().getByRole('option').count()).toBe(1)
    expect(await canvas().getByRole('option', { name: 'Rare beacon', exact: true }).count()).toBe(0)
    await list().getByText('Type to narrow the list.', { exact: true }).waitFor()
    await screenshot('canvas-cap.png')
    await prompt().pressSequentially('BEACON')
    expect(await canvas().getByRole('option').count()).toBe(1)
    expect(await canvas().getByRole('option', { name: 'Rare beacon', exact: true }).count()).toBe(1)
    expect(await list().getByText('Type to narrow the list.', { exact: true }).count()).toBe(0)
    await prompt().press('Escape')
    expect(await prompt().textContent()).toBe('Use @BEACON')
    expect((await target()).inputs).toEqual([ids.attached])
  })

  it('gives the script prompt the same searchable attach-and-insert behavior including hidden video', async () => {
    const { idMap } = await apply([{ op: 'node.delete', nodeId: targetId }, { op: 'node.create', tempId: 'script', kind: 'script', title: 'Script draft', x: 400, y: 0, prompt: '' }])
    targetId = idMap.script
    await page.getByText('Script draft', { exact: true }).click()
    await page.getByRole('region', { name: 'Script or editing instructions', exact: true }).waitFor()
    await search('sky')
    await canvas().getByRole('option', { name: 'Blue skyline', exact: true }).click()
    await expect.poll(() => prompt().textContent()).toBe('Use Image 1')
    expect((await target()).inputs).toEqual([ids.image])
    await prompt().pressSequentially(' with @camera')
    await canvas().getByRole('option', { name: 'Hidden camera motion', exact: true }).waitFor()
    await screenshot('script-choice.png')
    await prompt().press('Enter')
    await expect.poll(() => prompt().textContent()).toBe('Use Image 1 with Video 1')
    await commit()
    await expect.poll(storedPrompt).toEqual({ type: 'text', body: `Use ${promptRef(ids.image!)} with ${promptRef(ids.video!)}` })
    expect((await target()).inputs).toEqual([ids.image, ids.video])
    await screenshot('script-chips.png')
  })
})
