import { describe, expect, it } from 'vitest'
import { MAX_MODEL_BYTES, MAX_MODEL_TRIANGLES, validateGlb } from './model'

function glb(doc: Record<string, unknown> = {}, size?: number, binary?: Buffer) {
  const json = Buffer.from(JSON.stringify({ asset: { version: '2.0' }, ...doc }))
  const padded = Math.ceil(json.length / 4) * 4
  const bytes = Buffer.alloc(size ?? 20 + padded, 0x20)
  bytes.writeUInt32LE(0x46546c67, 0)
  bytes.writeUInt32LE(2, 4)
  bytes.writeUInt32LE(bytes.length, 8)
  bytes.writeUInt32LE(bytes.length - 20, 12)
  bytes.writeUInt32LE(0x4e4f534a, 16)
  json.copy(bytes, 20)
  if (!binary) return bytes
  const paddedBinary = Buffer.alloc(Math.ceil(binary.length / 4) * 4)
  binary.copy(paddedBinary)
  const chunk = Buffer.alloc(8)
  chunk.writeUInt32LE(paddedBinary.length, 0)
  chunk.writeUInt32LE(0x004e4942, 4)
  const result = Buffer.concat([bytes, chunk, paddedBinary])
  result.writeUInt32LE(result.length, 8)
  return result
}

function geometry(counts: number[], indexed = true, mode = 4) {
  return {
    accessors: [
      { count: indexed ? 3 : counts[0], type: 'VEC3', componentType: 5126 },
      ...counts.map(count => ({ count, type: 'SCALAR', componentType: 5125 })),
    ],
    meshes: counts.map((_, index) => ({ primitives: [{
      attributes: { POSITION: 0 }, ...(indexed ? { indices: index + 1 } : {}), mode,
    }] })),
  }
}

const reason = (value: string) => expect.objectContaining({ code: 'invalid_params', details: { reason: value, params: {} } })

