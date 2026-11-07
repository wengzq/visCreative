import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { EntityView, NodeView, ScriptDoc, SeriesView, WorkItemView } from '@vis/protocol'
import { messagesFor, type Locale } from '@vis/ui-kit'
import { libraryShellMessages } from '../../../packages/library/ui/src/messages'
import { settingsMessages } from '../../../packages/library/ui/src/settings/messages'
import { seriesMessages } from '../../../packages/library/ui/src/settings/series-messages'
import { dialogMessages, sessionMessages } from '../../../packages/workbench/ui/src/messages'
import { seriesProjectMessages } from '../../../packages/workbench/ui/src/series-messages'
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
let first: string
let second: string
let hero: EntityView
const errors: string[] = []
const rid = () => crypto.randomUUID()
const settings = async (): Promise<EntityView[]> => (await admin.call('entity.list', { includeDeleted: false })).items
const nodes = async (): Promise<NodeView[]> => (await admin.call('canvas.get', {})).nodes
const subscribe = (spaceId: string) => admin.call('events.subscribe', { spaceId })
const dictionaries = (locale: Locale) => ({
  library: messagesFor(libraryShellMessages, locale), settings: messagesFor(settingsMessages, locale),
  series: messagesFor(seriesMessages, locale), project: messagesFor(seriesProjectMessages, locale),
  dialog: messagesFor(dialogMessages, locale), session: messagesFor(sessionMessages, locale),
})
type Copy = ReturnType<typeof dictionaries>
const library = (target = page, locale: Locale = 'en') => target.getByRole('complementary', { name: dictionaries(locale).library.library, exact: true })
const editor = (target = page, locale: Locale = 'en') => target.getByRole('dialog', { name: dictionaries(locale).settings.edit, exact: true })
async function openLibrary(target = page, locale: Locale = 'en') {
  const m = dictionaries(locale)
  if (!await library(target, locale).isVisible()) await target.getByRole('button', { name: m.library.library, exact: true }).click()
  await library(target, locale).getByRole('tab', { name: new RegExp(`^${m.library.settings}`) }).click()
}
async function navigate(target: Page, spaceId: string) {
  const url = new URL(host.url)
  url.searchParams.set('space', spaceId)
  await target.goto(url.href)
  await target.locator('.react-flow__pane').waitFor()
}
async function screenshots(name: string, spaceId: string, prepare: (target: Page, locale: Locale, copy: Copy) => Promise<void>) {
  for (const locale of ['en', 'zh-CN'] as const) {
    const target = await browser.newPage({ locale: locale === 'en' ? 'en-US' : locale, viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 })
    try {
      target.setDefaultTimeout(15_000)
      await navigate(target, spaceId)
      await prepare(target, locale, dictionaries(locale))
      await target.screenshot({ path: join(shots, `series-${name}-${locale}.png`), animations: 'disabled' })
    } finally { await target.close() }
  }
}
async function projectMenu(target = page, locale: Locale = 'en') {
  const m = dictionaries(locale)
  await target.getByRole('button', { name: m.session.switchProject, exact: true }).click()
  return target.getByRole('menu', { name: m.session.project, exact: true })
}
async function openPublish(target = page, locale: Locale = 'en') {
  const m = dictionaries(locale)
  await openLibrary(target, locale)
  await library(target, locale).getByRole('button', { name: hero.name, exact: true }).click()
  await editor(target, locale).getByRole('button', { name: m.series.publish, exact: true }).click()
  return target.getByRole('dialog', { name: m.series.publishTitle, exact: true })
}

