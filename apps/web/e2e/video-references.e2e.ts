import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright-core'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { arkVideoParamsSchema, createMockProvider, type ProviderRequest, type ProviderType } from '../../../packages/generation/src/index'
import { promptRef, type CanvasOp, type NodeView } from '../../../packages/protocol/src/index'
import { createMemorySecretStore } from '../../../services/studiod/src/secret-store'
import { createFakeTos } from '../../../services/studiod/src/testing/fake-tos'
import { startStudiod, type Studiod } from '../../../services/studiod/src/studiod'
import { createWebHost, type WebHost } from '../src/host/server'
import { openStudiodLink, type StudiodLink } from '../src/host/studiod-link'
import { chromePath, removeTempDir } from './platform'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const screenshots = join(process.platform === 'win32' ? tmpdir() : '/tmp', 'vis-at-refs')
const ready = existsSync(chromePath()) && existsSync(join(root, 'apps/web/dist/client/index.html'))
const model = 'mock-video-1'
const seedanceModels = [
  { id: 'doubao-seedance-2-0-260128', label: 'Seedance 2.0 fixture' },
  { id: 'doubao-seedance-2-5-260628', label: 'Seedance 2.5 fixture' },
]
const clipNames = ['Short reference', 'Long reference A', 'Long reference B', 'Overlong reference']
const durations = [5000, 20000, 20000, 31000]
const countError = 'At most 3 video references are allowed'
const durationError = 'Each video reference must be 0.001–30 seconds long'
const totalError = 'The total duration of video references cannot exceed 30 seconds'
const frameError = 'This generation service cannot combine frame inputs with media references'
let dir: string
let studiod: Studiod
let host: WebHost
let admin: StudiodLink
let browser: Browser
let page: Page
let tos: Awaited<ReturnType<typeof createFakeTos>>
let spaceId: string
let targetId: string
let clips: string[]
let assets: string[]
let submittedInputs: ProviderRequest['inputs']
let submittedPrompt: string
let unexpectedHostedSubmits = 0
const errors: string[] = []
const apply = (ops: CanvasOp[]) => admin.call('canvas.apply', { requestId: crypto.randomUUID(), ops })
const nodes = async () => (await admin.call('canvas.get')).nodes as NodeView[]
const target = async () => (await nodes()).find(node => node.nodeId === targetId)!
const generate = () => page.getByRole('button', { name: 'Generate', exact: true })
const settingsLink = () => page.getByRole('button', { name: 'Media hosting settings', exact: true })
const preview = (ordinal: number) => page.getByRole('button', { name: `Insert Video ${ordinal}`, exact: true })
async function pick(index: number) {
  const previous = (await target()).inputs?.length ?? 0
  await page.getByRole('button', { name: 'Add reference', exact: true }).click()
  await page.getByText(clipNames[index]!, { exact: true }).click()
  await expect.poll(async () => (await target()).inputs?.length).toBe(previous + 1)
  await expect.poll(() => preview(previous + 1).isVisible()).toBe(true)
}
async function remove(index: number) {
  const previous = (await target()).inputs?.length ?? 0
  await page.getByRole('button', { name: `Remove reference ${clips[index]}`, exact: true }).click()
  await expect.poll(async () => (await target()).inputs?.length ?? 0).toBe(previous - 1)
}
async function selectModel(label: string) {
  await page.getByRole('button', { name: 'Model and parameters', exact: true }).click()
  const picker = page.getByRole('dialog', { name: 'Choose model and parameters', exact: true })
  await picker.getByRole('button', { name: label, exact: true }).click()
  await picker.press('Escape')
}
async function problem(message: string, absent: string[]) {
  await expect.poll(() => page.getByText(message, { exact: true }).isVisible()).toBe(true)
  for (const text of absent) expect(await page.getByText(text, { exact: true }).count()).toBe(0)
  await expect.poll(() => generate().isDisabled()).toBe(true)
}