describe('binary glTF validation', () => {
  it.each([0, 1, 2, 3])('bounds non-triangle geometry in mode %i', mode => {
    expect(() => validateGlb(glb(geometry([1_500_003], true, mode)))).toThrow(reason('asset.model_too_complex'))
  })

  it.each([[0, 500_000], [1, 1_000_000], [2, 500_000], [3, 500_001]])('bounds mode %i at %i elements without miscounting them as triangles', (mode, limit) => {
    expect(validateGlb(glb(geometry([limit!], true, mode)))).toEqual({ triangles: 0 })
    expect(() => validateGlb(glb(geometry([limit! + (mode === 1 ? 2 : 1)], true, mode)))).toThrow(reason('asset.model_too_complex'))
  })

  it('counts shared POSITION data once within a mesh with several material primitives', () => {
    const doc = geometry([750_000, 750_000])
    doc.accessors[0]!.count = MAX_MODEL_TRIANGLES * 3
    doc.meshes = [{ primitives: doc.meshes.flatMap(mesh => mesh.primitives) }]
    expect(validateGlb(glb(doc))).toEqual({ triangles: MAX_MODEL_TRIANGLES })
  })

  it('bounds the memory of every attribute and morph target, not only POSITION', () => {
    const doc = geometry([3])
    const wide = { componentType: 5126, type: 'MAT4', count: MAX_MODEL_TRIANGLES * 3 }
    doc.accessors.push(wide, wide, wide)
    const primitive = doc.meshes[0]!.primitives[0]! as Record<string, any>
    primitive.attributes.COLOR_0 = 2
    primitive.targets = [{ NORMAL: 3 }, { NORMAL: 4 }]
    expect(() => validateGlb(glb(doc))).toThrow(reason('asset.model_too_complex'))
    primitive.targets = []
    expect(validateGlb(glb(doc))).toEqual({ triangles: 1 })
  })

  it('bounds bufferless POSITION accessors even when a small index accessor is used', () => {
    const doc = geometry([3])
    doc.accessors[0]!.count = MAX_MODEL_TRIANGLES * 3 + 1
    expect(() => validateGlb(glb(doc))).toThrow(reason('asset.model_too_complex'))
  })

  it('counts a mesh for each node reference, including nodes in different scenes', () => {
    const doc = { ...geometry([MAX_MODEL_TRIANGLES * 3]), nodes: [{ mesh: 0 }, { mesh: 0 }], scenes: [{ nodes: [0] }, { nodes: [1] }] }
    expect(() => validateGlb(glb(doc))).toThrow(reason('asset.model_too_complex'))
    expect(validateGlb(glb({ ...doc, nodes: [{ mesh: 0 }] }))).toEqual({ triangles: MAX_MODEL_TRIANGLES })
  })

  it.each([
    { count: 4 },
    { byteOffset: 4 },
    { count: 3, stride: 16, length: 40 },
  ])('refuses an accessor that extends past its buffer view: %j', ({ stride, length = 36, ...accessor }) => {
    const doc = {
      buffers: [{ byteLength: length }],
      bufferViews: [{ buffer: 0, byteLength: length, ...(stride ? { byteStride: stride } : {}) }],
      accessors: [{ bufferView: 0, componentType: 5126, type: 'VEC3', count: 3, ...accessor }],
    }
    expect(() => validateGlb(glb(doc, undefined, Buffer.alloc(length)))).toThrow(reason('asset.model_invalid'))
  })

  it.each(['KHR_texture_basisu', 'KHR_meshopt_compression', 'UNSUPPORTED_required_extension'])('refuses the required extension %s before loading', extension => {
    expect(() => validateGlb(glb({ extensionsUsed: [extension], extensionsRequired: [extension] }))).toThrow(reason('asset.model_unsupported'))
  })

  it.each([MAX_MODEL_BYTES - 4, MAX_MODEL_BYTES])('accepts a valid %i-byte GLB without binary resources', size => {
    expect(validateGlb(glb({}, size))).toEqual({ triangles: 0 })
  })

  it.each([MAX_MODEL_BYTES + 1, MAX_MODEL_BYTES + 4])('refuses %i bytes before parsing the container', size => {
    expect(() => validateGlb(Buffer.alloc(size))).toThrow(reason('asset.model_too_large'))
  })

  it.each([false, true])('counts %s indexed geometry below, at and above the triangle limit', indexed => {
    for (const triangles of [MAX_MODEL_TRIANGLES - 1, MAX_MODEL_TRIANGLES]) {
      expect(validateGlb(glb(geometry([triangles * 3], indexed)))).toEqual({ triangles })
    }
    expect(() => validateGlb(glb(geometry([(MAX_MODEL_TRIANGLES + 1) * 3], indexed)))).toThrow(reason('asset.model_too_complex'))
  })

  it('sums every primitive across meshes, including reused accessors and non-triangle modes', () => {
    expect(validateGlb(glb(geometry([750_000, 749_997])))).toEqual({ triangles: 499_999 })
    expect(validateGlb(glb(geometry([750_000, 750_000])))).toEqual({ triangles: 500_000 })
    expect(() => validateGlb(glb(geometry([750_000, 750_003])))).toThrow(reason('asset.model_too_complex'))
    const doc = geometry([750_003])
    doc.meshes.push(doc.meshes[0]!)
    expect(() => validateGlb(glb(doc))).toThrow(reason('asset.model_too_complex'))
    for (const mode of [0, 1, 2, 3]) expect(validateGlb(glb(geometry([3_000], true, mode)))).toEqual({ triangles: 0 })
  })

  it.each([5, 6])('counts strips and fans in mode %i at their limit', mode => {
    expect(validateGlb(glb(geometry([MAX_MODEL_TRIANGLES + 1], true, mode)))).toEqual({ triangles: MAX_MODEL_TRIANGLES - 1 })
    expect(validateGlb(glb(geometry([MAX_MODEL_TRIANGLES + 2], true, mode)))).toEqual({ triangles: MAX_MODEL_TRIANGLES })
    expect(() => validateGlb(glb(geometry([MAX_MODEL_TRIANGLES + 3], true, mode)))).toThrow(reason('asset.model_too_complex'))
  })

  it.each(['buffers', 'images'])('refuses every %s URI, including empty and embedded data URIs', field => {
    for (const uri of ['', null, 'model.bin', '../private.bin', 'file:///private', 'https://example.invalid/a', 'data:application/octet-stream;base64,AA==']) {
      expect(() => validateGlb(glb({ [field]: [{ uri }] }))).toThrow(reason('asset.model_external_reference'))
    }
  })

  it.each(['KHR_draco_mesh_compression', 'EXT_meshopt_compression'])('refuses declared and nested %s compression', extension => {
    for (const doc of [
      { extensionsUsed: [extension] },
      { extensionsRequired: [extension] },
      { bufferViews: [{ extensions: { [extension]: {} } }] },
      { meshes: [{ primitives: [{ extensions: { [extension]: {} } }] }] },
    ]) expect(() => validateGlb(glb(doc))).toThrow(reason('asset.model_unsupported'))
  })

  it('validates an embedded buffer, buffer view and image with binary padding', () => {
    const json = glb({ buffers: [{ byteLength: 5 }], bufferViews: [{ buffer: 0, byteLength: 5 }], images: [{ bufferView: 0, mimeType: 'image/png' }] })
    const bytes = Buffer.concat([json, Buffer.alloc(16)])
    bytes.writeUInt32LE(bytes.length, 8)
    bytes.writeUInt32LE(8, json.length)
    bytes.writeUInt32LE(0x004e4942, json.length + 4)
    expect(validateGlb(bytes)).toEqual({ triangles: 0 })
    bytes.writeUInt32LE(7, json.length)
    expect(() => validateGlb(bytes)).toThrow(reason('asset.model_invalid'))
  })

  it('accepts tightly packed, interleaved, sparse and padded matrix accessor layouts', () => {
    for (const [accessor, view, length] of [
      [{ count: 3, type: 'VEC3', componentType: 5126 }, {}, 36],
      [{ count: 3, type: 'VEC3', componentType: 5126 }, { byteStride: 16 }, 44],
      [{ count: 2, type: 'MAT3', componentType: 5121 }, {}, 23],
      [{ count: 2, type: 'MAT3', componentType: 5123 }, {}, 46],
    ] as const) {
      expect(validateGlb(glb({
        buffers: [{ byteLength: length }], bufferViews: [{ buffer: 0, byteLength: length, ...view }],
        accessors: [{ ...accessor, bufferView: 0 }],
      }, undefined, Buffer.alloc(length)))).toEqual({ triangles: 0 })
    }
    const doc = {
      buffers: [{ byteLength: 16 }],
      bufferViews: [{ buffer: 0, byteLength: 1 }, { buffer: 0, byteOffset: 4, byteLength: 12 }],
      accessors: [{
        count: 3, type: 'VEC3', componentType: 5126,
        sparse: { count: 1, indices: { bufferView: 0, componentType: 5121 }, values: { bufferView: 1 } },
      }],
    }
    expect(validateGlb(glb(doc, undefined, Buffer.alloc(16)))).toEqual({ triangles: 0 })
    doc.accessors[0]!.sparse.count = 2
    expect(() => validateGlb(glb(doc, undefined, Buffer.alloc(16)))).toThrow(reason('asset.model_invalid'))
  })

  it('accepts supported required extensions and bounds GPU mesh instances', () => {
    expect(validateGlb(glb({ extensionsUsed: ['KHR_materials_unlit'], extensionsRequired: ['KHR_materials_unlit'] }))).toEqual({ triangles: 0 })
    const doc = {
      ...geometry([3]), nodes: [{ mesh: 0, extensions: { EXT_mesh_gpu_instancing: { attributes: { TRANSLATION: 2 } } } }],
    }
    doc.accessors.push({ count: MAX_MODEL_TRIANGLES, type: 'VEC3', componentType: 5126 })
    expect(validateGlb(glb(doc))).toEqual({ triangles: MAX_MODEL_TRIANGLES })
    doc.accessors[2]!.count = MAX_MODEL_TRIANGLES + 1
    expect(() => validateGlb(glb(doc))).toThrow(reason('asset.model_too_complex'))
  })

  it('rejects corrupt headers, chunk lengths and JSON with a model-specific reason', () => {
    const corrupt = [
      Buffer.alloc(0), Buffer.from('glTF'), glb().subarray(0, 19), glb().subarray(0, glb().length - 1),
    ]
    for (const [offset, value] of [[0, 0], [4, 1], [8, 1000], [12, 0], [12, 0xfffffff0], [12, 3], [16, 0x004e4942]]) {
      const bytes = glb()
      bytes.writeUInt32LE(value!, offset)
      corrupt.push(bytes)
    }
    const badJson = glb()
    badJson[20] = 0xff
    corrupt.push(badJson)
    const malformed = glb()
    malformed[20] = 0x5d
    corrupt.push(malformed)
    for (const bytes of corrupt) expect(() => validateGlb(bytes)).toThrow(reason('asset.model_invalid'))
  })

  it.each([
    { asset: { version: '1.0' } }, { asset: null }, { meshes: {} }, { accessors: [{ count: -1 }] },
    { buffers: [{ byteLength: 1 }] }, { bufferViews: [{ buffer: 0, byteLength: 1 }] },
    { meshes: [{ primitives: [] }] }, { images: [{}] }, { extensionsUsed: {} },
    { ...geometry([3]), accessors: [{ count: 3, type: 'VEC3', componentType: 5126 }] },
    geometry([4]), geometry([3], true, 7),
  ])('rejects invalid document structure %#', doc => {
    expect(() => validateGlb(glb(doc))).toThrow(reason('asset.model_invalid'))
  })

  it('rejects duplicate JSON chunks and truncated chunk headers while accepting an unknown chunk', () => {
    const json = glb()
    const extra = Buffer.alloc(8)
    const bytes = Buffer.concat([json, extra])
    bytes.writeUInt32LE(bytes.length, 8)
    bytes.writeUInt32LE(1234, json.length + 4)
    expect(validateGlb(bytes)).toEqual({ triangles: 0 })
    bytes.writeUInt32LE(0x4e4f534a, json.length + 4)
    expect(() => validateGlb(bytes)).toThrow(reason('asset.model_invalid'))
    const truncated = bytes.subarray(0, bytes.length - 4)
    truncated.writeUInt32LE(truncated.length, 8)
    expect(() => validateGlb(truncated)).toThrow(reason('asset.model_invalid'))
  })
})
