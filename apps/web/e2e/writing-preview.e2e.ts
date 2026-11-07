import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { writingWordCount, type CanvasOp, type NodeView } from '@vis/protocol'
import { createMockProvider } from '../../../packages/generation/src/index'
import { codexRuntime } from '../../../services/studiod/src/codex'
import { studiodEndpoint } from '../../../runtime/studiod-endpoint'
import { createMemorySecretStore } from '../../../services/studiod/src/secret-store'
import { startStudiod, type Studiod } from '../../../services/studiod/src/studiod'
import { createWebHost, type WebHost } from '../src/host/server'
import { openStudiodLink, type StudiodLink } from '../src/host/studiod-link'
import { chromePath, removeTempDir } from './platform'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const ready = existsSync(chromePath()) && existsSync(join(root, 'apps/cli/dist/vis.mjs')) && existsSync(join(root, 'apps/web/dist/client/index.html'))
const screenshots = '/tmp/vis-next/writing'
const body = '# Live preview\n## A quiet morning\n**A letter** and *a journey*.\n> A quiet river.\n- First stop\n2) Second stop\n\n| Name | Value |\n| --- | --- |\n| Letter | Home |\n\nAfter the table.'
let dir: string, nodeId: string, spaceId: string
let daemon: Studiod, host: WebHost, admin: StudiodLink, browser: Browser, page: Page
const errors: string[] = []
const nodes = async (): Promise<NodeView[]> => (await admin.call('canvas.get', {})).nodes
const apply = (ops: CanvasOp[]) => admin.call('canvas.apply', { requestId: crypto.randomUUID(), ops })
const main = async () => (await nodes()).find(node => node.nodeId === nodeId)!.slots.find(slot => slot.slotKey === 'main')!
const editor = () => page.getByRole('dialog', { name: 'Writing page', exact: true })
const input = () => editor().getByRole('textbox', { name: 'Manuscript', exact: true })
const outline = () => editor().getByRole('navigation', { name: 'Chapter outline', exact: true })
const line = (text: string) => input().locator('.cm-line').filter({ hasText: text })
async function caret() {
  return input().evaluate((element, body) => {
    const selection = window.getSelection()!
    const position = (node: Node | null, offset: number) => {
      const parent = node?.nodeType === Node.ELEMENT_NODE ? node as Element : node?.parentElement
      const line = parent?.closest('.cm-line')
      if (!line || !node) return -1
      const range = document.createRange()
      range.setStart(line, 0); range.setEnd(node, offset)
      const index = [...element.querySelectorAll('.cm-line')].indexOf(line)
      return body.split('\n').slice(0, index).reduce((sum, text) => sum + text.length + 1, 0) + range.toString().length
    }
    return { anchor: position(selection.anchorNode, selection.anchorOffset), head: position(selection.focusNode, selection.focusOffset), text: selection.toString() }
  }, body)
}
async function assertCaret(anchor: number, head = anchor) {
  await expect.poll(caret).toEqual({ anchor, head, text: body.slice(Math.min(anchor, head), Math.max(anchor, head)) })
}
async function home() { await input().focus(); await page.keyboard.press('ControlOrMeta+Home'); await assertCaret(0) }

