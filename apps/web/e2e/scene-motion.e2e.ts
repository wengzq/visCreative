import { existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RenderVideoParams, SceneView, type MethodParams, type NodeView, type SceneDoc } from '@vis/protocol'
import { chromium, type Browser, type Page } from 'playwright-core'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createMockProvider, type ProviderAdapter, type ProviderRequest } from '../../../packages/generation/src/index'
import { studiodEndpoint } from '../../../runtime/studiod-endpoint'
import { codexRuntime } from '../../../services/studiod/src/codex'
import { createMemorySecretStore } from '../../../services/studiod/src/secret-store'
import { startStudiod, type Studiod } from '../../../services/studiod/src/studiod'
import { createWebHost, type WebHost } from '../src/host/server'
import { openStudiodLink, type StudiodLink } from '../src/host/studiod-link'
import { chromePath, removeTempDir } from './platform'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const screenshots = process.platform === 'win32' ? 'C:/tmp/vis-scene-motion-e2e' : '/tmp/vis-scene-motion-e2e'
let dir: string
let daemon: Studiod
let host: WebHost
let admin: StudiodLink
let browser: Browser
let page: Page
let sceneId: string
const errors: string[] = []
const requests: MethodParams<'generation.submit'>[] = []
const renders: ProviderRequest[] = []
const nodes = async (): Promise<NodeView[]> => (await admin.call('canvas.get', {})).nodes
const sceneNode = async () => (await nodes()).find(node => node.nodeId === sceneId)!
const slot = async () => (await sceneNode()).slots.find(slot => slot.slotKey === 'main')!
const doc = async (): Promise<SceneDoc> => {
  const content = (await slot()).content
  if (content.type !== 'scene') throw new Error('Expected a scene document')
  return content.doc
}
const editor = () => page.getByRole('dialog', { name: '3D scene', exact: true })
const field = (name: string) => editor().getByRole('spinbutton', { name, exact: true })
const button = (name: string) => editor().getByRole('button', { name, exact: true })
async function saved() {
  await expect.poll(() => editor().getByRole('status').allTextContents(), { timeout: 10_000 }).toContain('Saved')
}
async function seek(time: number) {
  await field('Playhead time (s)').fill(String(time))
  await field('Playhead time (s)').press('Enter')
}
async function openScene() {
  await page.getByRole('button', { name: 'Fit canvas', exact: true }).click()
  await page.getByRole('region', { name: /^3D scene · \d+ views$/ }).getByRole('button', { name: 'Open scene', exact: true }).click()
  await expect.poll(() => button('Add view').isEnabled(), { timeout: 10_000 }).toBe(true)
}

