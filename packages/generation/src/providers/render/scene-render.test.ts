import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chromium } from 'playwright-core'
import { SceneDoc } from '@vis/protocol'
import type { ProviderAdapter, ProviderRequest, ProviderTaskState } from '../types'
import { createRenderProvider, defaultRenderLibs, DEFAULT_CHROME_PATHS, RENDER_ORIGIN } from './index'
import { readRenderLibrary } from './render-libs'
import { sceneImageParams, sceneModelInputs, sceneRenderPage, sceneVideoParams, type SceneInput } from './scene'

const chromePath = process.env.VIS_CHROME_PATH ?? DEFAULT_CHROME_PATHS.find(path => existsSync(path))
const hasChrome = !!chromePath && existsSync(chromePath)
const hasFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true } catch { return false } })()
const transform = { position: [-1, 0.5, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }
const scene = () => SceneDoc.parse({
  version: 1, rev: 0, durationS: 1,
  objects: [{
    id: 'box', name: 'Box', transform, createdBy: 'user', userTouched: false, hidden: false,
    source: { type: 'primitive', shape: 'box', size: [0.7, 0.7, 0.7] },
    tracks: { transform: [
      { t: 0, value: transform, ease: 'linear' },
      { t: 1, value: { ...transform, position: [1, 0.5, 0] }, ease: 'linear' },
    ] },
  }],
  views: [{
    id: 'wide', name: 'Wide', aspectRatio: '16:9', still: null,
    camera: { position: [0, 0.5, 5], target: [0, 0.5, 0], roll: 0, focalLengthMm: 35 },
  }],
})
const request = (doc = scene(), kind: 'image' | 'video' = 'video', params: Record<string, unknown> = {}): ProviderRequest => ({
  operation: 'generate', kind, model: 'scene', prompt: '', params: { viewId: 'wide', width: 320, height: 180, fps: 10, ...params },
  inputs: [{ type: 'scene', doc, models: [] }],
})
const input = (request: ProviderRequest) => request.inputs[0] as SceneInput
function modelGlb(external = false): Buffer {
  const positions = Buffer.alloc(36)
  const vertices = [-0.6, 0, 0, 0.6, 0, 0, 0, 1.2, 0]
  vertices.forEach((value, index) => positions.writeFloatLE(value, index * 4))
  const json = Buffer.from(JSON.stringify({
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    buffers: [{ byteLength: positions.length, ...(external ? { uri: 'https://example.com/model.bin' } : {}) }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positions.length }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [-0.6, 0, 0], max: [0.6, 1.2, 0] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
  }))
  const padded = Buffer.alloc(Math.ceil(json.length / 4) * 4, 0x20)
  json.copy(padded)
  const header = Buffer.alloc(20)
  header.writeUInt32LE(0x46546c67, 0)
  header.writeUInt32LE(2, 4)
  header.writeUInt32LE(20 + padded.length + 8 + positions.length, 8)
  header.writeUInt32LE(padded.length, 12)
  header.writeUInt32LE(0x4e4f534a, 16)
  const binary = Buffer.alloc(8)
  binary.writeUInt32LE(positions.length, 0)
  binary.writeUInt32LE(0x004e4942, 4)
  return Buffer.concat([header, padded, binary, positions])
}
async function settle(provider: ProviderAdapter, key: string): Promise<ProviderTaskState> {
  await expect.poll(async () => (await provider.getTask(key)).state, { timeout: 45_000, interval: 50 }).toSatisfy(state => ['succeeded', 'failed', 'cancelled'].includes(state))
  const state = await provider.getTask(key)
  expect(state, JSON.stringify(state)).toMatchObject({ state: 'succeeded' })
  return state
}
const decode = (path: string, args: string[] = []) => execFileSync('ffmpeg', ['-v', 'error', '-i', path, ...args, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 20 * 1024 * 1024 })
function centroid(frame: Buffer): number {
  const background = frame[0]!
  let total = 0
  let weight = 0
  for (let y = 0; y < 180; y++) for (let x = 0; x < 320; x++) {
    if (Math.abs(frame[(y * 320 + x) * 3]! - background) > 12) { total += x; weight++ }
  }
  expect(weight).toBeGreaterThan(100)
  return total / weight
}
let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'vis-scene-render-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('scene render validation', () => {
  it('requires a view and defaults scene rendering to 24 fps', () => {
    expect(sceneVideoParams.safeParse({}).success).toBe(false)
    expect(sceneVideoParams.parse({ viewId: 'wide' })).toEqual({ viewId: 'wide', width: 1920, height: 1080, fps: 24 })
    expect(sceneImageParams.parse({ viewId: 'wide' }).timeS).toBe(0)
    for (const fps of [1, 60]) expect(sceneVideoParams.parse({ viewId: 'wide', fps }).fps).toBe(fps)
  })

  it.each([0, 61, 1.5, Infinity])('refuses fps %s before launching Chrome', async fps => {
    const provider = createRenderProvider({ workDir: dir, chromePath: join(dir, 'missing-chrome') })
    await expect(provider.submit(request(scene(), 'video', { fps }), { idempotencyKey: 'bad' })).rejects.toMatchObject({ kind: 'rejected', message: expect.stringContaining('fps') })
    expect(await provider.findTaskByIdempotencyKey!('bad')).toBeNull()
  })

  it('refuses a missing view and a static video before checking Chrome availability', async () => {
    const provider = createRenderProvider({ workDir: dir, chromePath: join(dir, 'missing-chrome') })
    await expect(provider.submit(request(scene(), 'video', { viewId: 'absent' }), { idempotencyKey: 'view' })).rejects.toMatchObject({ reason: 'generation.render_scene_view_missing' })
    const staticScene = scene()
    delete staticScene.durationS
    delete staticScene.objects[0]!.tracks
    await expect(provider.submit(request(staticScene), { idempotencyKey: 'static' })).rejects.toMatchObject({ reason: 'generation.render_scene_motion_required' })
    await expect(provider.submit({ ...request(), inputs: [{ type: 'text', text: '<script>throw 1</script>' }] }, { idempotencyKey: 'text' })).rejects.toMatchObject({ reason: 'generation.render_scene_input_required' })
  })

  it('maps model versions in first document occurrence order, skips unavailable versions and serializes scene content safely', () => {
    const req = request()
    const first = req.inputs[0] as SceneInput
    const base = first.doc.objects[0]!
    first.doc.objects = ['second', 'missing', 'first', 'second'].map((id, index) => ({
      ...base, id: `object-${index}`, name: '</script><script>throw 1</script>', source: { type: 'model', assetVersionId: id },
    }))
    first.models = ['first', 'second'].map(id => ({ assetVersionId: id, mime: 'model/gltf-binary', path: join(dir, `${id}.glb`) }))
    expect(sceneModelInputs(first).map(model => model.assetVersionId)).toEqual(['second', 'first'])
    const html = sceneRenderPage(first, sceneImageParams.parse(req.params))
    expect(html).toContain('"second":"/input/0","first":"/input/1"')
    expect(html).not.toContain('</script><script>throw 1</script>')
    expect(html).toContain('preserveDrawingBuffer: true')
  })
})