describe.skipIf(!ready)('Manuscript Markdown live preview', () => {
  beforeAll(async () => {
    mkdirSync(screenshots, { recursive: true })
    dir = mkdtempSync(join(tmpdir(), 'vis-writing-preview-'))
    vi.stubEnv('VIS_PROJECTS_DIR', join(dir, 'projects'))
    daemon = await startStudiod({ dataDir: dir, studiodVersion: 'writing-preview-e2e', runtimes: { codex: codexRuntime({ dataDir: dir, socketPath: studiodEndpoint(dir), codexPath: join(root, 'apps/web/e2e/fake-codex.mjs'), visMcp: { command: process.execPath, args: [join(root, 'apps/cli/dist/vis.mjs'), 'mcp'] } }) }, secretStore: createMemorySecretStore(), providers: [createMockProvider({ latencyMs: 0 })], defaults: { image: { provider: 'mock' } } })
    spaceId = daemon.spaces.create('Live preview acceptance').spaceId
    admin = await openStudiodLink({ socketPath: daemon.socketPath, tokenPath: daemon.tokenPath })
    await admin.call('events.subscribe', { spaceId })
    nodeId = (await apply([{ op: 'node.create', tempId: 'book', kind: 'text', title: 'Live preview manuscript', format: 'markdown', content: { text: body } }])).idMap.book!
    host = await createWebHost({ socketPath: daemon.socketPath, tokenPath: daemon.tokenPath, staticDir: join(root, 'apps/web/dist/client') })
    browser = await chromium.launch({ executablePath: chromePath(), headless: true })
    page = await browser.newPage({ locale: 'en-US', viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 })
    page.setDefaultTimeout(8000)
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(host.url, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: 'Open writing page', exact: true }).click()
    await input().waitFor()
  })
  afterAll(async () => {
    await browser?.close(); admin?.close(); await host?.close(); await daemon?.stop('user_quit')
    vi.unstubAllEnvs(); if (dir) removeTempDir(dir)
  })
  it('renders inactive lines and reveals the cursor heading without changing text, counts or revision', async () => {
    await home()
    expect(await line('Live preview').innerText()).toBe('# Live preview')
    expect(await line('A quiet morning').innerText()).toBe('A quiet morning')
    expect(await line('A letter').innerText()).toBe('A letter and a journey.')
    expect(await line('A quiet river').innerText()).toBe('A quiet river.')
    expect(await line('First stop').innerText()).toBe('•First stop')
    expect(await line('Second stop').innerText()).toBe('2.Second stop')
    expect(await input().getByText('A letter', { exact: true }).evaluate(element => getComputedStyle(element).fontWeight)).toBe('700')
    expect(await input().getByText('a journey', { exact: true }).evaluate(element => getComputedStyle(element).fontStyle)).toBe('italic')
    await outline().getByRole('button', { name: 'A quiet morning', exact: true }).click()
    await assertCaret(body.indexOf('##'))
    expect(await line('Live preview').innerText()).toBe('Live preview')
    expect(await line('A quiet morning').innerText()).toBe('## A quiet morning')
    await editor().getByText(`${writingWordCount(body)} words in document`, { exact: true }).waitFor()
    const before = await caret()
    await page.screenshot({ path: join(screenshots, 'live-preview-heading.png'), animations: 'disabled', caret: 'initial' })
    expect(await caret()).toEqual(before)
    expect(await main()).toMatchObject({ revision: 1, content: { type: 'text', body } })
  })
  it('moves one source character at a time in both directions across hidden heading and emphasis markers', async () => {
    await home()
    await page.keyboard.press('End')
    const end = body.indexOf('\n'), next = end + 1
    await assertCaret(end)
    for (let offset = 0; offset < 6; offset++) {
      await page.keyboard.press('ArrowRight')
      await assertCaret(next + offset)
    }
    for (let offset = 4; offset >= -1; offset--) {
      await page.keyboard.press('ArrowLeft')
      await assertCaret(next + offset)
    }
    expect(await line('A quiet morning').innerText()).toBe('A quiet morning')
    await outline().getByRole('button', { name: 'A quiet morning', exact: true }).click()
    await page.keyboard.press('End')
    const emphasis = body.indexOf('**')
    await page.keyboard.press('ArrowRight')
    await assertCaret(emphasis)
    expect(await line('A letter').innerText()).toBe('**A letter** and *a journey*.')
    for (let offset = 1; offset <= 13; offset++) { await page.keyboard.press('ArrowRight'); await assertCaret(emphasis + offset) }
    for (let offset = 12; offset >= -1; offset--) { await page.keyboard.press('ArrowLeft'); await assertCaret(emphasis + offset) }
    expect(await line('A letter').innerText()).toBe('A letter and a journey.')
  })
  it('enters quote and list source prefixes without skipping characters or selection text', async () => {
    for (const prefix of ['> ', '- ', '2) ']) {
      await home()
      const target = body.indexOf(prefix), index = body.slice(0, target).split('\n').length - 1
      await input().locator('.cm-line').nth(index - 1).evaluate(element => {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
        let last: Node | null = null
        for (let text = walker.nextNode(); text; text = walker.nextNode()) if (text.textContent?.trim()) last = text
        window.getSelection()!.setBaseAndExtent(last!, last!.textContent!.length, last!, last!.textContent!.length)
        document.dispatchEvent(new Event('selectionchange'))
      })
      await assertCaret(target - 1)
      for (let offset = 0; offset <= prefix.length; offset++) {
        await page.keyboard.press('Shift+ArrowRight')
        await assertCaret(target - 1, target + offset)
      }
      await page.keyboard.press('ArrowRight')
      await assertCaret(target + prefix.length)
      for (let offset = prefix.length - 1; offset >= -1; offset--) {
        await page.keyboard.press('ArrowLeft')
        await assertCaret(target + offset)
      }
    }
  })
  it('preserves the clicked source position and moves vertically onto and away from revealed lines', async () => {
    await home()
    const target = await line('A quiet morning').evaluate(element => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
      let text = walker.nextNode()!
      while (!text.textContent?.includes('A quiet morning')) text = walker.nextNode()!
      const range = document.createRange()
      range.setStart(text, 0); range.setEnd(text, 1)
      const box = range.getBoundingClientRect()
      return { x: box.left + 1, y: (box.top + box.bottom) / 2 }
    })
    await page.mouse.click(target.x, target.y)
    await assertCaret(body.indexOf('A quiet morning'))
    await page.keyboard.press('ArrowRight')
    await assertCaret(body.indexOf('A quiet morning') + 1)
    await page.keyboard.press('Home')
    await assertCaret(body.indexOf('##'))
    await page.keyboard.press('ArrowDown')
    await assertCaret(body.indexOf('A letter'))
    await page.keyboard.press('ArrowDown')
    await assertCaret(body.indexOf('A quiet river.'))
    await page.keyboard.press('ArrowUp')
    await assertCaret(body.indexOf('A letter'))
  })
  it('opens list source when its rendered bullet is clicked', async () => {
    await home()
    await line('First stop').locator('.vis-writing-list-marker').click()
    await expect.poll(() => line('First stop').innerText()).toBe('- First stop')
    const position = await caret(), from = body.indexOf('- First stop')
    expect(position.anchor).toBe(position.head)
    expect(position.head).toBeGreaterThanOrEqual(from)
    expect(position.head).toBeLessThanOrEqual(from + 2)
    await page.keyboard.press('ArrowRight')
    await assertCaret(position.head + 1)
    await home()
    expect(await line('First stop').innerText()).toBe('•First stop')
  })
  it('keeps forward and backward selections exact while revealing every intersected line', async () => {
    await home(); await page.keyboard.press('End')
    const start = body.indexOf('\n')
    for (let offset = 1; offset <= 8; offset++) { await page.keyboard.press('Shift+ArrowRight'); await assertCaret(start, start + offset) }
    expect(await line('Live preview').innerText()).toBe('# Live preview')
    expect(await line('A quiet morning').innerText()).toBe('## A quiet morning')
    await page.keyboard.press('ArrowRight')
    await assertCaret(start + 8)
    for (let offset = 1; offset <= 8; offset++) { await page.keyboard.press('Shift+ArrowLeft'); await assertCaret(start + 8, start + 8 - offset) }
    await home()
    await page.keyboard.press('ControlOrMeta+a')
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe(body)
    await home()
    expect(await line('A quiet morning').innerText()).toBe('A quiet morning')
    expect(await main()).toMatchObject({ revision: 1, content: { type: 'text', body } })
  })
  it('reveals whole lines for review edits and shot passages while leaving tables rendered', async () => {
    const session = await admin.call('session.create', { requestId: crypto.randomUUID(), title: 'Fixture reviewer', agentKind: 'codex' })
    const slot = await main()
    daemon.spaces.get(spaceId)!.textProposals.propose({ requestId: crypto.randomUUID(), slotId: slot.slotId, baseRevision: slot.revision, summary: 'Clarify the destination', edits: [{ find: 'First stop', replace: 'First destination' }] }, session.sessionId)
    await editor().getByRole('button', { name: 'Accept edit 1', exact: true }).waitFor()
    await expect.poll(() => line('First stop').textContent()).toBe('- First stopFirst destinationAcceptReject')
    await apply([{ op: 'node.create', tempId: 'script', kind: 'script', title: 'Source storyboard' }, { op: 'script.patch', slotId: 'script:main', ops: [{ kind: 'shot.insert', tempId: 'river', afterShotId: null, shot: { description: 'A quiet river', source: { nodeId, quote: 'A quiet river.' } } }] }])
    await expect.poll(() => line('A quiet river').innerText()).toBe('> A quiet river.')
    await editor().getByRole('button', { name: '1 linked shot: Go to Source storyboard · Shot 1', exact: true }).waitFor()
    expect(await editor().getByRole('table', { name: 'Table (click to edit)', exact: true }).count()).toBe(1)
    await editor().getByRole('button', { name: 'Reject edit 1', exact: true }).click()
    await expect.poll(() => line('First stop').innerText()).toBe('•First stop')
    expect(await main()).toMatchObject({ revision: 1, content: { type: 'text', body } })
  })
  it('bounds DOM and preview work while typing and scrolling a 200,000-character manuscript', async () => {
    await editor().getByRole('button', { name: 'Close writing page', exact: true }).click()
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: Number(process.env.VIS_WRITING_CPU_RATE ?? 1) })
    const longBody = ('# Chapter\n**A letter** and *a journey*.\n\n').repeat(5300)
    expect(longBody.length).toBeGreaterThan(200_000)
    nodeId = (await apply([{ op: 'node.create', tempId: 'long', kind: 'text', title: 'Long preview manuscript', format: 'markdown', content: { text: longBody } }])).idMap.long!
    await page.getByRole('button', { name: 'Fit canvas', exact: true }).click()
    await page.locator('.react-flow__node').filter({ hasText: 'Long preview manuscript' }).getByRole('button', { name: 'Open writing page', exact: true }).click()
    await input().waitFor()
    expect(await outline().getByRole('button').count()).toBeLessThan(100)
    const initialVisibleLines = await input().locator('.cm-line').count()
    expect(initialVisibleLines).toBeLessThan(150)
    const latency: number[] = []
    for (let index = 0; index < 20; index++) {
      const started = performance.now()
      await page.keyboard.insertText('a')
      await page.evaluate(() => new Promise(requestAnimationFrame))
      latency.push(performance.now() - started)
    }
    await page.keyboard.press('ControlOrMeta+End')
    const bottomVisibleLines = await input().locator('.cm-line').count()
    expect(bottomVisibleLines).toBeLessThan(150)
    expect(await input().getByText('A letter', { exact: true }).count()).toBeGreaterThan(0)
    await expect.poll(() => outline().evaluate(element => element.scrollTop)).toBeGreaterThan(100_000)
    const activeChapter = await outline().locator('[aria-current="location"]').boundingBox()
    const outlineBox = (await outline().boundingBox())!
    expect(activeChapter!.y).toBeGreaterThanOrEqual(outlineBox.y)
    expect(activeChapter!.y + activeChapter!.height).toBeLessThanOrEqual(outlineBox.y + outlineBox.height)
    await page.keyboard.press('ControlOrMeta+Home')
    await expect.poll(() => outline().evaluate(element => element.scrollTop)).toBeLessThan(100)
    await expect.poll(() => input().locator('.cm-line').first().textContent()).toBe('a'.repeat(20) + '# Chapter')
    const closeStarted = performance.now()
    await editor().getByRole('button', { name: 'Close writing page', exact: true }).click()
    await expect.poll(async () => (await main()).content).toEqual({ type: 'text', body: 'a'.repeat(20) + longBody })
    await cdp.detach()
    writeFileSync(join(screenshots, 'typing-latency.json'), JSON.stringify({ characters: longBody.length, measurement: 'Playwright insertText through next animation frame', initialVisibleLines, bottomVisibleLines, closeMs: performance.now() - closeStarted, cpuRate: Number(process.env.VIS_WRITING_CPU_RATE ?? 1), samplesMs: latency }, null, 2))
    expect(errors).toEqual([])
  })
})