describe.skipIf(!ready)('Video references from the model catalog', () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'vis-video-references-'))
    vi.stubEnv('VIS_PROJECTS_DIR', join(dir, 'projects'))
    tos = await createFakeTos()
    const mock = createMockProvider({ latencyMs: 0 })
    const submit = mock.submit.bind(mock)
    // Expose the real frame-mode control on the local mock so exclusivity can be exercised without a vendor.
    mock.paramsSchemaFor = kind => kind === 'video' ? arkVideoParamsSchema : mock.paramsSchema
    mock.submit = async (request, options) => {
      submittedInputs = request.inputs
      submittedPrompt = request.prompt
      return submit(request, options)
    }
    const hostedType: ProviderType = {
      type: 'hosted-fixture', label: { zh: 'Hosted fixture', en: 'Hosted fixture' }, needsKey: false, kinds: ['video'], regions: [], allowCustomBaseUrl: true,
      knownModels: [{ id: model, kind: 'video', label: 'Hosted reference fixture' }, ...seedanceModels.map(model => ({ ...model, kind: 'video' as const }))], verified: false,
      help: { consoleUrl: 'https://example.invalid', key: { zh: 'Local test only', en: 'Local test only' } },
      create: config => ({ ...mock, id: config.id, type: config.type, configuration: config,
        referenceLimitsFor: (kind, id) => {
          const limits = mock.referenceLimitsFor!(kind, seedanceModels.some(model => model.id === id) ? model : id)
          return limits?.video ? { ...limits, video: { ...limits.video, requiresHosting: true } } : limits
        },
        async submit() {
          unexpectedHostedSubmits++
          throw new Error('The catalog fixture must never submit')
        },
      }),
    }
    studiod = await startStudiod({ dataDir: dir, studiodVersion: 'e2e', runtimes: {}, secretStore: createMemorySecretStore(), hostingSecretStore: createMemorySecretStore(), hostingFetch: tos.fetch, hostingUploadRequest: tos.uploadRequest,
      providers: [mock], providerTypes: [hostedType], defaults: { image: { provider: 'mock' }, video: { provider: 'mock' }, audio: { provider: 'mock' } } })
    spaceId = studiod.spaces.create('Video references').spaceId
    admin = await openStudiodLink({ socketPath: studiod.socketPath, tokenPath: studiod.tokenPath })
    await admin.call('events.subscribe', { spaceId })
    await admin.call('preferences.set', { locale: 'en' })
    await admin.call('providers.update', { config: { providers: [{ id: 'hosted-fixture', type: hostedType.type, label: 'Hosted fixture', baseUrl: 'http://127.0.0.1:1', imageModels: [], videoModels: [{ id: model, label: 'Hosted reference fixture' }, ...seedanceModels], audioModels: [] }], defaults: { video: { provider: 'mock', model } }, limits: { maxConcurrent: 3, dailyImage: 50, dailyVideo: 10, dailyAudio: 20 } } })
    const space = studiod.spaces.get(spaceId)!
    assets = []
    for (let index = 0; index < durations.length; index++) {
      const path = join(dir, `clip-${index}.mp4`)
      execFileSync('ffmpeg', ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i', `color=c=steelblue:s=160x90:r=24:d=${durations[index]! / 1000}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path], { windowsHide: true })
      assets.push(space.assets.registerVersion(space.db, { staged: await space.assets.stageFile(path), kind: 'video', mime: 'video/mp4', origin: 'import', width: 160, height: 90, fps: 24, durationMs: durations[index]! }).assetVersionId)
    }
    host = await createWebHost({ socketPath: studiod.socketPath, tokenPath: studiod.tokenPath, staticDir: join(root, 'apps/web/dist/client') })
    browser = await chromium.launch({ executablePath: chromePath(), headless: true })
  })
  beforeEach(async () => {
    await admin.call('hosting.update', { config: null })
    const existing = await nodes()
    if (existing.length) await apply(existing.map(node => ({ op: 'node.delete', nodeId: node.nodeId })))
    const { idMap } = await apply([
      ...assets.map((assetVersionId, index) => ({ op: 'node.create' as const, tempId: `clip-${index}`, title: clipNames[index]!, kind: 'video' as const, x: 0, y: index * 170, w: 200, h: 120, content: { assetVersionId } })),
      { op: 'node.create', tempId: 'target', kind: 'video', title: 'Video draft', x: 400, y: 0, w: 480, h: 270, prompt: 'Follow the reference camera motion' },
    ])
    clips = assets.map((_, index) => idMap[`clip-${index}`])
    targetId = idMap.target
    submittedInputs = []
    submittedPrompt = ''
    errors.length = 0
    page = await browser.newPage({ locale: 'en', viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 })
    page.setDefaultTimeout(10_000)
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(host.url)
    await page.getByText('Video draft', { exact: true }).click()
    await page.getByRole('textbox', { name: 'Prompt', exact: true }).waitFor()
    await expect.poll(() => generate().isEnabled()).toBe(true)
  })
  afterEach(async ({ task }) => {
    try {
      if (task.result?.state === 'fail') await page?.screenshot({ path: join(tmpdir(), 'vis-video-references-failure.png'), animations: 'disabled' })
      expect(errors).toEqual([])
      expect(unexpectedHostedSubmits).toBe(0)
    } finally { await page?.close() }
  })
  afterAll(async () => {
    await browser?.close()
    admin?.close()
    await host?.close()
    await studiod?.stop('user_quit')
    await tos?.close()
    vi.unstubAllEnvs()
    if (dir) removeTempDir(dir)
  })

  it('picks a mock video reference with its poster, badge, duration, limits and billing note and submits without hosting', async () => {
    expect((await admin.call('providers.list')).videoReferences).toBe('hosting_required')
    await pick(0)
    await expect.poll(() => preview(1).locator('img').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(160)
    expect(await preview(1).locator('img').getAttribute('src')).toContain('/poster?t=')
    expect(await preview(1).getByLabel('Video', { exact: true }).count()).toBe(1)
    await preview(1).getByText('0:05', { exact: true }).waitFor()
    await page.getByText('1 / 3 videos · 5 / 30 s', { exact: true }).waitFor()
    await page.getByText('Reference video duration adds to billed tokens.', { exact: true }).waitFor()
    expect(await settingsLink().count()).toBe(0)
    await expect.poll(() => generate().isEnabled()).toBe(true)
    const jobs = () => studiod.spaces.get(spaceId)!.db.query.generationJobs.findMany().sync()
    const before = jobs().length
    await generate().click()
    await expect.poll(() => jobs().slice(before).map(job => job.status), { timeout: 10_000 }).toEqual(['succeeded'])
    const videos = submittedInputs.filter(input => input.type === 'asset' && input.kind === 'video')
    expect(videos).toHaveLength(1)
    expect(videos[0]).toMatchObject({ kind: 'video', mime: 'video/mp4', durationMs: 5000 })
    expect(tos.verified).toBe(0)
    expect((await admin.call('hosting.get')).config).toBeNull()
  })

  it.each(['mock-video-1', 'Hosted reference fixture', ...seedanceModels.map(model => model.label)])('inserts attached image and video markers with %s catalog limits', async label => {
    if (label !== model) await selectModel(label)
    await pick(0)
    const space = studiod.spaces.get(spaceId)!
    const staged = await space.assets.stageBytes(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="red"/></svg>'))
    const asset = space.assets.registerVersion(space.db, { staged, kind: 'image', mime: 'image/svg+xml', origin: 'import', width: 20, height: 20 })
    const { idMap } = await apply([
      { op: 'node.create', tempId: 'image', kind: 'image', purpose: 'working', content: { assetVersionId: asset.assetVersionId } },
      { op: 'node.setInputs', nodeId: targetId, inputNodeIds: [clips[0]!, 'image'] },
    ])
    await expect.poll(() => page.getByRole('button', { name: 'Insert Image 1', exact: true }).isEnabled()).toBe(true)
    const prompt = page.getByRole('textbox', { name: 'Prompt', exact: true })
    await prompt.fill('Use ')
    await prompt.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End')
    await prompt.press('@')
    await page.getByRole('listbox', { name: 'Insert reference', exact: true }).waitFor()
    expect(await page.getByRole('group', { name: 'Attached references', exact: true }).getByRole('option').evaluateAll(options => options.map(option => option.getAttribute('aria-label')))).toEqual(['Video 1', 'Image 1'])
    await page.getByRole('option', { name: 'Video 1', exact: true }).click()
    await prompt.pressSequentially(' with @')
    await prompt.press('ArrowDown')
    await prompt.press('Enter')
    expect(await prompt.getByText('Video 1', { exact: true }).count()).toBe(1)
    expect(await prompt.getByText('Image 1', { exact: true }).count()).toBe(1)
    await page.getByRole('button', { name: 'Parameter summary', exact: true }).click()
    await expect.poll(async () => (await target()).slots.find(slot => slot.slotKey === 'prompt')?.content).toEqual({ type: 'text', body: `Use ${promptRef(clips[0]!)} with ${promptRef(idMap.image)}` })
    await page.getByRole('dialog', { name: 'Generation parameters', exact: true }).press('Escape')
    expect((await target()).inputs).toEqual([clips[0], idMap.image])
    mkdirSync(screenshots, { recursive: true })
    await page.screenshot({ path: join(screenshots, `catalog-${label.replaceAll(' ', '-')}.png`), animations: 'disabled' })
  })

  it('keeps mixed image and video chip numbers aligned with submitted labels after reordering', async () => {
    const space = studiod.spaces.get(spaceId)!
    const staged = await space.assets.stageBytes(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="red"/></svg>'))
    const image = space.assets.registerVersion(space.db, { staged, kind: 'image', mime: 'image/svg+xml', origin: 'import', width: 20, height: 20 })
    const { idMap } = await apply([{ op: 'node.create', tempId: 'image', kind: 'image', x: 0, y: 700, w: 100, h: 100, content: { assetVersionId: image.assetVersionId } }])
    await apply([{ op: 'node.setInputs', nodeId: targetId, inputNodeIds: [clips[0]!, idMap.image, clips[1]!] }])
    await page.getByRole('button', { name: 'Insert Image 1', exact: true }).waitFor()
    await preview(1).waitFor()
    await preview(2).waitFor()
    const prompt = page.getByRole('textbox', { name: 'Prompt', exact: true })
    await prompt.fill('Use ')
    await preview(2).click()
    await expect.poll(() => prompt.textContent()).toBe('Use Video 2')
    await apply([{ op: 'node.setInputs', nodeId: targetId, inputNodeIds: [clips[1]!, idMap.image, clips[0]!] }])
    await expect.poll(() => prompt.textContent()).toBe('Use Video 1')
    await page.getByRole('button', { name: 'Insert Image 1', exact: true }).waitFor()
    await generate().click()
    await expect.poll(() => submittedPrompt).toBe('Use 视频 1')
    expect(submittedInputs.filter(input => input.type === 'asset').map(input => input.kind)).toEqual(['video', 'image', 'video'])
  })

  it('prioritizes count, per-clip duration and total duration and re-enables submit after removals', async () => {
    for (const index of [3, 1, 2, 0]) await pick(index)
    await page.getByText('4 / 3 videos · 76 / 30 s', { exact: true }).waitFor()
    await problem(countError, [durationError, totalError])
    await remove(0)
    await problem(durationError, [countError, totalError])
    await remove(3)
    await problem(totalError, [countError, durationError])
    await remove(2)
    await page.getByText('1 / 3 videos · 20 / 30 s', { exact: true }).waitFor()
    await expect.poll(() => generate().isEnabled()).toBe(true)
    await pick(0)
    await page.getByText('2 / 3 videos · 25 / 30 s', { exact: true }).waitFor()
    await expect.poll(() => generate().isEnabled()).toBe(true)
  })

  it('keeps first-frame and first-and-last-frame modes exclusive with video references', async () => {
    await pick(0)
    for (const mode of ['First frame', 'First and last frames']) {
      await page.getByRole('button', { name: 'Parameter summary', exact: true }).click()
      const parameters = page.getByRole('dialog', { name: 'Generation parameters', exact: true })
      await parameters.getByRole('group', { name: 'Reference image mode', exact: true }).getByRole('button', { name: mode, exact: true }).click()
      await parameters.press('Escape')
      await problem(frameError, [])
      await remove(0)
      await expect.poll(() => page.getByText(frameError, { exact: true }).count()).toBe(0)
      await expect.poll(() => generate().isEnabled()).toBe(true)
      await pick(0)
      await problem(frameError, [])
      await page.getByRole('button', { name: 'Parameter summary', exact: true }).click()
      await parameters.getByRole('group', { name: 'Reference image mode', exact: true }).getByRole('button', { name: 'Auto', exact: true }).click()
      await parameters.press('Escape')
      await expect.poll(() => generate().isEnabled()).toBe(true)
    }
  })

  it('links hosted-model readiness to Media hosting settings while leaving the mock exempt', async () => {
    await pick(0)
    expect(await settingsLink().count()).toBe(0)
    await selectModel('Hosted reference fixture')
    await expect.poll(() => settingsLink().isVisible()).toBe(true)
    await expect.poll(() => generate().isDisabled()).toBe(true)
    await settingsLink().click()
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
    await expect.poll(() => settings.getByRole('button', { name: 'Media hosting', exact: true }).getAttribute('aria-pressed')).toBe('true')
    await settings.getByLabel('Hosting region', { exact: true }).fill('cn-beijing')
    await settings.getByLabel('Bucket', { exact: true }).fill('reference-clips')
    await settings.getByLabel('Access key ID', { exact: true }).fill('testAK')
    await settings.getByRole('button', { name: 'Save media hosting', exact: true }).click()
    await settings.getByText('Media hosting saved', { exact: true }).waitFor()
    await settings.getByLabel('Secret access key', { exact: true }).fill('testSK')
    await settings.getByRole('button', { name: 'Save hosting secret', exact: true }).click()
    await settings.getByText('Hosting secret saved', { exact: true }).waitFor()
    await settings.getByRole('button', { name: 'Test media hosting', exact: true }).click()
    await settings.getByText('Connection test succeeded', { exact: true }).waitFor()
    expect(tos.verified).toBe(3)
    expect(tos.rejected).toBe(0)
    await settings.getByRole('button', { name: 'Close settings', exact: true }).click()
    await expect.poll(() => settingsLink().count()).toBe(0)
    await expect.poll(() => generate().isEnabled()).toBe(true)
    await admin.call('hosting.update', { config: null })
    await expect.poll(() => settingsLink().isVisible()).toBe(true)
    await selectModel('mock-video-1')
    await expect.poll(() => settingsLink().count()).toBe(0)
    await expect.poll(() => generate().isEnabled()).toBe(true)
  })
})