describe.skipIf(!hasChrome || !hasFfmpeg)('scene rendering with Chrome and ffmpeg', () => {
  it('renders a moving box to a one-second video with movement between the first and last frames', async () => {
    const provider = createRenderProvider({ workDir: dir })
    await provider.submit(request(), { idempotencyKey: 'motion' })
    expect(await settle(provider, 'motion')).toMatchObject({ state: 'succeeded' })
    const output = await provider.download({ outputIndex: 0, ref: 'motion' })
    expect(output).toMatchObject({ mime: 'video/mp4', width: 320, height: 180, durationMs: 1000, fps: 10 })
    const path = join(dir, 'motion.mp4')
    writeFileSync(path, output.data)
    const frames = decode(path)
    const size = 320 * 180 * 3
    expect(frames.length).toBe(10 * size)
    expect(centroid(frames.subarray(-size)) - centroid(frames.subarray(0, size))).toBeGreaterThan(70)
  }, 60_000)

  it('captures the requested time as a nonblank PNG, matches a fresh shared build and recovers after restart', async () => {
    const provider = createRenderProvider({ workDir: dir })
    await provider.submit(request(scene(), 'image', { timeS: 0.75 }), { idempotencyKey: 'still' })
    expect(await settle(provider, 'still')).toMatchObject({ state: 'succeeded' })
    const output = await provider.download({ outputIndex: 0, ref: 'still' })
    expect(output).toMatchObject({ mime: 'image/png', width: 320, height: 180 })
    expect(output).not.toHaveProperty('durationMs')
    const path = join(dir, 'still.png')
    writeFileSync(path, output.data)
    const pixels = decode(path)
    expect(pixels.length).toBe(320 * 180 * 3)
    expect(centroid(pixels)).toBeGreaterThan(175)
    const browser = await chromium.launch({ executablePath: chromePath!, headless: true })
    try {
      const page = await browser.newPage({ viewport: { width: 320, height: 180 }, deviceScaleFactor: 1 })
      const libs = defaultRenderLibs()
      const served: string[] = []
      await page.route('**/*', async route => {
        const url = new URL(route.request().url())
        if (url.pathname.startsWith('/lib/')) {
          const body = await readRenderLibrary(url.pathname.slice(5), libs)
          served.push(url.pathname)
          return route.fulfill({ contentType: 'text/javascript', body: body! })
        }
        return route.fulfill({ contentType: 'text/html', body: `<!doctype html><body style="margin:0"><script type="importmap">{"imports":{"three":"/lib/three.module.js"}}</script><script type="module">
          import { WebGLRenderer } from 'three'
          import { buildScene, sampleScene } from '/lib/vis-scene.js'
          const built = await buildScene(sampleScene(${JSON.stringify(scene())}, 0.75), 'wide')
          const renderer = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })
          renderer.setSize(320, 180)
          document.body.append(renderer.domElement)
          renderer.render(built.scene, built.camera)
          window.ready = true
        </script>` })
      })
      await page.goto(RENDER_ORIGIN)
      await page.waitForFunction('window.ready')
      expect(served).toContain('/lib/vis-scene.js')
      expect(Buffer.from(output.data)).toEqual(await page.screenshot({ type: 'png' }))
    } finally {
      await browser.close()
    }
    const restarted = createRenderProvider({ workDir: dir })
    expect(await restarted.findTaskByIdempotencyKey!('still')).toEqual({ externalTaskId: 'still' })
    expect(await restarted.download({ outputIndex: 0, ref: 'still' })).toMatchObject({ mime: 'image/png', width: 320, height: 180 })
  }, 60_000)

  it('renders static scenes as images and figure pose tracks as videos', async () => {
    const provider = createRenderProvider({ workDir: dir })
    const doc = scene()
    delete doc.durationS
    delete doc.objects[0]!.tracks
    await provider.submit(request(doc, 'image', { timeS: 10 }), { idempotencyKey: 'static' })
    expect(await settle(provider, 'static')).toMatchObject({ state: 'succeeded' })
    const figure = scene()
    figure.objects[0]!.source = { type: 'figure', bodyId: 'human', heightM: 1.8, pose: {} }
    figure.objects[0]!.tracks = { pose: { leftKnee: [
      { t: 0, value: [0, 0, 0, 1], ease: 'linear' },
      { t: 1, value: [Math.sin(-0.4), 0, 0, Math.cos(-0.4)], ease: 'linear' },
    ] } }
    await provider.submit(request(figure, 'video', { fps: 2 }), { idempotencyKey: 'figure' })
    expect(await settle(provider, 'figure')).toMatchObject({ state: 'succeeded' })
  }, 60_000)

  it('loads an embedded model and renders the same wireframe for missing blobs, missing versions and refused external references', async () => {
    const provider = createRenderProvider({ workDir: dir })
    const doc = scene()
    doc.objects[0]!.source = { type: 'model', assetVersionId: 'model-version' }
    delete doc.objects[0]!.tracks
    const render = async (key: string, model?: Buffer) => {
      const req = request(doc, 'image')
      if (key !== 'missing-version') {
        const path = join(dir, `${key}.glb`)
        if (model) writeFileSync(path, model)
        input(req).models = [{ assetVersionId: 'model-version', mime: 'model/gltf-binary', path }]
      }
      await provider.submit(req, { idempotencyKey: key })
      expect(await settle(provider, key)).toMatchObject({ state: 'succeeded' })
      return Buffer.from((await provider.download({ outputIndex: 0, ref: key })).data)
    }
    const loaded = await render('embedded', modelGlb())
    const missing = await render('missing-version')
    expect(await render('missing-blob')).toEqual(missing)
    expect(await render('external', modelGlb(true))).toEqual(missing)
    expect(loaded).not.toEqual(missing)
    const path = join(dir, 'loaded.png')
    writeFileSync(path, loaded)
    expect(centroid(decode(path))).toBeLessThan(130)
  }, 60_000)
})
