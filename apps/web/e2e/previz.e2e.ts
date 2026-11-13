import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Locator, type Page } from 'playwright-core'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CanvasOp, NodeView, PrevizDoc, SessionSummary } from '@vis/protocol'
import { spaceSchema as s } from '../../../packages/storage/src/index'
import { createMockProvider } from '../../../packages/generation/src/index'
import { codexRuntime } from '../../../services/studiod/src/codex'
import { createMemorySecretStore } from '../../../services/studiod/src/secret-store'
import { startStudiod, type Studiod } from '../../../services/studiod/src/studiod'
import { studiodEndpoint } from '../../../runtime/studiod-endpoint'
import { createWebHost, type WebHost } from '../src/host/server'
import { openStudiodLink, type StudiodLink } from '../src/host/studiod-link'
import { chromePath, removeTempDir } from './platform'

const screenshots = join(process.platform === 'win32' ? tmpdir() : '/tmp', 'vis-previz')
const root = fileURLToPath(new URL('../../../', import.meta.url))
const cli = join(root, 'apps/cli/dist/vis.mjs')
const ready = existsSync(chromePath()) && existsSync(cli) && existsSync(join(root, 'apps/web/dist/client/index.html'))
let dir: string
let daemon: Studiod
let host: WebHost
let admin: StudiodLink
let browser: Browser
let page: Page
let nodeId: string
let spaceId: string
let sessionId: string
let fileA: string
let fileB: string
let canvasImageId: string
const errors: string[] = []
const uploads: string[] = []
const nodes = async (): Promise<NodeView[]> => (await admin.call('canvas.get', {})).nodes
const node = async () => (await nodes()).find(node => node.nodeId === nodeId)!
const doc = async (): Promise<PrevizDoc> => {
  const content = (await node()).slots.find(slot => slot.slotKey === 'main')!.content
  if (content.type !== 'previz') throw new Error('Expected a previz document')
  return content.doc
}
const apply = (ops: CanvasOp[]) => admin.call('canvas.apply', { requestId: crypto.randomUUID(), ops })
const editor = () => page.getByRole('dialog', { name: 'Shot previz', exact: true })
const card = () => page.getByRole('region', { name: /^Shot previz Shot previz,/ })
async function saved() {
  await expect.poll(() => editor().getByRole('status').allTextContents(), { timeout: 10_000, intervals: [100] }).toContain('Saved')
}
async function open() {
  await page.getByRole('button', { name: 'Fit canvas', exact: true }).click()
  await card().getByRole('button', { name: 'Open shot previz' }).click()
  await editor().waitFor()
}
async function draw(surface: Locator, y = 0.4) {
  await expect.poll(() => surface.getAttribute('aria-disabled')).toBe('false')
  const box = (await surface.boundingBox())!
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * y)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * y, { steps: 12 })
  await page.mouse.up()
  await saved()
}
async function scenario(text: string) {
  await admin.call('session.sendMessage', { requestId: crypto.randomUUID(), sessionId, text, refs: [] })
  await expect.poll(async () => JSON.stringify((await admin.call('session.getTranscript', { sessionId })).items), { timeout: 15_000 }).toContain(`Completed ${text}`)
  await expect.poll(async () => ((await admin.call('session.list')).sessions as SessionSummary[]).find(session => session.sessionId === sessionId)?.activeTurnId).toBeNull()
}
async function drop(files: { name: string; bytes: string }[], target: Locator, paste = false) {
  await target.evaluate((element, value) => {
    const data = new DataTransfer()
    for (const file of value.files) data.items.add(new File([Uint8Array.from(atob(file.bytes), char => char.charCodeAt(0))], file.name, { type: 'image/png' }))
    element.dispatchEvent(value.paste ? new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }) : new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }))
  }, { files, paste })
  await saved()
}