describe('Scene motion editor acceptance', () => {
  beforeAll(async () => {
    expect(existsSync(join(root, 'apps/web/dist/client/index.html')), 'Build the web app before scene motion acceptance').toBe(true)
    mkdirSync(screenshots, { recursive: true })
    dir = mkdtempSync(join(tmpdir(), 'vis-motion-'))
    vi.stubEnv('VIS_PROJECTS_DIR', join(dir, 'projects'))
    // This suite tests editor submission and delivery. The render worker's suite checks scene pixels.
    const mock = createMockProvider({ latencyMs: 0 })
    const sceneParams = RenderVideoParams.pick({ width: true, height: true, fps: true }).extend({ viewId: SceneView.shape.id })
    const render: ProviderAdapter = {
      ...mock, id: 'render', type: 'render', kinds: ['video'], models: ['scene'], defaultModels: { video: 'scene' },
      paramsSchema: sceneParams, paramsSchemaFor: () => sceneParams,
      async submit(request, options) {
        renders.push(request)
        return mock.submit({ ...request, model: 'mock-video-1', params: { width: 128, height: 128 } }, options)
      },
    }
    daemon = await startStudiod({
      dataDir: dir, studiodVersion: 'scene-motion-e2e', secretStore: createMemorySecretStore(),
      providers: [render], defaults: { video: { provider: 'render', model: 'scene' } },
      runtimes: { codex: codexRuntime({ dataDir: dir, socketPath: studiodEndpoint(dir), codexPath: join(root, 'apps/web/e2e/fake-codex.mjs'), visMcp: { command: process.execPath, args: [join(root, 'apps/cli/dist/vis.mjs'), 'mcp'] } }) },
    })
    const spaceId = daemon.spaces.create('Scene motion acceptance').spaceId
    admin = await openStudiodLink({ socketPath: daemon.socketPath, tokenPath: daemon.tokenPath })
    await admin.call('events.subscribe', { spaceId })
    await admin.call('session.create', { requestId: crypto.randomUUID(), agentKind: 'codex' })
    host = await createWebHost({ socketPath: daemon.socketPath, tokenPath: daemon.tokenPath, staticDir: join(root, 'apps/web/dist/client') })
    browser = await chromium.launch({ ...(process.platform === 'win32' ? { channel: 'msedge' } : { executablePath: chromePath() }), headless: true })
    page = await browser.newPage({ locale: 'en-US', viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2, reducedMotion: 'reduce' })
    page.setDefaultTimeout(5000)
    page.on('pageerror', error => errors.push(error.message))
    page.on('websocket', socket => socket.on('framesent', ({ payload }) => {
      const message = JSON.parse(String(payload))
      if (message.method === 'generation.submit') requests.push(message.params)
    }))
    await page.goto(host.url, { waitUntil: 'domcontentloaded', timeout: 15_000 })
    await page.getByRole('button', { name: 'New 3D scene', exact: true }).waitFor()
  })
  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail' && page) await page.screenshot({ path: join(screenshots, `failure-${task.name.replaceAll(/[^a-z0-9]+/gi, '-')}.png`), animations: 'disabled' })
  })
  afterAll(async () => {
    await browser?.close()
    admin?.close()
    await host?.close()
    await daemon?.stop('user_quit')
    vi.unstubAllEnvs()
    removeTempDir(dir)
  })

  it('adds motion, auto-keys figure positions and samples linear and hold segments in the inspector', async () => {
    await page.getByRole('button', { name: 'New 3D scene', exact: true }).click()
    await expect.poll(async () => (await nodes()).filter(node => node.kind === 'scene').length).toBe(1)
    sceneId = (await nodes()).find(node => node.kind === 'scene')!.nodeId
    await openScene()
    expect(await button('Render video').isDisabled()).toBe(true)
    await button('Add a figure').click()
    await editor().getByRole('textbox', { name: 'Object name', exact: true }).fill('Hero')
    await page.keyboard.press('Enter')
    await button('Add view').click()
    await editor().getByRole('textbox', { name: 'View name', exact: true }).fill('Wide')
    await page.keyboard.press('Enter')
    expect(await button('Render video').isDisabled()).toBe(true)
    await button('Add motion').click()
    expect(await field('Duration (s)').inputValue()).toBe('5')
    await page.keyboard.press('k')
    await seek(2)
    await field('Position (m) X').fill('4')
    expect(await button('Render video').isDisabled()).toBe(true)
    await seek(1)
    await expect.poll(() => field('Position (m) X').inputValue()).toBe('2')
    await button('Transform key at 0 s').click()
    await editor().getByRole('combobox', { name: 'Ease', exact: true }).selectOption('hold')
    await seek(1)
    await expect.poll(() => field('Position (m) X').inputValue()).toBe('0')
    await saved()
    expect((await doc()).objects[0]!.tracks?.transform).toMatchObject([
      { t: 0, ease: 'hold', value: { position: [0, 0, 0] } },
      { t: 2, ease: 'linear', value: { position: [4, 0, 0] } },
    ])
  })

  it('keys the current camera, reloads the saved motion and renders a video with pinned scene provenance', async () => {
    await seek(0)
    await button('Select track: View camera').click()
    await button('Set key (K)').click()
    await seek(2)
    await field('Focal length (mm)').fill('85')
    await seek(1)
    await saved()
    expect((await doc()).views[0]!.cameraKeys).toHaveLength(2)
    const firstLens = (await doc()).views[0]!.cameraKeys![0]!.value.focalLengthMm
    await expect.poll(async () => Number(await field('Focal length (mm)').inputValue())).toBeCloseTo((firstLens + 85) / 2, 3)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await openScene()
    await button('Select object: Hero').click()
    expect(await field('Duration (s)').inputValue()).toBe('5')
    await seek(1)
    await expect.poll(() => field('Position (m) X').inputValue()).toBe('0')
    await expect.poll(async () => Number(await field('Focal length (mm)').inputValue())).toBeCloseTo((firstLens + 85) / 2, 3)
    await saved()
    const committed = await slot()
    const viewId = (await doc()).views[0]!.id
    await button('Render video').click()
    await expect.poll(() => requests.length).toBe(1)
    expect(requests[0]).toMatchObject({
      provider: 'render', model: 'scene', kind: 'video',
      inputs: [{ slotId: committed.slotId, revision: committed.revision }],
      params: { viewId, width: 1920, height: 1080, fps: 24 },
      targets: [{ outputIndex: 0, kind: 'new_node', nearNodeId: sceneId }],
    })
    await expect.poll(() => renders.length).toBe(1)
    expect(renders[0]).toMatchObject({ kind: 'video', model: 'scene', params: { viewId, width: 1920, height: 1080, fps: 24 } })
    await expect.poll(async () => (await nodes()).filter(node => node.kind === 'video').length, { timeout: 10_000 }).toBe(1)
    expect((await nodes()).find(node => node.kind === 'video')!.inputs).toEqual([sceneId])
    await page.screenshot({ path: join(screenshots, 'motion-editor.png'), animations: 'disabled' })
  })

  it('commits key drags on release, rejects time collisions and allows typing a key time', async () => {
    await button('Transform key at 2 s').click()
    await saved()
    const revision = (await slot()).revision
    const key = await button('Transform key at 2 s').boundingBox()
    const lane = await editor().getByRole('group', { name: 'Transform keys', exact: true }).boundingBox()
    expect(key).not.toBeNull()
    expect(lane).not.toBeNull()
    await page.mouse.move(key!.x + key!.width / 2, key!.y + key!.height / 2)
    await page.mouse.down()
    await page.mouse.move(lane!.x + lane!.width * 0.6, key!.y + key!.height / 2, { steps: 4 })
    expect((await slot()).revision).toBe(revision)
    expect((await doc()).objects[0]!.tracks!.transform![1]!.t).toBe(2)
    await page.mouse.up()
    await saved()
    await button('Transform key at 3 s').click()
    await field('Key time (s)').fill('0')
    await field('Key time (s)').press('Enter')
    await editor().getByRole('alert').filter({ hasText: 'Key times must be unique' }).waitFor()
    expect((await doc()).objects[0]!.tracks!.transform!.map(key => key.t)).toEqual([0, 3])
    await field('Key time (s)').fill('2')
    await field('Key time (s)').press('Enter')
    await saved()
    expect((await doc()).objects[0]!.tracks!.transform!.map(key => key.t)).toEqual([0, 2])
  })

  it('supports keyboard playback with reduced motion, frame stepping and key navigation without reaching the canvas', async () => {
    await button('Select track: Transform').click()
    await seek(0)
    await page.keyboard.press('.')
    await expect.poll(async () => Number(await field('Playhead time (s)').inputValue())).toBeCloseTo(1 / 24, 4)
    await page.keyboard.press(',')
    await expect.poll(() => field('Playhead time (s)').inputValue()).toBe('0')
    await page.keyboard.press(']')
    await expect.poll(() => field('Playhead time (s)').inputValue()).toBe('2')
    await page.keyboard.press('[')
    await expect.poll(() => field('Playhead time (s)').inputValue()).toBe('0')
    await page.keyboard.press('Space')
    await expect.poll(async () => Number(await field('Playhead time (s)').inputValue())).toBeGreaterThan(0)
    await page.keyboard.press('Space')
    await button('Play').waitFor()
    expect((await nodes()).filter(node => node.kind === 'scene')).toHaveLength(1)
  })

  it('keys visibility and figure joints and restores a static value when the final key is deleted', async () => {
    await seek(0)
    await button('Select track: Visibility').click()
    await button('Set key (K)').click()
    await seek(2)
    await button('Hide object: Hero').click()
    await seek(1)
    await button('Hide object: Hero').waitFor()
    await button('Visibility key at 0 s').click()
    await button('Delete key').click()
    await button('Visibility key at 2 s').click()
    await button('Delete key').click()
    await button('Show object: Hero').waitFor()
    await button('Show object: Hero').click()
    await button('Select joint: Left shoulder').click()
    await seek(0)
    await page.keyboard.press('k')
    await seek(2)
    await field('Left shoulder rotation (degrees) X').fill('30')
    await field('Left shoulder rotation (degrees) X').press('Enter')
    await seek(1)
    await expect.poll(async () => Number(await field('Left shoulder rotation (degrees) X').inputValue())).toBeCloseTo(15, 3)
    await button('Left shoulder key at 0 s').click()
    await button('Delete key').click()
    await button('Left shoulder key at 2 s').click()
    await button('Delete key').click()
    await seek(0)
    await expect.poll(async () => Number(await field('Left shoulder rotation (degrees) X').inputValue())).toBeCloseTo(30, 3)
    await button('Reset joint').click()
    await button('Leave joint selection').click()
    await saved()
    expect((await doc()).objects[0]!.tracks?.hidden).toBeUndefined()
    expect((await doc()).objects[0]!.tracks?.pose).toBeUndefined()
  })

  it('nudges a keyed object from the keyboard by updating its key at the playhead', async () => {
    if (await button('Pause').count()) await button('Pause').click()
    await button('Select object: Hero').click()
    await seek(2)
    const before = (await doc()).objects[0]!.tracks!.transform!
    expect(before.map(key => key.t)).toEqual([0, 2])
    await editor().focus()
    await page.keyboard.press('w')
    await page.keyboard.press('ArrowRight')
    // A nudge on a keyed transform must move the key, not the static transform the track overrides.
    await expect.poll(async () => (await doc()).objects[0]!.tracks!.transform![1]!.value.position, { timeout: 10_000 }).not.toEqual(before[1]!.value.position)
    const after = (await doc()).objects[0]!.tracks!.transform!
    expect(after.map(key => key.t)).toEqual([0, 2])
    expect(after[0]).toEqual(before[0])
    await expect.poll(async () => Number(await field('Position (m) X').inputValue())).toBeCloseTo(after[1]!.value.position[0], 3)
  })

  it('confirms the number of keys removed on shortening and keeps the duration badge on the card', async () => {
    if (await button('Pause').count()) await button('Pause').click()
    await field('Duration (s)').fill('1')
    await field('Duration (s)').press('Enter')
    await editor().getByRole('alert').filter({ hasText: 'Shortening the duration will delete 2 keys. Continue?' }).waitFor()
    expect((await doc()).durationS).toBe(5)
    await button('Cancel').click()
    expect(await field('Duration (s)').inputValue()).toBe('5')
    await field('Duration (s)').fill('1')
    await field('Duration (s)').press('Enter')
    await button('Shorten and delete keys').click()
    await saved()
    expect((await doc()).durationS).toBe(1)
    expect((await doc()).objects[0]!.tracks!.transform).toHaveLength(1)
    expect((await doc()).views[0]!.cameraKeys).toHaveLength(1)
    await button('Close scene editor').click()
    await editor().waitFor({ state: 'detached' })
    expect(await page.getByRole('region', { name: /^3D scene · \d+ views$/ }).getByText('1 s', { exact: true }).count()).toBe(1)
    expect(errors).toEqual([])
  })
})
