import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright-core'
import { startStudiod, type Studiod } from '../../../services/studiod/src/studiod'
import { registerAgents } from '../../../services/studiod/src/agents'
import { createMemorySecretStore } from '../../../services/studiod/src/secret-store'
import { createMockProvider } from '../../../packages/generation/src/index'
import { eq, spaceSchema } from '../../../packages/storage/src/index'
import { appendNotice } from '../../../packages/workbench/core/src/transcript'
import { studiodEndpoint } from '../../../runtime/studiod-endpoint'
import { createWebHost } from '../src/host/server'
import { openStudiodLink, type StudiodLink } from '../src/host/studiod-link'
import { exampleDescriptor, exampleRegistrations } from './example-agent'
import { chromePath, removeTempDir, supportsNativeApprovals } from './platform'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const rid = () => `registry-${crypto.randomUUID()}`
let dir: string
let daemon: Studiod
let web: Awaited<ReturnType<typeof createWebHost>>
let admin: StudiodLink
let browser: Browser
let page: Page
let spaceId: string
const errors: string[] = []

describe.skipIf(!existsSync(chromePath()))('Agent registry seam', () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'vis-agent-registry-'))
    // Keep the writable project outside the private daemon data directory so macOS can sandbox it.
    const dataDir = join(dir, 'data')
    daemon = await startStudiod({
      dataDir, studiodVersion: 'test',
      runtimes: registerAgents(exampleRegistrations({
        socketPath: studiodEndpoint(dataDir), dataDir,
        codexPath: join(root, 'apps/web/e2e/fake-codex.mjs'),
        visMcp: { command: process.execPath, args: [join(root, 'apps/cli/dist/vis.mjs'), 'mcp'] },
      })),
      providers: [createMockProvider()],
      secretStore: createMemorySecretStore(),
      defaults: { image: { provider: 'mock' }, video: { provider: 'mock' }, audio: { provider: 'mock' } },
    })
    const space = daemon.spaces.create({ requestId: rid(), name: 'Registry project', rootPath: join(dir, 'project') })
    spaceId = space.spaceId
    const host = daemon.spaces.get(spaceId)!
    const removed = host.sessions.create({ requestId: rid(), title: 'Removed adapter history', agentKind: 'example' })
    host.db.update(spaceSchema.sessions).set({ agentKind: 'removed-adapter' }).where(eq(spaceSchema.sessions.id, removed.sessionId)).run()
    appendNotice(host.db, removed.sessionId, null, 'fixture', 'Historical transcript remains visible', Date.now())
    web = await createWebHost({ socketPath: daemon.socketPath, tokenPath: daemon.tokenPath, staticDir: join(root, 'apps/web/dist/client') })
    admin = await openStudiodLink({ socketPath: daemon.socketPath, tokenPath: daemon.tokenPath })
    await admin.call('events.subscribe', { spaceId })
    browser = await chromium.launch({ executablePath: chromePath(), headless: true })
    page = await browser.newPage({ locale: 'en-US', viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2, reducedMotion: 'reduce' })
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
    await page.goto(web.url)
    await page.getByRole('button', { name: 'Start creating', exact: true }).waitFor()
  })

  afterAll(async () => {
    admin?.close()
    await browser?.close()
    await web?.close()
    await daemon?.stop('user_quit')
    removeTempDir(dir)
  })

  it('discovers a fixture adapter in workspace choices and runs a turn', async () => {
    await page.getByRole('button', { name: 'Switch project', exact: true }).first().click()
    await page.getByRole('menuitem', { name: '＋ New project', exact: true }).click()
    const project = page.getByRole('dialog', { name: 'New project', exact: true })
    expect(await project.getByRole('button', { name: exampleDescriptor.label, exact: true }).locator('svg path').first().getAttribute('d')).toBe(exampleDescriptor.icon[0])
    await project.press('Escape')
    await page.getByRole('button', { name: 'Start creating', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'New workspace', exact: true })
    const example = dialog.getByRole('button', { name: exampleDescriptor.label, exact: true })
    expect(await example.locator('svg path').first().getAttribute('d')).toBe(exampleDescriptor.icon[0])
    expect(await dialog.getByRole('button', { name: 'Missing Example', exact: true }).isDisabled()).toBe(true)
    await example.click()
    await dialog.getByRole('button', { name: /Create workspace/ }).click()
    const input = page.getByRole('textbox', { name: 'Message the Agent', exact: true })
    await input.fill('Registry echo')
    await input.press('Enter')
    await page.getByText('收到：Registry echo', { exact: true }).waitFor()
  })

  it.skipIf(!supportsNativeApprovals)('answers a native approval from the fixture adapter', async () => {
    const input = page.getByRole('textbox', { name: 'Message the Agent', exact: true })
    await input.fill('审批检查')
    await input.press('Enter')
    await page.getByRole('button', { name: 'Allow once', exact: true }).click()
    await page.getByText('已获准', { exact: true }).waitFor()
  })

  it('remembers the fixture adapter and offers it for ownership and activation', async () => {
    await page.getByRole('button', { name: 'Back to list', exact: true }).click()
    expect(await page.locator('svg.vis-agent-icon.is-example').count()).toBeGreaterThan(0)
    await page.getByRole('button', { name: 'Start creating', exact: true }).click()
    expect(await page.getByRole('dialog', { name: 'New workspace', exact: true }).getByRole('button', { name: exampleDescriptor.label, exact: true }).getAttribute('aria-pressed')).toBe('true')
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'New script', exact: true }).click()
    await page.getByText('Script 1', { exact: true }).click()
    await page.getByRole('region', { name: 'Script or editing instructions', exact: true }).getByRole('button', { name: 'Change', exact: true }).click()
    const owner = page.getByRole('dialog', { name: 'Choose owning session', exact: true })
    await owner.getByRole('combobox', { name: 'Session', exact: true }).selectOption('new')
    const kinds = owner.getByRole('combobox', { name: 'Agent kind', exact: true })
    await kinds.selectOption('example')
    expect(await kinds.inputValue()).toBe('example')
    expect(await kinds.getByRole('option', { name: exampleDescriptor.label, exact: true }).count()).toBe(1)
    await owner.press('Escape')
    await page.getByRole('tab', { name: 'Board', exact: true }).click()
    const board = page.getByRole('region', { name: 'Work board', exact: true })
    expect(await board.locator('svg.vis-agent-icon.is-example').count()).toBeGreaterThan(0)
    await page.getByRole('tab', { name: 'Canvas', exact: true }).click()

    const { item } = await admin.call('work.create', { requestId: rid(), spaceId, title: 'Example activation', brief: 'Registry activation' })
    const card = page.getByRole('listitem').filter({ hasText: 'Example activation' }).first()
    await card.click()
    const choice = page.getByRole('dialog')
    await choice.getByRole('button', { name: exampleDescriptor.label, exact: true }).click()
    await choice.getByRole('button', { name: 'Activate', exact: true }).click()
    await expect.poll(async () => (await admin.call('work.get', { spaceId, workItemId: item.workItemId })).item.sessions[0]?.agentKind).toBe('example')
    expect(errors).toEqual([])
  })

  it('keeps an unregistered session transcript visible and prevents new turns', async () => {
    const back = page.getByRole('button', { name: 'Back to list', exact: true })
    if (await back.isVisible()) await back.click()
    await page.getByRole('listitem').filter({ hasText: 'Removed adapter history' }).first().click()
    await page.getByText('Historical transcript remains visible', { exact: true }).waitFor()
    await page.getByText('This session’s Agent is no longer registered. You can view its history; install the adapter to continue.', { exact: true }).waitFor()
    expect(await page.getByRole('textbox', { name: 'Message the Agent', exact: true }).isDisabled()).toBe(true)
    expect(errors).toEqual([])
  })
})
