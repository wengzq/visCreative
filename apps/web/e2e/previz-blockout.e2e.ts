import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright-core'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { EMPTY_PREVIZ, emptyPrevizPanel, type CanvasOp, type NodeView, type PrevizDoc, type PrevizPanel } from '@vis/protocol'
import { spaceSchema as s } from '../../../packages/storage/src/index'
import { createMockProvider, createRenderProvider } from '../../../packages/generation/src/index'
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
const screenshots = join(process.platform === 'win32' ? tmpdir() : '/tmp', 'vis-0029/step-c')
const ffmpeg = process.platform === 'darwin' ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg'
let dir: string
let dataDir: string
let daemon: Studiod
let host: WebHost
let admin: StudiodLink
let browser: Browser
let page: Page
let nodeId: string
let scriptId: string
let shotId: string
let image: string
let video: string
let sessionId: string
let spaceId: string
let renderedNodes: NodeView[]
let renderedDoc: PrevizDoc
let extractionConflict = false
let saveFailure: 'error' | 'conflict' | null = null
const requests: { method: string; params: any }[] = []
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
const blockout = () => card().getByRole('region', { name: 'Blockout · Previz only', exact: true })
const editor = () => page.getByRole('dialog', { name: 'Board', exact: true })
const composer = () => page.getByRole('textbox', { name: 'Message the Agent', exact: true })
async function setPanel(fields: Partial<PrevizPanel>, index = 0) {
  const node = await current()
  const slot = node.slots.find(slot => slot.slotKey === 'main')!
  const document = await doc()
  await apply([{ op: 'previz.set', slotId: slot.slotId, expectedRevision: slot.revision, doc: { ...document, rev: document.rev + 1, panels: document.panels.map((panel, i) => i === index ? { ...panel, ...fields, rev: panel.rev + 1 } : panel) } }])
}
async function scene(withVideo = true) {
  const existing = await nodes()
  if (existing.length) await apply(existing.map(node => ({ op: 'node.delete', nodeId: node.nodeId })))
  const created = await apply([{ op: 'node.create', tempId: 'script', kind: 'script', title: 'Camera plan', x: -700, y: 0 }, { op: 'node.create', tempId: 'previz', kind: 'previz', title: 'Board', x: 0, y: 0, w: 650, h: 340 }])
  scriptId = created.idMap.script!; nodeId = created.idMap.previz!
  const script = (await nodes()).find(node => node.nodeId === scriptId)!
  await apply([{ op: 'script.replace', slotId: script.slots[0]!.slotId, expectedRevision: script.slots[0]!.revision, doc: { assets: [], shots: [{ tempId: 'shot', description: 'Two figures beside a box', framePrompt: 'Follow the composition with finished cinematic lighting', transition: 'cut', durationSec: 1, characterIds: [], propIds: [] }] } }])
  const scriptContent = (await nodes()).find(node => node.nodeId === scriptId)!.slots[0]!.content
  shotId = scriptContent.type === 'script' ? scriptContent.doc.shots[0]!.id : ''
  const node = await current()
  await apply([{ op: 'previz.set', slotId: node.slots[0]!.slotId, expectedRevision: node.slots[0]!.revision, doc: { ...EMPTY_PREVIZ, panels: [1, 2].map(n => ({ ...emptyPrevizPanel(`panel-${n}`), image, sketch: image, note: n === 1 ? 'Camera starts wide' : 'Dolly toward the figures', durationSec: 0.5, shot: { scriptNodeId: scriptId, shotId } })) } }])
  if (withVideo) await apply([{ op: 'node.create', tempId: 'video', kind: 'video', title: 'Camera blockout', x: 800, y: 0, content: { assetVersionId: video }, inputNodeIds: [nodeId], shot: { scriptNodeId: scriptId, shotId, role: 'previz' } }])
}

