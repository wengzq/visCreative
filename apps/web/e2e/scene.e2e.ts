import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright-core'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { EMPTY_PREVIZ, SCENE_LIMITS, emptyPrevizPanel, type CanvasOp, type NodeView, type PrevizDoc, type SceneDoc, type SceneObject } from '@vis/protocol'
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
const screenshots = process.platform === 'win32' ? 'C:/tmp/vis-0037-S6' : '/tmp/vis-0037-S6'
let dir: string
let daemon: Studiod
let host: WebHost
let admin: StudiodLink
let browser: Browser
let page: Page
let sceneId: string
let previzId: string
let spaceId: string
let importedModel: string
const pageErrors: string[] = []
const jsRequests: string[] = []
const nodes = async (): Promise<NodeView[]> => (await admin.call('canvas.get', {})).nodes
const apply = (ops: CanvasOp[]) => admin.call('canvas.apply', { requestId: crypto.randomUUID(), ops })
const sceneNode = async () => (await nodes()).find(node => node.nodeId === sceneId)!
const sceneSlot = async () => (await sceneNode()).slots.find(slot => slot.slotKey === 'main')!
async function sceneDoc(): Promise<SceneDoc> {
  const content = (await sceneSlot()).content
  if (content.type !== 'scene') throw new Error('Expected a scene document')
  return content.doc
}
async function previzDoc(): Promise<PrevizDoc> {
  const content = (await nodes()).find(node => node.nodeId === previzId)!.slots.find(slot => slot.slotKey === 'main')!.content
  if (content.type !== 'previz') throw new Error('Expected a previz document')
  return content.doc
}
const editor = () => page.getByRole('dialog', { name: '3D scene', exact: true })
const card = () => page.getByRole('region', { name: /^3D scene · \d+ views$/ })
const previzEditor = () => page.getByRole('dialog', { name: 'Storyboard', exact: true })
async function saved() {
  await expect.poll(() => editor().getByRole('status').allTextContents(), { timeout: 10_000 }).toContain('Saved')
}
async function viewportReady() {
  await expect.poll(() => editor().getByRole('button', { name: 'Add view', exact: true }).isEnabled(), { timeout: 10_000 }).toBe(true)
  const unavailable = await editor().getByRole('alert').filter({ hasText: 'WebGL is unavailable' }).count()
  expect(unavailable, 'WebGL must be available; do not skip scene acceptance cases').toBe(0)
}
async function openScene() {
  await page.getByRole('button', { name: 'Fit canvas', exact: true }).click()
  await card().getByRole('button', { name: 'Open scene', exact: true }).click()
  await editor().waitFor()
  await viewportReady()
}
async function closeScene() {
  await editor().getByRole('button', { name: 'Close scene editor', exact: true }).click()
  await editor().waitFor({ state: 'detached' })
}
async function openPreviz() {
  if (await previzEditor().count()) return
  await page.getByRole('button', { name: 'Fit canvas', exact: true }).click()
  await page.getByRole('region', { name: /^Shot previz Storyboard,/ }).getByRole('button', { name: 'Open shot previz', exact: true }).click()
  await previzEditor().waitFor()
}
async function add(name: string) {
  await editor().getByRole('button', { name: 'Add', exact: true }).click()
  await editor().getByRole('group', { name: 'Add objects', exact: true }).getByRole('button', { name, exact: true }).click()
}
async function importFile(path: string) {
  await editor().getByRole('button', { name: 'Add', exact: true }).click()
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    editor().getByRole('group', { name: 'Add objects', exact: true }).getByRole('button', { name: 'Import GLB', exact: true }).click(),
  ])
  await chooser.setFiles(path)
}
function triangleGlb() {
  const binary = Buffer.alloc(36)
  const positions = [-0.5, 0, 0, 0.5, 0, 0, 0, 1, 0]
  positions.forEach((value, index) => binary.writeFloatLE(value, index * 4))
  const json = Buffer.from(JSON.stringify({
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    buffers: [{ byteLength: binary.length }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: binary.length }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [-0.5, 0, 0], max: [0.5, 1, 0] }],
  }))
  const length = Math.ceil(json.length / 4) * 4
  const bytes = Buffer.alloc(28 + length + binary.length, 0x20)
  bytes.writeUInt32LE(0x46546c67, 0)
  bytes.writeUInt32LE(2, 4)
  bytes.writeUInt32LE(bytes.length, 8)
  bytes.writeUInt32LE(length, 12)
  bytes.writeUInt32LE(0x4e4f534a, 16)
  json.copy(bytes, 20)
  bytes.writeUInt32LE(binary.length, 20 + length)
  bytes.writeUInt32LE(0x004e4942, 24 + length)
  binary.copy(bytes, 28 + length)
  return bytes
}

