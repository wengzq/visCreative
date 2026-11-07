import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright-core'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { EMPTY_PREVIZ, emptyPrevizPanel, type CanvasOp, type NodeView, type PrevizDoc, type PrevizPanel } from '@vis/protocol'
import { spaceSchema as s } from '../../../packages/storage/src/index'
import { createMockProvider, type ProviderType } from '../../../packages/generation/src/index'
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
const screenshots = '/tmp/vis-0029/step-b'
let dir: string
let daemon: Studiod
let host: WebHost
let admin: StudiodLink
let browser: Browser
let page: Page
let nodeId: string
let scriptId: string
let shotIds: string[]
let image: string
let sessionId: string
let spaceId: string
let referenceLimit = 9
let keyFixtureCalls = 0
const errors: string[] = []
const apply = (ops: CanvasOp[]) => admin.call('canvas.apply', { requestId: crypto.randomUUID(), ops })
const nodes = async (): Promise<NodeView[]> => (await admin.call('canvas.get', {})).nodes
const current = async () => (await nodes()).find(node => node.nodeId === nodeId)!
const doc = async () => {
  const content = (await current()).slots.find(slot => slot.slotKey === 'main')!.content
  if (content.type !== 'previz') throw new Error('Expected previz')
  return content.doc
}
const card = () => page.getByRole('region', { name: /^Shot previz Board,/ })
const tile = (n = 1) => card().getByRole('button', { name: new RegExp(`^Panel ${n}(,|$)`) })
const popover = () => page.getByRole('region', { name: 'Panel controls', exact: true })
async function setPanel(fields: Partial<PrevizPanel>, index = 0) {
  const node = await current()
  const slot = node.slots.find(slot => slot.slotKey === 'main')!
  const document = await doc()
  await apply([{ op: 'previz.set', slotId: slot.slotId, expectedRevision: slot.revision, doc: { ...document, rev: document.rev + 1, panels: document.panels.map((panel, i) => i === index ? { ...panel, ...fields, rev: panel.rev + 1 } : panel) } }])
}
async function select(n = 1) {
  await tile(n).click()
  await popover().waitFor()
}
async function finishJobs(before: number, kind: 'image' | 'video') {
  await expect.poll(async () => (await nodes()).filter(node => node.kind === kind).length, { timeout: 10_000 }).toBe(before + 1)
  await expect.poll(() => popover().getByRole('button', { name: /Generate/ }).isEnabled(), { timeout: 10_000 }).toBe(true)
}

