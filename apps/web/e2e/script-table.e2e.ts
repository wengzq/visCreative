import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright-core'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CanvasOp, NodeView, ScriptDoc, ScriptOp } from '@vis/protocol'
import { createMemorySecretStore } from '../../../services/studiod/src/secret-store'
import { startStudiod, type Studiod } from '../../../services/studiod/src/studiod'
import { createWebHost, type WebHost } from '../src/host/server'
import { openStudiodLink, type StudiodLink } from '../src/host/studiod-link'
import { chromePath, removeTempDir } from './platform'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const ready = existsSync(chromePath()) && existsSync(join(root, 'apps/web/dist/client/index.html'))
const screenshots = join(tmpdir(), 'vis-0023-S3-e2e')
let dir: string
let daemon: Studiod
let host: WebHost
let admin: StudiodLink
let browser: Browser
let page: Page
let nodeId: string
let projectSpaceId: string
const errors: string[] = []
const nodes = async (): Promise<NodeView[]> => (await admin.call('canvas.get')).nodes
const apply = (ops: CanvasOp[]) => admin.call('canvas.apply', { requestId: crypto.randomUUID(), ops })
const script = async () => (await nodes()).find(node => node.nodeId === nodeId)!
const main = async () => (await script()).slots.find(slot => slot.slotKey === 'main')!
const doc = async (): Promise<ScriptDoc> => {
  const content = (await main()).content
  if (content.type !== 'script') throw new Error('Expected script content')
  return content.doc
}
const patch = async (ops: ScriptOp[]) => apply([{ op: 'script.patch', slotId: (await main()).slotId, ops }])
const editor = () => page.getByRole('dialog', { name: 'Script editor', exact: true })
const row = (number: number) => editor().getByRole('row', { name: `Shot ${number}`, exact: true })
const cell = (number: number, name: string) => `Shot ${number} · ${name}`
const edit = async (number: number, field: string, value: string) => {
  await editor().getByRole('button', { name: cell(number, field), exact: true }).click()
  const input = editor().getByRole('textbox', { name: cell(number, field), exact: true })
  await input.fill(value)
  await input.press('Enter')
}

async function seedScript() {
  const { idMap } = await apply([{ op: 'node.create', tempId: 'script', kind: 'script', x: 200, y: 120 }])
  nodeId = idMap.script
  await page.getByRole('button', { name: 'Expand storyboard', exact: true }).click()
  await editor().waitFor()
}

async function addShots(count: number) {
  const before = (await doc()).shots.length
  for (let index = 0; index < count; index++) {
    await editor().getByRole('button', { name: 'Add shot', exact: true }).click()
    await expect.poll(async () => (await doc()).shots.length).toBe(before + index + 1)
  }
}

