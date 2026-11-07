import { existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AssetVersionView, JobView, WorkItemView } from '@vis/protocol'
import { chromium, type Browser, type Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
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
const artifacts = '/tmp/vis-0030'
const rid = () => crypto.randomUUID()
let dir: string
let daemon: Studiod
let host: WebHost
let admin: StudiodLink
let browser: Browser
let page: Page
let item: WorkItemView
let sessionId: string
let image: JobView
let video: JobView
let imageAsset: AssetVersionView
let videoAsset: AssetVersionView
const errors: string[] = []
const externalRequests: string[] = []
const panel = () => page.locator('.vis-session-panel')
const composer = () => page.getByRole('textbox', { name: 'Message the Agent', exact: true })
const result = (name: string) => panel().getByRole('region', { name, exact: true })
const openSession = async () => {
  await page.getByRole('listitem', { name: /^Session results,/ }).click()
  await composer().waitFor()
}
const send = async (text: string) => {
  await composer().fill(text)
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect.poll(() => composer().inputValue()).toBe('')
  await expect.poll(async () => (await admin.call('session.list')).sessions.find(session => session.sessionId === sessionId)?.activeTurnId, { timeout: 30_000 }).toBeNull()
}

describe.skipIf(!ready)('RFC 0030 session generation results', () => {
  beforeAll(async () => {
    mkdirSync(artifacts, { recursive: true })
    dir = mkdtempSync(join(tmpdir(), 'vis-session-results-'))
    vi.stubEnv('VIS_PROJECTS_DIR', join(dir, 'projects'))
    const mock = createMockProvider({ latencyMs: 0 })
    const failedTasks = new Set<string>()
    const provider = { ...mock,
      async submit(...args: Parameters<typeof mock.submit>) {
        const submitted = await mock.submit(...args)
        if (args[0].prompt === 'session-results-fail') failedTasks.add(submitted.externalTaskId)
        return submitted
      },
      async getTask(...args: Parameters<typeof mock.getTask>) {
        if (failedTasks.has(args[0])) return { state: 'failed' as const, error: { code: 'moderation_rejected', message: 'Mock moderation failure', data: { reason: 'generation.moderation_rejected' } } }
        return mock.getTask(...args)
      },
    }
    daemon = await startStudiod({
      dataDir: dir, studiodVersion: 'session-results-e2e', secretStore: createMemorySecretStore(),
      runtimes: { codex: codexRuntime({ dataDir: dir, socketPath: studiodEndpoint(dir), codexPath: join(root, 'apps/web/e2e/fake-codex.mjs'), visMcp: { command: process.execPath, args: [cli, 'mcp'] } }) },
      providers: [provider], defaults: { image: { provider: 'mock' }, video: { provider: 'mock' }, audio: { provider: 'mock' } },
    })
    const { spaceId } = daemon.spaces.create('Session results acceptance')
    admin = await openStudiodLink({ socketPath: daemon.socketPath, tokenPath: daemon.tokenPath })
    await admin.call('events.subscribe', { spaceId })
    item = (await admin.call('work.create', { requestId: rid(), title: 'Session results', chat: { agentKind: 'codex' } })).item
    sessionId = item.sessions[0]!.sessionId
    host = await createWebHost({ socketPath: daemon.socketPath, tokenPath: daemon.tokenPath, staticDir: join(root, 'apps/web/dist/client') })
    browser = await chromium.launch({ executablePath: chromePath(), headless: true })
    page = await browser.newPage({ locale: 'en-US', viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2, reducedMotion: 'reduce' })
    page.setDefaultTimeout(10_000)
    page.on('pageerror', error => errors.push(error.message))
    page.on('request', request => { if (request.url().includes('session-results.invalid')) externalRequests.push(request.url()) })
    await page.addInitScript(() => localStorage.setItem('vis.session.width', '480'))
    await page.goto(host.url)
    await openSession()
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

  it('shows mock image, video and failure cards outside closed tools, previews, locates and references a delivered result', async () => {
    await send('session-results')
    await result('Video result').getByText('Completed', { exact: true }).waitFor()
    const transcript = (await admin.call('session.getTranscript', { sessionId })).items
    const jobIds = [...new Set(transcript.filter(entry => entry.kind === 'tool_result').flatMap(entry => {
      try { return [JSON.parse((entry.payload as { text: string }).text).jobId as string] } catch { return [] }
    }).filter(Boolean))]
    const jobs = await Promise.all(jobIds.map(jobId => admin.call('generation.get', { jobId })))
    image = jobs.find(job => job.kind === 'image' && job.status === 'succeeded')!
    video = jobs.find(job => job.kind === 'video')!
    expect(jobs.map(job => job.status).sort()).toEqual(['failed', 'succeeded', 'succeeded'])
    imageAsset = await admin.call('asset.get', { assetVersionId: image.outputs[0]!.assetVersionId })
    videoAsset = await admin.call('asset.get', { assetVersionId: video.outputs[0]!.assetVersionId })
    const imageName = imageAsset.displayName ?? 'Output 1'
    const videoName = videoAsset.displayName ?? 'Output 1'
    const succeededImage = result('Image result').filter({ hasText: 'Completed' })
    expect(await result('Image result').count()).toBe(2)
    expect(await panel().locator('.vis-tool-group[open]').count()).toBe(0)
    expect(await succeededImage.evaluate(element => element.closest('details'))).toBeNull()
    await result('Image result').getByText('The generation service rejected this request during content moderation', { exact: true }).waitFor()
    expect(await panel().locator('video').count()).toBe(0)
    await expect.poll(() => succeededImage.locator('img').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
    await expect.poll(() => result('Video result').locator('img').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
    expect(await result('Video result').locator('img').getAttribute('src')).toContain('/poster?t=')
    expect(await succeededImage.locator('img').getAttribute('loading')).toBe('lazy')
    await panel().getByRole('link', { name: 'Remote reference', exact: true }).waitFor()
    expect(await panel().getByRole('link', { name: 'Remote reference', exact: true }).getAttribute('rel')).toBe('noreferrer')
    expect(await panel().getByRole('link', { name: 'https://session-results.invalid/no-alt.png', exact: true }).count()).toBe(1)
    expect(await panel().getByRole('link', { name: 'Local file', exact: true }).count()).toBe(0)
    expect(externalRequests).toEqual([])
    await page.screenshot({ path: join(artifacts, 'session-results.png'), animations: 'disabled' })
    await succeededImage.getByRole('button', { name: `Preview generation result: ${imageName}`, exact: true }).click()
    const imageDialog = page.getByRole('dialog', { name: `Attachment preview: ${imageName}`, exact: true })
    await imageDialog.waitFor()
    expect(await imageDialog.locator('img').getAttribute('src')).toContain(imageAsset.assetVersionId)
    await imageDialog.press('Escape')
    await result('Video result').getByRole('button', { name: `Preview generation result: ${videoName}`, exact: true }).click()
    const videoDialog = page.getByRole('dialog', { name: `Attachment preview: ${videoName}`, exact: true })
    await videoDialog.waitFor()
    await expect.poll(() => videoDialog.locator('video').evaluate(video => (video as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2)
    expect(await videoDialog.locator('video').getAttribute('controls')).not.toBeNull()
    // The fixture is smaller than a real video, so give it the size of one.
    // The dialog must grow with the media: a fixed width crops it into a false portrait frame.
    const fit = await videoDialog.evaluate(dialog => {
      const video = dialog.querySelector('video')!, body = dialog.querySelector('.vis-dialog-body')!
      video.style.width = '1000px'
      video.style.height = '562px'
      const shown = video.getBoundingClientRect(), frame = dialog.getBoundingClientRect()
      return { inside: shown.left >= frame.left && shown.right <= frame.right && shown.bottom <= frame.bottom, scrolls: body.scrollWidth > body.clientWidth || body.scrollHeight > body.clientHeight }
    })
    expect(fit).toEqual({ inside: true, scrolls: false })
    await videoDialog.press('Escape')
    expect(await panel().locator('video').count()).toBe(0)
    await admin.call('canvas.apply', { requestId: rid(), ops: [{ op: 'node.setMeta', nodeId: image.outputs[0]!.delivery.nodeId!, title: 'Located generated image' }] })
    await succeededImage.getByRole('button', { name: `Locate generation result: ${imageName}`, exact: true }).click()
    const located = page.locator('.react-flow__node').filter({ has: page.getByText('Located generated image', { exact: true }) })
    await expect.poll(() => located.getAttribute('class')).toContain('selected')
    expect(await located.locator('img').getAttribute('src')).toContain(imageAsset.assetVersionId)
    await succeededImage.getByRole('button', { name: `Reference generation result: ${imageName}`, exact: true }).click()
    expect(await panel().locator('.vis-composer .vis-ref-thumb').count()).toBe(1)
    await send('Use this generated image')
    const sent = (await admin.call('session.getTranscript', { sessionId })).items.find(entry => entry.kind === 'user' && (entry.payload as { text: string }).text === 'Use this generated image')!
    expect(sent.payload).toMatchObject({ refs: [{ nodeId: image.outputs[0]!.delivery.nodeId, versionPolicy: 'latest-at-execution' }] })
    expect(errors).toEqual([])
  }, 60_000)

  it('restores old jobs on reload, keeps audio unloaded until played, and preserves bottom scrolling', async () => {
    await send('session-audio')
    await result('Audio result').getByText('Completed', { exact: true }).waitFor()
    expect(await result('Audio result').locator('audio').getAttribute('preload')).toBe('none')
    expect(await panel().locator('video').count()).toBe(0)
    await expect.poll(() => panel().locator('.vis-transcript').evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThan(2)
    await page.reload()
    await openSession()
    await result('Video result').waitFor()
    await result('Audio result').waitFor()
    expect(await result('Image result').count()).toBe(2)
    expect(await panel().locator('.vis-generation-result').count()).toBe(4)
    expect(await panel().locator('video').count()).toBe(0)
    const preview = result('Audio result').getByRole('button', { name: /^Preview generation result:/ })
    await expect.poll(() => preview.isEnabled()).toBe(true)
    await preview.click()
    const dialog = page.getByRole('dialog', { name: /^Attachment preview:/ })
    await dialog.waitFor()
    expect(await dialog.locator('audio').getAttribute('controls')).not.toBeNull()
    await dialog.press('Escape')
    expect(externalRequests).toEqual([])
    expect(errors).toEqual([])
  }, 60_000)
  it('expands historical outputs, omits unavailable jobs, references undelivered assets and disables archived references', async () => {
    let archived = false
    const jobReads: string[] = []
    await page.routeWebSocket(/.*/, socket => {
      const server = socket.connectToServer()
      const requests = new Map<number, { method: string; params: { jobId?: string } }>()
      socket.onMessage(message => {
        const request = JSON.parse(String(message))
        requests.set(request.id, request)
        if (request.method === 'generation.get') jobReads.push(request.params.jobId)
        server.send(message)
      })
      server.onMessage(message => {
        const response = JSON.parse(String(message))
        const request = requests.get(response.id)
        if (response.result?.snapshot) response.result.snapshot.activeJobs = []
        if (request?.method === 'generation.usage') response.result.jobs = []
        if (request?.method === 'generation.get' && request.params.jobId === image.jobId) {
          response.result = { ...image, outputs: Array.from({ length: 6 }, (_, outputIndex) => ({
            ...image.outputs[0], outputIndex, delivery: { status: 'conflict', ...(outputIndex === 0 ? { nodeId: image.outputs[0]!.delivery.nodeId } : {}) },
            assetVersionId: outputIndex === 5 ? 'deleted-fixture-version' : imageAsset.assetVersionId,
          })) }
        }
        if (request?.method === 'session.getTranscript') {
          const entries = response.result.items
          entries.push({ itemId: 'missing-job-tool', kind: 'tool_result', turnId: null, createdSeq: entries.at(-1).createdSeq + 1, revision: 1, createdAt: Date.now(), updatedAt: Date.now(), payload: { text: '{"jobId":"unavailable-fixture-job"}' } })
        }
        const markArchived = (value: unknown) => {
          if (!value || typeof value !== 'object') return
          const entry = value as { workItemId?: string; sessions?: { archived: boolean }[] }
          if (archived && entry.workItemId === item.workItemId && Array.isArray(entry.sessions)) for (const session of entry.sessions) session.archived = true
          for (const child of Object.values(value)) markArchived(child)
        }
        markArchived(response)
        socket.send(JSON.stringify(response))
      })
    })
    try {
      await page.reload()
      await openSession()
      const historical = result('Image result').filter({ hasText: 'Completed' })
      await historical.getByRole('button', { name: '2 more', exact: true }).waitFor()
      expect(await historical.getByRole('button', { name: /^Preview generation result:/ }).count()).toBe(4)
      expect(await historical.getByRole('button', { name: /^Locate generation result:/ }).count()).toBe(1)
      expect(await historical.getByRole('button', { name: 'Locate generation result: Output 2', exact: true }).count()).toBe(0)
      await historical.getByRole('button', { name: '2 more', exact: true }).click()
      expect(await historical.getByRole('button', { name: /^Preview generation result:/ }).count()).toBe(6)
      await historical.getByText('Asset deleted or unavailable', { exact: true }).waitFor()
      expect(await historical.getByRole('button', { name: 'Preview generation result: Output 6', exact: true }).isDisabled()).toBe(true)
      expect(await historical.locator('img').count()).toBe(5)
      const reference = historical.getByRole('button', { name: 'Reference generation result: Output 1', exact: true })
      await reference.click()
      await reference.click()
      expect(await panel().locator('.vis-composer .vis-attachment-thumb').count()).toBe(1)
      await send('Use the undelivered asset')
      const sent = (await admin.call('session.getTranscript', { sessionId })).items.find(entry => entry.kind === 'user' && (entry.payload as { text: string }).text === 'Use the undelivered asset')!
      expect(sent.payload).toMatchObject({ refs: [{ assetVersionId: imageAsset.assetVersionId }] })
      await expect.poll(() => jobReads.includes('unavailable-fixture-job')).toBe(true)
      expect(await panel().locator('.vis-generation-result').count()).toBe(4)
      expect(await page.locator('.app-notices').textContent()).not.toContain('unavailable-fixture-job')
      archived = true
      await page.reload()
      await openSession()
      await page.getByText('This session is archived. You can only view its history.', { exact: true }).waitFor()
      // Both actions are disabled while the asset loads, so wait for it: Reference must then stay disabled because the session is archived.
      await result('Video result').getByRole('button', { name: /^Preview generation result:/ }).click({ trial: true })
      await expect.poll(() => result('Video result').getByRole('button', { name: /^Preview generation result:/ }).isEnabled()).toBe(true)
      const references = panel().getByRole('button', { name: /^Reference generation result:/ })
      expect(await references.evaluateAll(elements => elements.length > 0 && elements.every(element => (element as HTMLButtonElement).disabled))).toBe(true)
      expect(errors).toEqual([])
    } finally { await page.unrouteAll({ behavior: 'wait' }) }
  }, 60_000)

})