// A real local render is shared by the UI cases; only the Agent process is fake.
describe.skipIf(!ready)('Previz blockout workflow', () => {
  beforeAll(async () => {
    mkdirSync(screenshots, { recursive: true })
    dir = mkdtempSync(join(tmpdir(), 'vis-previz-blockout-'))
    dataDir = join(dir, 'data')
    vi.stubEnv('VIS_PROJECTS_DIR', join(dir, 'projects'))
    daemon = await startStudiod({ dataDir, studiodVersion: 'previz-blockout-e2e', secretStore: createMemorySecretStore(),
      providers: [createMockProvider({ latencyMs: 0 }), createRenderProvider({ workDir: join(dir, 'render'), chromePath: chromePath(), ffmpegPath: ffmpeg })], defaults: { image: { provider: 'mock' }, video: { provider: 'mock' } },
      runtimes: { codex: codexRuntime({ dataDir, socketPath: studiodEndpoint(dataDir), codexPath: join(root, 'apps/web/e2e/fake-codex.mjs'), visMcp: { command: process.execPath, args: [cli, 'mcp'] } }) },
    })
    spaceId = daemon.spaces.create('Blockout workflow').spaceId
    admin = await openStudiodLink({ socketPath: daemon.socketPath, tokenPath: daemon.tokenPath })
    await admin.call('events.subscribe', { spaceId })
    sessionId = (await admin.call('session.create', { requestId: crypto.randomUUID(), agentKind: 'codex' })).sessionId
    const file = join(dir, 'layout.png')
    execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=steelblue:size=320x180', '-frames:v', '1', '-y', file])
    image = (await admin.call('asset.import', { requestId: crypto.randomUUID(), path: file })).assetVersionId
    await scene(false)
    await admin.call('session.sendMessage', { requestId: crypto.randomUUID(), sessionId, text: 'previz-blockout', refs: [] })
    await vi.waitFor(async () => expect(JSON.stringify((await admin.call('session.getTranscript', { sessionId })).items)).toContain('Completed previz-blockout'), { timeout: 25_000 })
    await vi.waitFor(async () => expect((await admin.call('session.list')).sessions.find((session: any) => session.sessionId === sessionId)?.activeTurnId).toBeNull())
    const content = (await nodes()).find(node => node.kind === 'video' && node.inputs?.includes(nodeId))!.slots.find(slot => slot.slotKey === 'main')!.content
    if (content.type !== 'asset') throw new Error('Expected a rendered video')
    video = content.assetVersionId
    // Agents render but never write frames into panels; the user's action does.
    expect((await doc()).panels.every(panel => panel.blockout === null)).toBe(true)
    const main = (await nodes()).find(node => node.nodeId === nodeId)!.slots.find(slot => slot.slotKey === 'main')!
    await admin.call('previz.extractBlockout', { requestId: crypto.randomUUID(), slotId: main.slotId, expectedRevision: main.revision, assetVersionId: video })
    renderedNodes = await nodes(); renderedDoc = await doc()
    host = await createWebHost({ socketPath: daemon.socketPath, tokenPath: daemon.tokenPath, staticDir: join(root, 'apps/web/dist/client') })
    browser = await chromium.launch({ executablePath: chromePath(), headless: true })
    page = await browser.newPage({ locale: 'en-US', viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 })
    page.setDefaultTimeout(5000)
    page.on('pageerror', error => errors.push(error.message))
    await page.routeWebSocket('**/ws?*', ws => {
      const server = ws.connectToServer()
      ws.onMessage(async raw => {
        const message = JSON.parse(String(raw))
        requests.push(message)
        if (message.method === 'previz.extractBlockout' && extractionConflict) {
          extractionConflict = false
          await setPanel({ note: 'A concurrent camera note' })
        }
        if (message.method === 'canvas.apply' && message.params.ops.some((op: CanvasOp) => op.op === 'previz.set') && saveFailure) {
          const failure = saveFailure
          saveFailure = null
          if (failure === 'error') {
            ws.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'Save failed', data: { code: 'unavailable', reason: 'host.studiod_disconnected' } } }))
            return
          }
          await setPanel({ note: 'Remote camera note' })
        }
        server.send(raw)
      })
    })
    await page.goto(host.url, { waitUntil: 'domcontentloaded', timeout: 15_000 })
    await page.getByRole('button', { name: 'Shot previz', exact: true }).waitFor()
    await page.getByText('Codex 1', { exact: true }).click()
  })
  beforeEach(async () => {
    await scene()
    await composer().fill('')
    for (const button of await page.getByRole('button', { name: 'Remove reference', exact: true }).all()) await button.click()
    await card().waitFor()
    await page.getByRole('button', { name: 'Fit canvas', exact: true }).click()
    await page.mouse.move(10, 950)
    requests.length = 0
  })
  afterEach(async ({ task }) => {
    saveFailure = null; extractionConflict = false
    if (task.result?.state === 'fail') await page.screenshot({ path: join(screenshots, `failure-${task.name.replace(/[^a-z0-9]+/gi, '-').slice(0, 80)}.png`), animations: 'disabled' })
    if (await editor().count()) {
      const discard = editor().getByRole('button', { name: 'Close without saving', exact: true })
      if (await discard.count()) await discard.click()
      else await editor().getByRole('button', { name: 'Close editor', exact: true }).click()
    }
    await page.keyboard.press('Escape')
  })
  afterAll(async () => {
    await browser?.close(); admin?.close(); await host?.close(); await daemon?.stop('user_quit')
    vi.unstubAllEnvs(); if (dir) removeTempDir(dir)
  })

  it('runs fake Codex through the real render provider, links its source and extracts without changing drawings', () => {
    const previz = renderedNodes.find(node => node.kind === 'previz')!
    const output = renderedNodes.find(node => node.kind === 'video' && node.inputs?.includes(previz.nodeId))!
    const code = renderedNodes.find(node => node.format === 'code')!
    expect(output.kind).toBe('video')
    expect(output.inputs).toEqual([code.nodeId, previz.nodeId])
    expect(output.shot ?? null).toBeNull()
    expect(code.slots[0]!.content).toMatchObject({ type: 'text', body: expect.stringContaining('/lib/three.module.js') })
    expect(renderedDoc.panels.every(panel => panel.blockout && panel.blockout !== panel.image)).toBe(true)
    expect(renderedDoc.panels.map(panel => [panel.image, panel.sketch])).toEqual([[image, image], [image, image]])
    const job = daemon.spaces.get(spaceId)!.db.select().from(s.generationJobs).all()[0]!
    expect(job.provider).toBe('render')
    expect(JSON.stringify(job)).toContain('"fps":24')
  })

  it('adds a footer draft with its reference and focus without sending, including missing durations', async () => {
    await setPanel({ durationSec: null })
    await composer().fill('Keep the camera low.')
    const before = (await admin.call('session.getTranscript', { sessionId })).items
    const button = card().getByRole('button', { name: 'Render previz', exact: true })
    const footer = await button.evaluate(element => element.closest('footer')?.getBoundingClientRect().toJSON())
    expect(footer).toBeTruthy()
    await button.click()
    await expect.poll(() => composer().inputValue()).toContain('Keep the camera low.\n\nRead this shot previz')
    expect(await composer().inputValue()).toContain('ask for missing durations in one message')
    await expect.poll(() => composer().evaluate(element => element === document.activeElement)).toBe(true)
    expect(await page.getByRole('button', { name: 'Remove reference', exact: true }).count()).toBe(1)
    expect((await admin.call('session.getTranscript', { sessionId })).items).toEqual(before)
    expect(requests.some(request => request.method === 'session.sendMessage' || request.method === 'generation.submit')).toBe(false)
  })

  it('saves from the editor header, closes it, and focuses the unsent draft', async () => {
    await card().getByRole('button', { name: 'Open shot previz', exact: true }).click()
    const button = editor().getByRole('button', { name: 'Render previz', exact: true })
    expect(await button.evaluate(element => Boolean(element.closest('header')))).toBe(true)
    await editor().getByRole('textbox', { name: 'Panel note', exact: true }).fill('Save before rendering')
    await button.click()
    await expect.poll(() => editor().count()).toBe(0)
    expect((await doc()).panels[0]!.note).toBe('Save before rendering')
    await expect.poll(() => composer().inputValue()).toContain('Read this shot previz')
    await expect.poll(() => composer().evaluate(element => element === document.activeElement)).toBe(true)
    expect(requests.some(request => request.method === 'session.sendMessage')).toBe(false)
  })

  it.each(['error', 'conflict'] as const)('keeps the editor and adds no draft when save returns %s', async failure => {
    await card().getByRole('button', { name: 'Open shot previz', exact: true }).click()
    await editor().getByRole('textbox', { name: 'Panel note', exact: true }).fill('Unsaved direction')
    saveFailure = failure
    await editor().getByRole('button', { name: 'Render previz', exact: true }).click()
    await editor().getByRole('alert').first().waitFor()
    expect(await editor().count()).toBe(1)
    expect(await editor().getByRole('textbox', { name: 'Panel note', exact: true }).inputValue()).toBe('Unsaved direction')
    expect(await composer().inputValue()).toBe('')
    expect(await page.getByRole('button', { name: 'Remove reference', exact: true }).count()).toBe(0)
    if (failure === 'conflict') await editor().getByRole('button', { name: 'Load their version', exact: true }).click()
  })

  it('shows the newest associated poster above the footer with no player until preview or playback', async () => {
    await apply([{ op: 'node.create', tempId: 'new', kind: 'video', title: 'New blockout', x: 800, y: 300, content: { assetVersionId: video }, inputNodeIds: [nodeId] }])
    await expect.poll(() => blockout().locator('img').count()).toBe(1)
    expect(await blockout().locator('video').count()).toBe(0)
    expect(await blockout().getByRole('button', { name: 'Play', exact: true }).evaluate(element => getComputedStyle(element.parentElement!).opacity)).toBe('1')
    const poster = (await blockout().boundingBox())!
    const footer = (await card().getByRole('button', { name: 'Render previz', exact: true }).boundingBox())!
    const strip = (await card().getByRole('group', { name: 'Panels', exact: true }).boundingBox())!
    expect(poster.y).toBeGreaterThanOrEqual(strip.y + strip.height - 1)
    expect(poster.y + poster.height).toBeLessThanOrEqual(footer.y)
    await page.screenshot({ path: join(screenshots, 'card-blockout.png'), animations: 'disabled' })
    await blockout().getByRole('button', { name: 'Play', exact: true }).click()
    await expect.poll(() => blockout().locator('video').count()).toBe(1)
    await expect.poll(() => blockout().locator('video').evaluate((element: HTMLVideoElement) => element.paused)).toBe(false)
  })

  it('names panels missing durations and preserves every picture on extraction failure', async () => {
    await setPanel({ durationSec: null }, 1)
    const before = await doc()
    const track = card().locator('.vis-previz-track')
    const height = (await track.boundingBox())!.height
    await blockout().getByRole('button', { name: 'Use blockout frames', exact: true }).click()
    await card().getByRole('alert').filter({ hasText: 'Set durations for these panels: Panel 2 · Dolly toward the figures' }).waitFor()
    expect(await doc()).toEqual(before)
    // The node height is fixed, so a message must not take room from the panels.
    expect((await track.boundingBox())!.height).toBe(height)
  })

  it('offers an even split only when no panel has a duration, and changes nothing if declined', async () => {
    const before = await doc()
    for (const index of before.panels.keys()) await setPanel({ durationSec: null }, index)
    const cleared = await doc()
    page.once('dialog', dialog => void dialog.dismiss())
    await blockout().getByRole('button', { name: 'Use blockout frames', exact: true }).click()
    await card().getByRole('alert').filter({ hasText: 'Set durations for these panels' }).waitFor()
    expect(await doc()).toEqual(cleared)
    let question = ''
    page.once('dialog', dialog => { question = dialog.message(); void dialog.accept() })
    await blockout().getByRole('button', { name: 'Use blockout frames', exact: true }).click()
    await expect.poll(async () => (await doc()).panels.every(panel => panel.durationSec !== null && panel.blockout !== null), { timeout: 10_000 }).toBe(true)
    expect(question).toContain(`across ${before.panels.length} panels`)
    const durations = (await doc()).panels.map(panel => panel.durationSec!)
    expect(durations.reduce((sum, value) => sum + value, 0)).toBeCloseTo(before.panels.reduce((sum, panel) => sum + panel.durationSec!, 0), 1)
    expect(Math.max(...durations) - Math.min(...durations)).toBeLessThan(.01)
    for (const [index, panel] of before.panels.entries()) await setPanel({ durationSec: panel.durationSec, blockout: panel.blockout }, index)
  })

  it('moves the node when dragged by a panel or the blockout row, and a plain click still selects the panel', async () => {
    const drag = async (from: { x: number; y: number }) => {
      const start = (await current()).x
      await page.mouse.move(from.x, from.y)
      await page.mouse.down()
      await page.mouse.move(from.x + 60, from.y + 10, { steps: 6 })
      await page.mouse.move(from.x + 120, from.y + 20, { steps: 6 })
      await page.mouse.up()
      await expect.poll(async () => (await current()).x - start).toBeGreaterThan(50)
    }
    const tile = card().locator('.vis-previz-tile').first()
    const box = (await tile.boundingBox())!
    await drag({ x: box.x + box.width / 2, y: box.y + box.height / 2 })
    const row = (await blockout().getByText('Blockout · Previz only', { exact: true }).boundingBox())!
    await drag({ x: row.x + 8, y: row.y + row.height / 2 })
    await card().locator('.vis-previz-tile').first().click()
    await expect.poll(() => card().locator('.vis-previz-tile').first().getAttribute('aria-pressed')).toBe('true')
    await page.keyboard.press('Escape')
  })

  it('rereads and retries a real revision conflict once, marks frames, and batches with blockout composition', async () => {
    const before = await doc()
    extractionConflict = true
    await blockout().getByRole('button', { name: 'Use blockout frames', exact: true }).click()
    await expect.poll(async () => (await doc()).panels.every(panel => Boolean(panel.blockout)), { timeout: 10_000 }).toBe(true)
    const attempts = requests.filter(request => request.method === 'previz.extractBlockout')
    expect(attempts).toHaveLength(2)
    expect(attempts[1]!.params.expectedRevision).toBe(attempts[0]!.params.expectedRevision + 1)
    const extracted = await doc()
    expect(extracted.panels[0]!.note).toBe('A concurrent camera note')
    expect(extracted.panels.map(panel => [panel.image, panel.sketch, panel.underlay])).toEqual(before.panels.map(panel => [panel.image, panel.sketch, panel.underlay]))
    const tile = card().getByRole('button', { name: 'Panel 1, Shot 1', exact: true })
    // The server read above can win the race against the event that updates this card.
    await expect.poll(() => tile.getByLabel('Composition uses the blockout frame', { exact: true }).count()).toBe(1)
    expect(await tile.getByRole('img').getAttribute('src')).toContain(image)
    await card().getByRole('status').filter({ hasText: 'Saved blockout frames to 2 panels' }).waitFor()
    await tile.click()
    await page.getByRole('region', { name: 'Panel controls', exact: true }).getByText('Composition uses the blockout frame', { exact: true }).waitFor()
    await page.keyboard.press('Escape')
    await card().getByRole('button', { name: 'Batch generate', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Batch generate shot images', exact: true })
    await dialog.getByText('2 composition references used', { exact: true }).waitFor()
    await dialog.getByRole('button', { name: 'Confirm generation', exact: true }).click()
    await expect.poll(async () => (await admin.call('script.batch.list', {})).batches.at(-1)?.status, { timeout: 10_000 }).toBe('succeeded')
    const jobs = daemon.spaces.get(spaceId)!.db.select().from(s.generationJobs).all()
    const inputs = daemon.spaces.get(spaceId)!.db.select().from(s.jobInputs).all().filter(input => input.jobId === jobs.at(-1)!.id)
    expect(inputs.map(input => input.assetVersionId)).toEqual(extracted.panels.map(panel => panel.blockout))
  })

  it('shows the blockout frame on a panel without a picture and generates a composition from it', async () => {
    const before = (await doc()).panels[0]!
    // Each case rebuilds its scene, so use an existing frame as this panel's blockout.
    const frame = before.image!
    await setPanel({ image: null, sketch: null, underlay: null, blockout: frame }, 0)
    const tile = card().getByRole('button', { name: 'Panel 1, Shot 1', exact: true })
    await expect.poll(() => tile.getByRole('img').first().getAttribute('src')).toContain(frame)
    await tile.click()
    const controls = page.getByRole('region', { name: 'Panel controls', exact: true })
    expect(await controls.locator('.vis-previz-selected-picture').getAttribute('src')).toContain(frame)
    await controls.getByText('Composition uses the blockout frame', { exact: true }).waitFor()
    expect(await controls.getByText('Draw or import first', { exact: true }).count()).toBe(0)
    await page.keyboard.press('Escape')
    await setPanel({ image: before.image, sketch: before.sketch, underlay: before.underlay, blockout: before.blockout }, 0)
  })

  it('draws over the blockout frame of a panel without a picture and keeps it in the saved picture', async () => {
    const before = (await doc()).panels[0]!
    // The steelblue layout image stands in for a blockout frame, so white means the frame was dropped.
    const frame = before.image!
    await setPanel({ image: null, sketch: null, underlay: null, blockout: frame }, 0)
    await card().getByRole('button', { name: 'Open shot previz', exact: true }).click()
    const surface = editor().getByRole('img', { name: 'Panel drawing', exact: true })
    expect(await editor().locator('.vis-pv-paper > img').getAttribute('src')).toContain(frame)
    await expect.poll(() => surface.getAttribute('aria-disabled')).toBe('false')
    const box = (await surface.boundingBox())!
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.5)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.5, { steps: 12 })
    await page.mouse.up()
    await expect.poll(async () => (await doc()).panels[0]!.image, { timeout: 10_000 }).toMatch(/^astv_/)
    await expect.poll(() => editor().getByRole('status').filter({ hasText: 'Saved' }).count()).toBe(1)
    const saved = (await doc()).panels[0]!
    expect(saved).toMatchObject({ blockout: frame, underlay: null })
    expect(saved.image).not.toBe(frame)
    await editor().getByRole('button', { name: 'Close editor', exact: true }).click()
    const tile = card().getByRole('button', { name: 'Panel 1, Shot 1', exact: true }).getByRole('img').first()
    await expect.poll(() => tile.getAttribute('src')).toContain(saved.image!)
    // Sample a corner away from the stroke: the frame, not a blank page, sits under the ink.
    const pixel = await tile.evaluate(async (element: HTMLImageElement) => {
      const image = new Image()
      image.src = element.src
      await image.decode()
      const canvas = document.createElement('canvas')
      canvas.width = image.naturalWidth; canvas.height = image.naturalHeight
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(image, 0, 0)
      return [...ctx.getImageData(4, 4, 1, 1).data.slice(0, 3)]
    })
    expect(pixel[2]! - pixel[0]!).toBeGreaterThan(60)
    await setPanel({ image: before.image, sketch: before.sketch, underlay: before.underlay, blockout: before.blockout }, 0)
  })

  it('keeps shot links and the blockout row when the script and video are hidden working documents', async () => {
    const video = (await nodes()).find(node => node.kind === 'video')!
    await apply([{ op: 'node.setMeta', nodeId: scriptId, purpose: 'working' }, { op: 'node.setMeta', nodeId: video.nodeId, purpose: 'working' }])
    await expect.poll(() => page.locator('.react-flow__node').filter({ hasText: 'Camera plan' }).count()).toBe(0)
    await card().getByRole('button', { name: 'Panel 1, Shot 1', exact: true }).waitFor()
    await blockout().getByRole('button', { name: 'Use blockout frames', exact: true }).waitFor()
    await apply([{ op: 'node.setMeta', nodeId: scriptId, purpose: 'artifact' }, { op: 'node.setMeta', nodeId: video.nodeId, purpose: 'artifact' }])
  })

  it('shows a distinct previz-only thumbnail in the script row, separate from finished outputs', async () => {
    await page.getByRole('button', { name: 'Expand storyboard', exact: true }).click()
    const script = page.getByRole('dialog', { name: 'Script editor', exact: true })
    const row = script.getByRole('row', { name: 'Shot 1', exact: true })
    const preview = row.getByRole('button', { name: /Blockout · Previz only/ })
    await preview.scrollIntoViewIfNeeded()
    expect(await preview.getByText('Blockout · Previz only', { exact: true }).count()).toBe(1)
    expect(await preview.evaluate(element => getComputedStyle(element).borderTopStyle)).toBe('dashed')
    expect(await preview.locator('video').count()).toBe(0)
    expect(await preview.locator('img').getAttribute('src')).toContain('/poster')
    expect(await row.getByRole('button', { name: /^Focus (First frame|Last frame|Video)/ }).count()).toBe(0)
    await page.screenshot({ path: join(screenshots, 'script-blockout.png'), animations: 'disabled' })
    await page.keyboard.press('Escape')
    expect(errors).toEqual([])
  })
})
