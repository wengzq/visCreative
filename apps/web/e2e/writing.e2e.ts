import { existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { CanvasOp, NodeView } from '@vis/protocol'
import { createMockProvider } from '../../../packages/generation/src/index'
import { createMemorySecretStore } from '../../../services/studiod/src/secret-store'
import { startStudiod, type Studiod } from '../../../services/studiod/src/studiod'
import { writingStyles, writingXml, writingZip } from '../../../services/studiod/src/fixtures/writing'
import { createWebHost, type WebHost } from '../src/host/server'
import { openStudiodLink, type StudiodLink } from '../src/host/studiod-link'
import { chromePath, removeTempDir } from './platform'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const ready = existsSync(chromePath()) && existsSync(join(root, 'apps/web/dist/client/index.html'))
const shots = '/tmp/vis-0031'
const round2 = '/tmp/vis-round2'
let dir: string
let daemon: Studiod
let host: WebHost
let admin: StudiodLink
let browser: Browser
let page: Page
let manuscriptId: string
const errors: string[] = []
const body = '# 第一章 雾中的来信\n\n**一封来信**与*未知的旅程*。\n\n' + '清晨的雾沿着河岸缓缓升起。林舟推开旧书店的木门，发现柜台上放着一封没有署名的信。\n\n'.repeat(38) + '# 第二章 归途\n\n' + '他沿着记忆中的小路走向远方。\n\n'.repeat(25)
const nodes = async (): Promise<NodeView[]> => (await admin.call('canvas.get', {})).nodes
const apply = (ops: CanvasOp[]) => admin.call('canvas.apply', { requestId: crypto.randomUUID(), ops })
const manuscript = async () => (await nodes()).find(node => node.nodeId === manuscriptId)!
const main = async () => (await manuscript()).slots.find(slot => slot.slotKey === 'main')!
const text = async () => { const content = (await main()).content; return content.type === 'text' ? content.body : '' }
const editor = () => page.getByRole('dialog', { name: 'Writing page', exact: true })
const input = () => editor().getByRole('textbox', { name: 'Manuscript', exact: true })
const preview = () => page.getByRole('dialog', { name: 'Import preview', exact: true })
const open = async () => { await page.getByRole('button', { name: 'Fit canvas', exact: true }).click(); await page.getByRole('button', { name: 'Open writing page', exact: true }).first().click(); await input().waitFor() }
async function choose(name: string, buffer: Buffer) {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), preview().getByRole('button', { name: 'Choose file', exact: true }).click()])
  await chooser.setFiles({ name, mimeType: 'application/octet-stream', buffer })
  await preview().getByRole('button', { name: 'Insert manuscript', exact: true }).waitFor()
  await expect.poll(() => preview().getByRole('button', { name: 'Insert manuscript', exact: true }).isEnabled()).toBe(true)
}

