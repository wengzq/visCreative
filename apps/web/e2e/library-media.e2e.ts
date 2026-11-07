import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { LibraryAsset, NodeView, WorkItemView } from '@vis/protocol'
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
const shots = join(tmpdir(), 'shots')
let dir: string
let daemon: Studiod
let host: WebHost
let admin: StudiodLink
let browser: Browser
let page: Page
let projectId: string
const errors: string[] = []
const library = () => page.getByRole('complementary', { name: 'Library', exact: true })
const detail = () => library().getByRole('region', { name: 'Media details', exact: true })
const assets = async (archived = false): Promise<LibraryAsset[]> => (await admin.call('asset.list', { archived })).items
const canvasNodes = async (): Promise<NodeView[]> => (await admin.call('canvas.get', {})).nodes
const waitForVisiblePreviews = () => expect.poll(() => library().locator('img').evaluateAll(images => images.filter(image => {
  const rect = image.getBoundingClientRect()
  return rect.top < innerHeight && rect.bottom > 0
}).every(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0)), { timeout: 15_000 }).toBe(true)

describe.skipIf(!ready)('Media library and organize runs', () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'vis-library-media-'))
    mkdirSync(shots, { recursive: true })
    vi.stubEnv('VIS_PROJECTS_DIR', join(dir, 'projects'))
    daemon = await startStudiod({
      dataDir: dir, studiodVersion: 'library-media-e2e',
      runtimes: { codex: codexRuntime({ dataDir: dir, socketPath: studiodEndpoint(dir), codexPath: join(root, 'apps/web/e2e/fake-codex.mjs'), visMcp: { command: process.execPath, args: [cli, 'mcp'] } }) },
      providers: [createMockProvider({ latencyMs: 0 })], defaults: { image: { provider: 'mock' } }, secretStore: createMemorySecretStore(),
    })
    const { spaceId } = daemon.spaces.create('Dawn · Media library')
    projectId = spaceId
    admin = await openStudiodLink({ socketPath: daemon.socketPath, tokenPath: daemon.tokenPath })
    await admin.call('events.subscribe', { spaceId })
    host = await createWebHost({ socketPath: daemon.socketPath, tokenPath: daemon.tokenPath, staticDir: join(root, 'apps/web/dist/client') })
    browser = await chromium.launch({ executablePath: chromePath(), headless: true })
    page = await browser.newPage({ locale: 'en-US', viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 })
    page.setDefaultTimeout(10_000)
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(host.url)
    await page.getByRole('button', { name: 'Library', exact: true }).click()
    await library().waitFor()
    await library().getByText('Your media library is empty', { exact: true }).first().waitFor()
    await page.screenshot({ path: join(shots, 'A2-empty-dark.png'), animations: 'disabled' })
  })

  afterAll(async () => {
    await browser?.close()
    admin?.close()
    await host?.close()
    await daemon?.stop('user_quit')
    vi.unstubAllEnvs()
    removeTempDir(dir)
  })

  it('imports files without nodes, selects one library session, preserves corrections on relabel, undoes, filters, archives and drags to canvas', async () => {
    const image = join(dir, 'portrait.png')
    const audio = join(dir, 'ambience.wav')
    const video = join(dir, 'arrival.mp4')
    execFileSync('ffmpeg', ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i', 'color=c=0x596b8e:s=320x180', '-frames:v', '1', image])
    execFileSync('ffmpeg', ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', audio])
    execFileSync('ffmpeg', ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=15:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video])
    await library().locator('input[type=file]').setInputFiles([image, audio, video])
    await expect.poll(async () => (await assets()).length, { timeout: 10_000 }).toBe(3)
    expect(await canvasNodes()).toHaveLength(0)
    await expect.poll(() => library().getByRole('listitem').count(), { timeout: 10_000 }).toBe(3)
    await waitForVisiblePreviews()
    await page.screenshot({ path: join(shots, 'A2-populated-dark.png'), animations: 'disabled' })
    const { item } = await admin.call('work.create', { requestId: crypto.randomUUID(), title: 'Library curator', chat: { agentKind: 'codex' } }) as { item: WorkItemView }
    await library().getByRole('button', { name: 'Organize with Agent', exact: true }).click()
    const chooser = page.getByRole('dialog', { name: 'Choose library session', exact: true })
    await chooser.getByRole('combobox', { name: 'Library session', exact: true }).selectOption(item.sessions[0]!.sessionId)
    await chooser.getByRole('button', { name: 'Confirm', exact: true }).click()
    const confirm = page.getByRole('dialog', { name: 'Organize media', exact: true })
    await confirm.getByText('3 unlabeled assets; 2 need viewing.', { exact: true }).waitFor()
    await confirm.getByText("Uses the selected session's model tokens. No generation provider is called.", { exact: true }).waitFor()
    await page.screenshot({ path: join(shots, 'A2-organize-dark.png'), animations: 'disabled' })
    await confirm.getByRole('button', { name: 'Start organizing', exact: true }).click()
    await expect.poll(async () => (await assets()).every(asset => asset.labeledBy === 'agent'), { timeout: 20_000 }).toBe(true)
    await library().getByRole('button', { name: 'Dawn portrait', exact: true }).click()
    await detail().getByRole('textbox', { name: 'Name', exact: true }).fill('My dawn portrait')
    await detail().getByRole('button', { name: 'Save changes', exact: true }).click()
    await expect.poll(async () => (await assets()).find(asset => asset.kind === 'image')?.displayName).toBe('My dawn portrait')
    await page.screenshot({ path: join(shots, 'A2-detail-dark.png'), animations: 'disabled' })
    await detail().getByRole('button', { name: 'Close details', exact: true }).click()
    await expect.poll(() => library().getByRole('button', { name: 'Organize with Agent', exact: true }).isEnabled()).toBe(true)
    await library().getByRole('button', { name: 'Organize with Agent', exact: true }).click()
    await confirm.waitFor()
    expect(await chooser.count()).toBe(0)
    await confirm.getByRole('checkbox', { name: 'Relabel everything except my edits', exact: true }).check()
    await confirm.getByRole('button', { name: 'Start organizing', exact: true }).click()
    await expect.poll(async () => (await assets()).some(asset => asset.displayName === 'Arrival clip revised'), { timeout: 20_000 }).toBe(true)
    expect((await assets()).find(asset => asset.kind === 'image')?.displayName).toBe('My dawn portrait')
    await expect.poll(() => library().getByRole('button', { name: 'Organize with Agent', exact: true }).isEnabled()).toBe(true)
    await library().getByText('Recent runs', { exact: true }).click()
    await library().getByRole('button', { name: 'Undo this run', exact: true }).first().click()
    await page.getByRole('dialog', { name: 'Undo this run', exact: true }).getByRole('button', { name: 'Undo this run', exact: true }).click()
    await library().getByText('Reverted 3; skipped 0.', { exact: true }).waitFor()
    await expect.poll(async () => (await assets()).some(asset => asset.displayName === 'Arrival clip')).toBe(true)
    const tagGroup = library().getByRole('group', { name: 'Tags', exact: true })
    await tagGroup.getByRole('button', { name: 'image', exact: true }).click()
    await expect.poll(() => library().getByRole('listitem').count()).toBe(1)
    await tagGroup.getByRole('button', { name: 'image', exact: true }).click()
    await library().getByRole('button', { name: 'Station ambience', exact: true }).click()
    await detail().getByRole('button', { name: 'Archive media', exact: true }).click()
    await page.getByRole('dialog', { name: 'Archive this media?', exact: true }).getByRole('button', { name: 'Archive media', exact: true }).click()
    await expect.poll(async () => (await assets(true)).length).toBe(1)
    await library().getByRole('button', { name: 'Archived', exact: true }).click()
    await library().getByRole('button', { name: 'Station ambience', exact: true }).waitFor()
    await library().getByRole('button', { name: 'Archived', exact: true }).click()
    const source = library().getByRole('button', { name: 'My dawn portrait', exact: true })
    const pane = page.locator('.react-flow__pane')
    await source.dragTo(pane, { targetPosition: { x: 160, y: 180 } })
    await expect.poll(async () => (await canvasNodes()).length).toBe(1)
    await source.click()
    await detail().getByRole('button', { name: 'My dawn portrait', exact: true }).click()
    const node = (await canvasNodes())[0]!
    await expect.poll(() => page.locator(`.react-flow__node[data-id="${node.nodeId}"]`).getAttribute('class')).toContain('selected')
    await detail().getByRole('button', { name: 'Close details', exact: true }).click()
    await library().getByRole('tab', { name: 'Settings', exact: true }).click()
    await page.reload()
    await expect.poll(() => library().getByRole('tab', { name: 'Settings', exact: true }).getAttribute('aria-selected')).toBe('true')
    await library().getByRole('tab', { name: 'Media', exact: true }).click()
    expect(errors).toEqual([])
  }, 90_000)

  it('confirms agent labels, bulk edits two assets, searches and refreshes setting chips', async () => {
    await library().getByRole('button', { name: 'Arrival clip', exact: true }).click()
    await detail().getByRole('button', { name: 'Looks right', exact: true }).click()
    await expect.poll(async () => (await assets()).find(asset => asset.kind === 'video')?.userFields).toEqual(['displayName', 'category', 'tags'])
    await detail().getByRole('button', { name: 'Close details', exact: true }).click()
    await library().getByRole('checkbox', { name: 'Select My dawn portrait', exact: true }).check()
    await library().getByRole('checkbox', { name: 'Select Arrival clip', exact: true }).check()
    await library().getByRole('button', { name: 'Edit selection', exact: true }).click()
    const bulk = page.getByRole('dialog', { name: 'Edit selected media', exact: true })
    await bulk.getByRole('checkbox', { name: 'Apply category', exact: true }).check()
    await bulk.getByRole('textbox', { name: 'Category', exact: true }).fill('Review')
    await bulk.getByRole('checkbox', { name: 'Apply tags', exact: true }).check()
    await bulk.getByRole('textbox', { name: 'Tags', exact: true }).fill('curated, dawn')
    await bulk.getByRole('button', { name: 'Save changes', exact: true }).click()
    await bulk.getByText('Saved 2; failed 0.', { exact: true }).waitFor()
    await bulk.getByRole('button', { name: 'Done', exact: true }).click()
    await expect.poll(async () => (await assets()).every(asset => asset.category === 'Review')).toBe(true)
    await library().getByRole('searchbox', { name: 'Search media', exact: true }).fill('portrait')
    await expect.poll(() => library().getByRole('listitem').count(), { timeout: 10_000 }).toBe(1)
    await library().getByRole('searchbox', { name: 'Search media', exact: true }).fill('')
    const image = (await assets()).find(asset => asset.kind === 'image')!
    const setting = await admin.call('entity.create', { requestId: crypto.randomUUID(), kind: 'character', name: 'Dawn traveler', members: [{ assetId: image.assetId, role: 'image' }], refs: [{ assetVersionId: image.latest.assetVersionId }] })
    const card = library().getByRole('listitem', { name: 'My dawn portrait', exact: true })
    await card.getByText('Dawn traveler', { exact: true }).waitFor()
    await admin.call('entity.update', { entityId: setting.id, expectedRevision: setting.revision, name: 'Traveler at dawn' })
    await card.getByText('Traveler at dawn', { exact: true }).waitFor()
    await page.screenshot({ path: join(shots, 'A2-reviewed-dark.png'), animations: 'disabled' })
    expect(errors).toEqual([])
  }, 30_000)

  it('keeps a dense mixed library aligned and collapsible', async () => {
    const space = daemon.spaces.get(projectId)!
    const palette = ['#c8a586', '#687e8a', '#948c99', '#6f8771', '#b69c77']
    for (let index = 0; index < 29; index++) {
      const color = palette[index % palette.length]!
      const staged = await space.assets.stageBytes(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240"><rect width="240" height="240" fill="${color}"/><circle cx="${45 + index % 5 * 30}" cy="65" r="28" fill="#eed7ac"/><path d="M0 190 70 95 135 190 190 130 240 190V240H0Z" fill="#304554"/><path d="M0 205 105 150 170 205 240 165V240H0Z" fill="#4b6260"/></svg>`))
      const image = space.assets.registerVersion(space.db, { staged, kind: 'image', mime: 'image/svg+xml', origin: 'import', width: 240, height: 240, displayName: `Dawn landscape · Study ${index + 1}` })
      await admin.call('asset.update', { assetId: image.assetId, expectedRevision: 1, category: ['Landscape', 'Character', 'Location'][index % 3], tags: ['dawn'] })
    }
    for (let index = 0; index < 5; index++) {
      const audio = space.assets.registerVersion(space.db, { staged: await space.assets.stageFile(join(dir, 'ambience.wav')), kind: 'audio', mime: 'audio/wav', origin: 'import', durationMs: 2000, displayName: ['Platform footsteps', 'Morning birds', 'Train arrival', 'Distant announcement', 'City waking'][index]! })
      await admin.call('asset.update', { assetId: audio.assetId, expectedRevision: 1, category: 'Ambience' })
      const video = space.assets.registerVersion(space.db, { staged: await space.assets.stageFile(join(dir, 'arrival.mp4')), kind: 'video', mime: 'video/mp4', origin: 'import', width: 320, height: 180, durationMs: 2000, displayName: `Station arrival · Take ${index + 1}` })
      await admin.call('asset.update', { assetId: video.assetId, expectedRevision: 1, category: 'Clips' })
    }
    await expect.poll(async () => (await assets()).length, { timeout: 10_000 }).toBe(41)
    await library().getByRole('region', { name: 'Audio', exact: true }).getByText('City waking', { exact: true }).waitFor()
    await waitForVisiblePreviews()
    await page.screenshot({ path: join(shots, 'A2-dense-dark.png'), animations: 'disabled' })
    await library().getByRole('button', { name: 'Collapse Images', exact: true }).click()
    expect(await library().getByRole('region', { name: 'Images', exact: true }).getByRole('listitem').count()).toBe(0)
    await library().getByRole('button', { name: 'Expand Images', exact: true }).click()
    await library().getByRole('region', { name: 'Video', exact: true }).scrollIntoViewIfNeeded()
    await waitForVisiblePreviews()
    await page.screenshot({ path: join(shots, 'A2-dense-video-dark.png'), animations: 'disabled' })
    expect(errors).toEqual([])
  }, 30_000)
})