describe.skipIf(!ready)('Series settings library', () => {
  beforeAll(async () => {
    mkdirSync(shots, { recursive: true })
    dir = mkdtempSync(join(tmpdir(), 'vis-library-series-'))
    vi.stubEnv('VIS_PROJECTS_DIR', join(dir, 'projects'))
    daemon = await startStudiod({
      dataDir: dir, studiodVersion: 'library-series-e2e',
      runtimes: { codex: codexRuntime({ dataDir: dir, socketPath: studiodEndpoint(dir), codexPath: join(root, 'apps/web/e2e/fake-codex.mjs'), visMcp: { command: process.execPath, args: [cli, 'mcp'] } }) },
      providers: [], defaults: {}, secretStore: createMemorySecretStore(),
    })
    first = daemon.spaces.create('Episode one').spaceId
    admin = await openStudiodLink({ socketPath: daemon.socketPath, tokenPath: daemon.tokenPath })
    await subscribe(first)
    host = await createWebHost({ socketPath: daemon.socketPath, tokenPath: daemon.tokenPath, staticDir: join(root, 'apps/web/dist/client') })
    browser = await chromium.launch({ executablePath: chromePath(), headless: true })
    page = await browser.newPage({ locale: 'en-US', viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 })
    page.setDefaultTimeout(15_000)
    page.on('pageerror', error => errors.push(error.message))
    await navigate(page, first)
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

  it('joins with settings, creates an episode, links and casts copies, publishes, compares and resolves revisions', async () => {
    const space = daemon.spaces.get(first)!
    const staged = await space.assets.stageBytes(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="180"><rect width="240" height="180" fill="#355d73"/><circle cx="120" cy="65" r="32" fill="#d9c8a9"/></svg>'))
    const image = space.assets.registerVersion(space.db, { staged, kind: 'image', mime: 'image/svg+xml', origin: 'import', width: 240, height: 180 })
    hero = await admin.call('entity.create', { requestId: rid(), kind: 'character', name: '二狗', description: 'A young traveler in a blue coat.', refs: [{ assetVersionId: image.assetVersionId }] })
    await admin.call('entity.create', { requestId: rid(), kind: 'scene', name: '山海', description: 'The mountains at dawn.' })
    const created = await admin.call('canvas.apply', { requestId: rid(), ops: [{ op: 'node.create', tempId: 'script', kind: 'script', title: 'Episode one script', x: 0, y: 0 }] })
    const scriptId = created.idMap.script
    const script = (await nodes()).find(node => node.nodeId === scriptId)!
    const slot = script.slots.find(slot => slot.slotKey === 'main')!
    await admin.call('canvas.apply', { requestId: rid(), ops: [{ op: 'script.patch', slotId: slot.slotId, ops: [
      { kind: 'doc.set', rev: 0, fields: { castIds: [hero.id] } },
      { kind: 'shot.insert', tempId: 'walk', afterShotId: null, shot: { description: 'A traveler walks', characterIds: [hero.id], framePrompt: 'Blue coat in dawn light' } },
    ] }] })
    const menu = await projectMenu()
    await menu.getByRole('menuitem', { name: 'More actions for Episode one', exact: true }).click()
    await menu.getByRole('menuitem', { name: 'Join series…', exact: true }).click()
    const joinDialog = page.getByRole('dialog', { name: 'Join a series', exact: true })
    await joinDialog.getByRole('textbox', { name: 'Series name', exact: true }).fill('山海少年')
    await expect.poll(() => joinDialog.getByRole('checkbox').count()).toBe(2)
    expect(await joinDialog.getByRole('checkbox', { name: hero.name, exact: true }).isChecked()).toBe(true)
    expect(await joinDialog.getByRole('checkbox', { name: '山海', exact: true }).isChecked()).toBe(true)
    await joinDialog.getByRole('button', { name: 'Save', exact: true }).click()
    await joinDialog.waitFor({ state: 'hidden' })
    const series = (await admin.call('series.list', {})).items[0] as SeriesView
    expect(series.settingCount).toBe(2)
    hero = await admin.call('entity.get', { entityId: hero.id })

    await screenshots('new-episode', first, async (target, _locale, m) => {
      const projects = await projectMenu(target, _locale)
      await projects.getByRole('menuitem', { name: m.session.createProject, exact: true }).click()
      const dialog = target.getByRole('dialog', { name: m.dialog.newProject, exact: true })
      await dialog.getByRole('textbox', { name: m.dialog.projectName, exact: true }).fill('Episode two')
      await dialog.getByRole('radio', { name: m.project.newEpisode, exact: true }).check()
      await dialog.getByRole('combobox', { name: m.project.series, exact: true }).selectOption(series.seriesId)
      expect(await dialog.getByRole('spinbutton', { name: m.project.episode, exact: true }).inputValue()).toBe('2')
    })
    const createMenu = await projectMenu()
    await createMenu.getByRole('menuitem', { name: '＋ New project', exact: true }).click()
    const createDialog = page.getByRole('dialog', { name: 'New project', exact: true })
    await createDialog.getByRole('textbox', { name: 'Project name', exact: true }).fill('Episode two')
    await createDialog.getByRole('radio', { name: 'New episode of a series', exact: true }).check()
    await createDialog.getByRole('combobox', { name: 'Series', exact: true }).selectOption(series.seriesId)
    await createDialog.getByRole('button', { name: 'Skip for now', exact: true }).click()
    await createDialog.getByRole('button', { name: 'Create project', exact: true }).click()
    await createDialog.waitFor({ state: 'hidden' })
    second = (await admin.call('space.list', {})).spaces.find((item: { name: string }) => item.name === 'Episode two').spaceId
    await screenshots('grouped-projects', first, async (target, locale, m) => {
      const grouped = await projectMenu(target, locale)
      await grouped.getByRole('group', { name: series.name, exact: true }).waitFor()
      await grouped.getByText(m.project.episodeLabel('1'), { exact: true }).waitFor()
      await grouped.getByText(m.project.episodeLabel('2'), { exact: true }).waitFor()
    })
    await subscribe(second)
    await openLibrary()
    const unused = library().locator('.library-series-unused')
    expect(await unused.getAttribute('open')).toBeNull()
    await unused.locator('summary').click()
    await unused.getByRole('article', { name: hero.name, exact: true }).getByRole('button', { name: 'Use in this episode', exact: true }).click()
    await expect.poll(async () => (await settings()).some(item => item.name === hero.name)).toBe(true)
    const secondHero = (await settings()).find(item => item.name === hero.name)!
    expect(secondHero.series?.revision).toBe(1)
    expect(secondHero.refs).toHaveLength(1)
    await expect.poll(() => library().getByRole('button', { name: hero.name, exact: true }).getByRole('img', { name: 'Cover', exact: true }).evaluate(element => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
    await library().getByRole('button', { name: 'Close library', exact: true }).click()

    const secondScript = await admin.call('canvas.apply', { requestId: rid(), ops: [{ op: 'node.create', tempId: 'script', kind: 'script', title: 'Episode two script', x: 0, y: 0 }] })
    await page.getByRole('button', { name: 'Fit canvas', exact: true }).click()
    await page.locator(`.react-flow__node[data-id="${secondScript.idMap.script}"]`).getByRole('button', { name: 'Expand storyboard', exact: true }).click()
    const scriptEditor = page.getByRole('dialog', { name: 'Script editor', exact: true })
    await scriptEditor.getByRole('tab', { name: 'Settings', exact: true }).click()
    await scriptEditor.getByRole('button', { name: 'Add from library', exact: true }).click()
    await page.getByRole('dialog', { name: 'Add from library', exact: true }).getByRole('button', { name: hero.name, exact: true }).click()
    await scriptEditor.getByRole('button', { name: 'Add from library', exact: true }).click()
    await page.getByRole('dialog', { name: 'Add from library', exact: true }).getByRole('article', { name: '山海', exact: true }).getByRole('button', { name: 'Use in this episode', exact: true }).click()
    // Linking the series setting and committing the cast are separate asynchronous RPCs.
    await page.getByRole('dialog', { name: 'Add from library', exact: true }).waitFor({ state: 'hidden' })
    const secondDoc = (await nodes()).find(node => node.nodeId === secondScript.idMap.script)!.slots.find(item => item.slotKey === 'main')!.content
    expect(secondDoc.type).toBe('script')
    expect((secondDoc as { doc: ScriptDoc }).doc.castIds).toContain(secondHero.id)
    expect((secondDoc as { doc: ScriptDoc }).doc.castIds).toHaveLength(2)
    await scriptEditor.getByRole('button', { name: 'Close script editor', exact: true }).click()

    const episodeOne = await browser.newPage({ locale: 'en-US', viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 })
    await navigate(episodeOne, first)
    await openLibrary(episodeOne)
    const pinnedCover = await library(episodeOne).getByRole('button', { name: hero.name, exact: true }).getByRole('img', { name: 'Cover', exact: true }).getAttribute('src')
    const secondSpace = daemon.spaces.get(second)!
    const redBytes = await secondSpace.assets.stageBytes(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="180"><rect width="240" height="180" fill="#924c46"/><circle cx="120" cy="65" r="32" fill="#d9c8a9"/></svg>'))
    const redCover = secondSpace.assets.registerVersion(secondSpace.db, { staged: redBytes, kind: 'image', mime: 'image/svg+xml', origin: 'import', width: 240, height: 180 })
    const beforeCover = await admin.call('entity.get', { entityId: secondHero.id }) as EntityView
    await admin.call('entity.update', { entityId: secondHero.id, expectedRevision: beforeCover.revision, refs: [{ assetVersionId: redCover.assetVersionId }] })
    await openLibrary()
    await expect.poll(() => library().getByRole('button', { name: hero.name, exact: true }).getByRole('img', { name: 'Cover', exact: true }).getAttribute('src')).toContain(redCover.assetVersionId)
    await library().getByRole('button', { name: hero.name, exact: true }).click()
    await editor().getByRole('textbox', { name: 'Description', exact: true }).fill('A young traveler in a red coat.')
    await editor().getByRole('button', { name: 'Save', exact: true }).click()
    const publish = await openPublish()
    await publish.getByText('Publish as series v2; other episodes will see a newer version.', { exact: true }).waitFor()
    await publish.getByRole('button', { name: 'Publish to series', exact: true }).click()
    await publish.waitFor({ state: 'hidden' })
    await editor().getByRole('button', { name: 'Cancel', exact: true }).click()
    await library(episodeOne).getByRole('tab', { name: 'Settings · 1 with newer versions', exact: true }).waitFor()
    expect(await library(episodeOne).getByRole('button', { name: hero.name, exact: true }).getByRole('img', { name: 'Cover', exact: true }).getAttribute('src')).toBe(pinnedCover)
    expect(await library(episodeOne).getByRole('button', { name: hero.name, exact: true }).textContent()).toContain('A young traveler in a blue coat.')
    const lantern = await admin.call('entity.create', { requestId: rid(), kind: 'prop', name: 'Lantern', description: 'A warm brass lantern.' })
    await admin.call('entity.publish', { requestId: rid(), entityId: lantern.id, expectedRevision: lantern.revision })

    await subscribe(first)
    hero = await admin.call('entity.get', { entityId: hero.id })
    await admin.call('entity.update', { entityId: hero.id, expectedRevision: hero.revision, description: 'Local blue coat with a silver scarf.' })
    await screenshots('settings-badges', first, async (target, locale, m) => {
      await openLibrary(target, locale)
      const card = library(target, locale).getByRole('button', { name: hero.name, exact: true })
      await card.getByText(m.series.revision('1'), { exact: true }).waitFor()
      await card.getByText(m.series.newer, { exact: true }).waitFor()
      await card.getByText(m.series.modified, { exact: true }).waitFor()
      await library(target, locale).locator('.library-setting-group > summary').filter({ hasText: m.settings.scene }).click()
      await library(target, locale).locator('.library-series-unused summary').click()
      const unusedCard = library(target, locale).getByRole('article', { name: 'Lantern', exact: true })
      await unusedCard.getByRole('button', { name: m.series.use, exact: true }).waitFor()
      expect(await unusedCard.evaluate(element => element.getBoundingClientRect().bottom <= innerHeight)).toBe(true)
    })
    await screenshots('publish-conflict', first, async (target, locale, m) => {
      const confirmation = await openPublish(target, locale)
      await confirmation.getByRole('button', { name: m.series.publish, exact: true }).click()
      const conflict = target.getByRole('dialog', { name: m.series.conflictTitle, exact: true })
      await conflict.getByRole('button', { name: m.series.overwrite, exact: true }).waitFor()
      await conflict.getByRole('button', { name: m.series.takeSeries, exact: true }).waitFor()
    })
    await screenshots('update', first, async (target, locale, m) => {
      await openLibrary(target, locale)
      await library(target, locale).getByRole('button', { name: `${m.series.updateTitle} ${hero.name}`, exact: true }).click()
      const update = target.getByRole('dialog', { name: m.series.updateTitle, exact: true })
      await update.getByText(m.series.shots('1'), { exact: true }).waitFor()
      await update.getByText(m.series.otherEpisodes, { exact: true }).waitFor()
      await expect.poll(() => update.getByRole('img').evaluateAll(images => images.length === 2 && images.every(image => (image as HTMLImageElement).naturalWidth > 0))).toBe(true)
    })
    const beforeUpdate = (await nodes()).find(node => node.nodeId === scriptId)!.slots.find(item => item.slotKey === 'main')!.content as { doc: ScriptDoc }
    const currentShot = beforeUpdate.doc.shots[0]!
    await admin.call('canvas.apply', { requestId: rid(), ops: [{ op: 'script.patch', slotId: slot.slotId, ops: [
      { kind: 'shot.update', shotId: currentShot.id, rev: currentShot.rev, fields: { framePrompt: 'The local scarf in dawn light' } },
    ] }] })
    const refreshedPrompt = (await nodes()).find(node => node.nodeId === scriptId)!.slots.find(item => item.slotKey === 'main')!.content as { doc: ScriptDoc }
    expect(refreshedPrompt.doc.shots[0]?.promptState).toBe('edited')
    await library(episodeOne).getByRole('button', { name: `Update setting from series ${hero.name}`, exact: true }).click()
    const update = episodeOne.getByRole('dialog', { name: 'Update setting from series', exact: true })
    await update.getByRole('button', { name: 'Not now', exact: true }).click()
    await library(episodeOne).getByRole('tab', { name: 'Settings · 1 with newer versions', exact: true }).waitFor()
    await library(episodeOne).getByRole('button', { name: `Update setting from series ${hero.name}`, exact: true }).click()
    await update.getByRole('button', { name: 'Update', exact: true }).click()
    await expect.poll(async () => (await admin.call('entity.get', { entityId: hero.id })).series.revision).toBe(2)
    const updatedScript = (await nodes()).find(node => node.nodeId === scriptId)!.slots.find(item => item.slotKey === 'main')!.content
    expect((updatedScript as { doc: ScriptDoc }).doc.shots[0]?.promptState).toBe('stale')
    expect((await admin.call('entity.get', { entityId: hero.id })).description).toBe('A young traveler in a red coat.')

    const work = (await admin.call('work.create', { requestId: rid(), title: 'Series curator', chat: { agentKind: 'codex' } })).item as WorkItemView
    await admin.call('session.sendMessage', { requestId: rid(), sessionId: work.sessions[0]!.sessionId, text: 'library-series-link Lantern', refs: [] })
    await expect.poll(async () => (await settings()).some(item => item.name === 'Lantern'), { timeout: 30_000 }).toBe(true)
    await expect.poll(async () => (await admin.call('session.list', { includeArchived: false })).sessions.find((item: { sessionId: string }) => item.sessionId === work.sessions[0]!.sessionId)?.activeTurnId, { timeout: 30_000 }).toBeFalsy()
    const agentLog = readFileSync(join(work.workDir, '.vis-e2e-agent.jsonl'), 'utf8')
    expect(agentLog).toContain('series_list')
    expect(agentLog).toContain('entity_link')
    await admin.call('space.delete', { requestId: rid(), spaceId: second })
    const remaining = (await admin.call('series.list', {})).items[0] as SeriesView
    expect(remaining.seriesId).toBe(series.seriesId)
    expect(remaining.episodes.map(item => item.spaceId)).toEqual([first])
    expect((await admin.call('entity.get', { entityId: hero.id })).series.revision).toBe(2)
    await episodeOne.close()
    expect(errors).toEqual([])
  }, 180_000)

  it('joins a populated series, replaces a name collision, resets the pin, changes episode numbers and detaches safely', async () => {
    const series = (await admin.call('series.list', {})).items[0] as SeriesView
    const extra = await admin.call('space.create', { requestId: rid(), name: 'Existing episode' })
    await subscribe(extra.spaceId)
    const local = await admin.call('entity.create', { requestId: rid(), kind: 'character', name: hero.name, description: 'An independent interpretation.' }) as EntityView
    const created = await admin.call('canvas.apply', { requestId: rid(), ops: [{ op: 'node.create', tempId: 'script', kind: 'script', title: 'Existing script', x: 0, y: 0 }] })
    const scriptId = created.idMap.script
    const slot = (await nodes()).find(node => node.nodeId === scriptId)!.slots.find(item => item.slotKey === 'main')!
    await admin.call('canvas.apply', { requestId: rid(), ops: [{ op: 'script.patch', slotId: slot.slotId, ops: [
      { kind: 'doc.set', rev: 0, fields: { castIds: [local.id] } },
      { kind: 'shot.insert', tempId: 'walk', afterShotId: null, shot: { description: 'A traveler walks', characterIds: [local.id], framePrompt: 'Original local setting' } },
    ] }] })
    await navigate(page, extra.spaceId)
    const menu = await projectMenu()
    await menu.getByRole('menuitem', { name: 'More actions for Existing episode', exact: true }).click()
    await menu.getByRole('menuitem', { name: 'Join series…', exact: true }).click()
    const joinDialog = page.getByRole('dialog', { name: 'Join a series', exact: true })
    await joinDialog.getByRole('combobox', { name: 'Series', exact: true }).selectOption(series.seriesId)
    expect(await joinDialog.getByRole('checkbox', { name: hero.name, exact: true }).isChecked()).toBe(false)
    await joinDialog.getByRole('button', { name: 'Save', exact: true }).click()
    await joinDialog.waitFor({ state: 'hidden' })
    expect((await admin.call('entity.get', { entityId: local.id })).series).toBeUndefined()
    const beforeLink = (await nodes()).find(node => node.nodeId === scriptId)!.slots.find(item => item.slotKey === 'main')!.content as { doc: ScriptDoc }
    expect(beforeLink.doc.shots[0]?.promptState).toBe('edited')
    await openLibrary()
    await library().locator('.library-series-unused summary').click()
    await library().getByRole('article', { name: hero.name, exact: true }).getByRole('button', { name: 'Use in this episode', exact: true }).click()
    const collision = page.getByRole('dialog', { name: 'This episode has a setting with the same name', exact: true })
    await collision.getByRole('button', { name: 'Use series version', exact: true }).click()
    await expect.poll(async () => (await admin.call('entity.get', { entityId: local.id })).series?.revision).toBe(2)
    const content = (await nodes()).find(node => node.nodeId === scriptId)!.slots.find(item => item.slotKey === 'main')!.content as { doc: ScriptDoc }
    expect(content.doc.castIds).toContain(local.id)
    expect(content.doc.shots[0]?.characterIds).toContain(local.id)
    expect(content.doc.shots[0]?.promptState).toBe('stale')
    const linked = await admin.call('entity.get', { entityId: local.id }) as EntityView
    await admin.call('entity.update', { entityId: local.id, expectedRevision: linked.revision, description: 'A local scarf edit.' })
    await subscribe(first)
    const original = await admin.call('entity.get', { entityId: hero.id }) as EntityView
    const changed = await admin.call('entity.update', { entityId: original.id, expectedRevision: original.revision, description: 'The newest green coat.' }) as EntityView
    await admin.call('entity.publish', { requestId: rid(), entityId: changed.id, expectedRevision: changed.revision })
    await subscribe(extra.spaceId)
    await library().getByRole('button', { name: hero.name, exact: true }).getByText('✎ Modified locally', { exact: true }).waitFor()
    await library().getByRole('button', { name: hero.name, exact: true }).click()
    await editor().getByRole('button', { name: 'Reset to series version', exact: true }).click()
    const reset = page.getByRole('dialog', { name: 'Reset to series version?', exact: true })
    await reset.getByRole('button', { name: 'Reset to series version', exact: true }).click()
    await reset.waitFor({ state: 'hidden' })
    const restored = await admin.call('entity.get', { entityId: local.id }) as EntityView
    expect(restored.description).toBe('A young traveler in a red coat.')
    expect(restored.series).toMatchObject({ revision: 2, latestRevision: 3, modifiedLocally: false })
    await editor().getByRole('button', { name: 'Publish to series', exact: true }).click()
    await page.getByRole('dialog', { name: 'Publish setting to series?', exact: true }).getByRole('button', { name: 'Publish to series', exact: true }).click()
    const conflict = page.getByRole('dialog', { name: 'The series has a newer version', exact: true })
    await conflict.getByRole('button', { name: 'Discard local edits and use the series version', exact: true }).click()
    await expect.poll(async () => (await admin.call('entity.get', { entityId: local.id })).series?.revision).toBe(3)
    await editor().getByRole('button', { name: 'Cancel', exact: true }).click()

    const episodeMenu = await projectMenu()
    await episodeMenu.getByRole('menuitem', { name: 'More actions for Existing episode', exact: true }).click()
    await episodeMenu.getByRole('menuitem', { name: 'Change episode number', exact: true }).click()
    const numberDialog = page.getByRole('dialog', { name: 'Change episode number', exact: true })
    await numberDialog.getByRole('spinbutton', { name: 'Episode number', exact: true }).fill('4')
    await numberDialog.getByRole('button', { name: 'Save', exact: true }).click()
    await expect.poll(async () => (await admin.call('space.list', {})).spaces.find((item: { spaceId: string }) => item.spaceId === extra.spaceId)?.series.episode).toBe(4)
    const leaveMenu = await projectMenu()
    await leaveMenu.getByRole('menuitem', { name: 'More actions for Existing episode', exact: true }).click()
    await leaveMenu.getByRole('menuitem', { name: 'Leave series', exact: true }).click()
    const leave = page.getByRole('dialog', { name: 'Leave this series?', exact: true })
    await leave.getByText('All settings stay in this episode as standalone settings.', { exact: true }).waitFor()
    await leave.getByRole('button', { name: 'Leave series', exact: true }).click()
    await leave.waitFor({ state: 'hidden' })
    const detached = await admin.call('entity.get', { entityId: local.id }) as EntityView
    expect(detached.series).toBeUndefined()
    expect(detached.description).toBe('The newest green coat.')
    expect(detached.refs).toHaveLength(1)
    const deleteMenu = await projectMenu()
    await deleteMenu.getByRole('menuitem', { name: `Delete series ${series.name}`, exact: true }).click()
    const remove = page.getByRole('dialog', { name: 'Delete this series?', exact: true })
    await remove.getByText('All episodes and their settings are kept. Episodes become standalone projects.', { exact: true }).waitFor()
    await remove.getByRole('button', { name: 'Delete series', exact: true }).click()
    await remove.waitFor({ state: 'hidden' })
    expect((await admin.call('series.list', {})).items).toEqual([])
    await subscribe(first)
    const firstHero = await admin.call('entity.get', { entityId: hero.id }) as EntityView
    expect(firstHero.series).toBeUndefined()
    expect(firstHero.description).toBe('The newest green coat.')
    expect((await admin.call('space.list', {})).spaces).toHaveLength(2)
    expect(errors).toEqual([])
  }, 90_000)
})