describe.skipIf(!ready)('Manuscript writing and import', () => {
  beforeAll(async () => {
    mkdirSync(shots, { recursive: true })
    mkdirSync(round2, { recursive: true })
    dir = mkdtempSync(join(tmpdir(), 'vis-writing-e2e-'))
    vi.stubEnv('VIS_PROJECTS_DIR', join(dir, 'projects'))
    daemon = await startStudiod({ dataDir: dir, studiodVersion: 'writing-e2e', runtimes: {}, secretStore: createMemorySecretStore(), providers: [createMockProvider({ latencyMs: 0 })], defaults: { image: { provider: 'mock' } } })
    const spaceId = daemon.spaces.create('Manuscript acceptance').spaceId
    admin = await openStudiodLink({ socketPath: daemon.socketPath, tokenPath: daemon.tokenPath })
    await admin.call('events.subscribe', { spaceId })
    manuscriptId = (await apply([{ op: 'node.create', tempId: 'manuscript', kind: 'text', title: '雾中的来信', format: 'markdown', content: { text: body } }])).idMap.manuscript!
    host = await createWebHost({ socketPath: daemon.socketPath, tokenPath: daemon.tokenPath, staticDir: join(root, 'apps/web/dist/client') })
    browser = await chromium.launch({ executablePath: chromePath(), headless: true })
    page = await browser.newPage({ locale: 'en-US', viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 })
    page.setDefaultTimeout(8000)
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(host.url, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: 'Open writing page', exact: true }).waitFor()
  })
  afterAll(async () => {
    await browser?.close(); admin?.close(); await host?.close(); await daemon?.stop('user_quit')
    vi.unstubAllEnvs(); if (dir) removeTempDir(dir)
  })
  it('opens long cards on double click, centres the column and jumps to chapter positions', async () => {
    const cardBody = page.locator('.vis-node-text-body').first()
    expect((await cardBody.innerText()).length).toBeLessThan(2400)
    await cardBody.getByRole('heading', { name: '第一章 雾中的来信', exact: true }).waitFor()
    expect(await cardBody.locator('strong').innerText()).toBe('一封来信')
    const bar = (await page.locator('.vis-writing-card-bar').first().boundingBox())!
    const card = (await cardBody.boundingBox())!
    expect(card.y).toBeGreaterThanOrEqual(bar.y + bar.height - 1)
    expect(card.width).toBeGreaterThan(400)
    expect((await manuscript()).w).toBe(560)
    expect((await manuscript()).h).toBeGreaterThanOrEqual(420)
    await page.screenshot({ path: join(round2, 'long-markdown-card.png'), animations: 'disabled' })
    await cardBody.dblclick()
    await input().waitFor()
    expect(await input().getByText('# 第一章 雾中的来信', { exact: true }).evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThan(18)
    expect(await input().getByText('一封来信', { exact: true }).evaluate(element => Number(getComputedStyle(element).fontWeight))).toBeGreaterThanOrEqual(600)
    expect(await input().getByText('未知的旅程', { exact: true }).evaluate(element => getComputedStyle(element).fontStyle)).toBe('italic')
    await page.screenshot({ path: join(round2, 'writing-page.png'), animations: 'disabled' })
    const layout = await page.locator('.vis-writing-codemirror .cm-content').boundingBox()
    const mainBox = (await editor().getByRole('main').boundingBox())!
    expect(layout!.width).toBeLessThanOrEqual(790)
    expect(Math.abs(layout!.x + layout!.width / 2 - (mainBox.x + mainBox.width / 2))).toBeLessThan(3)
    await page.screenshot({ path: join(shots, 'writing-chinese.png'), animations: 'disabled' })
    await editor().getByRole('navigation', { name: 'Chapter outline' }).getByRole('button', { name: '第二章 归途', exact: true }).click()
    await expect.poll(() => page.locator('.cm-scroller').evaluate(element => element.scrollTop)).toBeGreaterThan(500)
    await expect.poll(() => editor().getByRole('button', { name: '第二章 归途', exact: true }).getAttribute('aria-current')).toBe('location')
    const line = input().getByText('# 第二章 归途', { exact: true })
    await expect.poll(async () => { const box = await line.boundingBox(); return box ? Math.abs(box.y - mainBox.y - 28) : 1000 }).toBeLessThan(45)
  })
  it('types, autosaves with revisions, reloads and restores history', async () => {
    await input().click()
    await page.keyboard.press('ControlOrMeta+End')
    await page.keyboard.press('Enter')
    await page.keyboard.insertText('A saved ending.')
    await expect.poll(text, { timeout: 12_000 }).toBe(body + '\nA saved ending.')
    await editor().getByRole('button', { name: 'Close writing page', exact: true }).click()
    await page.reload({ waitUntil: 'domcontentloaded' })
    await open()
    await editor().getByRole('button', { name: 'Version history', exact: true }).click()
    const history = editor().getByRole('complementary', { name: 'Version history' })
    await history.getByRole('button', { name: /^Version 1 / }).click()
    expect(await history.locator('pre').innerText()).toBe(body)
    await history.getByRole('button', { name: 'Restore this version', exact: true }).click()
    await expect.poll(text).toBe(body)
    await history.getByRole('button', { name: 'Cancel', exact: true }).click()
  })
  it('preserves local text, pauses autosave on a remote edit and loads the newer revision', async () => {
    await input().click(); await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.press('Enter'); await page.keyboard.insertText('My unsaved draft')
    const slot = await main()
    await apply([{ op: 'slot.setText', slotId: slot.slotId, expectedRevision: slot.revision, body: '# Updated chapter\nA remote edit' }])
    await editor().getByRole('alert').waitFor()
    expect(await input().innerText()).toContain('My unsaved draft')
    expect(await input().getAttribute('contenteditable')).toBe('false')
    await new Promise(resolve => setTimeout(resolve, 5500))
    expect(await text()).toBe('# Updated chapter\nA remote edit')
    await editor().getByRole('button', { name: 'Load their version', exact: true }).click()
    await expect.poll(() => input().innerText()).toBe('# Updated chapter\nA remote edit')
    expect(await input().getAttribute('contenteditable')).toBe('true')
  })
  it.each([
    ['book.txt', Buffer.from([0xb5, 0xda, 0xd2, 0xbb, 0xd5, 0xc2]), '# 第一章'],
    ['book.md', Buffer.from('# Imported chapter\n\nEnglish prose'), '# Imported chapter\n\nEnglish prose'],
    ['book.docx', writingZip([{ path: 'word/document.xml', body: writingXml('<w:p><w:pPr><w:pStyle w:val="1"/></w:pPr><w:r><w:t>第一章 清晨</w:t></w:r></w:p><w:p><w:r><w:t>林舟收到了一封信。</w:t></w:r></w:p>') }, { path: 'word/styles.xml', body: writingStyles('<w:style w:type="paragraph" w:styleId="1"><w:name w:val="heading 1"/></w:style>') }]), '# 第一章 清晨\n\n林舟收到了一封信。'],
  ])('previews %s before inserting the full document at the cursor', async (name, buffer, imported) => {
    const before = await text()
    await input().click(); await page.keyboard.press('ControlOrMeta+Home')
    await editor().getByRole('button', { name: 'Import manuscript', exact: true }).click()
    await choose(name, buffer)
    expect(await text()).toBe(before)
    expect(await preview().getByRole('navigation', { name: 'Chapter outline' }).innerText()).toContain(imported.split('\n')[0]!.slice(2))
    if (name.endsWith('.docx')) await page.screenshot({ path: join(shots, 'import-preview.png'), animations: 'disabled' })
    await preview().getByRole('button', { name: 'Insert manuscript', exact: true }).click()
    await editor().getByRole('button', { name: 'Close writing page', exact: true }).click()
    await expect.poll(text).toBe(`${imported}\n\n${before}`)
    await open()
  })
  it('keeps the import preview open and blocks insertion after an intervening remote edit', async () => {
    await editor().getByRole('button', { name: 'Import manuscript', exact: true }).click()
    await choose('pending.md', Buffer.from('# Pending import\nNew prose'))
    const slot = await main()
    await apply([{ op: 'slot.setText', slotId: slot.slotId, expectedRevision: slot.revision, body: '# Remote chapter\nIntervening edit' }])
    await expect.poll(() => preview().getByRole('button', { name: 'Insert manuscript', exact: true }).isEnabled()).toBe(false)
    expect(await preview().getByRole('alert').innerText()).toContain('autosave is paused')
    expect(await text()).toBe('# Remote chapter\nIntervening edit')
    await preview().getByRole('button', { name: 'Cancel', exact: true }).last().click()
    await editor().getByRole('button', { name: 'Load their version', exact: true }).click()
    await expect.poll(() => input().innerText()).toBe('# Remote chapter\nIntervening edit')
  })
  it('creates a text node only after canvas import confirmation and leaves short notes inline', async () => {
    await editor().getByRole('button', { name: 'Close writing page', exact: true }).click()
    const before = (await nodes()).length
    await page.getByRole('button', { name: 'Import manuscript', exact: true }).click()
    await choose('new.txt', Buffer.from('第一章 远行\n新的故事'))
    expect((await nodes()).length).toBe(before)
    await preview().getByRole('button', { name: 'Insert manuscript', exact: true }).click()
    await input().waitFor()
    await expect.poll(async () => (await nodes()).length).toBe(before + 1)
    const imported = (await nodes()).find(node => node.title === 'new')!
    expect(imported.format).toBe('markdown')
    expect(imported).toMatchObject({ w: 560, h: 420 })
    expect(imported.slots[0]!.content).toEqual({ type: 'text', body: '# 第一章 远行\n新的故事' })
    await editor().getByRole('button', { name: 'Close writing page', exact: true }).click()
    await page.getByRole('button', { name: 'Fit canvas', exact: true }).click()
    await page.locator('.vis-node-text-body').filter({ hasText: '新的故事' }).dblclick()
    await page.getByRole('textbox', { name: 'Text content', exact: true }).waitFor()
    expect(await editor().count()).toBe(0)
    await page.keyboard.press('Escape')
    await apply([{ op: 'node.create', tempId: 'code', kind: 'text', format: 'code', content: { text: 'console.log(1)' }, x: 900, y: 0 }])
    await page.getByRole('button', { name: 'Fit canvas', exact: true }).click()
    const code = page.locator('.react-flow__node').filter({ hasText: 'console.log(1)' })
    expect(await code.getByRole('button', { name: 'Open writing page', exact: true }).count()).toBe(0)
    expect(errors).toEqual([])
  })
  it('renders editable literal tables near the viewport of a 200,000-character manuscript', async () => {
    const tableBody = '# Table chapter\n\n| Name | Value |\n| --- | --- |\n| Item | <b>literal</b> |\n\nAfter the table.\n\n' + 'A long paragraph for viewport testing.\n\n'.repeat(5200)
    const result = await apply([{ op: 'node.create', tempId: 'table', kind: 'text', title: 'Editable table', format: 'markdown', content: { text: tableBody } }])
    const id = result.idMap.table!
    await page.getByRole('button', { name: 'Fit canvas', exact: true }).click()
    const card = page.locator('.react-flow__node').filter({ hasText: 'Editable table' })
    await card.getByRole('button', { name: 'Open writing page', exact: true }).click()
    const table = editor().getByRole('table', { name: 'Table (click to edit)', exact: true })
    await table.waitFor()
    expect(await table.getByRole('row').count()).toBe(2)
    expect(await table.getByRole('cell', { name: '<b>literal</b>', exact: true }).count()).toBe(1)
    expect(await table.locator('b').count()).toBe(0)
    await table.getByRole('columnheader', { name: 'Value', exact: true }).click()
    await table.waitFor({ state: 'hidden' })
    await page.keyboard.insertText('Edited ')
    await page.keyboard.press('ControlOrMeta+Home')
    await table.getByRole('columnheader', { name: 'Edited Value', exact: true }).waitFor()
    const content = async () => { const node = (await nodes()).find(node => node.nodeId === id)!; return node.slots[0]!.content }
    await expect.poll(content, { timeout: 12_000 }).toEqual({ type: 'text', body: tableBody.replace('| Name | Value |', '| Name | Edited Value |') })
    await page.keyboard.press('ControlOrMeta+End')
    await expect.poll(() => table.count()).toBe(0)
    expect(await input().locator('.cm-line').count()).toBeLessThan(150)
    await page.keyboard.press('ControlOrMeta+Home')
    await table.getByRole('columnheader', { name: 'Edited Value', exact: true }).waitFor()
    expect(errors).toEqual([])
    await editor().getByRole('button', { name: 'Close writing page', exact: true }).click()
  })

})