describe.skipIf(!ready)('Shot previz editor acceptance', () => {
  beforeAll(async () => {
    mkdirSync(screenshots, { recursive: true })
    dir = mkdtempSync(join(tmpdir(), 'vis-previz-e2e-'))
    vi.stubEnv('VIS_PROJECTS_DIR', join(dir, 'projects'))
    daemon = await startStudiod({
      dataDir: dir, studiodVersion: 'previz-e2e', secretStore: createMemorySecretStore(),
      providers: [createMockProvider({ latencyMs: 0 })], defaults: { image: { provider: 'mock' } },
      runtimes: { codex: codexRuntime({ dataDir: dir, socketPath: studiodEndpoint(dir), codexPath: join(root, 'apps/web/e2e/fake-codex.mjs'), visMcp: { command: process.execPath, args: [cli, 'mcp'] } }) },
    })
    spaceId = daemon.spaces.create('Previz acceptance').spaceId
    admin = await openStudiodLink({ socketPath: daemon.socketPath, tokenPath: daemon.tokenPath })
    await admin.call('events.subscribe', { spaceId })
    sessionId = (await admin.call('session.create', { requestId: crypto.randomUUID(), agentKind: 'codex' })).sessionId
    fileA = join(dir, 'A.png'); fileB = join(dir, 'B.png')
    for (const [file, colour] of [[fileA, 'red'], [fileB, 'blue']]) execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=c=${colour}:size=160x90`, '-frames:v', '1', '-y', file!], { shell: false })
    const imported = await admin.call('asset.import', { requestId: crypto.randomUUID(), path: fileA })
    canvasImageId = (await apply([{ op: 'node.create', tempId: 'source', kind: 'image', title: 'Canvas picture', content: { assetVersionId: imported.assetVersionId } }])).idMap.source!
    host = await createWebHost({ socketPath: daemon.socketPath, tokenPath: daemon.tokenPath, staticDir: join(root, 'apps/web/dist/client') })
    browser = await chromium.launch({ executablePath: chromePath(), headless: true })
    page = await browser.newPage({ locale: 'en-US', viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 })
    page.setDefaultTimeout(5000)
    page.on('pageerror', error => errors.push(error.message))
    page.on('request', request => { if (new URL(request.url()).pathname === '/upload') uploads.push(request.url()) })
    await page.goto(host.url, { waitUntil: 'domcontentloaded', timeout: 15_000 })
    await page.getByRole('button', { name: 'Shot previz', exact: true }).waitFor()
  })
  beforeEach(async () => {
    if (nodeId && !await editor().count()) await open()
  })
  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail' && page) {
      await page.screenshot({ path: join(screenshots, 'failure.png'), animations: 'disabled' })
      await page.reload({ waitUntil: 'domcontentloaded' })
    }
  })
  afterAll(async () => {
    await browser?.close(); admin?.close(); await host?.close(); await daemon?.stop('user_quit')
    vi.unstubAllEnvs(); if (dir) removeTempDir(dir)
  })

  it('creates a card, draws with pointer events and erases with session undo', async () => {
    await page.getByRole('button', { name: 'Shot previz', exact: true }).click()
    await expect.poll(async () => (await nodes()).filter(node => node.kind === 'previz').length).toBe(1)
    nodeId = (await nodes()).find(node => node.kind === 'previz')!.nodeId
    await open()
    await editor().getByRole('button', { name: 'Add panel', exact: true }).click()
    const surface = editor().getByRole('img', { name: 'Panel drawing', exact: true })
    await draw(surface)
    const firstImage = (await doc()).panels[0]!.image
    expect((await doc()).panels[0]).toMatchObject({ underlay: null, sketch: expect.any(String), image: expect.any(String), use: 'composition' })
    await editor().getByRole('button', { name: 'Eraser', exact: true }).click()
    await editor().getByRole('slider', { name: 'Brush size' }).fill('40')
    await draw(surface)
    expect((await doc()).panels[0]!.image).not.toBe(firstImage)
    await editor().getByRole('button', { name: 'Undo', exact: true }).click()
    await saved()
    expect((await doc()).panels[0]!.image).toBe(firstImage)
    await editor().getByRole('textbox', { name: 'Panel note' }).fill('Camera moves left')
    await editor().getByRole('spinbutton', { name: 'Duration (seconds)' }).fill('2.5')
    await editor().getByRole('combobox', { name: 'Aspect ratio' }).selectOption('4:3')
    await saved()
    expect(await doc()).toMatchObject({ aspectRatio: '4:3', panels: [{ note: 'Camera moves left', durationSec: 2.5 }] })
    expect(uploads.length).toBeGreaterThanOrEqual(2)
    expect(uploads.every(url => /requestId=previz-[a-f0-9]{64}/.test(url))).toBe(true)
    mkdirSync(screenshots, { recursive: true })
    await page.screenshot({ path: join(screenshots, 'editor.png'), animations: 'disabled' })
  })

  it('keeps every stroke of quick sketching, on screen and in the saved sketch', async () => {
    await editor().getByRole('button', { name: 'Add panel', exact: true }).click()
    await editor().getByRole('button', { name: 'Pen', exact: true }).click()
    await editor().getByRole('slider', { name: 'Brush size' }).fill('6')
    const surface = editor().getByRole('img', { name: 'Panel drawing', exact: true })
    await expect.poll(() => surface.getAttribute('aria-disabled')).toBe('false')
    const box = (await surface.boundingBox())!
    const rows = [.15, .3, .45, .6, .75, .9]
    // No wait between strokes: a person sketching does not pause for the save.
    for (const row of rows) {
      await page.mouse.move(box.x + box.width * .2, box.y + box.height * row)
      await page.mouse.down()
      await page.mouse.move(box.x + box.width * .7, box.y + box.height * row, { steps: 3 })
      await page.mouse.up()
    }
    const inked = () => surface.evaluate((element, rows) => {
      const canvas = element as HTMLCanvasElement
      const context = canvas.getContext('2d')!
      return rows.map(row => context.getImageData(Math.round(canvas.width * .45), Math.round(canvas.height * row), 1, 1).data[3]! > 0)
    }, rows)
    await saved()
    await expect.poll(() => surface.getAttribute('aria-disabled')).toBe('false')
    expect(await inked()).toEqual(rows.map(() => true))
    // Reloading from the saved picture proves the last save holds every stroke, in order.
    await editor().getByRole('button', { name: 'Panel 1', exact: true }).click()
    await editor().getByRole('button', { name: 'Panel 2', exact: true }).click()
    await expect.poll(inked).toEqual(rows.map(() => true))
    await editor().getByRole('button', { name: 'Delete panel', exact: true }).nth(1).click()
    await saved()
  })

  it('imports through the picker, sorted multi-file drop and paste, fills from canvas, reorders and persists after reload', async () => {
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), editor().getByRole('button', { name: 'Import images', exact: true }).click()])
    await chooser.setFiles(fileA)
    await expect.poll(async () => (await doc()).panels[0]!.underlay, { timeout: 10_000 }).not.toBeNull()
    const data = (path: string, name: string) => ({ name, bytes: readFileSync(path).toString('base64') })
    await drop([data(fileB, 'Z.png'), data(fileA, 'A.png')], editor().getByRole('main'))
    await expect.poll(async () => (await doc()).panels.length).toBe(3)
    await saved()
    const imported = await doc()
    expect(imported.panels[1]!.underlay).toBe(imported.panels[0]!.underlay)
    expect(imported.panels[1]).toMatchObject({ use: 'frame', frameRole: 'first', sketch: null })
    const third = imported.panels[2]!.id
    await editor().getByRole('button', { name: 'Panel 3', exact: true }).click()
    await drop([data(fileA, 'pasted.png')], editor().getByRole('img', { name: 'Panel drawing' }), true)
    await expect.poll(async () => (await doc()).panels[2]!.underlay).toBe(imported.panels[0]!.underlay)
    await editor().getByRole('combobox', { name: 'Choose canvas image' }).selectOption(canvasImageId)
    const source = (await nodes()).find(node => node.nodeId === canvasImageId)!.slots[0]!.content
    await expect.poll(async () => (await doc()).panels[2]!.underlay).toBe(source.type === 'asset' ? source.assetVersionId : '')
    await editor().getByRole('button', { name: 'Move panel earlier', exact: true }).nth(2).click()
    await saved()
    expect((await doc()).panels[1]!.id).toBe(third)
    const persisted = await doc()
    await editor().getByRole('button', { name: 'Close editor', exact: true }).click()
    await expect.poll(() => card().getByRole('img', { name: 'Panel 1', exact: true }).evaluate(element => ({ loaded: (element as HTMLImageElement).naturalWidth > 0, cached: (element as HTMLImageElement).src.includes('/previews/') })), { timeout: 10_000 }).toEqual({ loaded: true, cached: true })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: 'Shot previz', exact: true }).waitFor()
    await open()
    expect(await doc()).toEqual(persisted)
    expect(await editor().getByRole('textbox', { name: 'Panel note' }).inputValue()).toBe('Camera moves left')
    await expect.poll(() => editor().getByRole('img', { name: 'Panel drawing' }).evaluate(element => {
      const context = (element as HTMLCanvasElement).getContext('2d')!
      return context.getImageData(0, 0, (element as HTMLCanvasElement).width, (element as HTMLCanvasElement).height).data.some((value, index) => index % 4 === 3 && value > 0)
    })).toBe(true)
    const before = (await doc()).panels.length
    await editor().getByRole('button', { name: 'Add panel', exact: true }).click()
    await editor().getByRole('button', { name: 'Delete panel', exact: true }).last().click()
    await saved()
    expect((await doc()).panels.length).toBe(before)
  })

  it('keeps the full-screen editor limited to free previz work', async () => {
    expect(await editor().getByRole('button', { name: 'Model and parameters', exact: true }).count()).toBe(0)
    expect(await editor().getByRole('textbox', { name: 'Image generation prompt', exact: true }).count()).toBe(0)
    expect(await editor().getByRole('button', { name: /Generate/ }).count()).toBe(0)
    expect(await editor().getByRole('region', { name: 'Generation', exact: true }).count()).toBe(0)
    expect(await editor().getByRole('button', { name: 'Pen', exact: true }).isEnabled()).toBe(true)
    expect(await editor().getByRole('textbox', { name: 'Panel note', exact: true }).isEnabled()).toBe(true)
    expect(await editor().getByRole('spinbutton', { name: 'Duration (seconds)', exact: true }).isEnabled()).toBe(true)
    expect(await editor().getByRole('button', { name: 'Import images', exact: true }).isEnabled()).toBe(true)
  })

  it('offers panel actions on right click and shows order and notes on the canvas card', async () => {
    const menu = editor().getByRole('menu', { name: 'Panel actions', exact: true })
    const before = (await doc()).panels
    await editor().getByRole('button', { name: 'Panel 1', exact: true }).click({ button: 'right' })
    await menu.waitFor()
    await page.keyboard.press('Escape')
    await menu.waitFor({ state: 'detached' })
    expect(await editor().count()).toBe(1)

    await editor().getByRole('button', { name: 'Panel 1', exact: true }).click({ button: 'right' })
    await menu.getByRole('menuitem', { name: 'Duplicate panel', exact: true }).click()
    await expect.poll(async () => (await doc()).panels.length).toBe(before.length + 1)
    const copied = (await doc()).panels
    expect(copied[1]).toMatchObject({ image: before[0]!.image, note: before[0]!.note })
    expect(copied[1]!.id).not.toBe(before[0]!.id)

    await editor().getByRole('button', { name: 'Panel 2', exact: true }).click({ button: 'right' })
    await menu.getByRole('menuitem', { name: 'Insert panel before', exact: true }).click()
    await expect.poll(async () => (await doc()).panels.length).toBe(before.length + 2)
    expect((await doc()).panels[1]!.image).toBeNull()

    // The selected blank panel is on the stage, so its menu is available there as well.
    await editor().getByRole('img', { name: 'Panel drawing', exact: true }).click({ button: 'right' })
    await menu.getByRole('menuitem', { name: 'Delete panel', exact: true }).click()
    await expect.poll(async () => (await doc()).panels.length).toBe(before.length + 1)

    await editor().getByRole('button', { name: 'Panel 1', exact: true }).click()
    await editor().getByRole('textbox', { name: 'Panel note', exact: true }).fill('Slow push in on the door')
    await editor().getByRole('button', { name: 'Close editor', exact: true }).click()
    await editor().waitFor({ state: 'detached' })
    const card = page.getByRole('region', { name: /^Shot previz/ })
    expect(await card.locator('.vis-previz-number').first().textContent()).toBe('1')
    expect(await card.getByText('Slow push in on the door', { exact: true }).count()).toBe(1)
  })
  it('refuses an agent picture write and shows a conflict banner for a later agent note edit', async () => {
    const before = await doc()
    await scenario('previz-refuse')
    expect(await doc()).toEqual(before)
    await editor().getByRole('textbox', { name: 'Panel note' }).fill('My local camera note')
    await saved()
    await scenario('previz-edit')
    await expect.poll(() => editor().getByRole('alert').allTextContents()).toContainEqual(expect.stringContaining('This previz was changed'))
    expect(await editor().getByRole('textbox', { name: 'Panel note' }).inputValue()).toBe('My local camera note')
    await editor().getByRole('button', { name: 'Show differences', exact: true }).click()
    await editor().getByRole('region', { name: 'Show differences' }).waitFor()
    await editor().getByRole('button', { name: 'Load their version', exact: true }).click()
    await expect.poll(() => editor().getByRole('textbox', { name: 'Panel note' }).inputValue()).toBe('Agent camera note')
    expect(errors).toEqual([])
  })
})