describe.skipIf(!ready)('Script storyboard table', () => {
  beforeAll(async () => {
    mkdirSync(screenshots, { recursive: true })
    dir = mkdtempSync(join(tmpdir(), 'vis-script-table-'))
    vi.stubEnv('VIS_PROJECTS_DIR', join(dir, 'projects'))
    daemon = await startStudiod({ dataDir: dir, studiodVersion: 'e2e', runtimes: {}, providers: [], defaults: {}, secretStore: createMemorySecretStore() })
    const { spaceId } = daemon.spaces.create('Script table acceptance')
    projectSpaceId = spaceId
    admin = await openStudiodLink({ socketPath: daemon.socketPath, tokenPath: daemon.tokenPath })
    await admin.call('events.subscribe', { spaceId })
    host = await createWebHost({ socketPath: daemon.socketPath, tokenPath: daemon.tokenPath, staticDir: join(root, 'apps/web/dist/client') })
    browser = await chromium.launch({ executablePath: chromePath(), headless: true })
  })
  beforeEach(async () => {
    const existing = await nodes()
    if (existing.length) await apply(existing.map(node => ({ op: 'node.delete', nodeId: node.nodeId })))
    errors.length = 0
    page = await browser.newPage({ locale: 'en-US', viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 })
    page.setDefaultTimeout(5000)
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(host.url, { waitUntil: 'domcontentloaded' })
    await page.locator('.react-flow__pane').waitFor()
  })
  afterEach(async ({ task }) => {
    try {
      if (task.result?.state === 'fail') await page.screenshot({ path: join(screenshots, `${task.name.replaceAll(/[^a-z0-9]+/gi, '-')}.png`), animations: 'disabled' })
      expect(errors).toEqual([])
    } finally { await page?.close() }
  })
  afterAll(async () => {
    await browser?.close()
    admin?.close()
    await host?.close()
    await daemon?.stop('user_quit')
    vi.unstubAllEnvs()
    removeTempDir(dir)
  })

  it('creates a script through the canvas entry without a provider or model picker', async () => {
    const create = page.getByRole('button', { name: 'New script', exact: true })
    await expect.poll(() => create.isEnabled()).toBe(true)
    await create.click()
    await expect.poll(async () => (await nodes()).filter(node => node.kind === 'script').length).toBe(1)
    nodeId = (await nodes()).find(node => node.kind === 'script')!.nodeId
    await page.getByRole('region', { name: 'Script or editing instructions', exact: true }).waitFor()
    expect(await page.getByRole('button', { name: 'Model and parameters', exact: true }).count()).toBe(0)
    expect((await doc()).shots).toEqual([])
    expect((await script()).slots.some(slot => slot.slotKey === 'prompt')).toBe(true)
    await page.getByRole('button', { name: 'Expand storyboard', exact: true }).last().click()
    await editor().waitFor()
    await editor().getByRole('tab', { name: 'Settings', exact: true }).click()
    await page.keyboard.press('Escape')
    await editor().waitFor({ state: 'hidden' })
  })

  it('adds three shots, edits with undo and redo, reorders, sets continuity, inserts asset chips and exports', async () => {
    await seedScript()
    await addShots(3)
    await edit(1, 'Description', 'Opening scene')
    await expect.poll(async () => (await doc()).shots[0]?.description, { timeout: 5_000 }).toBe('Opening scene')
    await editor().getByRole('tab', { name: 'Shots', exact: true }).focus()
    await page.keyboard.press('ControlOrMeta+Z')
    await expect.poll(async () => (await doc()).shots[0]?.description, { timeout: 5_000 }).toBe('')
    await page.keyboard.press('ControlOrMeta+Shift+Z')
    await expect.poll(async () => (await doc()).shots[0]?.description, { timeout: 5_000 }).toBe('Opening scene')
    const before = (await doc()).shots.map(shot => shot.id)
    await row(3).getByRole('button', { name: cell(3, 'Drag to reorder shot'), exact: true }).dragTo(row(1), { targetPosition: { x: 20, y: 5 } })
    await expect.poll(async () => (await doc()).shots.map(shot => shot.id), { timeout: 5_000 }).toEqual([before[2], before[0], before[1]])
    await expect.poll(() => row(2).getByRole('button', { name: cell(2, 'Description'), exact: true }).textContent(), { timeout: 5_000 }).toBe('Opening scene')
    await row(2).getByRole('combobox', { name: cell(2, 'Transition'), exact: true }).selectOption('continuous')
    await expect.poll(async () => (await doc()).shots[1]?.transition, { timeout: 5_000 }).toBe('continuous')
    await expect.poll(() => row(1).getByRole('combobox', { name: cell(1, 'Transition'), exact: true }).isDisabled(), { timeout: 5_000 }).toBe(true)
    await expect.poll(() => row(1).getByRole('cell').first().getAttribute('class'), { timeout: 5_000 }).toContain('vis-script-chain is-start')
    await expect.poll(() => row(2).getByRole('cell').first().getAttribute('class'), { timeout: 5_000 }).toContain('vis-script-chain is-end')
    const { idMap } = await patch([{ kind: 'asset.insert', tempId: 'hero', asset: { kind: 'character', name: 'Hero', description: 'Lead character' } }])
    // Typing @ before the asset arrives leaves the choices closed.
    await editor().getByRole('article', { name: 'Hero', exact: true, includeHidden: true }).waitFor({ state: 'attached' })
    await row(1).getByRole('button', { name: cell(1, 'Description'), exact: true }).click()
    const input = editor().getByRole('textbox', { name: cell(1, 'Description'), exact: true })
    await input.fill('Follow @')
    await editor().getByRole('listbox', { name: 'Insert asset', exact: true }).getByRole('option', { name: 'Hero', exact: true }).click()
    await input.press('Enter')
    await expect.poll(async () => (await doc()).shots[0]?.description, { timeout: 5_000 }).toBe(`Follow {{asset:${idMap.hero}}}`)
    await expect.poll(() => row(1).getByRole('button', { name: cell(1, 'Description'), exact: true }).textContent(), { timeout: 5_000 }).toBe('Follow Hero')
    await row(1).getByRole('checkbox', { name: 'Select shot 1', exact: true }).check()
    await row(2).getByRole('checkbox', { name: 'Select shot 2', exact: true }).check()
    const bulk = editor().getByRole('form', { name: 'Set selected shots', exact: true })
    await bulk.getByRole('spinbutton', { name: 'Duration (s)', exact: true }).fill('4')
    await bulk.getByRole('button', { name: 'Apply', exact: true }).click()
    await expect.poll(async () => (await doc()).shots.slice(0, 2).map(shot => shot.durationSec), { timeout: 5_000 }).toEqual([4, 4])
    await editor().getByRole('tab', { name: 'Shots', exact: true }).focus()
    await page.keyboard.press('ControlOrMeta+Z')
    await expect.poll(async () => (await doc()).shots.slice(0, 2).map(shot => shot.durationSec ?? null), { timeout: 5_000 }).toEqual([null, null])
    for (const [label, extension] of [['Export CSV', '.csv'], ['Export Markdown', '.md']] as const) {
      const pending = page.waitForEvent('download')
      await editor().getByRole('button', { name: label, exact: true }).click()
      const download = await pending
      expect(download.suggestedFilename()).toBe(`storyboard${extension}`)
      const body = readFileSync((await download.path())!, 'utf8')
      expect(body).toContain('Follow Hero')
      expect(body).toContain('Opening scene')
      expect(body.trim().split(/\r?\n/)).toHaveLength(extension === '.csv' ? 4 : 5)
    }
    await editor().getByRole('button', { name: 'Clear selection', exact: true }).click()
    await page.screenshot({ path: join(screenshots, 'storyboard.png'), animations: 'disabled' })
    await page.keyboard.press('Escape')
    await editor().waitFor({ state: 'hidden' })
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('aria-label')), { timeout: 5_000 }).toBe('Expand storyboard')
  })

  it('keeps the edit-start revision, shows the current row on conflict and supports prompt and keyboard editing', async () => {
    await seedScript()
    await addShots(1)
    await row(1).getByRole('button', { name: cell(1, 'Description'), exact: true }).click()
    const input = editor().getByRole('textbox', { name: cell(1, 'Description'), exact: true })
    await input.fill('User draft')
    const shot = (await doc()).shots[0]!
    await patch([{ kind: 'shot.update', shotId: shot.id, rev: shot.rev, fields: { description: 'Concurrent current row' } }])
    await input.press('Enter')
    await editor().getByRole('status').filter({ hasText: 'Another editor changed this row.' }).waitFor()
    expect((await doc()).shots[0]?.description).toBe('Concurrent current row')
    expect(await row(1).getByRole('button', { name: cell(1, 'Description'), exact: true }).textContent()).toBe('Concurrent current row')
    await row(1).getByRole('button', { name: cell(1, 'Description'), exact: true }).click()
    await editor().getByRole('textbox', { name: cell(1, 'Description'), exact: true }).fill('Discard this')
    await page.keyboard.press('Escape')
    expect(await editor().isVisible()).toBe(true)
    expect((await doc()).shots[0]?.description).toBe('Concurrent current row')
    await row(1).getByRole('button', { name: cell(1, 'Description'), exact: true }).click()
    await editor().getByRole('textbox', { name: cell(1, 'Description'), exact: true }).fill('Tab saved')
    await page.keyboard.press('Tab')
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe(cell(1, 'End state'))
    await edit(1, 'End state', 'The door closes')
    await editor().getByRole('tab', { name: 'Prompts', exact: true }).click()
    await edit(1, 'End frame prompt', 'A closed door')
    await expect.poll(async () => (await doc()).shots[0]?.promptState).toBe('edited')
    await expect.poll(() => editor().getByRole('status', { name: 'Prompt state', exact: true }).textContent()).toBe('Edited')
    await editor().getByRole('tab', { name: 'Shots', exact: true }).click()
    await edit(1, 'Description', 'Changed source')
    await editor().getByRole('tab', { name: 'Prompts', exact: true }).click()
    await expect.poll(() => editor().getByRole('status', { name: 'Prompt state', exact: true }).textContent()).toBe('Stale')
  })

  it('virtualizes 200 rows and keeps a full-screen editor usable on mobile', async () => {
    await seedScript()
    const slot = await main()
    await apply([{ op: 'script.replace', slotId: slot.slotId, expectedRevision: slot.revision, doc: {
      assets: [], shots: Array.from({ length: 200 }, (_, index) => ({ tempId: `shot-${index}`, description: `Scene ${index + 1}`, transition: index % 3 ? 'continuous' : 'cut' })),
    } }])
    await row(1).waitFor()
    await expect.poll(() => editor().getByRole('row').count()).toBeLessThan(30)
    await editor().getByRole('table', { name: 'Shots', exact: true }).evaluate(table => { table.parentElement!.scrollTop = table.parentElement!.scrollHeight })
    await row(200).waitFor()
    expect(await editor().getByRole('row').count()).toBeLessThan(30)
    await page.setViewportSize({ width: 390, height: 844 })
    expect(await editor().evaluate(element => element.getBoundingClientRect().width)).toBe(390)
    await page.screenshot({ path: join(screenshots, 'mobile-200-shots.png'), animations: 'disabled' })
  })

  it('keeps deleted asset markers visible and focuses linked image outputs from their thumbnail', async () => {
    await seedScript()
    await addShots(1)
    const shot = (await doc()).shots[0]!
    const { idMap } = await patch([
      { kind: 'asset.insert', tempId: 'hero', asset: { kind: 'character', name: 'Hero', description: '' } },
      { kind: 'shot.update', shotId: shot.id, rev: shot.rev, fields: { description: 'Use {{asset:hero}}' } },
    ])
    const asset = (await doc()).assets[0]!
    await patch([{ kind: 'asset.delete', assetId: idMap.hero, rev: asset.rev }])
    await expect.poll(() => row(1).getByRole('button', { name: cell(1, 'Description'), exact: true }).textContent()).toBe('Use Deleted asset')
    expect((await doc()).shots[0]?.description).toBe(`Use {{asset:${idMap.hero}}}`)
    const space = daemon.spaces.get(projectSpaceId)!
    const staged = await space.assets.stageBytes(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"><rect width="40" height="30" fill="teal"/></svg>'))
    const image = space.assets.registerVersion(space.db, { staged, kind: 'image', mime: 'image/svg+xml', origin: 'import', width: 40, height: 30 })
    const created = await apply([{
      op: 'node.create', tempId: 'frame', kind: 'image', title: 'Linked frame', x: 900, y: 120,
      content: { assetVersionId: image.assetVersionId }, shot: { scriptNodeId: nodeId, shotId: shot.id, role: 'first' },
    }])
    const output = row(1).getByRole('button', { name: 'Focus First frame node · Linked frame', exact: true })
    await expect.poll(() => output.locator('img').evaluateAll(images => images.map(image => (image as HTMLImageElement).naturalWidth))).toEqual([40])
    await output.click()
    await editor().waitFor({ state: 'hidden' })
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-id'))).toBe(created.idMap.frame)
  })
})
