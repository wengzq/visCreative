import { afterEach, expect, it, vi } from 'vitest'
import { disposeScene } from '@vis/scene-core'
import { assertEmbeddedGlb, loadSceneModel } from './model-loader'

function glb(json: object, binary?: Uint8Array) {
  const encoded = new TextEncoder().encode(JSON.stringify(json))
  const length = Math.ceil(encoded.length / 4) * 4
  const binaryLength = binary ? Math.ceil(binary.length / 4) * 4 : 0
  const data = new ArrayBuffer(20 + length + (binary ? 8 + binaryLength : 0))
  const header = new DataView(data)
  header.setUint32(0, 0x46546c67, true)
  header.setUint32(4, 2, true)
  header.setUint32(8, data.byteLength, true)
  header.setUint32(12, length, true)
  header.setUint32(16, 0x4e4f534a, true)
  new Uint8Array(data, 20).fill(32)
  new Uint8Array(data, 20, encoded.length).set(encoded)
  if (binary) {
    header.setUint32(20 + length, binaryLength, true)
    header.setUint32(24 + length, 0x004e4942, true)
    new Uint8Array(data, 28 + length, binary.length).set(binary)
  }
  return data
}
afterEach(() => vi.unstubAllGlobals())

it('refuses external buffer and image references before a loader sees the model', () => {
  expect(() => assertEmbeddedGlb(glb({ buffers: [{ byteLength: 0 }] }))).not.toThrow()
  for (const uri of ['https://example.com/model.bin', 'file:///local/path', 'data:application/octet-stream;base64,AA==', '']) {
    expect(() => assertEmbeddedGlb(glb({ buffers: [{ uri }] }))).toThrow('External model references')
    expect(() => assertEmbeddedGlb(glb({ images: [{ uri }] }))).toThrow('External model references')
  }
  expect(() => assertEmbeddedGlb(new ArrayBuffer(0))).toThrow('Invalid binary glTF')
  const invalid = glb({})
  new DataView(invalid).setUint32(12, 999_999, true)
  expect(() => assertEmbeddedGlb(invalid)).toThrow('Invalid binary glTF JSON')
})

it('fetches the exact host asset URL once and parses a self-contained scene without a GPU', async () => {
  const data = glb({ asset: { version: '2.0' }, scenes: [{ nodes: [0] }], scene: 0, nodes: [{ name: 'Imported prop' }] })
  const fetch = vi.fn(async () => new Response(data, { status: 200 }))
  vi.stubGlobal('fetch', fetch)
  const url = vi.fn(() => '/asset/model-version')
  const model = await loadSceneModel('model-version', url)
  expect(url).toHaveBeenCalledExactlyOnceWith('model-version')
  expect(fetch).toHaveBeenCalledExactlyOnceWith('/asset/model-version', { credentials: 'same-origin', redirect: 'error' })
  expect(model.children[0]!.name).toBe('Imported_prop')
  disposeScene(model)
})

it('refuses external models without making a second network request', async () => {
  const data = glb({ asset: { version: '2.0' }, buffers: [{ uri: 'https://example.com/exfiltrate', byteLength: 4 }] })
  const fetch = vi.fn(async () => new Response(data))
  vi.stubGlobal('fetch', fetch)
  await expect(loadSceneModel('model', () => '/asset/model')).rejects.toThrow('External model references')
  expect(fetch).toHaveBeenCalledTimes(1)
})

it('loads a textured embedded mesh without image decoding or any additional URL', async () => {
  const binary = new Uint8Array(40)
  new Float32Array(binary.buffer, 0, 9).set([0, 0, 0, 1, 0, 0, 0, 1, 0])
  const data = glb({
    asset: { version: '2.0' }, scenes: [{ nodes: [0] }], scene: 0, nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
    buffers: [{ byteLength: binary.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 4 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
    textures: [{ source: 0 }], images: [{ bufferView: 1, mimeType: 'image/png' }],
  }, binary)
  const fetch = vi.fn(async () => new Response(data))
  vi.stubGlobal('fetch', fetch)
  const model = await loadSceneModel('textured', () => '/asset/textured')
  expect(model.children[0]).toMatchObject({ isMesh: true })
  expect(fetch).toHaveBeenCalledOnce()
  disposeScene(model)
})

it('reproduces a required Basis Universal texture failing before the material can be neutralized', async () => {
  const binary = new Uint8Array(40)
  new Float32Array(binary.buffer, 0, 9).set([0, 0, 0, 1, 0, 0, 0, 1, 0])
  const data = glb({
    asset: { version: '2.0' }, scenes: [{ nodes: [0] }], scene: 0, nodes: [{ mesh: 0 }],
    extensionsUsed: ['KHR_texture_basisu'], extensionsRequired: ['KHR_texture_basisu'],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
    buffers: [{ byteLength: binary.length }],
    bufferViews: [{ buffer: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 4 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
    textures: [{ extensions: { KHR_texture_basisu: { source: 0 } } }],
    images: [{ bufferView: 1, mimeType: 'image/ktx2' }],
  }, binary)
  vi.stubGlobal('fetch', vi.fn(async () => new Response(data)))
  await expect(loadSceneModel('basis', () => '/asset/basis')).rejects.toThrow('setKTX2Loader')
})
