import { RenderVideoParams, SceneDoc, type MediaKind } from '@vis/protocol'
import { z } from 'zod'
import { ProviderError, type ProviderInput } from '../types'

const sceneParams = z.object({
  viewId: z.string().min(1).meta({ 'x-vis-label': { zh: '视角', en: 'View' } }),
  width: RenderVideoParams.shape.width.meta({ 'x-vis-label': { zh: '宽度', en: 'Width' } }),
  height: RenderVideoParams.shape.height.meta({ 'x-vis-label': { zh: '高度', en: 'Height' } }),
  fps: z.int().min(1).max(60).default(24).meta({ 'x-vis-label': { zh: '帧率', en: 'Frame rate' } }),
})
export const sceneVideoParams = sceneParams
export const sceneImageParams = sceneParams.extend({
  timeS: z.number().min(0).default(0).meta({ 'x-vis-label': { zh: '时间（秒）', en: 'Time (seconds)' } }),
})
export type SceneParams = z.infer<typeof sceneImageParams>
export type SceneInput = Extract<ProviderInput, { type: 'scene' }>

export function validateSceneRender(kind: MediaKind, doc: SceneDoc, params: Record<string, unknown>): void {
  if (!SceneDoc.safeParse(doc).success) throw new ProviderError('rejected', 'The scene document is invalid', 'scene.invalid_document')
  if (!doc.views.some(view => view.id === params.viewId)) throw new ProviderError('rejected', 'The requested scene view does not exist', 'generation.render_scene_view_missing')
  if (kind === 'video' && doc.durationS === undefined) throw new ProviderError('rejected', 'Add motion before rendering a scene video', 'generation.render_scene_motion_required')
}

export function sceneModelVersionIds(doc: SceneDoc): string[] {
  return [...new Set(doc.objects.flatMap(object => object.source.type === 'model' ? [object.source.assetVersionId] : []))]
}

export function sceneModelInputs(input: SceneInput) {
  return sceneModelVersionIds(input.doc).flatMap(id => {
    const model = input.models.find(model => model.assetVersionId === id)
    return model ? [model] : []
  })
}

const json = (value: unknown) => JSON.stringify(value).replaceAll('<', '\\u003c')

/** Scene renders execute only this owned page; author content is serialized as data. */
export function sceneRenderPage(input: SceneInput, params: SceneParams): string {
  const models = Object.fromEntries(sceneModelInputs(input).map((model, index) => [model.assetVersionId, `/input/${index}`]))
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>html,body{margin:0;overflow:hidden}canvas{display:block}</style>
<script type="importmap">{"imports":{"three":"/lib/three.module.js"}}</script></head><body>
<script type="module">
import { WebGLRenderer, LoadingManager, Texture } from 'three'
import { buildScene, sampleScene, applySceneFrame, GLTFLoader } from '/lib/vis-scene.js'
const doc = ${json(input.doc)}
const viewId = ${json(params.viewId)}
const models = ${json(models)}
async function loadModel(id) {
  if (!Object.hasOwn(models, id)) throw new Error('Missing scene model')
  const response = await fetch(models[id], { credentials: 'same-origin', redirect: 'error' })
  if (!response.ok) throw new Error('Could not load the scene model')
  const data = await response.arrayBuffer()
  const header = new DataView(data)
  if (data.byteLength < 20 || header.getUint32(0, true) !== 0x46546c67 || header.getUint32(4, true) !== 2 || header.getUint32(8, true) !== data.byteLength || header.getUint32(16, true) !== 0x4e4f534a) throw new Error('Invalid binary glTF model')
  const size = header.getUint32(12, true)
  if (20 + size > data.byteLength) throw new Error('Invalid binary glTF JSON chunk')
  const model = JSON.parse(new TextDecoder().decode(new Uint8Array(data, 20, size)))
  if ([...(model.buffers ?? []), ...(model.images ?? [])].some(item => item.uri !== undefined)) throw new Error('External model references are not allowed')
  const manager = new LoadingManager()
  manager.setURLModifier(() => { throw new Error('Additional model URLs are not allowed') })
  const loader = new GLTFLoader(manager)
  loader.register(parser => {
    parser.loadTexture = async () => new Texture()
    parser.loadTextureImage = async () => new Texture()
    return { name: 'VIS_static_blockout' }
  })
  return (await loader.parseAsync(data, '')).scene
}
const built = await buildScene(doc, viewId, { loadModel })
const renderer = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })
renderer.setPixelRatio(1)
renderer.setSize(${params.width}, ${params.height})
document.body.append(renderer.domElement)
window.vis = {
  duration: doc.durationS ?? 0,
  seek(t) {
    applySceneFrame(built, sampleScene(doc, t), viewId)
    renderer.render(built.scene, built.camera)
  }
}
</script></body></html>`
}