describe.skipIf(!ready)('Previz canvas panels', () => {
  beforeAll(async () => {
    mkdirSync(screenshots, { recursive: true })
    dir = mkdtempSync(join(tmpdir(), 'vis-previz-panels-'))
    vi.stubEnv('VIS_PROJECTS_DIR', join(dir, 'projects'))
    const mock = createMockProvider({ latencyMs: 0 })
    const keyType: ProviderType = {
      type: 'key-fixture', label: { zh: 'Key fixture', en: 'Key fixture' }, needsKey: true, kinds: ['image'], regions: [], allowCustomBaseUrl: true,
      knownModels: [{ id: 'fixture-image', kind: 'image', label: 'Fixture image' }], verified: false,
      help: { consoleUrl: 'https://example.invalid', key: { zh: 'Local test only', en: 'Local test only' } },
      create: config => ({ ...mock, id: config.id, type: config.type, models: ['fixture-image'], defaultModels: { image: 'fixture-image' }, configuration: config,
        async submit() { keyFixtureCalls++; throw new Error('The key fixture must never submit') } }),
    }
    writeFileSync(join(dir, 'providers.json'), JSON.stringify({ providers: [{ id: 'key-fixture', type: 'key-fixture', label: 'Key fixture', baseUrl: 'https://example.invalid', imageModels: [{ id: 'fixture-image', label: 'Fixture image' }], videoModels: [], audioModels: [] }], defaults: {}, limits: { maxConcurrent: 3, dailyImage: 5, dailyVideo: 5, dailyAudio: 5 } }))
    daemon = await startStudiod({ dataDir: dir, studiodVersion: 'previz-panels-e2e', secretStore: createMemorySecretStore(),
      providerTypes: [keyType], providers: [{ ...mock, referenceImageLimitFor: () => referenceLimit }, { ...mock, id: 'render', type: 'render', kinds: ['video'], models: ['html'], defaultModels: { video: 'html' } }], defaults: { image: { provider: 'mock' }, video: { provider: 'mock' } },
      runtimes: { codex: codexRuntime({ dataDir: dir, socketPath: studiodEndpoint(dir), codexPath: join(root, 'apps/web/e2e/fake-codex.mjs'), visMcp: { command: process.execPath, args: [cli, 'mcp'] } }) },
    })
    spaceId = daemon.spaces.create('Previz panels').spaceId
    admin = await openStudiodLink({ socketPath: daemon.socketPath, tokenPath: daemon.tokenPath })
    await admin.call('events.subscribe', { spaceId })
    sessionId = (await admin.call('session.create', { requestId: crypto.randomUUID(), agentKind: 'codex' })).sessionId
    const file = join(dir, 'layout.png')
    execFileSync(process.platform === 'darwin' ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=steelblue:size=320x180', '-frames:v', '1', '-y', file])
    image = (await admin.call('asset.import', { requestId: crypto.randomUUID(), path: file })).assetVersionId
    host = await createWebHost({ socketPath: daemon.socketPath, tokenPath: daemon.tokenPath, staticDir: join(root, 'apps/web/dist/client') })
    browser = await chromium.launch({ executablePath: chromePath(), headless: true })
    page = await browser.newPage({ locale: 'en-US', viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 })
    page.setDefaultTimeout(5000)
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(host.url, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: 'Shot previz', exact: true }).waitFor()
    await page.getByText('Codex 1', { exact: true }).click()
  })
  beforeEach(async () => {
    referenceLimit = 9
    const existing = await nodes()
    if (existing.length) await apply(existing.map(node => ({ op: 'node.delete', nodeId: node.nodeId })))
    const created = await apply([{ op: 'node.create', tempId: 'script', kind: 'script', title: 'Street scene', x: -700, y: 0 }, { op: 'node.create', tempId: 'previz', kind: 'previz', title: 'Board', x: 0, y: 0, w: 600, h: 250 }])
    scriptId = created.idMap.script!; nodeId = created.idMap.previz!
    const script = (await nodes()).find(node => node.nodeId === scriptId)!
    await apply([{ op: 'script.replace', slotId: script.slots[0]!.slotId, expectedRevision: script.slots[0]!.revision, doc: { assets: [], shots: [1, 2, 3].map(n => ({ tempId: `s${n}`, description: `Street shot ${n}`, framePrompt: `Follow the layout for shot ${n}`, videoPrompt: `Camera moves for shot ${n}`, transition: 'cut', characterIds: [], propIds: [] })) } }])
    const content = (await nodes()).find(node => node.nodeId === scriptId)!.slots[0]!.content
    shotIds = content.type === 'script' ? content.doc.shots.map(shot => shot.id) : []
    const previz = await current()
    await apply([{ op: 'previz.set', slotId: previz.slots[0]!.slotId, expectedRevision: previz.slots[0]!.revision, doc: { ...EMPTY_PREVIZ, panels: Array.from({ length: 8 }, (_, index) => ({ ...emptyPrevizPanel(`p${index + 1}`), image, sketch: image, note: `Camera layout ${index + 1}` })) } }])
    await card().waitFor()
    await page.getByRole('button', { name: 'Fit canvas', exact: true }).click()
  })
  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail') await page.screenshot({ path: join(screenshots, `failure-${task.name.replace(/[^a-z0-9]+/gi, '-').slice(0, 80)}.png`), animations: 'disabled' })
    await page.keyboard.press('Escape')
  })
  afterAll(async () => {
    await browser?.close(); admin?.close(); await host?.close(); await daemon?.stop('user_quit')
    vi.unstubAllEnvs(); if (dir) removeTempDir(dir)
  })

  it('selects every tile locally, anchors its popover below the card and keeps vertical wheels on the canvas', async () => {
    const revision = (await current()).slots[0]!.revision
    expect(await card().getByRole('button', { name: /^Panel \d/ }).count()).toBe(8)
    await select()
    expect(await tile().getAttribute('aria-pressed')).toBe('true')
    const anchor = (await card().boundingBox())!
    const panel = (await popover().boundingBox())!
    expect(Math.abs(panel.x + panel.width / 2 - (anchor.x + anchor.width / 2))).toBeLessThan(2)
    expect(Math.abs(panel.y - (anchor.y + anchor.height) - 16)).toBeLessThan(3)
    expect(panel.y + panel.height).toBeLessThan(1000)
    expect(await popover().evaluate(element => { const box = element.getBoundingClientRect(); return [[box.left + 5, box.top + 5], [box.right - 5, box.bottom - 5]].every(([x, y]) => element.contains(document.elementFromPoint(x!, y!))) })).toBe(true)
    await page.screenshot({ path: join(screenshots, 'selected-panel.png'), animations: 'disabled' })
    const strip = card().getByRole('group', { name: 'Panels' })
    await strip.hover()
    const initialScroll = await strip.evaluate(element => element.scrollLeft)
    const transform = await page.locator('.react-flow__viewport').getAttribute('style')
    await page.mouse.wheel(0, 100)
    await expect.poll(() => page.locator('.react-flow__viewport').getAttribute('style')).not.toBe(transform)
    expect(await strip.evaluate(element => element.scrollLeft)).toBe(initialScroll)
    await strip.hover()
    const panned = await page.locator('.react-flow__viewport').getAttribute('style')
    const horizontalStart = await strip.evaluate(element => element.scrollLeft)
    // Chrome normalizes wheel deltas for deviceScaleFactor; assert the delivered delta exactly.
    const [delta] = await Promise.all([
      strip.evaluate(element => new Promise<number>(resolve => element.addEventListener('wheel', event => resolve((event as WheelEvent).deltaX), { once: true }))),
      page.mouse.wheel(200, 0),
    ])
    expect(delta).toBeGreaterThan(0)
    await expect.poll(() => strip.evaluate(element => element.scrollLeft)).toBe(horizontalStart + delta)
    expect(await page.locator('.react-flow__viewport').getAttribute('style')).toBe(panned)
    const scrolled = await strip.evaluate(element => element.scrollLeft)
    await page.keyboard.down('Shift'); await page.mouse.wheel(0, 100); await page.keyboard.up('Shift')
    await expect.poll(() => strip.evaluate(element => element.scrollLeft)).toBeGreaterThan(scrolled)
    const zoom = await page.locator('.react-flow__viewport').evaluate(element => new DOMMatrixReadOnly(getComputedStyle(element).transform).a)
    const beforeZoomScroll = await strip.evaluate(element => element.scrollLeft)
    await page.keyboard.down('Control'); await page.mouse.wheel(0, -100); await page.keyboard.up('Control')
    await expect.poll(() => page.locator('.react-flow__viewport').evaluate(element => new DOMMatrixReadOnly(getComputedStyle(element).transform).a)).toBeGreaterThan(zoom)
    expect(await strip.evaluate(element => element.scrollLeft)).toBe(beforeZoomScroll)
    await card().getByRole('button', { name: 'Scroll panels earlier' }).click()
    await expect.poll(() => strip.evaluate(element => element.scrollLeft)).toBe(0)
    await tile().focus(); await page.keyboard.press('ArrowRight')
    await expect.poll(() => tile(2).getAttribute('aria-pressed')).toBe('true')
    await page.keyboard.press('Escape')
    await expect.poll(() => popover().count()).toBe(0)
    expect((await current()).slots[0]!.revision).toBe(revision)
    await select()
    await page.getByRole('tab', { name: 'Canvas', exact: true }).click()
    await expect.poll(() => popover().count()).toBe(0)
    await page.getByRole('button', { name: 'Fit canvas', exact: true }).click()
    await tile(2).dblclick()
    const editor = page.getByRole('dialog', { name: 'Board', exact: true })
    await editor.waitFor()
    expect(await editor.getByRole('textbox', { name: 'Panel note', exact: true }).inputValue()).toBe('Camera layout 2')
    await editor.getByRole('button', { name: 'Close editor', exact: true }).click()

  })

  it.each([false, true])('generates a composition frame with its panel input and optional shot link (%s)', async linked => {
    if (linked) await setPanel({ shot: { scriptNodeId: scriptId, shotId: shotIds[0]! } })
    await select()
    const generation = popover().getByRole('region', { name: 'Generation', exact: true })
    await generation.getByRole('button', { name: 'Model and parameters', exact: true }).click()
    const picker = generation.getByRole('dialog', { name: 'Choose model and parameters', exact: true })
    expect(await picker.evaluate(element => {
      const box = element.getBoundingClientRect()
      return [[box.left + 8, box.top + 8], [box.right - 8, box.top + 8], [box.left + 8, box.bottom - 8], [box.right - 8, box.bottom - 8]].every(([x, y]) => element.contains(document.elementFromPoint(x!, y!)))
    })).toBe(true)
    const trigger = (await generation.getByRole('button', { name: 'Model and parameters', exact: true }).boundingBox())!
    const opened = (await picker.boundingBox())!
    expect(opened.x + opened.width).toBeLessThanOrEqual(trigger.x)
    expect(trigger.x - (opened.x + opened.width)).toBeLessThan(40)
    expect(opened.y).toBeLessThanOrEqual(trigger.y + trigger.height)
    expect(opened.y + opened.height).toBeGreaterThanOrEqual(trigger.y)
    await picker.getByRole('button', { name: /mock-image-1/ }).click()
    await generation.getByRole('button', { name: 'Model and parameters', exact: true }).click()
    await generation.getByRole('textbox', { name: 'Prompt', exact: true }).fill('Follow the layout and create a finished cinematic frame')
    const before = (await nodes()).filter(node => node.kind === 'image').length
    await generation.getByRole('button', { name: 'Generate frame', exact: true }).click()
    await finishJobs(before, 'image')
    const output = (await nodes()).find(node => node.kind === 'image')!
    expect(output.x).toBeGreaterThan((await current()).x + (await current()).w)
    expect(output.slots.find(slot => slot.slotKey === 'main')?.content).toMatchObject({ type: 'asset', mime: 'image/png' })
    expect(output.shot).toEqual(linked ? { scriptNodeId: scriptId, shotId: shotIds[0], role: 'first' } : null)
    expect(daemon.spaces.get(spaceId)!.db.select().from(s.jobInputs).all().some(input => input.assetVersionId === image)).toBe(true)
  })

  it.each([false, true])('uses a finished first frame for video with optional shot link (%s)', async linked => {
    await setPanel({ use: 'frame', frameRole: 'first', sketch: null, underlay: image, shot: linked ? { scriptNodeId: scriptId, shotId: shotIds[0]! } : null })
    await select()
    await popover().getByRole('button', { name: 'Model and parameters', exact: true }).click()
    const picker = popover().getByRole('dialog', { name: 'Choose model and parameters', exact: true })
    expect(await picker.getByRole('button', { name: /mock-image-1/ }).count()).toBe(0)
    await picker.getByRole('button', { name: /mock-video-1/ }).click()
    await popover().getByRole('button', { name: 'Model and parameters', exact: true }).click()
    if (linked) {
      const beforeJobs = daemon.spaces.get(spaceId)!.db.select().from(s.generationJobs).all().length
      await popover().getByRole('region', { name: 'Previz', exact: true }).getByRole('button', { name: 'Set as first frame', exact: true }).click()
      await expect.poll(async () => (await nodes()).filter(node => node.shot?.role === 'first').length).toBe(1)
      expect(daemon.spaces.get(spaceId)!.db.select().from(s.generationJobs).all()).toHaveLength(beforeJobs)
    }
    await popover().getByRole('button', { name: 'Generate video', exact: true }).click()
    await finishJobs(0, 'video')
    const output = (await nodes()).find(node => node.kind === 'video')!
    const first = (await nodes()).find(node => node.kind === 'image')!
    expect(first.slots[0]!.content).toMatchObject({ type: 'asset', assetVersionId: image })
    expect(first.shot).toEqual(linked ? { scriptNodeId: scriptId, shotId: shotIds[0], role: 'first' } : null)
    expect(output.shot).toEqual(linked ? { scriptNodeId: scriptId, shotId: shotIds[0], role: 'video' } : null)
    const job = daemon.spaces.get(spaceId)!.db.select().from(s.generationJobs).all().at(-1)!
    expect(JSON.stringify(job)).toContain(first.slots[0]!.slotId)
    expect(job.kind).toBe('video')
  })

  it('sets a last frame freely and disables missing-shot and missing-picture actions', async () => {
    await setPanel({ use: 'frame', frameRole: 'last' })
    await select()
    expect(await popover().getByRole('button', { name: 'Set as last frame', exact: true }).isDisabled()).toBe(true)
    expect(await popover().getByText('Link a shot first', { exact: true }).count()).toBe(1)
    await popover().getByRole('combobox', { name: 'Shot', exact: true }).selectOption(JSON.stringify({ scriptNodeId: scriptId, shotId: shotIds[0] }))
    await expect.poll(() => popover().getByRole('button', { name: 'Set as last frame', exact: true }).isEnabled()).toBe(true)
    const jobCount = daemon.spaces.get(spaceId)!.db.select().from(s.generationJobs).all().length
    await popover().getByRole('button', { name: 'Set as last frame', exact: true }).click()
    await expect.poll(async () => (await nodes()).filter(node => node.shot?.role === 'last').length).toBe(1)
    expect(daemon.spaces.get(spaceId)!.db.select().from(s.generationJobs).all()).toHaveLength(jobCount)
    await setPanel({ image: null })
    await expect.poll(() => popover().getByText('Draw or import first', { exact: true }).count()).toBe(1)
    expect(await popover().getByRole('button', { name: 'Set as last frame', exact: true }).isDisabled()).toBe(true)
  })

  it('previews order links without writing, preserves existing links, and allows several panels on one shot', async () => {
    await setPanel({ shot: { scriptNodeId: scriptId, shotId: shotIds[2]! } })
    const before = await doc()
    await card().getByRole('button', { name: 'Link in order', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Link in order', exact: true })
    await dialog.waitFor()
    expect(await dialog.getByRole('row').nth(1).textContent()).toContain('Shot 3')
    expect(await dialog.getByRole('row').nth(8).textContent()).toContain('Unlinked')
    expect(await doc()).toEqual(before)
    await page.screenshot({ path: join(screenshots, 'link-in-order.png'), animations: 'disabled' })
    await dialog.getByRole('button', { name: 'Confirm links', exact: true }).click()
    await expect.poll(async () => (await doc()).panels[1]!.shot?.shotId).toBe(shotIds[1])
    expect((await doc()).panels[0]!.shot?.shotId).toBe(shotIds[2])
    await card().getByRole('button', { name: 'Link in order', exact: true }).click()
    await dialog.getByRole('checkbox', { name: 'Replace existing links' }).check()
    await dialog.getByRole('button', { name: 'Confirm links', exact: true }).click()
    await expect.poll(async () => (await doc()).panels[0]!.shot?.shotId).toBe(shotIds[0])
    await select(2)
    await popover().getByRole('combobox', { name: 'Shot', exact: true }).selectOption(JSON.stringify({ scriptNodeId: scriptId, shotId: shotIds[0] }))
    await expect.poll(async () => (await doc()).panels.filter(panel => panel.shot?.shotId === shotIds[0]).length).toBe(2)
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Expand storyboard', exact: true }).click()
    const editor = page.getByRole('dialog', { name: 'Script editor', exact: true })
    await editor.waitFor()
    const row = editor.getByRole('row', { name: 'Shot 1', exact: true })
    expect(await row.getByRole('button', { name: /^Locate Panel/ }).count()).toBe(2)
    await row.getByRole('button', { name: 'Locate Panel 2', exact: true }).click()
    await expect.poll(() => tile(2).getAttribute('aria-pressed')).toBe('true')
  })

  it('groups shot choices by script, clears links and previews a different script', async () => {
    const otherId = (await apply([{ op: 'node.create', tempId: 'other', kind: 'script', title: 'Second script', x: -700, y: 400 }])).idMap.other!
    const other = (await nodes()).find(node => node.nodeId === otherId)!
    await apply([{ op: 'script.replace', slotId: other.slots[0]!.slotId, expectedRevision: other.slots[0]!.revision,
      doc: { assets: [], shots: [{ tempId: 'other-shot', description: 'Other scene', transition: 'cut', characterIds: [], propIds: [] }] } }])
    const content = (await nodes()).find(node => node.nodeId === otherId)!.slots[0]!.content
    const otherShot = content.type === 'script' ? content.doc.shots[0]!.id : ''
    await select()
    const selectShot = popover().getByRole('combobox', { name: 'Shot', exact: true })
    // Native select groups are hidden from the accessibility tree while the picker is collapsed.
    expect(await selectShot.evaluate(element => [...element.querySelectorAll('optgroup')].map(group => ({ label: group.label, options: group.querySelectorAll('option').length })))).toEqual([
      { label: 'Street scene', options: 3 }, { label: 'Second script', options: 1 },
    ])
    await selectShot.selectOption(JSON.stringify({ scriptNodeId: otherId, shotId: otherShot }))
    await expect.poll(async () => (await doc()).panels[0]!.shot).toEqual({ scriptNodeId: otherId, shotId: otherShot })
    await selectShot.selectOption('')
    await expect.poll(async () => (await doc()).panels[0]!.shot).toBeNull()
    await page.keyboard.press('Escape')
    const before = await doc()
    await card().getByRole('button', { name: 'Link in order', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Link in order', exact: true })
    await dialog.getByRole('combobox', { name: 'Script', exact: true }).selectOption(otherId)
    expect(await dialog.getByRole('row').nth(1).textContent()).toContain('Other scene')
    expect(await dialog.getByRole('row').nth(2).textContent()).toContain('Unlinked')
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    expect(await doc()).toEqual(before)
  })

  it('uses composition in a batch, warns about dropped inputs, and preserves finished panels without jobs', async () => {
    await setPanel({ shot: { scriptNodeId: scriptId, shotId: shotIds[0]! } })
    await card().getByRole('button', { name: 'Batch generate', exact: true }).click()
    let dialog = page.getByRole('dialog', { name: 'Batch generate shot images', exact: true })
    await dialog.getByText('1 composition references used', { exact: true }).waitFor()
    await dialog.getByRole('button', { name: 'Confirm generation', exact: true }).click()
    await expect.poll(async () => (await nodes()).filter(node => node.shot?.role === 'first').length, { timeout: 10_000 }).toBe(1)
    await expect.poll(async () => (await admin.call('script.batch.list', {})).batches.at(-1)?.status, { timeout: 10_000 }).toBe('succeeded')
    expect(daemon.spaces.get(spaceId)!.db.select().from(s.jobInputs).all().some(input => input.assetVersionId === image)).toBe(true)
    referenceLimit = 0
    await card().getByRole('button', { name: 'Batch generate', exact: true }).click()
    dialog = page.getByRole('dialog', { name: 'Batch generate shot images', exact: true })
    await dialog.getByRole('complementary', { name: 'Dropped composition references' }).waitFor()
    expect(await dialog.getByText(/This model accepts no reference images/).count()).toBe(1)
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await setPanel({ use: 'frame', frameRole: 'first', underlay: image, sketch: null })
    const jobs = daemon.spaces.get(spaceId)!.db.select().from(s.generationJobs).all().length
    await card().getByRole('button', { name: 'Batch generate', exact: true }).click()
    await dialog.getByText('1 panel frames reused', { exact: true }).waitFor()
    await dialog.getByRole('button', { name: 'Confirm generation', exact: true }).click()
    await expect.poll(async () => (await admin.call('script.batch.list', {})).batches.at(-1)?.status).toBe('succeeded')
    expect(daemon.spaces.get(spaceId)!.db.select().from(s.generationJobs).all()).toHaveLength(jobs)
    const frame = (await nodes()).filter(node => node.shot?.role === 'first').at(-1)!
    expect(frame.slots[0]!.content).toMatchObject({ type: 'asset', assetVersionId: image })
    referenceLimit = 9
    await card().getByRole('button', { name: 'Batch generate', exact: true }).click()
    await dialog.getByRole('combobox', { name: 'Generate', exact: true }).selectOption('video')
    const videoDialog = page.getByRole('dialog', { name: 'Batch generate videos', exact: true })
    await videoDialog.getByText('1 shot · 1 generation job', { exact: true }).waitFor()
    await videoDialog.getByRole('button', { name: 'Confirm generation', exact: true }).click()
    await expect.poll(async () => (await admin.call('script.batch.list', {})).batches.at(-1)?.status, { timeout: 10_000 }).toBe('succeeded')
    expect(daemon.spaces.get(spaceId)!.db.select().from(s.generationJobs).all()).toHaveLength(jobs + 1)
    expect((await nodes()).filter(node => node.shot?.role === 'video')).toHaveLength(1)

  })

  it('marks only key-requiring generation as Paid and keeps previz actions free', async () => {
    await select()
    const generation = popover().getByRole('region', { name: 'Generation', exact: true })
    const preparation = popover().getByRole('region', { name: 'Previz', exact: true })
    expect(await generation.getByText('Paid', { exact: true }).count()).toBe(0)
    expect(await preparation.getByText('Free', { exact: true }).count()).toBe(1)
    await generation.getByRole('button', { name: 'Model and parameters', exact: true }).click()
    let picker = generation.getByRole('dialog', { name: 'Choose model and parameters', exact: true })
    await picker.getByRole('button', { name: /Fixture image/ }).click()
    await expect.poll(() => generation.getByText('Paid', { exact: true }).count()).toBe(1)
    expect(await preparation.getByText('Paid', { exact: true }).count()).toBe(0)
    await page.screenshot({ path: join(screenshots, 'paid-generation.png'), animations: 'disabled' })
    expect(await generation.getByRole('button', { name: 'Generate frame', exact: true }).isDisabled()).toBe(true)
    await generation.getByRole('button', { name: 'Model and parameters', exact: true }).click()
    await preparation.getByRole('combobox', { name: 'Shot', exact: true }).selectOption(JSON.stringify({ scriptNodeId: scriptId, shotId: shotIds[0] }))
    await expect.poll(async () => (await doc()).panels[0]!.shot?.shotId).toBe(shotIds[0])
    await preparation.getByRole('radio', { name: 'Use as last frame', exact: true }).click()
    await expect.poll(() => preparation.getByRole('radio', { name: 'Use as last frame', exact: true }).isChecked()).toBe(true)
    const jobs = daemon.spaces.get(spaceId)!.db.select().from(s.generationJobs).all().length
    await expect.poll(() => preparation.getByRole('button', { name: 'Set as last frame', exact: true }).isEnabled()).toBe(true)
    await preparation.getByRole('button', { name: 'Set as last frame', exact: true }).click()
    await expect.poll(async () => (await nodes()).filter(node => node.shot?.role === 'last').length).toBe(1)
    expect(daemon.spaces.get(spaceId)!.db.select().from(s.generationJobs).all()).toHaveLength(jobs)
    expect(await generation.getByText('Paid', { exact: true }).count()).toBe(1)
    await preparation.getByRole('radio', { name: 'Composition reference', exact: true }).click()
    await expect.poll(() => preparation.getByRole('radio', { name: 'Composition reference', exact: true }).isChecked()).toBe(true)
    await generation.getByRole('button', { name: 'Model and parameters', exact: true }).click()
    await picker.getByRole('button', { name: /mock-image-1/ }).click()
    await expect.poll(() => generation.getByText('Paid', { exact: true }).count()).toBe(0)
    await generation.getByRole('button', { name: 'Model and parameters', exact: true }).click()
    await preparation.getByRole('radio', { name: 'Use as first frame', exact: true }).click()
    await expect.poll(() => preparation.getByRole('radio', { name: 'Use as first frame', exact: true }).isChecked()).toBe(true)
    await expect.poll(async () => (await doc()).panels[0]!.use).toBe('frame')
    await generation.getByRole('button', { name: 'Model and parameters', exact: true }).click()
    picker = generation.getByRole('dialog', { name: 'Choose model and parameters', exact: true })
    await picker.getByRole('button', { name: /HTML/i }).click()
    expect(await generation.getByText('Paid', { exact: true }).count()).toBe(0)
    expect(keyFixtureCalls).toBe(0)
  })

  it('shows stale links and creates an Agent draft with a reference without sending', async () => {
    await setPanel({ shot: { scriptNodeId: scriptId, shotId: shotIds[0]! } })
    await apply([{ op: 'node.delete', nodeId: scriptId }])
    await tile().getByText('Stale shot link', { exact: true }).waitFor()
    await select()
    const before = (await admin.call('session.getTranscript', { sessionId })).items
    await popover().getByRole('combobox', { name: 'Shot', exact: true }).selectOption('ask')
    const composer = page.getByRole('textbox', { name: 'Message the Agent', exact: true })
    await expect.poll(() => composer.inputValue()).toContain('Read the panels and notes')
    expect(await page.getByRole('button', { name: 'Remove reference' }).count()).toBe(1)
    expect((await admin.call('session.getTranscript', { sessionId })).items).toEqual(before)
    expect(errors).toEqual([])
  })
})
