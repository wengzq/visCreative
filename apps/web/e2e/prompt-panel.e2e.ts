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
const screenshots = join(process.platform === 'win32' ? tmpdir() : '/tmp', 'vis-at-refs')
const chrome = chromePath()
const documentEnd = process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End'
const ready = existsSync(chrome) && existsSync(join(root, 'apps/web/dist/client/index.html'))
let dir: string
let studiod: Studiod
let host: WebHost
let admin: StudiodLink
let browser: Browser
let page: Page
let targetId: string
let sourceId: string
let otherId: string
let projectSpaceId: string
const errors: string[] = []
const apply = (ops: CanvasOp[]) => admin.call('canvas.apply', { requestId: crypto.randomUUID(), ops })
const nodes = async () => (await admin.call('canvas.get')).nodes as NodeView[]
const prompt = () => page.getByRole('textbox', { name: 'Prompt', exact: true })
const storedPrompt = async () => (await nodes()).find(node => node.nodeId === targetId)?.slots.find(slot => slot.slotKey === 'prompt')?.content
const marker = () => prompt().getByText('Image 1', { exact: true })

describe.skipIf(!ready)('Numbered prompt references and parameters', () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'vis-prompt-e2e-'))
    vi.stubEnv('VIS_PROJECTS_DIR', join(dir, 'projects'))
    studiod = await startStudiod({
      dataDir: dir, studiodVersion: 'e2e', runtimes: {}, secretStore: createMemorySecretStore(),
      providers: [createMockProvider({ latencyMs: 0 })], defaults: { image: { provider: 'mock' } },
    })
    const { spaceId } = studiod.spaces.create('Prompt panel')
    projectSpaceId = spaceId
    admin = await openStudiodLink({ socketPath: studiod.socketPath, tokenPath: studiod.tokenPath })
    await admin.call('events.subscribe', { spaceId })
    host = await createWebHost({ socketPath: studiod.socketPath, tokenPath: studiod.tokenPath, staticDir: join(root, 'apps/web/dist/client') })
    browser = await chromium.launch({ executablePath: chrome, headless: true })
  })
  beforeEach(async () => {
    const existing = await nodes()
    if (existing.length) await apply(existing.map(node => ({ op: 'node.delete', nodeId: node.nodeId })))
    const space = studiod.spaces.get(projectSpaceId)!
    const staged = await space.assets.stageBytes(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="red"/></svg>'))
    const asset = space.assets.registerVersion(space.db, { staged, kind: 'image', mime: 'image/svg+xml', origin: 'import', width: 20, height: 20 })
    const { idMap } = await apply([
      { op: 'node.create', tempId: 'source', kind: 'image', x: 0, y: 0, w: 180, h: 160, content: { assetVersionId: asset.assetVersionId } },
      { op: 'node.create', tempId: 'other', kind: 'image', x: 0, y: 220, w: 180, h: 160, content: { assetVersionId: asset.assetVersionId } },
      { op: 'node.create', tempId: 'target', kind: 'image', x: 300, y: 0, w: 320, h: 240, prompt: 'Use ', inputNodeIds: ['source', 'other'] },
    ])
    sourceId = idMap.source
    otherId = idMap.other
    targetId = idMap.target
    errors.length = 0
    page = await browser.newPage({ locale: 'en-US', viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 })
    page.setDefaultTimeout(10_000)
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(host.url)
    await page.locator(`.react-flow__node[data-id="${targetId}"] .vis-node-label`).click()
    await prompt().waitFor()
  })
  afterEach(async ({ task }) => {
    try {
      if (task.result?.state === 'fail') await page.screenshot({ path: join(tmpdir(), 'vis-prompt-panel-failure.png'), animations: 'disabled' })
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

  it('inserts at the cursor, renumbers after reorder and blocks sending when an input is removed', async () => {
    await prompt().click()
    await prompt().press(documentEnd)
    await page.getByRole('button', { name: 'Insert Image 1', exact: true }).click()
    expect(await marker().count()).toBe(1)
    await page.screenshot({ path: join(tmpdir(), 'vis-prompt-panel-collapsed.png'), animations: 'disabled' })
    await page.getByRole('button', { name: 'Parameter summary', exact: true }).click()
    await expect.poll(storedPrompt).toEqual({ type: 'text', body: `Use ${promptRef(sourceId)}` })
    await page.getByRole('dialog', { name: 'Generation parameters', exact: true }).press('Escape')
    await apply([{ op: 'node.setInputs', nodeId: targetId, inputNodeIds: [otherId, sourceId] }])
    await expect.poll(() => prompt().textContent()).toContain('Image 2')
    const send = page.getByRole('button', { name: 'Generate', exact: true })
    await expect.poll(() => send.isEnabled()).toBe(true)
    await page.getByRole('button', { name: `Remove reference ${sourceId}`, exact: true }).click()
    await expect.poll(() => send.isDisabled()).toBe(true)
    await prompt().getByText('Missing reference', { exact: true }).waitFor()
    expect(await storedPrompt()).toEqual({ type: 'text', body: `Use ${promptRef(sourceId)}` })
  })

  it('excludes text and empty media from insertion choices and numbering and marks their existing markers broken', async () => {
    const { idMap } = await apply([
      { op: 'node.create', tempId: 'text', kind: 'text', content: { text: 'Text input' } },
      { op: 'node.create', tempId: 'empty', kind: 'image' },
      { op: 'node.setInputs', nodeId: targetId, inputNodeIds: ['text', 'empty', sourceId, otherId] },
    ])
    await expect.poll(() => page.getByRole('button', { name: 'Insert Text', exact: true }).isDisabled()).toBe(true)
    expect(await page.getByRole('button', { name: 'Insert Image', exact: true }).isDisabled()).toBe(true)
    await prompt().fill('@')
    await page.getByRole('listbox', { name: 'Insert reference', exact: true }).waitFor()
    expect(await page.getByRole('group', { name: 'Attached references', exact: true }).getByRole('option').evaluateAll(options => options.map(option => option.getAttribute('aria-label')))).toEqual(['Image 1', 'Image 2'])
    await prompt().press('Escape')
    for (const id of [idMap.text, idMap.empty]) {
      await prompt().fill(promptRef(id))
      await prompt().getByText('Missing reference', { exact: true }).waitFor()
      expect(await page.getByRole('button', { name: 'Generate', exact: true }).isDisabled()).toBe(true)
    }
  })

  it('offers references after @ and preserves insertion through undo, redo and expansion', async () => {
    await prompt().fill('Before  after')
    await prompt().press('Home')
    for (let index = 0; index < 7; index++) await prompt().press('ArrowRight')
    await prompt().press('@')
    await page.getByRole('option', { name: 'Image 1', exact: true }).click()
    expect(await prompt().textContent()).toBe('Before Image 1 after')
    await prompt().press('ControlOrMeta+z')
    expect(await prompt().textContent()).toBe('Before @ after')
    await prompt().press('ControlOrMeta+Shift+z')
    expect(await prompt().textContent()).toBe('Before Image 1 after')
    await page.getByRole('button', { name: 'Expand prompt', exact: true }).click()
    const expanded = page.getByRole('dialog', { name: 'Edit prompt', exact: true })
    await expanded.waitFor()
    expect(await expanded.getByRole('textbox', { name: 'Prompt', exact: true }).textContent()).toBe('Before Image 1 after')
    await expect.poll(() => prompt().isEditable()).toBe(true)
    await prompt().press(documentEnd)
    await prompt().press('Enter')
    await prompt().pressSequentially('Long prompt')
    await page.screenshot({ path: join(tmpdir(), 'vis-prompt-panel-expanded.png'), animations: 'disabled' })
    await page.setViewportSize({ width: 390, height: 844 })
    await expect.poll(async () => {
      const box = await expanded.boundingBox()
      return box !== null && box.x >= 0 && box.x + box.width <= 390
    }).toBe(true)
    expect(await prompt().textContent()).toBe('Before Image 1 after\nLong prompt')
    await page.screenshot({ path: join(tmpdir(), 'vis-prompt-panel-mobile.png'), animations: 'disabled' })
    await page.setViewportSize({ width: 1600, height: 1000 })
    await prompt().press('Escape')
    expect(await prompt().textContent()).toBe('Before Image 1 after\nLong prompt')
    await page.getByRole('button', { name: 'Expand prompt', exact: true }).click()
    await expanded.getByRole('button', { name: 'Collapse prompt', exact: true }).click()
    expect(await prompt().textContent()).toBe('Before Image 1 after\nLong prompt')
    await expect.poll(storedPrompt).toEqual({ type: 'text', body: `Before ${promptRef(sourceId)} after\nLong prompt` })
  })

  it.each(['image', 'video'] as const)('inserts attached image and video references in the %s prompt even when their sources are hidden', async kind => {
    const { idMap } = await apply([
      { op: 'node.delete', nodeId: targetId },
      { op: 'node.create', tempId: 'draft', kind, title: 'Reference draft', x: 300, y: 0, w: 320, h: 240, prompt: 'Use ' },
    ])
    targetId = idMap.draft
    await page.getByText('Reference draft', { exact: true }).click()
    await page.getByRole('button', { name: 'Add reference', exact: true }).click()
    await page.locator(`.react-flow__node[data-id="${sourceId}"] .vis-node-label`).click()
    await expect.poll(async () => (await nodes()).find(node => node.nodeId === targetId)?.inputs).toEqual([sourceId])
    await page.getByLabel('Upload references', { exact: true }).and(page.locator('input')).setInputFiles(join(root, 'packages/generation/src/providers/mock/fixtures/sample.mp4'))
    await expect.poll(async () => (await nodes()).find(node => node.nodeId === targetId)?.inputs?.length).toBe(2)
    const videoId = (await nodes()).find(node => node.nodeId === targetId)!.inputs![1]!
    await prompt().click()
    await prompt().press(documentEnd)
    await prompt().press('@')
    await page.getByRole('listbox', { name: 'Insert reference', exact: true }).waitFor()
    expect(await page.getByRole('group', { name: 'Attached references', exact: true }).getByRole('option').evaluateAll(options => options.map(option => option.getAttribute('aria-label')))).toEqual(['Image 1', 'Video 1'])
    await prompt().press('Escape')
    await prompt().fill('Use ')
    await page.getByRole('button', { name: 'Parameter summary', exact: true }).click()
    await page.getByRole('dialog', { name: 'Generation parameters', exact: true }).press('Escape')
    await apply([
      { op: 'node.setMeta', nodeId: sourceId, purpose: 'working' },
      { op: 'node.setMeta', nodeId: videoId, purpose: 'working' },
    ])
    await expect.poll(() => page.locator(`.react-flow__node[data-id="${sourceId}"]`).count()).toBe(0)
    await expect.poll(() => page.locator(`.react-flow__node[data-id="${videoId}"]`).count()).toBe(0)
    await expect.poll(() => page.getByRole('button', { name: 'Insert Video 1', exact: true }).isEnabled()).toBe(true)
    await prompt().click()
    await prompt().press(documentEnd)
    await prompt().press('@')
    mkdirSync(screenshots, { recursive: true })
    await page.getByRole('option', { name: 'Image 1', exact: true }).waitFor()
    await page.screenshot({ path: join(screenshots, `${kind}-choices.png`), animations: 'disabled' })
    await page.getByRole('option', { name: 'Image 1', exact: true }).click()
    expect(await marker().count()).toBe(1)
    await prompt().pressSequentially(' and @')
    await page.getByRole('option', { name: 'Video 1', exact: true }).click()
    expect(await prompt().getByText('Video 1', { exact: true }).count()).toBe(1)
    expect(await prompt().textContent()).toBe('Use Image 1 and Video 1')
    await page.getByRole('button', { name: 'Parameter summary', exact: true }).click()
    await expect.poll(storedPrompt).toEqual({ type: 'text', body: `Use ${promptRef(sourceId)} and ${promptRef(videoId)}` })
    await page.getByRole('dialog', { name: 'Generation parameters', exact: true }).press('Escape')
    await page.screenshot({ path: join(screenshots, `${kind}-chips.png`), animations: 'disabled' })
    await page.reload()
    await page.getByText('Reference draft', { exact: true }).click()
    await expect.poll(() => prompt().textContent()).toBe('Use Image 1 and Video 1')
  })

  it('updates the schema-driven summary and retains the selected value after reopening', async () => {
    const summary = page.getByRole('button', { name: 'Parameter summary', exact: true })
    await expect.poll(() => summary.innerText()).toContain('Count 1')
    await summary.click()
    const params = page.getByRole('dialog', { name: 'Generation parameters', exact: true })
    await params.getByRole('group', { name: 'Count', exact: true }).getByRole('button', { name: '3', exact: true }).click()
    await expect.poll(() => summary.innerText()).toContain('Count 3')
    await expect.poll(async () => (await nodes()).find(node => node.nodeId === targetId)?.generation?.params?.n).toBe(3)
    await params.press('Escape')
    await summary.click()
    expect(await params.getByRole('group', { name: 'Count', exact: true }).getByRole('button', { name: '3', exact: true }).getAttribute('aria-pressed')).toBe('true')
  })

  it('attaches a video before choosing a capable model and shows unsupported feedback in the panel', async () => {
    const space = studiod.spaces.get(projectSpaceId)!
    const staged = await space.assets.stageFile(join(root, 'packages/generation/src/providers/mock/fixtures/sample.mp4'))
    const asset = space.assets.registerVersion(space.db, { staged, kind: 'video', mime: 'video/mp4', origin: 'import', width: 128, height: 128, durationMs: 1000 })
    const { idMap } = await apply([{ op: 'node.create', tempId: 'clip', kind: 'video', title: 'Video picker fixture', x: 0, y: 440, w: 180, h: 160, content: { assetVersionId: asset.assetVersionId } }])
    await page.getByText('Video picker fixture', { exact: true }).waitFor()
    await page.getByRole('button', { name: 'Add reference', exact: true }).click()
    await page.getByText('Video picker fixture', { exact: true }).click()
    await expect.poll(async () => (await nodes()).find(node => node.nodeId === targetId)?.inputs).toEqual([sourceId, otherId, idMap.clip])
    await page.getByText('The selected model does not support video references. Remove the video or choose a model that does.', { exact: true }).waitFor()
    expect(await page.getByRole('button', { name: 'Generate', exact: true }).isDisabled()).toBe(true)
    await page.getByRole('button', { name: `Remove reference ${idMap.clip}`, exact: true }).click()
    await expect.poll(() => page.getByRole('button', { name: 'Generate', exact: true }).isEnabled()).toBe(true)
  })

  it('preserves composition, plain-text paste and multiline marker round trips', async () => {
    await prompt().fill('Start ')
    await prompt().press(documentEnd)
    const composed = '\u7b2c\u4e00\u955c'
    const ime = await page.context().newCDPSession(page)
    await ime.send('Input.imeSetComposition', { text: composed, selectionStart: composed.length, selectionEnd: composed.length })
    expect(await page.getByRole('button', { name: 'Generate', exact: true }).isDisabled()).toBe(true)
    await prompt().evaluate(editor => editor.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', ctrlKey: true, isComposing: true })))
    expect(await prompt().textContent()).toBe(`Start ${composed}`)
    expect(await storedPrompt()).toEqual({ type: 'text', body: 'Use ' })
    await ime.send('Input.insertText', { text: composed })
    await ime.detach()
    await prompt().press('ControlOrMeta+z')
    expect(await prompt().textContent()).toBe('Start ')
    await prompt().press('ControlOrMeta+Shift+z')
    expect(await prompt().textContent()).toBe(`Start ${composed}`)
    const pasted = `\n<b>literal</b>\n${promptRef(sourceId)}\n\n`
    await prompt().evaluate((editor, text) => {
      const clipboard = new DataTransfer()
      clipboard.setData('text/plain', text)
      clipboard.setData('text/html', '<img src="bad" onerror="window.promptPasteExecuted = true">')
      editor.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: clipboard }))
    }, pasted)
    expect(await marker().count()).toBe(1)
    expect(await prompt().locator('b').count()).toBe(0)
    expect(await prompt().locator('img').count()).toBe(1)
    expect(await prompt().locator('img').getAttribute('src')).toContain('/assets/')
    await page.getByRole('button', { name: 'Parameter summary', exact: true }).click()
    await expect.poll(storedPrompt).toEqual({ type: 'text', body: `Start ${composed}${pasted}` })
    await page.getByRole('dialog', { name: 'Generation parameters', exact: true }).press('Escape')
    await expect.poll(() => prompt().isEditable()).toBe(true)
    await prompt().focus()
    await prompt().press('ControlOrMeta+a')
    const copied = await prompt().evaluate(editor => {
      const clipboard = new DataTransfer()
      editor.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: clipboard }))
      return clipboard.getData('text/plain')
    })
    expect(copied).toBe(`Start ${composed}${pasted}`)
    await prompt().fill('')
    expect(await page.getByRole('button', { name: 'Generate', exact: true }).isDisabled()).toBe(true)
    await page.getByRole('button', { name: 'Parameter summary', exact: true }).click()
    await expect.poll(storedPrompt).toEqual({ type: 'text', body: '' })
  })
})
