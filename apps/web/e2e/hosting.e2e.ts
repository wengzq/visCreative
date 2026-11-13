import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createMockProvider } from '../../../packages/generation/src/index'
import { createMemorySecretStore } from '../../../services/studiod/src/secret-store'
import { createFakeTos } from '../../../services/studiod/src/testing/fake-tos'
import { startStudiod, type Studiod } from '../../../services/studiod/src/studiod'
import { createWebHost, type WebHost } from '../src/host/server'
import { openStudiodLink, type StudiodLink } from '../src/host/studiod-link'
import { chromePath, removeTempDir } from './platform'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const ready = existsSync(chromePath()) && existsSync(join(root, 'apps/web/dist/client/index.html'))
let dir: string
let studiod: Studiod
let host: WebHost
let admin: StudiodLink
let browser: Browser
let page: Page
let tos: Awaited<ReturnType<typeof createFakeTos>>
let hostingSecrets: ReturnType<typeof createMemorySecretStore>
const frames: string[] = []
const errors: string[] = []

function files(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(path, entry.name)) : entry.isFile() ? [join(path, entry.name)] : [])
}

describe.skipIf(!ready)('Media hosting settings with signature-verifying TOS', () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'vis-hosting-e2e-'))
    vi.stubEnv('VIS_PROJECTS_DIR', join(dir, 'projects'))
    tos = await createFakeTos()
    hostingSecrets = createMemorySecretStore()
    studiod = await startStudiod({
      dataDir: dir, studiodVersion: 'e2e', runtimes: {},
      secretStore: createMemorySecretStore(), hostingSecretStore: hostingSecrets, hostingFetch: tos.fetch,
      providers: [createMockProvider({ latencyMs: 0 })],
      defaults: { image: { provider: 'mock' }, video: { provider: 'mock' }, audio: { provider: 'mock' } },
    })
    studiod.spaces.create('Hosting settings')
    admin = await openStudiodLink({ socketPath: studiod.socketPath, tokenPath: studiod.tokenPath, onMessage() {} })
    await admin.call('preferences.set', { locale: 'en' })
    await admin.call('providers.update', { config: { providers: [], defaults: {}, limits: { maxConcurrent: 3, dailyImage: 50, dailyVideo: 10, dailyAudio: 20 } } })
    host = await createWebHost({ socketPath: studiod.socketPath, tokenPath: studiod.tokenPath, staticDir: join(root, 'apps/web/dist/client') })
    browser = await chromium.launch({ executablePath: chromePath(), headless: true })
    page = await browser.newPage({ locale: 'en', viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 })
    page.setDefaultTimeout(5000)
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => errors.push(message.text()))
    page.on('websocket', socket => {
      socket.on('framereceived', frame => frames.push(String(frame.payload)))
      socket.on('framesent', frame => {
        const text = String(frame.payload)
        // The write-only secret is allowed only on its explicit credential write request.
        if (JSON.parse(text).method !== 'hosting.setSecret') frames.push(text)
      })
    })
    await page.goto(host.url)
    await page.waitForSelector('.react-flow__pane')
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
  }, 30_000)

  afterAll(async () => {
    await browser?.close()
    admin?.close()
    await host?.close()
    await studiod?.stop('user_quit')
    await tos?.close()
    vi.unstubAllEnvs()
    if (dir) removeTempDir(dir)
  }, 30_000)

  it('saves hosting independently, keeps the secret write-only, and tests upload, signed read and delete', async () => {
    const dialog = page.getByRole('dialog', { name: 'Settings', exact: true })
    await dialog.getByRole('button', { name: 'Safety and limits', exact: true }).click()
    await dialog.getByLabel('Agent daily audio limit', { exact: true }).fill('17')
    const providersBefore = readFileSync(join(dir, 'providers.json'), 'utf8')
    await dialog.getByRole('button', { name: 'Media hosting', exact: true }).click()
    await dialog.getByLabel('Hosting region', { exact: true }).fill('cn-beijing')
    await dialog.getByLabel('Bucket', { exact: true }).fill('reference-clips')
    await dialog.getByLabel('Access key ID', { exact: true }).fill('testAK')
    expect(await dialog.getByLabel('Secret access key', { exact: true }).isDisabled()).toBe(true)
    await dialog.getByText('Save the media hosting settings before entering a secret.', { exact: true }).waitFor()
    expect(await dialog.getByText(/A referenced clip leaves this machine/).isVisible()).toBe(true)
    expect(await dialog.getByText(/deletes objects under the prefix after 3 days/).isVisible()).toBe(true)
    await dialog.getByRole('button', { name: 'Save media hosting', exact: true }).click()
    await dialog.getByText('Media hosting saved', { exact: true }).waitFor()
    expect(await dialog.getByLabel('Secret access key', { exact: true }).isEnabled()).toBe(true)
    expect(readFileSync(join(dir, 'providers.json'), 'utf8')).toBe(providersBefore)
    await dialog.getByLabel('Secret access key', { exact: true }).fill('testSK')
    expect(await dialog.getByRole('button', { name: 'Test media hosting', exact: true }).isDisabled()).toBe(true)
    await dialog.getByText('Save the entered hosting secret before testing the connection.', { exact: true }).waitFor()
    await dialog.getByRole('button', { name: 'Save hosting secret', exact: true }).click()
    await dialog.getByText('Hosting secret saved', { exact: true }).waitFor()
    expect(await dialog.getByLabel('Secret access key', { exact: true }).inputValue()).toBe('')
    expect((await admin.call<any>('providers.list')).videoReferences).toBe('ready')
    await dialog.getByRole('button', { name: 'Test media hosting', exact: true }).click()
    await dialog.getByText('Connection test succeeded', { exact: true }).waitFor()
    expect(tos.uploadSizes).toEqual([1024])
    expect(tos.objects.size).toBe(0)
    expect(tos.verified).toBe(3)
    expect(tos.rejected).toBe(0)
    await page.screenshot({ path: '/tmp/vis-hosting-settings.png' })
    const hostingBefore = readFileSync(join(dir, 'hosting.json'), 'utf8')
    await dialog.getByRole('button', { name: 'Safety and limits', exact: true }).click()
    expect(await dialog.getByLabel('Agent daily audio limit', { exact: true }).inputValue()).toBe('17')
    await dialog.getByRole('button', { name: 'Save configuration', exact: true }).click()
    await dialog.getByText('Configuration saved', { exact: true }).waitFor()
    expect(readFileSync(join(dir, 'hosting.json'), 'utf8')).toBe(hostingBefore)
    expect(JSON.parse(readFileSync(join(dir, 'providers.json'), 'utf8')).limits.dailyAudio).toBe(17)
    expect((await admin.call<any>('providers.list')).videoReferences).toBe('ready')
    expect(await page.content()).not.toContain('testSK')
    expect(frames.join('\n')).not.toMatch(/testSK|X-Tos-Signature|tos-cn-beijing\.volces\.com/)
    expect(errors).toEqual([])
    for (const file of files(dir)) {
      expect(readFileSync(file).includes(Buffer.from('testSK')), file).toBe(false)
      expect(readFileSync(file).includes(Buffer.from('X-Tos-Signature')), file).toBe(false)
      if (file.endsWith('.db') || file.endsWith('-wal')) expect(readFileSync(file).includes(Buffer.from('testAK')), file).toBe(false)
    }
  })

  it.each(['missing', 'invalid'])('warns before replacing %s hosting configuration with an orphan secret', async mode => {
    const { config } = await admin.call<any>('hosting.get')
    await page.getByRole('dialog', { name: 'Settings', exact: true }).getByRole('button', { name: 'Media hosting', exact: true }).click()
    try {
      await admin.call('hosting.update', { config: null })
      admin.close()
      await studiod.stop('user_quit')
      await hostingSecrets.set('tos', 'orphan-test-secret')
      if (mode === 'invalid') writeFileSync(join(dir, 'hosting.json'), '{')
      studiod = await startStudiod({ dataDir: dir, studiodVersion: 'e2e', runtimes: {}, secretStore: createMemorySecretStore(), hostingSecretStore: hostingSecrets, hostingFetch: tos.fetch, providers: [createMockProvider({ latencyMs: 0 })], defaults: { image: { provider: 'mock' }, video: { provider: 'mock' }, audio: { provider: 'mock' } } })
      admin = await openStudiodLink({ socketPath: studiod.socketPath, tokenPath: studiod.tokenPath, onMessage() {} })
      await page.reload()
      await page.waitForSelector('.react-flow__pane')
      await page.getByRole('button', { name: 'Settings', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'Settings', exact: true })
      await dialog.getByRole('button', { name: 'Media hosting', exact: true }).click()
      await expect.poll(() => dialog.getByLabel('Bucket', { exact: true }).inputValue()).toBe('')
      await dialog.getByLabel('Hosting region', { exact: true }).fill('cn-beijing')
      await dialog.getByLabel('Bucket', { exact: true }).fill('reference-clips')
      await dialog.getByLabel('Access key ID', { exact: true }).fill('testAK')
      expect(await dialog.getByLabel('Secret access key', { exact: true }).isDisabled()).toBe(true)
      expect(await dialog.getByText('Changing the access key ID clears the saved hosting secret. Save the matching secret again afterward.', { exact: true }).count()).toBe(0)
      page.once('dialog', prompt => prompt.dismiss())
      await dialog.getByRole('button', { name: 'Save media hosting', exact: true }).click()
      expect((await admin.call<any>('hosting.get')).hasSecret).toBe(true)
      page.once('dialog', prompt => prompt.accept())
      await dialog.getByRole('button', { name: 'Save media hosting', exact: true }).click()
      await dialog.getByText('Media hosting saved', { exact: true }).waitFor()
      expect((await admin.call<any>('hosting.get')).hasSecret).toBe(false)
    } finally {
      await admin.call('hosting.update', { config })
      await admin.call('hosting.setSecret', { secret: 'testSK' })
      await page.reload()
      await page.waitForSelector('.react-flow__pane')
      await page.getByRole('button', { name: 'Settings', exact: true }).click()
      await page.getByRole('dialog', { name: 'Settings', exact: true }).getByRole('button', { name: 'Media hosting', exact: true }).click()
    }
  })

  it('preserves the secret on bucket changes and displays a safe failing upload step', async () => {
    const dialog = page.getByRole('dialog', { name: 'Settings', exact: true })
    await dialog.getByRole('button', { name: 'Media hosting', exact: true }).click()
    await dialog.getByLabel('Bucket', { exact: true }).fill('broken-bucket')
    await dialog.getByRole('button', { name: 'Save media hosting', exact: true }).click()
    await dialog.getByText('Media hosting saved', { exact: true }).waitFor()
    expect((await admin.call<any>('hosting.get')).hasSecret).toBe(true)
    await dialog.getByRole('button', { name: 'Test media hosting', exact: true }).click()
    await dialog.getByText('Connection test failed (upload): Check the bucket permissions and hosting settings, then retry.', { exact: true }).waitFor()
    expect(tos.rejected).toBe(0)
    expect(await dialog.textContent()).not.toMatch(/testSK|X-Tos-Signature|tos-cn-beijing\.volces\.com/)
  })

  it('refreshes external changes and warns before a new access key clears the secret', async () => {
    const dialog = page.getByRole('dialog', { name: 'Settings', exact: true })
    const { config } = await admin.call<any>('hosting.get')
    await admin.call('hosting.update', { config: { ...config, bucket: 'reference-clips', prefix: 'updated/' } })
    await expect.poll(() => dialog.getByLabel('Object prefix', { exact: true }).inputValue()).toBe('updated/')
    await dialog.getByLabel('Access key ID', { exact: true }).fill('nextAK')
    expect(await dialog.getByText('Changing the access key ID clears the saved hosting secret. Save the matching secret again afterward.', { exact: true }).count()).toBe(0)
    page.once('dialog', prompt => prompt.dismiss())
    await dialog.getByRole('button', { name: 'Save media hosting', exact: true }).click()
    expect((await admin.call<any>('hosting.get')).hasSecret).toBe(true)
    page.once('dialog', prompt => prompt.accept())
    await dialog.getByRole('button', { name: 'Save media hosting', exact: true }).click()
    await dialog.getByText('Media hosting saved', { exact: true }).waitFor()
    expect((await admin.call<any>('hosting.get')).hasSecret).toBe(false)
    expect((await admin.call<any>('providers.list')).videoReferences).toBe('hosting_required')
    await admin.call('hosting.setSecret', { secret: 'testSK' })
    await dialog.getByRole('button', { name: 'Clear hosting secret', exact: true }).waitFor()
  })

  it('clears the secret, reports the configuration step, and removes hosting without changing providers', async () => {
    const dialog = page.getByRole('dialog', { name: 'Settings', exact: true })
    const providersBefore = readFileSync(join(dir, 'providers.json'), 'utf8')
    await dialog.getByRole('button', { name: 'Clear hosting secret', exact: true }).click()
    await dialog.getByText('Hosting secret cleared', { exact: true }).waitFor()
    expect((await admin.call<any>('providers.list')).videoReferences).toBe('hosting_required')
    await dialog.getByRole('button', { name: 'Test media hosting', exact: true }).click()
    await dialog.getByText('Connection test failed (config): Configure media hosting and save its secret first.', { exact: true }).waitFor()
    await dialog.getByRole('button', { name: 'Remove media hosting', exact: true }).click()
    await dialog.getByText('Media hosting and its secret removed', { exact: true }).waitFor()
    expect(await admin.call('hosting.get')).toEqual({ config: null, hasSecret: false })
    expect(existsSync(join(dir, 'hosting.json'))).toBe(false)
    expect(readFileSync(join(dir, 'providers.json'), 'utf8')).toBe(providersBefore)
    expect(frames.join('\n')).not.toMatch(/testSK|X-Tos-Signature|tos-cn-beijing\.volces\.com/)
  })
})
