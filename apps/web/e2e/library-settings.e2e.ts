import { existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { CanvasOp, EntityProposalView, EntityView, LibraryAsset, NodeView, ScriptDoc, WorkItemView } from '@vis/protocol'
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
const rid = () => crypto.randomUUID()
const nodes = async (): Promise<NodeView[]> => (await admin.call('canvas.get', {})).nodes
const apply = (ops: CanvasOp[]) => admin.call('canvas.apply', { requestId: rid(), ops })
const settings = async (): Promise<EntityView[]> => (await admin.call('entity.list', { includeDeleted: false })).items
const proposals = async (): Promise<EntityProposalView[]> => (await admin.call('entity.proposalList', { status: 'pending' })).items
const doc = async (nodeId: string): Promise<ScriptDoc> => {
  const content = (await nodes()).find(node => node.nodeId === nodeId)!.slots.find(slot => slot.slotKey === 'main')!.content
  if (content.type !== 'script') throw new Error('Expected a script document')
  return content.doc
}
const mainSlot = async (nodeId: string) => (await nodes()).find(node => node.nodeId === nodeId)!.slots.find(slot => slot.slotKey === 'main')!
const library = () => page.getByRole('complementary', { name: 'Library', exact: true })
const settingEditor = () => page.getByRole('dialog', { name: 'Edit setting', exact: true })
const openLibrary = async () => {
  if (!await library().isVisible()) await page.getByRole('button', { name: 'Library', exact: true }).click()
  await library().getByRole('tab', { name: 'Settings', exact: true }).click()
}

describe.skipIf(!ready)('Project settings library', () => {
  beforeAll(async () => {
    mkdirSync(shots, { recursive: true })
    dir = mkdtempSync(join(tmpdir(), 'vis-library-settings-'))
    vi.stubEnv('VIS_PROJECTS_DIR', join(dir, 'projects'))
    daemon = await startStudiod({
      dataDir: dir, studiodVersion: 'library-settings-e2e',
      runtimes: { codex: codexRuntime({ dataDir: dir, socketPath: studiodEndpoint(dir), codexPath: join(root, 'apps/web/e2e/fake-codex.mjs'), visMcp: { command: process.execPath, args: [cli, 'mcp'] } }) },
      providers: [], defaults: {}, secretStore: createMemorySecretStore(),
    })
    projectId = daemon.spaces.create('Settings acceptance').spaceId
    admin = await openStudiodLink({ socketPath: daemon.socketPath, tokenPath: daemon.tokenPath })
    await admin.call('events.subscribe', { spaceId: projectId })
    host = await createWebHost({ socketPath: daemon.socketPath, tokenPath: daemon.tokenPath, staticDir: join(root, 'apps/web/dist/client') })
    browser = await chromium.launch({ executablePath: chromePath(), headless: true })
    page = await browser.newPage({ locale: 'en-US', viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 })
    page.setDefaultTimeout(10_000)
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(host.url)
    await page.locator('.react-flow__pane').waitFor()
  })
  afterAll(async () => {
    await page?.close()
    await browser?.close()
    admin?.close()
    await host?.close()
    await daemon?.stop('user_quit')
    vi.unstubAllEnvs()
    removeTempDir(dir)
  })

  it('reviews a fake Agent merge, casts across scripts, preserves covers and unmerges accepted members', async () => {
    try {
      await openLibrary()
      await library().getByText('No settings yet', { exact: true }).waitFor()
      await page.screenshot({ path: join(shots, 'settings-empty-dark.png'), animations: 'disabled' })
      await library().getByRole('button', { name: 'Close library', exact: true }).click()

      const space = daemon.spaces.get(projectId)!
      const images = []
      for (const [index, color] of ['#325986', '#b18a61', '#658e83'].entries()) {
        const staged = await space.assets.stageBytes(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="240" height="180"><rect width="240" height="180" fill="${color}"/><circle cx="120" cy="64" r="30" fill="#ddcab7"/><path d="M60 180v-50a60 60 0 0 1 120 0v50" fill="#263e55"/></svg>`))
        const image = space.assets.registerVersion(space.db, { staged, kind: 'image', mime: 'image/svg+xml', origin: 'import', width: 240, height: 180 })
        await admin.call('asset.update', { assetId: image.assetId, expectedRevision: 1, displayName: `Portrait ${index + 1}` })
        images.push(image)
      }
      const staged = await space.assets.stageBytes(Buffer.from('RIFFsettings voice fixture'))
      const voice = space.assets.registerVersion(space.db, { staged, kind: 'audio', mime: 'audio/wav', origin: 'import', durationMs: 1000 })
      await admin.call('asset.update', { assetId: voice.assetId, expectedRevision: 1, displayName: 'Hero voice' })
      const { idMap } = await apply([
        { op: 'node.create', tempId: 'ref', kind: 'image', title: 'Lin reference', x: 0, y: 400, content: { assetVersionId: images[0]!.assetVersionId } },
        { op: 'node.create', tempId: 'one', kind: 'script', title: 'Episode one', x: 0, y: 0 },
        { op: 'node.create', tempId: 'two', kind: 'script', title: 'Episode two', x: 500, y: 0 },
      ])
      await apply([{ op: 'script.patch', slotId: (await mainSlot(idMap.one)).slotId, ops: [
        { kind: 'asset.insert', tempId: 'lin', asset: { kind: 'character', name: 'Lin', description: 'A traveler', imageNodeId: idMap.ref } },
        { kind: 'shot.insert', tempId: 'first', afterShotId: null, shot: { description: 'Lin walks', characterIds: ['lin'], framePrompt: 'A traveler walks' } },
      ] }])
      await apply([{ op: 'script.patch', slotId: (await mainSlot(idMap.two)).slotId, ops: [
        { kind: 'shot.insert', tempId: 'second', afterShotId: null, shot: { description: 'Lin arrives', framePrompt: 'A traveler arrives' } },
      ] }])
      const lin = (await settings()).find(item => item.name === 'Lin')!
      const { item } = await admin.call('work.create', { requestId: rid(), title: 'Library curator', chat: { agentKind: 'codex' } }) as { item: WorkItemView }
      const sessionId = item.sessions[0]!.sessionId
      await admin.call('library.setSession', { sessionId })
      const run = await admin.call('library.runStart', { requestId: rid(), kind: 'merge' })
      await admin.call('session.sendMessage', { requestId: rid(), sessionId, text: `library-settings-merge ${run.runId}`, refs: [] })
      await expect.poll(async () => (await proposals()).length, { timeout: 20_000 }).toBe(1)
      const proposal = (await proposals())[0]!
      expect(proposal.runId).toBe(run.runId)
      const coverAsset = images.find(image => image.assetVersionId === proposal.refs?.[0])!
      const omit = images.find(image => image.assetId !== coverAsset.assetId)!
      const omittedName = (await admin.call('asset.list', { limit: 200 })).items.find((item: LibraryAsset) => item.assetId === omit.assetId).displayName
      await openLibrary()
      const pending = library().getByRole('region', { name: 'Pending merges', exact: true })
      await pending.getByRole('checkbox', { name: `Select member ${omittedName}`, exact: true }).uncheck()
      await page.screenshot({ path: join(shots, 'settings-proposal-dark.png'), animations: 'disabled' })
      await pending.getByRole('button', { name: 'Accept', exact: true }).click()
      await expect.poll(async () => (await settings()).find(item => item.name === 'Library Hero')?.members.length).toBe(3)
      const merged = (await settings()).find(item => item.name === 'Library Hero')!
      expect(merged.members).toContainEqual({ assetId: voice.assetId, role: 'voice' })
      const card = library().getByRole('button', { name: 'Library Hero', exact: true })
      await card.getByLabel('Voice', { exact: true }).waitFor()
      expect(await card.getByRole('img', { name: 'Cover', exact: true }).getAttribute('src')).toContain(proposal.refs![0])
      const media = (await admin.call('asset.list', { limit: 200 })).items as LibraryAsset[]
      expect(media.filter(item => item.entityIds.includes(merged.id)).map(item => item.assetId).sort()).toEqual(merged.members.map(member => member.assetId).sort())
      await page.screenshot({ path: join(shots, 'settings-populated-dark.png'), animations: 'disabled' })
      await library().getByRole('button', { name: 'Close library', exact: true }).click()

      await page.getByRole('button', { name: 'Fit canvas', exact: true }).click()
      await page.locator(`.react-flow__node[data-id="${idMap.two}"]`).getByRole('button', { name: 'Expand storyboard', exact: true }).click()
      const editor = page.getByRole('dialog', { name: 'Script editor', exact: true })
      await editor.getByRole('tab', { name: 'Settings', exact: true }).click()
      await editor.getByRole('button', { name: 'Add from library', exact: true }).click()
      const picker = page.getByRole('dialog', { name: 'Add from library', exact: true })
      await picker.getByRole('button', { name: 'Lin', exact: true }).click()
      await expect.poll(async () => (await doc(idMap.two)).castIds).toContain(lin.id)
      const secondDoc = await doc(idMap.two)
      await apply([{ op: 'script.patch', slotId: (await mainSlot(idMap.two)).slotId, ops: [
        { kind: 'shot.update', shotId: secondDoc.shots[0]!.id, rev: secondDoc.shots[0]!.rev, fields: { characterIds: [lin.id], framePrompt: 'Lin arrives' } },
      ] }])
      await editor.getByRole('button', { name: 'Close script editor', exact: true }).click()
      await openLibrary()
      await library().getByRole('button', { name: 'Lin', exact: true }).click()
      await settingEditor().getByRole('textbox', { name: 'Description', exact: true }).fill('A traveler in a red coat')
      await page.screenshot({ path: join(shots, 'settings-editor-dark.png'), animations: 'disabled' })
      await settingEditor().getByRole('button', { name: 'Save', exact: true }).click()
      await expect.poll(async () => (await doc(idMap.one)).shots[0]?.promptState).toBe('stale')
      await expect.poll(async () => (await doc(idMap.two)).shots[0]?.promptState).toBe('stale')
      await apply([{ op: 'node.delete', nodeId: idMap.ref }])
      const surviving = await admin.call('entity.get', { entityId: lin.id }) as EntityView
      expect(surviving.refs[0]?.assetVersionId).toBe(images[0]!.assetVersionId)
      const linCard = library().getByRole('button', { name: 'Lin', exact: true })
      await expect.poll(() => linCard.getByRole('img', { name: 'Cover', exact: true }).evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
      await card.click()
      await settingEditor().getByRole('button', { name: 'Unmerge', exact: true }).click()
      await page.getByRole('dialog', { name: 'Unmerge', exact: true }).getByRole('button', { name: 'Unmerge', exact: true }).click()
      await expect.poll(async () => (await admin.call('entity.get', { entityId: merged.id })).members).toEqual([])
      expect((await admin.call('asset.list', { limit: 200 })).items).toHaveLength(4)
      await settingEditor().getByRole('button', { name: 'Cancel', exact: true }).click()
      expect(errors).toEqual([])
    } catch (error) {
      await page.screenshot({ path: join(shots, 'settings-failure.png'), animations: 'disabled' })
      throw error
    }
  }, 60_000)

  it('edits members and covers, links duplicate names, and confirms deletion without deleting media', async () => {
    await openLibrary()
    await library().getByRole('button', { name: 'New setting', exact: true }).click()
    const create = page.getByRole('dialog', { name: 'New setting', exact: true })
    await create.getByRole('textbox', { name: 'Setting name', exact: true }).fill('Lin')
    await create.getByRole('button', { name: 'Save', exact: true }).click()
    await create.getByRole('button', { name: 'Open existing setting', exact: true }).waitFor()
    await create.getByRole('button', { name: 'Open existing setting', exact: true }).click()
    await expect.poll(() => settingEditor().getByRole('textbox', { name: 'Setting name', exact: true }).inputValue()).toBe('Lin')
    await settingEditor().getByRole('button', { name: 'Cancel', exact: true }).click()

    await library().getByRole('button', { name: 'New setting', exact: true }).click()
    await create.getByRole('textbox', { name: 'Setting name', exact: true }).fill('Station')
    await create.getByRole('combobox', { name: 'Kind', exact: true }).selectOption('scene')
    await create.getByRole('button', { name: 'Add members', exact: true }).click()
    await create.getByRole('button', { name: 'Portrait 1', exact: true }).click()
    await create.getByRole('button', { name: 'Portrait 2', exact: true }).click()
    await create.getByRole('button', { name: 'Hero voice', exact: true }).click()
    await create.getByRole('button', { name: 'Add reference image', exact: true }).click()
    await create.getByRole('button', { name: 'Portrait 1', exact: true }).click()
    await create.getByRole('button', { name: 'Add reference image', exact: true }).click()
    await create.getByRole('button', { name: 'Portrait 2', exact: true }).click()
    await create.getByRole('button', { name: 'Make cover', exact: true }).click()
    await create.getByRole('button', { name: 'Save', exact: true }).click()
    await expect.poll(async () => (await settings()).find(item => item.name === 'Station')?.members.length).toBe(3)
    const station = (await settings()).find(item => item.name === 'Station')!
    const media = (await admin.call('asset.list', { limit: 200 })).items as LibraryAsset[]
    expect(station.refs[0]?.assetVersionId).toBe(media.find(item => item.displayName === 'Portrait 2')!.latest.assetVersionId)
    await library().getByRole('button', { name: 'Station', exact: true }).click()
    await settingEditor().getByRole('button', { name: 'Delete setting', exact: true }).click()
    const confirmation = page.getByRole('dialog', { name: 'Delete this setting?', exact: true })
    await confirmation.getByText('Media are never deleted. All scripts lose this setting and its shot references.', { exact: true }).waitFor()
    await confirmation.getByRole('button', { name: 'Delete setting', exact: true }).click()
    await expect.poll(async () => (await settings()).some(item => item.id === station.id)).toBe(false)
    expect((await admin.call('asset.list', { limit: 200 })).items).toHaveLength(4)
    expect(errors).toEqual([])
  })

  it('presents a compact mixed gallery and reviews two proposals with thumbnail cover selection and recheck', async () => {
    await openLibrary()
    await library().getByRole('button', { name: 'Close library', exact: true }).click()
    const media = (await admin.call('asset.list', { limit: 200 })).items as LibraryAsset[]
    const images = media.filter(item => item.kind === 'image')
    for (const [index, item] of [
      { kind: 'character', name: 'Mira', description: 'A station keeper with a silver scarf and a quiet, observant manner.' },
      { kind: 'character', name: 'Kit', description: 'The young messenger, always carrying a folded timetable.' },
      { kind: 'scene', name: 'Dawn courtyard', description: 'Cold morning light settles across the empty stone courtyard.' },
      { kind: 'scene', name: 'Night platform', description: 'A warm pool of light beneath a clock at the last stop.' },
      { kind: 'prop', name: 'Travel bag', description: 'Worn leather, brass clasp, a small stitched repair near the handle.' },
      { kind: 'prop', name: 'Station map', description: 'A faded pocket map with three routes circled in red ink.' },
    ].entries()) {
      await admin.call('entity.create', { requestId: rid(), ...item,
        refs: item.name === 'Station map' ? [] : [{ assetVersionId: images[index % images.length]!.latest.assetVersionId }],
        members: index === 0 ? [{ assetId: images[0]!.assetId, role: 'image' }] : [],
      })
    }
    await openLibrary()
    await library().getByRole('button', { name: 'Station map', exact: true }).waitFor()
    await page.screenshot({ path: join(shots, 'settings-gallery-dark.png'), animations: 'disabled' })
    await library().locator('.library-panel-body').evaluate(element => { element.scrollTop = element.scrollHeight })
    await expect.poll(() => library().locator('.library-setting-card img').evaluateAll(images => images
      .filter(image => image.getBoundingClientRect().top < innerHeight && image.getBoundingClientRect().bottom > 0)
      .every(image => (image as HTMLImageElement).naturalWidth > 0))).toBe(true)
    await page.screenshot({ path: join(shots, 'settings-gallery-lower-dark.png'), animations: 'disabled' })
    await library().getByRole('button', { name: 'Close library', exact: true }).click()
    const state = await admin.call('library.state', {})
    const run = await admin.call('library.runStart', { requestId: rid(), kind: 'merge' })
    await admin.call('session.sendMessage', { requestId: rid(), sessionId: state.sessionId, text: `library-settings-gallery ${run.runId}`, refs: [] })
    await expect.poll(async () => (await proposals()).length, { timeout: 20_000 }).toBe(2)
    const mira = (await settings()).find(item => item.name === 'Mira')!
    await admin.call('entity.update', { entityId: mira.id, expectedRevision: mira.revision, description: 'Updated after the Agent review' })
    await openLibrary()
    const pending = library().getByRole('region', { name: 'Pending merges', exact: true })
    const proposal = pending.getByRole('article', { name: 'Mira', exact: true })
    await proposal.getByText('The setting or media changed. Edit the name, members or cover before accepting.', { exact: true }).waitFor()
    expect(await proposal.getByRole('button', { name: 'Accept', exact: true }).isDisabled()).toBe(true)
    await page.screenshot({ path: join(shots, 'settings-two-proposals-dark.png'), animations: 'disabled' })
    await proposal.getByRole('textbox', { name: 'Proposed name', exact: true }).fill('Mira reviewed')
    const draft = (await proposals()).find(item => item.entityId === mira.id)!
    const alternative = images.find(item => draft.members.some(member => member.assetId === item.assetId) && item.latest.assetVersionId !== draft.refs?.[0])!
    await proposal.getByRole('button', { name: `Use ${alternative.displayName} as cover`, exact: true }).click()
    await pending.getByRole('button', { name: 'Accept all', exact: true }).click()
    await expect.poll(async () => (await proposals()).length).toBe(0)
    const accepted = await admin.call('entity.get', { entityId: mira.id }) as EntityView
    expect(accepted.name).toBe('Mira reviewed')
    expect(accepted.refs[0]?.assetVersionId).toBe(alternative.latest.assetVersionId)
    expect((await settings()).find(item => item.name === 'Travel kit')?.members).toHaveLength(2)
    expect(errors).toEqual([])
  }, 30_000)
})
