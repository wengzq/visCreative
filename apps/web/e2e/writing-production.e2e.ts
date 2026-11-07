import { existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright-core'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { writingChapters, type CanvasOp, type NodeView, type ScriptDoc } from '@vis/protocol'
import { createMockProvider } from '../../../packages/generation/src/index'
import { codexRuntime } from '../../../services/studiod/src/codex'
import { createMemorySecretStore } from '../../../services/studiod/src/secret-store'
import { startStudiod, type Studiod } from '../../../services/studiod/src/studiod'
import { studiodEndpoint } from '../../../runtime/studiod-endpoint'
import { createWebHost, type WebHost } from '../src/host/server'
import { openStudiodLink, type StudiodLink } from '../src/host/studiod-link'
import { chromePath, removeTempDir } from './platform'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const cli = join(root, 'apps/cli/dist/vis.mjs')
const ready = existsSync(chromePath()) && existsSync(cli) && existsSync(join(root, 'apps/web/dist/client/index.html'))
const screenshots = '/tmp/vis-0031/step-c'
const passage = '清晨有雾。林舟回家。'
const body = `# 第一章 雾中的来信\n\n${passage}河水很静。\n\n# 第二章 夜航\n\n林舟带着信来到河边。`
let dir: string
let daemon: Studiod
let host: WebHost
let admin: StudiodLink
let browser: Browser
let page: Page
let nodeId: string
let sessionId: string
let spaceId: string
const errors: string[] = []
const apply = (ops: CanvasOp[]) => admin.call('canvas.apply', { requestId: crypto.randomUUID(), ops })
const nodes = async (): Promise<NodeView[]> => (await admin.call('canvas.get', {})).nodes
const manuscript = async () => (await nodes()).find(node => node.nodeId === nodeId)!
const main = async () => (await manuscript()).slots.find(slot => slot.slotKey === 'main')!
const script = async () => (await nodes()).find(node => node.kind === 'script')!
const doc = async (): Promise<ScriptDoc> => { const content = (await script()).slots.find(slot => slot.slotKey === 'main')!.content; if (content.type !== 'script') throw new Error('Expected script'); return content.doc }
const editor = () => page.getByRole('dialog', { name: 'Writing page', exact: true })
const input = () => editor().getByRole('textbox', { name: 'Manuscript', exact: true })
const storyboard = () => page.getByRole('dialog', { name: 'Script editor', exact: true })
const marker = (number: number) => editor().getByRole('button', { name: `1 linked shot: Go to Manuscript storyboard · Shot ${number}`, exact: true })
const toolbar = () => editor().getByRole('toolbar', { name: 'Selection actions', exact: true })
async function open() {
  await page.getByRole('button', { name: 'Fit canvas', exact: true }).click()
  await page.getByRole('button', { name: 'Open writing page', exact: true }).first().click()
  await input().waitFor()
}
async function close() {
  await editor().getByRole('button', { name: 'Close writing page', exact: true }).click()
  await expect.poll(() => editor().count()).toBe(0)
}
async function select() {
  await input().evaluate((element, passage) => {
    const line = [...element.querySelectorAll('.cm-line')].find(line => line.textContent?.startsWith(passage))!
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT)
    const text = walker.nextNode()!
    element.focus()
    window.getSelection()!.setBaseAndExtent(text, 0, text, passage.length)
    document.dispatchEvent(new Event('selectionchange'))
  }, passage)
  await toolbar().waitFor()
}
async function assertToolbarGeometry(heading = false) {
  await expect.poll(() => toolbar().evaluate((bar, heading) => {
    const selection = window.getSelection()
    const rects = selection?.rangeCount ? [...selection.getRangeAt(0).getClientRects()].filter(rect => rect.width && rect.height) : []
    const box = bar.getBoundingClientRect()
    const intersects = (other: DOMRect) => box.left < other.right && box.right > other.left && box.top < other.bottom && box.bottom > other.top
    const firstLine = document.querySelector('.vis-writing-codemirror .cm-line')!.getBoundingClientRect()
    const buttons = [...bar.querySelectorAll('button')].map(button => button.getBoundingClientRect())
    const viewport = document.querySelector('.vis-writing-codemirror .cm-scroller')!.getBoundingClientRect()
    return { selected: rects.length > 0, clear: rects.every(rect => !intersects(rect)), headingClear: !heading || !intersects(firstLine), oneRow: buttons.every(button => Math.abs(button.top - buttons[0]!.top) < 1), inViewport: box.left >= viewport.left && box.right <= viewport.right && box.top >= viewport.top && box.bottom <= viewport.bottom }
  }, heading)).toEqual({ selected: true, clear: true, headingClear: true, oneRow: true, inViewport: true })
}
async function assertMarkerGeometry() {
  await input().focus()
  await page.keyboard.press('ControlOrMeta+a')
  await expect.poll(() => input().locator('.cm-line').allTextContents()).toEqual(body.split('\n'))
  await page.keyboard.press('ControlOrMeta+Home')
  await expect.poll(() => input().evaluate((element, body) => {
    const column = element.getBoundingClientRect()
    const main = element.closest('.vis-writing-main')!.getBoundingClientRect()
    const markers = [...document.querySelectorAll<HTMLElement>('.vis-writing-shot-marker')]
    const lines = [...element.querySelectorAll('.cm-line')]
    return { outside: markers.length > 0 && markers.every(marker => marker.getBoundingClientRect().right <= column.left && marker.getBoundingClientRect().left >= main.left), text: lines.map(line => line.textContent), inlineControls: element.querySelectorAll('.vis-writing-shot-marker').length }
  }, body)).toEqual({ outside: true, text: body.split('\n').map((line, index) => index === 0 ? line : line.replace(/^#{1,6} /, '')), inlineControls: 0 })
}
async function productionAction(name: 'Break into shots' | 'Extract characters and scenes') {
  await toolbar().getByRole('button', { name: 'More', exact: true }).click()
  await page.getByRole('menuitem', { name, exact: true }).click()
}

async function waitAnswer(answer: string, afterSeq = 0) {
  await expect.poll(async () => (await admin.call('session.getTranscript', { sessionId })).items.some(item => item.createdSeq > afterSeq && item.kind === 'assistant_text' && item.payload.text === answer), { timeout: 15_000 }).toBe(true)
  await expect.poll(async () => (await admin.call('session.list')).sessions.find(session => session.sessionId === sessionId)?.activeTurnId).toBeNull()
}

describe.skipIf(!ready)('Manuscript into production acceptance', () => {
  beforeAll(async () => {
    mkdirSync(screenshots, { recursive: true })
    dir = mkdtempSync(join(tmpdir(), 'vis-writing-production-'))
    vi.stubEnv('VIS_PROJECTS_DIR', join(dir, 'projects'))
    daemon = await startStudiod({ dataDir: dir, studiodVersion: 'writing-production-e2e', secretStore: createMemorySecretStore(), providers: [createMockProvider({ latencyMs: 0 })], defaults: { image: { provider: 'mock' } },
      runtimes: { codex: codexRuntime({ dataDir: dir, socketPath: studiodEndpoint(dir), codexPath: join(root, 'apps/web/e2e/fake-codex.mjs'), visMcp: { command: process.execPath, args: [cli, 'mcp'] } }) } })
    spaceId = daemon.spaces.create('Manuscript production').spaceId
    admin = await openStudiodLink({ socketPath: daemon.socketPath, tokenPath: daemon.tokenPath })
    await admin.call('events.subscribe', { spaceId })
    nodeId = (await apply([{ op: 'node.create', tempId: 'book', kind: 'text', title: '雾中的来信', format: 'markdown', content: { text: body } }])).idMap.book!
    sessionId = (await admin.call('session.create', { requestId: crypto.randomUUID(), title: 'Production partner', agentKind: 'codex' })).sessionId
    host = await createWebHost({ socketPath: daemon.socketPath, tokenPath: daemon.tokenPath, staticDir: join(root, 'apps/web/dist/client') })
    browser = await chromium.launch({ executablePath: chromePath(), headless: true })
    page = await browser.newPage({ locale: 'en-US', viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 })
    page.setDefaultTimeout(8000)
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(host.url, { waitUntil: 'domcontentloaded' })
    await page.getByRole('listitem', { name: /^Production partner,/ }).click()
    await open()
  })
  afterEach(async ({ task }) => { if (task.result?.state === 'fail') await page.screenshot({ path: join(screenshots, 'failure.png'), animations: 'disabled' }) })
  afterAll(async () => {
    await browser?.close(); admin?.close(); await host?.close(); await daemon?.stop('user_quit')
    vi.unstubAllEnvs(); if (dir) removeTempDir(dir)
  })

  it('keeps a compact toolbar clear of selections, including the first heading and the viewport edge', async () => {
    const initial = await main()
    // Blank lines give the short chapter fixture a real scroll range without changing its opening.
    await apply([{ op: 'slot.setText', slotId: initial.slotId, expectedRevision: initial.revision, body: body + '\n'.repeat(50) }])
    try {
      await expect.poll(() => input().evaluate(element => { const scroll = element.closest('.cm-scroller')!; return scroll.scrollHeight - scroll.clientHeight })).toBeGreaterThan(100)
      await input().evaluate(element => {
        const line = element.querySelector('.cm-line')!
        element.focus()
        const range = document.createRange()
        range.selectNodeContents(line)
        window.getSelection()!.removeAllRanges()
        window.getSelection()!.addRange(range)
        document.dispatchEvent(new Event('selectionchange'))
      })
      await toolbar().waitFor()
      expect(await toolbar().getByRole('button').allTextContents()).toEqual(['Rewrite', 'Continue', 'Expand', 'Ask', 'More'])
      expect(await toolbar().getByRole('textbox').count()).toBe(0)
      expect(await toolbar().getByRole('combobox').count()).toBe(0)
      await assertToolbarGeometry(true)
      const firstLine = await input().locator('.cm-line').first().boundingBox()
      expect((await toolbar().boundingBox())!.y + (await toolbar().boundingBox())!.height).toBeLessThanOrEqual(firstLine!.y)
      await page.screenshot({ path: join(screenshots, 'selection-toolbar-first-line.png'), animations: 'disabled' })
      await input().evaluate(element => { element.closest('.cm-scroller')!.scrollTop = 45 })
      await expect.poll(() => input().evaluate(element => element.closest('.cm-scroller')!.scrollTop)).toBe(45)
      await assertToolbarGeometry(true)
      await expect.poll(async () => {
        const heading = (await input().locator('.cm-line').first().boundingBox())!
        return (await toolbar().boundingBox())!.y >= heading.y + heading.height
      }).toBe(true)
      await page.screenshot({ path: join(screenshots, 'selection-toolbar-viewport-edge.png'), animations: 'disabled' })
    } finally {
      await input().evaluate(element => { element.closest('.cm-scroller')!.scrollTop = 0 })
      const slot = await main()
      await apply([{ op: 'slot.setText', slotId: slot.slotId, expectedRevision: slot.revision, body }])
      await input().focus()
      await page.keyboard.press('ControlOrMeta+a')
      await expect.poll(() => input().locator('.cm-line').allTextContents()).toEqual(body.split('\n'))
      await page.keyboard.press('ControlOrMeta+Home')
    }
  })

  it('sends Break into shots to fake Codex and creates linked shots without editing prose', async () => {
    const revision = (await main()).revision
    await select()
    await assertToolbarGeometry()
    await productionAction('Break into shots')
    const target = page.getByRole('dialog', { name: 'Break into shots', exact: true })
    await target.getByLabel('Target script (optional)', { exact: true }).waitFor()
    await target.getByRole('button', { name: 'Send to Agent', exact: true }).click()
    await waitAnswer('Completed writing shots: Manuscript storyboard')
    expect((await doc()).shots).toHaveLength(1)
    expect((await doc()).shots[0]).toMatchObject({ description: 'A traveler walks beside the quiet river.', durationSec: 4, source: { nodeId, quote: passage } })
    expect(await main()).toMatchObject({ revision, content: { type: 'text', body } })
    const transcript = JSON.stringify((await admin.call('session.getTranscript', { sessionId })).items)
    expect(transcript).toContain('Writing task: shots')
    expect(transcript).toContain('第一章 雾中的来信')
    expect(transcript).toContain(passage)
    expect((await script()).inputs).toContain(nodeId)
  })

  it('opens a source at its highlighted passage and returns through a marker to the exact shot row', async () => {
    await close()
    await page.getByRole('button', { name: 'Fit canvas', exact: true }).click()
    await page.getByRole('button', { name: 'Expand storyboard', exact: true }).first().click()
    await storyboard().getByRole('button', { name: 'View source passage', exact: true }).click()
    await input().waitFor()
    await expect.poll(() => editor().locator('.vis-writing-source-highlight').allTextContents()).toEqual([passage])
    const passageMarker = marker(1)
    await passageMarker.waitFor()
    await assertMarkerGeometry()
    const line = (await input().locator('.cm-line').filter({ hasText: passage }).boundingBox())!
    const mark = (await passageMarker.boundingBox())!
    expect(mark.y + mark.height / 2).toBeGreaterThanOrEqual(line.y)
    expect(mark.y + mark.height / 2).toBeLessThanOrEqual(line.y + line.height)
    await page.screenshot({ path: join(screenshots, 'passage-markers.png'), animations: 'disabled' })
    await passageMarker.hover()
    const linkedShot = editor().getByRole('button', { name: 'Go to Manuscript storyboard · Shot 1', exact: true })
    await linkedShot.waitFor()
    await page.mouse.move(250, 90)
    await expect.poll(() => linkedShot.isVisible()).toBe(false)
    await passageMarker.focus()
    await linkedShot.waitFor()
    await page.keyboard.press('Enter')
    await expect.poll(() => editor().count()).toBe(0)
    const row = storyboard().getByRole('row', { name: 'Shot 1', exact: true })
    await expect.poll(() => row.getAttribute('aria-selected')).toBe('true')
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('Shot 1')
    expect(await row.getByRole('button', { name: 'Shot 1 · Description', exact: true }).innerText()).toContain('A traveler walks beside the quiet river.')
  })

  it('labels an ambiguous source stale and opens the manuscript without a false highlight', async () => {
    const slot = await main()
    const changed = body + `\n\n${passage}`
    await apply([{ op: 'slot.setText', slotId: slot.slotId, expectedRevision: slot.revision, body: changed }])
    await storyboard().getByRole('button', { name: 'Source changed · Open manuscript', exact: true }).click()
    await input().waitFor()
    await editor().getByText('The source changed and no longer matches exactly once', { exact: true }).waitFor()
    expect(await editor().locator('.vis-writing-source-highlight').count()).toBe(0)
    expect(await marker(1).count()).toBe(0)
    expect((await main()).content).toEqual({ type: 'text', body: changed })
    await close()
    await storyboard().getByRole('button', { name: 'Close script editor', exact: true }).click()
    const current = await main()
    await apply([{ op: 'slot.setText', slotId: current.slotId, expectedRevision: current.revision, body }])
    await open()
  })

  it('extracts descriptions and reports same-name settings while preserving manual values', async () => {
    const existing = await admin.call('entity.create', { requestId: crypto.randomUUID(), kind: 'character', name: 'Lin Zhou', description: 'The writer specifies a red scarf.' })
    await select()
    await productionAction('Extract characters and scenes')
    await waitAnswer('Extracted settings; existing settings preserved: Lin Zhou')
    const settings = (await admin.call('entity.list', {})).items
    expect(settings.filter(item => item.kind === 'character' && item.name === 'Lin Zhou')).toHaveLength(1)
    expect(settings.find(item => item.id === existing.id)).toMatchObject({ description: 'The writer specifies a red scarf.', revision: existing.revision })
    expect(settings.find(item => item.name === 'River')).toMatchObject({ kind: 'scene', description: 'A quiet river covered in morning fog.' })
    expect((await main()).content).toEqual({ type: 'text', body })
  })

  it('offers chapter production actions and adapts the full chapter into the existing script', async () => {
    const transcript = await admin.call('session.getTranscript', { sessionId })
    const beforeSeq = Math.max(0, ...transcript.items.map(item => item.createdSeq))
    const chapter = writingChapters(body)[0]!
    await editor().getByLabel(`Chapter actions: ${chapter.title}`, { exact: true }).click()
    const details = editor().getByLabel(`Chapter actions: ${chapter.title}`, { exact: true }).locator('..')
    await details.getByRole('button', { name: 'Break into shots', exact: true }).click()
    const target = page.getByRole('dialog', { name: 'Break into shots', exact: true })
    await target.getByLabel('Target script (optional)', { exact: true }).fill('Manuscript storyboard')
    await target.getByRole('button', { name: 'Send to Agent', exact: true }).click()
    // Sending queues the turn; wait for its new answer, not the identical reply from the earlier passage adaptation.
    await waitAnswer('Completed writing shots: Manuscript storyboard', beforeSeq)
    await expect.poll(async () => (await doc()).shots.length).toBe(2)
    await expect.poll(async () => (await admin.call('session.list')).sessions.find(session => session.sessionId === sessionId)?.activeTurnId).toBeNull()
    expect((await doc()).shots[1]!.source).toEqual({ nodeId, quote: body.slice(chapter.from, chapter.to) })
    expect((await nodes()).filter(node => node.kind === 'script')).toHaveLength(1)
    await page.keyboard.press('Escape')
    if (!await editor().count()) await open()
    await marker(2).waitFor()
    await page.screenshot({ path: join(screenshots, 'passage-markers.png'), animations: 'disabled' })
  })

  it('groups shots in the left gutter without changing heading or passage text and offers every row on focus', async () => {
    const current = await script()
    const slot = current.slots.find(slot => slot.slotKey === 'main')!
    const shots = (await doc()).shots
    await apply([{ op: 'script.patch', slotId: slot.slotId, ops: [{ kind: 'shot.insert', tempId: 'third', afterShotId: shots.at(-1)!.id, shot: { description: 'The still river.', source: { nodeId, quote: '河水很静。' } } }] }])
    const grouped = editor().getByRole('button', { name: '2 linked shots: Go to Manuscript storyboard · Shot 1; Go to Manuscript storyboard · Shot 3', exact: true })
    await grouped.waitFor()
    expect(await grouped.innerText()).toBe('2')
    expect(await editor().locator('.vis-writing-shot-marker').count()).toBe(2)
    await assertMarkerGeometry()
    const heading = (await input().locator('.cm-line').first().boundingBox())!
    const headingMarker = (await marker(2).boundingBox())!
    expect(headingMarker.y + headingMarker.height / 2).toBeGreaterThanOrEqual(heading.y)
    expect(headingMarker.y + headingMarker.height / 2).toBeLessThanOrEqual(heading.y + heading.height)
    await grouped.focus()
    const third = editor().getByRole('button', { name: 'Go to Manuscript storyboard · Shot 3', exact: true })
    await third.waitFor()
    await third.click()
    const row = storyboard().getByRole('row', { name: 'Shot 3', exact: true })
    await expect.poll(() => row.getAttribute('aria-selected')).toBe('true')
    await row.getByRole('button', { name: 'View source passage', exact: true }).click()
    await input().waitFor()
    await assertMarkerGeometry()
    await input().click()
    await page.screenshot({ path: join(screenshots, 'passage-markers.png'), animations: 'disabled' })
    expect((await main()).content).toEqual({ type: 'text', body })
  })

  it('splits selected chapters and resumes a partial failure after reload without duplicating or overwriting completed copies', async () => {
    const series = await admin.call('series.create', { requestId: crypto.randomUUID(), name: 'River letters' })
    const occupied = await admin.call('space.create', { requestId: crypto.randomUUID(), name: 'Occupied episode', series: { seriesId: series.seriesId }, episode: 3 })
    await editor().getByRole('button', { name: 'Split into episodes', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Split into episodes', exact: true })
    await dialog.getByRole('combobox', { name: 'Series', exact: true }).selectOption(series.seriesId)
    const chapters = writingChapters(body)
    for (const [index, chapter] of chapters.entries()) {
      await dialog.getByRole('spinbutton', { name: `Episode · ${chapter.title}`, exact: true }).fill(String(index + 2))
      expect(await dialog.getByRole('checkbox', { name: `Choose chapter: ${chapter.title}`, exact: true }).isChecked()).toBe(true)
    }
    await page.screenshot({ path: join(screenshots, 'split-dialog.png'), animations: 'disabled' })
    await dialog.getByRole('button', { name: 'Create episodes', exact: true }).click()
    await dialog.getByText('Created', { exact: true }).waitFor()
    await dialog.getByText('Failed · This episode number is already in use; choose another number', { exact: true }).waitFor()
    const first = daemon.spaces.list().find(space => space.name === chapters[0]!.title)!
    const firstHost = daemon.spaces.get(first.spaceId)!
    const copy = firstHost.canvas.get({}).nodes[0]!
    expect(copy.slots[0]!.content).toEqual({ type: 'text', body: body.slice(chapters[0]!.from, chapters[0]!.to) })
    firstHost.canvas.apply({ kind: 'user' }, { requestId: crypto.randomUUID(), ops: [{ op: 'slot.setText', slotId: copy.slots[0]!.slotId, expectedRevision: 1, body: 'Episode copy edited by the writer.' }] })
    await admin.call('space.setSeries', { requestId: crypto.randomUUID(), spaceId: occupied.spaceId, series: null })
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await close()
    await page.reload({ waitUntil: 'domcontentloaded' })
    await open()
    await editor().getByRole('button', { name: 'Split into episodes', exact: true }).click()
    await dialog.getByRole('button', { name: 'Retry unfinished chapters', exact: true }).click()
    await dialog.getByText('Already completed; skipped', { exact: true }).waitFor()
    await dialog.getByText('Created', { exact: true }).waitFor()
    await dialog.getByRole('button', { name: 'Done', exact: true }).click()
    const episodes = daemon.spaces.list().filter(space => space.series?.seriesId === series.seriesId)
    // Joining uses the existing series path's next episode number after the occupied episode 3.
    expect(episodes.find(space => space.spaceId === spaceId)!.series!.episode).toBe(4)
    expect(episodes.filter(space => space.spaceId !== spaceId).map(space => space.series!.episode).sort()).toEqual([2, 3])
    expect(firstHost.canvas.get({}).nodes).toHaveLength(1)
    expect(firstHost.canvas.get({}).nodes[0]!.slots[0]).toMatchObject({ revision: 2, content: { type: 'text', body: 'Episode copy edited by the writer.' } })
    const second = daemon.spaces.get(episodes.find(space => space.series!.episode === 3)!.spaceId)!
    expect(second.canvas.get({}).nodes[0]!.slots[0]!.content).toEqual({ type: 'text', body: body.slice(chapters[1]!.from, chapters[1]!.to) })
    expect((await main()).content).toEqual({ type: 'text', body })
    expect(errors).toEqual([])
  })
})
