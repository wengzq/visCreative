import { LoadingManager, Texture } from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'

export function assertEmbeddedGlb(data: ArrayBuffer): void {
  const header = new DataView(data)
  if (data.byteLength < 20 || header.getUint32(0, true) !== 0x46546c67 || header.getUint32(4, true) !== 2 || header.getUint32(8, true) !== data.byteLength || header.getUint32(16, true) !== 0x4e4f534a) throw new Error('Invalid binary glTF model')
  const size = header.getUint32(12, true)
  if (20 + size > data.byteLength) throw new Error('Invalid binary glTF JSON chunk')
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(data, 20, size))) as { buffers?: { uri?: unknown }[]; images?: { uri?: unknown }[] }
  if ([...json.buffers ?? [], ...json.images ?? []].some(item => item.uri !== undefined)) throw new Error('External model references are not allowed')
}

/** The only fetch is the host's exact asset URL. All nested loader requests are refused. */
export async function loadSceneModel(assetVersionId: string, assetUrl: (id: string) => string, signal?: AbortSignal) {
  const response = await fetch(assetUrl(assetVersionId), { credentials: 'same-origin', redirect: 'error', ...(signal ? { signal } : {}) })
  if (!response.ok) throw new Error('Could not load the scene model')
  const data = await response.arrayBuffer()
  assertEmbeddedGlb(data)
  const manager = new LoadingManager()
  manager.setURLModifier(() => { throw new Error('Additional model URLs are not allowed') })
  const loader = new GLTFLoader(manager)
  loader.register(parser => {
    // Blockouts discard imported materials, so even embedded textures need no image decoder or URL.
    parser.loadTexture = async () => new Texture()
    parser.loadTextureImage = async () => new Texture()
    return { name: 'VIS_static_blockout' }
  })
  const gltf = await loader.parseAsync(data, '')
  return gltf.scene
}