describe('Interactive scene editor acceptance', () => {
  beforeAll(async () => {
    expect(existsSync(cli), 'Build the CLI before running scene acceptance').toBe(true)
    expect(existsSync(join(root, 'apps/web/dist/client/index.html')), 'Build the web app before running scene acceptance').toBe(true)
    mkdirSync(screenshots, { recursive: true })
    dir = mkdtempSync(join(tmpdir(), 'vis-scene-e2e-'))
    vi.stubEnv('VIS_PROJECTS_DIR', join(dir, 'projects'))
    daemon = await startStudiod({
      dataDir: dir, studiodVersion: 'scene-e2e', secretStore: createMemorySecretStore(),
      providers: [createMockProvider({ latencyMs: 0 })], defaults: { image: { provider: 'mock' } },
      runtimes: { codex: codexRuntime({ dataDir: dir, socketPath: studiodEndpoint(dir), codexPath: join(root, 'apps/web/e2e/fake-codex.mjs'), visMcp: { command: process.execPath, args: [cli, 'mcp'] } }) },
    })
    spaceId = daemon.spaces.create('Scene acceptance').spaceId
    admin = await openStudiodLink({ socketPath: daemon.socketPath, tokenPath: daemon.tokenPath })
    await admin.call('events.subscribe', { spaceId })
    await admin.call('session.create', { requestId: crypto.randomUUID(), agentKind: 'codex' })
    host = await createWebHost({ socketPath: daemon.socketPath, tokenPath: daemon.tokenPath, staticDir: join(root, 'apps/web/dist/client') })
    browser = await chromium.launch({ ...(process.platform === 'win32' ? { channel: 'msedge' } : { executablePath: chromePath() }), headless: true })
    page = await browser.newPage({ locale: 'en-US', viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2, reducedMotion: 'reduce' })
    page.setDefaultTimeout(5000)
    page.on('pageerror', error => pageErrors.push(error.message))
    page.on('request', request => { if (request.resourceType() === 'script') jsRequests.push(request.url()) })
    await page.goto(host.url, { waitUntil: 'domcontentloaded', timeout: 15_000 })
    await page.getByRole('button', { name: 'New 3D scene', exact: true }).waitFor()
    const webgl = await page.evaluate(() => {
      const gl = document.createElement('canvas').getContext('webgl2')
      if (!gl) return false
      gl.getExtension('WEBGL_lose_context')?.loseContext()
      return true
    })
    expect(webgl, 'WebGL is unavailable in the test browser; report it to the coordinator').toBe(true)
  })
  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail' && page) await page.screenshot({ path: join(screenshots, `failure-${task.name.replaceAll(/[^a-z0-9]+/gi, '-')}.png`), animations: 'disabled', scale: 'css' })
  })
  afterAll(async () => {
    await browser?.close()
    admin?.close()
    await host?.close()
    await daemon?.stop('user_quit')
    vi.unstubAllEnvs()
    removeTempDir(dir)
  })

  it('creates from the toolbar, loads three only on open, and persists a mannequin and prop across reopening', async () => {
    const assets = join(root, 'apps/web/dist/client/assets')
    const sceneChunks = readdirSync(assets).filter(name => name.endsWith('.js') && readFileSync(join(assets, name), 'utf8').includes('WebGLRenderer'))
    expect(sceneChunks.length).toBeGreaterThan(0)
    const requestedScene = () => jsRequests.some(url => sceneChunks.includes(new URL(url).pathname.split('/').at(-1)!))
    expect(requestedScene()).toBe(false)
    await page.getByRole('button', { name: 'New 3D scene', exact: true }).click()
    await expect.poll(async () => (await nodes()).filter(node => node.kind === 'scene').length).toBe(1)
    sceneId = (await nodes()).find(node => node.kind === 'scene')!.nodeId
    await openScene()
    expect(requestedScene()).toBe(true)
    await editor().getByRole('button', { name: 'Add a figure', exact: true }).click()
    await editor().getByRole('textbox', { name: 'Object name', exact: true }).fill('Hero')
    await page.keyboard.press('Enter')
    await editor().getByRole('spinbutton', { name: 'Figure height (m)', exact: true }).fill('1.9')
    await add('Bench')
    await editor().getByRole('spinbutton', { name: 'Position (m) X', exact: true }).fill('2')
    await editor().getByRole('spinbutton', { name: 'Rotation (degrees) Y', exact: true }).fill('30')
    await closeScene()
    expect((await sceneDoc()).objects).toMatchObject([
      { name: 'Hero', source: { type: 'figure', heightM: 1.9 } },
      { name: 'Bench', source: { type: 'prop', propId: 'bench' }, transform: { position: [2, 0, 0] } },
    ])
    await openScene()
    expect(await editor().getByRole('button', { name: 'Select object: Hero', exact: true }).count()).toBe(1)
    expect(await editor().getByRole('button', { name: 'Select object: Bench', exact: true }).count()).toBe(1)
    await editor().getByRole('button', { name: 'Select object: Bench', exact: true }).click()
    expect(await editor().getByRole('spinbutton', { name: 'Position (m) X', exact: true }).inputValue()).toBe('2')
    expect(await editor().getByRole('spinbutton', { name: 'Rotation (degrees) Y', exact: true }).inputValue()).toBe('30')
  })

  it('adds a camera view and saves a nonblank 1920-pixel image with scene provenance and a card still', async () => {
    await editor().getByRole('button', { name: 'Add view', exact: true }).click()
    await editor().getByRole('textbox', { name: 'View name', exact: true }).fill('Wide')
    await page.keyboard.press('Enter')
    await editor().getByRole('button', { name: 'Through camera', exact: true }).click()
    await editor().getByRole('button', { name: '50 mm', exact: true }).click()
    await editor().getByRole('combobox', { name: 'Aspect ratio', exact: true }).selectOption('16:9')
    await expect.poll(() => editor().getByRole('button', { name: 'Save as image', exact: true }).isEnabled()).toBe(true)
    await editor().getByRole('button', { name: 'Save as image', exact: true }).click()
    await expect.poll(async () => (await nodes()).filter(node => node.kind === 'image').length, { timeout: 10_000 }).toBe(1)
    await saved()
    const view = (await sceneDoc()).views[0]!
    expect(view).toMatchObject({ name: 'Wide', still: expect.any(String), camera: { focalLengthMm: 50 } })
    const image = (await nodes()).find(node => node.kind === 'image')!
    expect(image.inputs).toEqual([sceneId])
    expect(image.slots[0]!.content).toMatchObject({ type: 'asset', assetVersionId: view.still })
    const token = new URLSearchParams(new URL(host.url).hash.slice(1)).get('t')!
    const png = await page.evaluate(async url => {
      const bitmap = await createImageBitmap(await (await fetch(url)).blob())
      const canvas = document.createElement('canvas')
      canvas.width = bitmap.width
      canvas.height = bitmap.height
      const context = canvas.getContext('2d')!
      context.drawImage(bitmap, 0, 0)
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
      const colours = new Set<number>()
      for (let index = 0; index < pixels.length; index += 64) colours.add(pixels[index]! << 16 | pixels[index + 1]! << 8 | pixels[index + 2]!)
      bitmap.close()
      return { width: canvas.width, height: canvas.height, colours: colours.size }
    }, `/assets/${spaceId}/${view.still}?t=${encodeURIComponent(token)}`)
    expect(png.width).toBe(1920)
    expect(png.height).toBe(1080)
    expect(png.colours).toBeGreaterThan(10)
    await expect.poll(() => editor().getByRole('img', { name: 'Wide still', exact: true }).evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(1920)
    await page.screenshot({ path: join(screenshots, 'editor.png'), animations: 'disabled', scale: 'css' })
    await closeScene()
    await expect.poll(() => card().getByRole('img', { name: 'Wide', exact: true }).evaluate(element => (element as HTMLImageElement).naturalWidth), { timeout: 10_000 }).toBeGreaterThan(0)
    await openScene()
  })

  it('poses a joint through the inspector, protects the figure from Delete and preserves pose through hiding, height changes and reload', async () => {
    await editor().getByRole('button', { name: 'Select object: Hero', exact: true }).click()
    await editor().getByRole('button', { name: 'Select joint: Right shoulder', exact: true }).click()
    const rotation = editor().getByRole('spinbutton', { name: 'Right shoulder rotation (degrees) X', exact: true })
    await rotation.fill('-70')
    await rotation.press('Enter')
    await saved()
    const figure = () => sceneDoc().then(doc => doc.objects.find(object => object.name === 'Hero')!)
    const pose = (object: SceneObject) => {
      if (object.source.type !== 'figure') throw new Error('Expected a figure')
      return object.source.pose
    }
    const originalPose = pose(await figure())
    expect(originalPose.rightShoulder![0]).toBeCloseTo(-Math.sin(35 * Math.PI / 180))
    for (const [key, name] of [['w', 'Move'], ['r', 'Scale'], ['e', 'Rotate']] as const) {
      await editor().focus()
      await page.keyboard.press(key)
      expect(await editor().getByRole('button', { name, exact: true }).getAttribute('aria-pressed')).toBe('true')
      expect(await editor().getByRole('button', { name: 'Select joint: Right shoulder', exact: true }).getAttribute('aria-pressed')).toBe('true')
    }
    await page.keyboard.press('Delete')
    await saved()
    expect(pose(await figure()).rightShoulder).toEqual([0, 0, 0, 1])
    expect((await sceneDoc()).objects.some(object => object.name === 'Hero')).toBe(true)
    await editor().getByRole('button', { name: 'Undo', exact: true }).click()
    await saved()
    expect(pose(await figure())).toEqual(originalPose)
    await editor().getByRole('spinbutton', { name: 'Figure height (m)', exact: true }).fill('0.95')
    await saved()
    expect(pose(await figure())).toEqual(originalPose)
    await editor().getByRole('spinbutton', { name: 'Figure height (m)', exact: true }).fill('1.9')
    await editor().getByRole('button', { name: 'Hide object: Hero', exact: true }).click()
    await saved()
    expect(await figure()).toMatchObject({ hidden: true })
    expect(pose(await figure())).toEqual(originalPose)
    await editor().getByRole('button', { name: 'Show object: Hero', exact: true }).click()
    await saved()
    await editor().focus()
    await page.keyboard.press('f')
    expect(await editor().getByRole('button', { name: 'Orbit', exact: true }).getAttribute('aria-pressed')).toBe('true')
    await page.keyboard.press('Escape')
    expect(await editor().getByRole('button', { name: 'Leave joint selection', exact: true }).count()).toBe(0)
    expect(await editor().count()).toBe(1)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await openScene()
    await editor().getByRole('button', { name: 'Select object: Hero', exact: true }).click()
    await editor().getByRole('button', { name: 'Select joint: Right shoulder', exact: true }).click()
    expect(Number(await editor().getByRole('spinbutton', { name: 'Right shoulder rotation (degrees) X', exact: true }).inputValue())).toBeCloseTo(-70)
    expect(pose(await figure())).toEqual(originalPose)
  })

  it('leaves an unchanged joint field without writing a pose key or saving', async () => {
    await editor().getByRole('button', { name: 'Select object: Hero', exact: true }).click()
    await editor().getByRole('button', { name: 'Select joint: Left elbow', exact: true }).click()
    const before = await sceneSlot()
    const rotation = editor().getByRole('spinbutton', { name: 'Left elbow rotation (degrees) X', exact: true })
    await rotation.focus()
    await editor().focus()
    await editor().getByRole('button', { name: 'Save', exact: true }).click()
    await saved()
    expect((await sceneSlot()).revision).toBe(before.revision)
    expect((await sceneSlot()).content).toEqual(before.content)
  })

  it('cancels typed joint text on Escape and keeps joint selection', async () => {
    await editor().getByRole('button', { name: 'Select joint: Right shoulder', exact: true }).click()
    const before = await sceneSlot()
    const rotation = editor().getByRole('spinbutton', { name: 'Right shoulder rotation (degrees) X', exact: true })
    const original = await rotation.inputValue()
    await rotation.fill('-95')
    await rotation.press('Escape')
    expect(await editor().getByRole('button', { name: 'Select joint: Right shoulder', exact: true }).getAttribute('aria-pressed')).toBe('true')
    expect(await rotation.inputValue()).toBe(original)
    await editor().getByRole('button', { name: 'Save', exact: true }).click()
    await saved()
    expect((await sceneSlot()).revision).toBe(before.revision)
    expect((await sceneSlot()).content).toEqual(before.content)
  })

  it.each(['Add', 'Send to…'])('closes %s before leaving joint selection on Escape', async name => {
    await editor().getByRole('button', { name: 'Select joint: Right shoulder', exact: true }).click()
    await editor().getByRole('button', { name, exact: true }).click()
    const overlay = name === 'Add' ? editor().getByRole('group', { name: 'Add objects', exact: true }) : editor().getByRole('dialog', { name: 'Send to…', exact: true })
    await overlay.waitFor()
    await page.keyboard.press('Escape')
    await overlay.waitFor({ state: 'detached' })
    expect(await editor().getByRole('button', { name: 'Select joint: Right shoulder', exact: true }).getAttribute('aria-pressed')).toBe('true')
  })

  it('commits pending joint text before viewport controls receive a pointer grab', async () => {
    await editor().getByRole('button', { name: 'Orbit', exact: true }).click()
    await editor().getByRole('button', { name: 'Select joint: Right shoulder', exact: true }).click()
    const before = await sceneDoc()
    await editor().getByRole('spinbutton', { name: 'Right shoulder rotation (degrees) X', exact: true }).fill('-65.25')
    const viewport = editor().getByRole('img', { name: '3D viewport', exact: true })
    const box = (await viewport.boundingBox())!
    await viewport.evaluate(element => {
      element.lastElementChild!.addEventListener('pointerdown', () => {
        element.setAttribute('data-pointer-focus', document.activeElement?.getAttribute('aria-label') ?? '')
      }, { once: true, capture: true })
    })
    await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.45)
    await page.mouse.down()
    await page.mouse.up()
    expect(await viewport.getAttribute('data-pointer-focus')).toBe('3D scene')
    await viewport.evaluate(element => element.removeAttribute('data-pointer-focus'))
    await saved()
    const source = (await sceneDoc()).objects.find(object => object.name === 'Hero')!.source
    if (source.type !== 'figure') throw new Error('Expected a figure')
    expect(source.pose.rightShoulder![0]).toBeCloseTo(Math.sin(-65.25 * Math.PI / 360))
    await editor().getByRole('button', { name: 'Undo', exact: true }).click()
    await saved()
    expect((await sceneDoc()).objects).toEqual(before.objects)
    await editor().getByRole('button', { name: 'Select object: Hero', exact: true }).click()
    await editor().getByRole('button', { name: 'Select joint: Right shoulder', exact: true }).click()
  })

  it('applies and undoes a preset, mirrors an asymmetric pose and saves a still that shows the pose', async () => {
    const figurePose = async () => {
      const source = (await sceneDoc()).objects.find(object => object.name === 'Hero')!.source
      if (source.type !== 'figure') throw new Error('Expected a figure')
      return source.pose
    }
    const before = await figurePose()
    const preset = editor().getByRole('combobox', { name: 'Preset pose', exact: true })
    await preset.selectOption('sitting')
    await editor().getByRole('button', { name: 'Apply pose', exact: true }).click()
    await saved()
    expect((await figurePose()).leftHip![0]).toBeCloseTo(-Math.SQRT1_2)
    await editor().getByRole('button', { name: 'Undo', exact: true }).click()
    await saved()
    expect(await figurePose()).toEqual(before)
    await editor().getByRole('button', { name: 'Reset to standing', exact: true }).click()
    await saved()
    expect(Object.values(await figurePose()).every(rotation => rotation.every((value, index) => Math.abs(value - (index === 3 ? 1 : 0)) < 1e-8))).toBe(true)
    const saveStill = async () => {
      const imageCount = (await nodes()).filter(node => node.kind === 'image').length
      await editor().getByRole('button', { name: 'Save as image', exact: true }).click()
      await expect.poll(async () => (await nodes()).filter(node => node.kind === 'image').length, { timeout: 10_000 }).toBe(imageCount + 1)
      await saved()
      return (await sceneDoc()).views[0]!.still!
    }
    const standingStill = await saveStill()
    await preset.selectOption('pointing')
    await editor().getByRole('button', { name: 'Apply pose', exact: true }).click()
    await saved()
    const pointing = await figurePose()
    await editor().getByRole('button', { name: 'Swap sides', exact: true }).click()
    await saved()
    expect((await figurePose()).leftShoulder![0]).toBeCloseTo(pointing.rightShoulder![0])
    expect((await figurePose()).leftShoulder![2]).toBeCloseTo(-pointing.rightShoulder![2])
    await editor().getByRole('button', { name: 'Swap sides', exact: true }).click()
    await saved()
    const restored = await figurePose()
    for (const [id, rotation] of Object.entries(pointing)) rotation.forEach((value, index) => expect(restored[id]![index]!).toBeCloseTo(value))
    await editor().getByRole('button', { name: 'Copy right to left', exact: true }).click()
    await saved()
    expect((await figurePose()).leftShoulder![0]).toBeCloseTo(pointing.rightShoulder![0])
    expect((await figurePose()).leftShoulder![2]).toBeCloseTo(-pointing.rightShoulder![2])
    await editor().getByRole('button', { name: 'Through camera', exact: true }).click()
    const posedStill = await saveStill()
    const token = new URLSearchParams(new URL(host.url).hash.slice(1)).get('t')!
    const changedPixels = await page.evaluate(async ({ urls }) => {
      const images = await Promise.all(urls.map(async url => {
        const bitmap = await createImageBitmap(await (await fetch(url)).blob())
        const canvas = document.createElement('canvas')
        canvas.width = bitmap.width
        canvas.height = bitmap.height
        const context = canvas.getContext('2d')!
        context.drawImage(bitmap, 0, 0)
        bitmap.close()
        return context.getImageData(0, 0, canvas.width, canvas.height).data
      }))
      let changed = 0
      for (let index = 0; index < images[0]!.length; index += 4) if (Math.abs(images[0]![index]! - images[1]![index]!) > 5) changed++
      return changed
    }, { urls: [standingStill, posedStill].map(id => `/assets/${spaceId}/${id}?t=${encodeURIComponent(token)}`) })
    expect(changedPixels).toBeGreaterThan(1000)
    await page.screenshot({ path: join(screenshots, 'posed-editor.png'), animations: 'disabled', scale: 'css' })
  })

  it('captures the viewport object colours in sRGB and keeps a neutral background under both themes', async () => {
    await closeScene()
    const baseline = await sceneDoc()
    const slot = await sceneSlot()
    const previousBackground = await page.evaluate(() => document.documentElement.style.getPropertyValue('--vis-bg'))
    const captureDoc: SceneDoc = {
      version: 1, rev: baseline.rev + 1,
      objects: [{
        id: 'capture-sphere', name: 'Capture sphere', hidden: false, createdBy: 'user', userTouched: true,
        transform: { position: [0, 1, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
        source: { type: 'primitive', shape: 'sphere', size: [2, 2, 2] },
      }],
      views: [{
        id: 'capture-view', name: 'Close?', still: null, aspectRatio: '16:9',
        camera: { position: [0, 1, 6], target: [0, 1, 0], roll: 0, focalLengthMm: 35 },
      }],
    }
    await apply([{ op: 'scene.set', slotId: slot.slotId, expectedRevision: slot.revision, doc: captureDoc }])
    await page.evaluate(() => document.documentElement.style.setProperty('--vis-bg', '#d9d9d9'))
    await openScene()
    await editor().getByRole('button', { name: 'Through camera', exact: true }).click()
    const token = new URLSearchParams(new URL(host.url).hash.slice(1)).get('t')!
    const capture = async () => {
      const viewport = await editor().getByRole('img', { name: '3D viewport', exact: true }).locator('canvas').screenshot({ scale: 'css' })
      const imageCount = (await nodes()).filter(node => node.kind === 'image').length
      await editor().getByRole('button', { name: 'Save as image', exact: true }).click()
      await expect.poll(async () => (await nodes()).filter(node => node.kind === 'image').length, { timeout: 10_000 }).toBe(imageCount + 1)
      await saved()
      const still = (await sceneDoc()).views[0]!.still!
      return page.evaluate(async ({ url, viewport }) => {
        const decode = async (blob: Blob) => {
          const bitmap = await createImageBitmap(blob)
          const canvas = document.createElement('canvas')
          canvas.width = bitmap.width
          canvas.height = bitmap.height
          const context = canvas.getContext('2d')!
          context.drawImage(bitmap, 0, 0)
          bitmap.close()
          return { width: canvas.width, height: canvas.height, pixels: context.getImageData(0, 0, canvas.width, canvas.height).data }
        }
        const png = await decode(await (await fetch(url)).blob())
        const screen = await decode(new Blob([Uint8Array.from(atob(viewport), char => char.charCodeAt(0))], { type: 'image/png' }))
        const width = Math.min(screen.width, screen.height * 16 / 9)
        const height = width * 9 / 16
        const sample = (image: typeof png, x: number, y: number) => {
          const offset = (Math.floor(y) * image.width + Math.floor(x)) * 4
          return Array.from(image.pixels.slice(offset, offset + 4))
        }
        const points = [[0.5, 0.5], [0.45, 0.5], [0.5, 0.42]]
        return {
          captured: points.map(([x, y]) => sample(png, x! * png.width, y! * png.height)),
          viewport: points.map(([x, y]) => sample(screen, (screen.width - width) / 2 + x! * width, (screen.height - height) / 2 + y! * height)),
          background: sample(png, png.width * 0.02, png.height * 0.02),
          viewportBackground: sample(screen, (screen.width - width) / 2 + width * 0.02, (screen.height - height) / 2 + height * 0.02),
        }
      }, { url: `/assets/${spaceId}/${still}?t=${encodeURIComponent(token)}`, viewport: viewport.toString('base64') })
    }
    try {
      const light = await capture()
      expect(light.background).toEqual([217, 217, 217, 255])
      expect(light.viewportBackground).toEqual([217, 217, 217, 255])
      for (const [index, pixel] of light.captured.entries()) {
        expect(light.viewport[index]![0]).toBeGreaterThan(50)
        expect(light.viewport[index]![0]).toBeLessThan(250)
        for (let channel = 0; channel < 3; channel++) expect(Math.abs(pixel[channel]! - light.viewport[index]![channel]!)).toBeLessThanOrEqual(3)
      }
      expect((await nodes()).some(node => node.kind === 'image' && node.title === 'Close?')).toBe(true)
      await editor().getByRole('textbox', { name: 'View name', exact: true }).fill('Wide: hero')
      await page.keyboard.press('Enter')
      await page.evaluate(async () => {
        document.documentElement.style.setProperty('--vis-bg', '#141414')
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      })
      const dark = await capture()
      expect(dark.viewportBackground).toEqual([20, 20, 20, 255])
      expect(dark.background).toEqual(light.background)
      expect(dark.captured).toEqual(light.captured)
      expect((await nodes()).some(node => node.kind === 'image' && node.title === 'Wide: hero')).toBe(true)
    } finally {
      await closeScene()
      await page.evaluate(value => {
        if (value) document.documentElement.style.setProperty('--vis-bg', value)
        else document.documentElement.style.removeProperty('--vis-bg')
      }, previousBackground)
      const current = await sceneSlot()
      const doc = await sceneDoc()
      await apply([{ op: 'scene.set', slotId: current.slotId, expectedRevision: current.revision, doc: { ...baseline, rev: doc.rev + 1 } }])
      await openScene()
    }
  })

  it('duplicates, renames, reorders and deletes views and keeps focal length within the contract limits', async () => {
    await editor().getByRole('button', { name: 'Duplicate view', exact: true }).click()
    await editor().getByRole('textbox', { name: 'View name', exact: true }).fill('Close')
    await page.keyboard.press('Enter')
    await editor().getByRole('button', { name: 'Move view earlier', exact: true }).click()
    await saved()
    expect((await sceneDoc()).views.map(view => view.name)).toEqual(['Close', 'Wide'])
    const focal = editor().getByRole('spinbutton', { name: 'Focal length (mm)', exact: true })
    await focal.fill('73')
    await focal.press('Enter')
    await saved()
    expect((await sceneDoc()).views[0]!.camera.focalLengthMm).toBe(73)
    await focal.fill(String(SCENE_LIMITS.focalLengthMm.max + 1))
    expect(await focal.evaluate(element => (element as HTMLInputElement).validity.rangeOverflow)).toBe(true)
    await editor().getByRole('button', { name: 'Move view later', exact: true }).click()
    await saved()
    expect((await sceneDoc()).views.map(view => view.name)).toEqual(['Wide', 'Close'])
    expect((await sceneDoc()).views[1]!.camera.focalLengthMm).toBe(73)
    await editor().getByRole('button', { name: 'Delete view', exact: true }).click()
    await saved()
    expect((await sceneDoc()).views.map(view => view.name)).toEqual(['Wide'])
    await editor().getByRole('button', { name: 'Hide object: Hero', exact: true }).click()
    await saved()
    expect((await sceneDoc()).objects.find(object => object.name === 'Hero')!.hidden).toBe(true)
    await editor().getByRole('button', { name: 'Show object: Hero', exact: true }).click()
    await saved()
    expect((await sceneDoc()).objects.find(object => object.name === 'Hero')!.hidden).toBe(false)
  })

  it('imports a generated GLB into the project model picker and localizes an invalid model error', async () => {
    const valid = join(dir, 'Triangle.glb')
    const invalid = join(dir, 'Broken.glb')
    writeFileSync(valid, triangleGlb())
    writeFileSync(invalid, Buffer.from('invalid glb fixture'))
    await importFile(valid)
    await expect.poll(async () => (await sceneDoc()).objects.filter(object => object.source.type === 'model').length, { timeout: 10_000 }).toBe(1)
    await saved()
    importedModel = (await admin.call('model.list', {})).models[0]!.assetVersionId
    await editor().getByRole('button', { name: 'Add', exact: true }).click()
    const picker = editor().getByRole('group', { name: 'Add objects', exact: true })
    const model = picker.getByRole('list', { name: 'Project models', exact: true }).getByRole('button')
    await model.waitFor()
    expect(await model.textContent()).toContain('Triangle')
    await model.click()
    await expect.poll(async () => (await sceneDoc()).objects.filter(object => object.source.type === 'model').length).toBe(2)
    expect((await sceneDoc()).objects.filter(object => object.source.type === 'model').every(object => object.source.type === 'model' && object.source.assetVersionId === importedModel)).toBe(true)
    await importFile(invalid)
    await expect.poll(() => editor().getByRole('alert').allTextContents()).toContainEqual(expect.stringContaining('The model file is invalid. Use a binary glTF 2.0 (.glb) file'))
    expect((await admin.call('model.list', {})).models).toHaveLength(1)
    await page.keyboard.press('Escape')
    await expect.poll(() => editor().getByRole('group', { name: 'Add objects', exact: true }).count()).toBe(0)
    expect(await editor().count()).toBe(1)
    await editor().getByRole('button', { name: 'Dismiss error', exact: true }).click()
  })

  it('keeps editor shortcuts away from text fields and deletes only the selected object', async () => {
    await editor().getByRole('button', { name: 'Select object: Hero', exact: true }).click()
    const name = editor().getByRole('textbox', { name: 'Object name', exact: true })
    await name.focus()
    await page.keyboard.press('ControlOrMeta+A')
    await page.keyboard.type('wer f')
    await page.keyboard.press('Delete')
    expect(await editor().getByRole('button', { name: 'Move', exact: true }).getAttribute('aria-pressed')).toBe('true')
    expect((await sceneDoc()).objects.some(object => object.name === 'Hero')).toBe(true)
    await page.keyboard.press('Escape')
    expect(await editor().count()).toBe(1)
    expect(await name.inputValue()).toBe('Hero')
    await editor().getByRole('button', { name: 'Select object: Hero', exact: true }).click()
    await editor().getByRole('button', { name: 'Through camera', exact: true }).click()
    await editor().getByRole('img', { name: '3D viewport', exact: true }).focus()
    for (const [key, tool] of [['e', 'Rotate'], ['r', 'Scale'], ['w', 'Move']]) {
      await page.keyboard.press(key!)
      await expect.poll(() => editor().getByRole('button', { name: tool!, exact: true }).getAttribute('aria-pressed')).toBe('true')
    }
    await page.keyboard.press('f')
    expect(await editor().getByRole('button', { name: 'Orbit', exact: true }).getAttribute('aria-pressed')).toBe('true')
    await page.keyboard.press('Delete')
    await expect.poll(async () => (await sceneDoc()).objects.some(object => object.name === 'Hero')).toBe(false)
    expect((await nodes()).some(node => node.nodeId === sceneId)).toBe(true)
    expect(await editor().count()).toBe(1)
    await editor().getByRole('button', { name: 'Undo', exact: true }).click()
    await saved()
    expect((await sceneDoc()).objects.some(object => object.name === 'Hero')).toBe(true)
  })

  it('preserves local edits on conflict and reloads the other version explicitly', async () => {
    await editor().getByRole('button', { name: 'Select object: Bench', exact: true }).click()
    await editor().getByRole('spinbutton', { name: 'Position (m) X', exact: true }).fill('2.5')
    await saved()
    const slot = await sceneSlot()
    const doc = await sceneDoc()
    await apply([{ op: 'scene.set', slotId: slot.slotId, expectedRevision: slot.revision, doc: {
      ...doc, rev: doc.rev + 1, objects: doc.objects.map(object => object.name === 'Bench' ? { ...object, name: 'Remote bench' } : object),
    } }])
    await editor().getByRole('button', { name: 'Load their version', exact: true }).waitFor()
    expect(await editor().getByRole('button', { name: 'Select object: Bench', exact: true }).count()).toBe(1)
    expect(await editor().getByRole('button', { name: 'Save as image', exact: true }).isDisabled()).toBe(true)
    await editor().getByRole('button', { name: 'Load their version', exact: true }).click()
    await editor().getByRole('button', { name: 'Select object: Remote bench', exact: true }).waitFor()
    await saved()
  })

  it('shows the object and view limits and disables additions when each limit is reached', async () => {
    const baseline = await sceneDoc()
    const slot = await sceneSlot()
    const extras: SceneObject[] = Array.from({ length: SCENE_LIMITS.objects - baseline.objects.length }, (_, index) => ({
      id: `limit-object-${index}`, name: `Box ${index + 1}`, hidden: false, createdBy: 'user', userTouched: true,
      transform: { position: [index % 8, 0.5, Math.floor(index / 8)], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      source: { type: 'primitive', shape: 'box', size: [1, 1, 1] },
    }))
    const limited: SceneDoc = {
      ...baseline, rev: baseline.rev + 1, objects: [...baseline.objects, ...extras],
      views: [...baseline.views, ...Array.from({ length: SCENE_LIMITS.views - baseline.views.length }, (_, index) => ({
        ...baseline.views[0]!, id: `limit-view-${index}`, name: `Limit view ${index + 1}`, still: null,
      }))],
    }
    await apply([{ op: 'scene.set', slotId: slot.slotId, expectedRevision: slot.revision, doc: limited }])
    await editor().getByText('The limit of 64 objects has been reached', { exact: true }).waitFor()
    await editor().getByText('The limit of 32 views has been reached', { exact: true }).waitFor()
    expect(await editor().getByRole('button', { name: 'Add', exact: true }).isDisabled()).toBe(true)
    expect(await editor().getByRole('button', { name: 'Add view', exact: true }).isDisabled()).toBe(true)
    expect((await sceneDoc()).objects).toHaveLength(SCENE_LIMITS.objects)
    expect((await sceneDoc()).views).toHaveLength(SCENE_LIMITS.views)
    const current = await sceneSlot()
    await apply([{ op: 'scene.set', slotId: current.slotId, expectedRevision: current.revision, doc: { ...baseline, rev: limited.rev + 1 } }])
    await expect.poll(() => editor().getByRole('button', { name: 'Add', exact: true }).isEnabled()).toBe(true)
    await viewportReady()
  })

  it('sends a view at the committed scene revision and changes the picture only through explicit Update', async () => {
    const result = await apply([{ op: 'node.create', tempId: 'previz', kind: 'previz', title: 'Storyboard', x: 600, y: 0 }])
    previzId = result.idMap.previz!
    const slot = (await nodes()).find(node => node.nodeId === previzId)!.slots.find(slot => slot.slotKey === 'main')!
    await apply([{ op: 'previz.set', slotId: slot.slotId, expectedRevision: slot.revision, doc: {
      ...EMPTY_PREVIZ, panels: [{ ...emptyPrevizPanel('first'), note: 'Opening' }, { ...emptyPrevizPanel('second'), note: 'Detail' }],
    } }])
    await editor().getByRole('button', { name: 'Send to…', exact: true }).click()
    let dialog = editor().getByRole('dialog', { name: 'Send to…', exact: true })
    await dialog.getByRole('combobox', { name: 'Choose shot previz', exact: true }).selectOption(previzId)
    await dialog.getByRole('combobox', { name: 'Choose panel', exact: true }).selectOption('second')
    expect((await previzDoc()).panels[1]!.blockout).toBeNull()
    await dialog.getByRole('button', { name: 'Send', exact: true }).click()
    await dialog.waitFor({ state: 'detached' })
    const first = (await previzDoc()).panels[1]!
    expect(first.sceneRef).toEqual({ sceneNodeId: sceneId, viewId: (await sceneDoc()).views[0]!.id, sceneRev: (await sceneSlot()).revision })
    expect(first.blockout).toBe((await sceneDoc()).views[0]!.still)
    await closeScene()
    await openPreviz()
    await previzEditor().getByRole('button', { name: 'Panel 2', exact: true }).click()
    expect(await previzEditor().getByText(/^Scene changed/).count()).toBe(0)
    const originalPicture = await previzEditor().getByRole('img', { name: 'Scene frame', exact: true }).getAttribute('src')
    await previzEditor().getByRole('button', { name: 'Close editor', exact: true }).click()
    await openScene()
    await editor().getByRole('button', { name: 'Select object: Hero', exact: true }).click()
    await editor().getByRole('spinbutton', { name: 'Position (m) X', exact: true }).fill('-2')
    await closeScene()
    await openPreviz()
    await previzEditor().getByRole('button', { name: 'Panel 2', exact: true }).click()
    await previzEditor().getByText(/^Scene changed/).waitFor()
    expect((await previzDoc()).panels[1]!.blockout).toBe(first.blockout)
    expect(await previzEditor().getByRole('img', { name: 'Scene frame', exact: true }).getAttribute('src')).toBe(originalPicture)
    await previzEditor().getByRole('button', { name: 'Update', exact: true }).click()
    await editor().waitFor()
    await viewportReady()
    expect((await previzDoc()).panels[1]!.blockout).toBe(first.blockout)
    await editor().getByRole('button', { name: 'Send to…', exact: true }).click()
    dialog = editor().getByRole('dialog', { name: 'Send to…', exact: true })
    expect(await dialog.getByRole('combobox', { name: 'Choose shot previz', exact: true }).inputValue()).toBe(previzId)
    expect(await dialog.getByRole('combobox', { name: 'Choose panel', exact: true }).inputValue()).toBe('second')
    expect((await previzDoc()).panels[1]!.blockout).toBe(first.blockout)
    await dialog.getByRole('button', { name: 'Send', exact: true }).focus()
    await page.keyboard.press('Tab')
    expect(await dialog.getByRole('combobox', { name: 'Choose shot previz', exact: true }).evaluate(element => document.activeElement === element)).toBe(true)
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'detached' })
    expect(await editor().count()).toBe(1)
    expect((await previzDoc()).panels[1]!.blockout).toBe(first.blockout)
    await editor().getByRole('button', { name: 'Send to…', exact: true }).click()
    dialog = editor().getByRole('dialog', { name: 'Send to…', exact: true })
    expect(await dialog.getByRole('combobox', { name: 'Choose panel', exact: true }).inputValue()).toBe('second')
    await dialog.getByRole('button', { name: 'Send', exact: true }).click()
    await dialog.waitFor({ state: 'detached' })
    const updated = (await previzDoc()).panels[1]!
    expect(updated.blockout).not.toBe(first.blockout)
    expect(updated.sceneRef!.sceneRev).toBe((await sceneSlot()).revision)
    expect((await previzDoc()).panels[0]!.blockout).toBeNull()
    await closeScene()
    await openPreviz()
    await previzEditor().getByRole('button', { name: 'Panel 2', exact: true }).click()
    expect(await previzEditor().getByText(/^Scene changed/).count()).toBe(0)
  })

  it('keeps the panel picture without a change notice after the scene is deleted', async () => {
    const picture = (await previzDoc()).panels[1]!.blockout
    await apply([{ op: 'node.delete', nodeId: sceneId }])
    await expect.poll(async () => (await nodes()).some(node => node.nodeId === sceneId)).toBe(false)
    expect((await previzDoc()).panels[1]!.blockout).toBe(picture)
    expect(await previzEditor().getByRole('img', { name: 'Scene frame', exact: true }).isVisible()).toBe(true)
    expect(await previzEditor().getByText(/^Scene changed/).count()).toBe(0)
    expect(await previzEditor().getByRole('button', { name: 'Update', exact: true }).count()).toBe(0)
    expect(pageErrors).toEqual([])
  })
})
