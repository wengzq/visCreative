import { VisError } from '@vis/domain'

export const MAX_MODEL_BYTES = 32 * 1024 ** 2
export const MAX_MODEL_TRIANGLES = 500_000
// Sized for a model at the triangle limit with several attributes per vertex.
export const MAX_MODEL_GEOMETRY_BYTES = 256 * 1024 ** 2
const JSON_CHUNK = 0x4e4f534a
const BIN_CHUNK = 0x004e4942
const unsupported = new Set(['KHR_draco_mesh_compression', 'EXT_meshopt_compression', 'KHR_meshopt_compression'])
// Keep this aligned with the scene loader's built-in plugins; no external decoders are configured.
const supportedRequired = new Set([
  'KHR_lights_punctual', 'KHR_materials_anisotropy', 'KHR_materials_clearcoat', 'KHR_materials_diffuse_roughness',
  'KHR_materials_dispersion', 'KHR_materials_emissive_strength', 'KHR_materials_ior', 'KHR_materials_iridescence',
  'KHR_materials_sheen', 'KHR_materials_specular', 'KHR_materials_transmission', 'KHR_materials_unlit',
  'KHR_materials_volume', 'KHR_mesh_quantization', 'KHR_texture_transform', 'EXT_materials_bump',
  'EXT_texture_avif', 'EXT_texture_webp', 'EXT_mesh_gpu_instancing',
])
const componentBytes = new Map([[5120, 1], [5121, 1], [5122, 2], [5123, 2], [5125, 4], [5126, 4]])
const components = new Map([['SCALAR', 1], ['VEC2', 2], ['VEC3', 3], ['VEC4', 4], ['MAT2', 4], ['MAT3', 9], ['MAT4', 16]])

function tooComplex(): never {
  throw VisError.of('invalid_params', 'asset.model_too_complex', {}, 'Models must contain at most 500,000 triangles')
}

function unsupportedExtension(): never {
  throw VisError.of('invalid_params', 'asset.model_unsupported', {}, 'The model requires an unsupported glTF extension')
}

function invalid(): never {
  throw VisError.of('invalid_params', 'asset.model_invalid', {}, 'Use a valid binary glTF 2.0 (.glb) model')
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid()
  return value as Record<string, unknown>
}

function entries(doc: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const value = doc[key]
  if (value === undefined) return []
  if (!Array.isArray(value)) invalid()
  return value.map(record)
}

function integer(value: unknown, min = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) invalid()
  return value
}

/** Inspect the container and JSON before any loader can resolve resources or allocate mesh data. */
export function validateGlb(data: Uint8Array): { triangles: number } {
  if (data.byteLength > MAX_MODEL_BYTES) throw VisError.of('invalid_params', 'asset.model_too_large', {}, 'Model files must be at most 32 MiB')
  if (data.byteLength < 20) invalid()
  const header = new DataView(data.buffer, data.byteOffset, data.byteLength)
  if (header.getUint32(0, true) !== 0x46546c67 || header.getUint32(4, true) !== 2 || header.getUint32(8, true) !== data.byteLength) invalid()
  let json: Uint8Array | undefined
  let binaryLength: number | undefined
  let chunk = 0
  for (let offset = 12; offset < data.byteLength; chunk++) {
    if (offset + 8 > data.byteLength) invalid()
    const length = header.getUint32(offset, true)
    const type = header.getUint32(offset + 4, true)
    const start = offset + 8
    const end = start + length
    if (length % 4 || end > data.byteLength) invalid()
    if (chunk === 0) {
      if (type !== JSON_CHUNK || !length) invalid()
      json = data.subarray(start, end)
    } else if (type === JSON_CHUNK) invalid()
    if (type === BIN_CHUNK) {
      if (chunk !== 1 || binaryLength !== undefined) invalid()
      binaryLength = length
    }
    offset = end
  }
  if (!json) invalid()
  let parsed: unknown
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(json)) } catch { invalid() }
  const doc = record(parsed)
  if (record(doc.asset).version !== '2.0') invalid()
  const buffers = entries(doc, 'buffers')
  const images = entries(doc, 'images')
  if ([...buffers, ...images].some(item => Object.hasOwn(item, 'uri'))) {
    throw VisError.of('invalid_params', 'asset.model_external_reference', {}, 'Models must embed all buffers and images in one GLB file')
  }
  const pending: unknown[] = [doc]
  while (pending.length) {
    const value = pending.pop()
    if (!value || typeof value !== 'object') continue
    if (Array.isArray(value)) {
      for (const child of value) pending.push(child)
      continue
    }
    const fields = record(value)
    for (const key of ['extensionsUsed', 'extensionsRequired']) if (fields[key] !== undefined) {
      if (!Array.isArray(fields[key]) || !(fields[key] as unknown[]).every(name => typeof name === 'string')) invalid()
      if ((fields[key] as string[]).some(name => unsupported.has(name) || key === 'extensionsRequired' && !supportedRequired.has(name))) unsupportedExtension()
    }
    if (fields.extensions !== undefined && Object.keys(record(fields.extensions)).some(name => unsupported.has(name))) {
      unsupportedExtension()
    }
    for (const child of Object.values(fields)) pending.push(child)
  }
  if (buffers.length > 1) invalid()
  if (buffers[0]) {
    const length = integer(buffers[0].byteLength, 1)
    if (binaryLength === undefined || length > binaryLength || binaryLength - length > 3) invalid()
  } else if (binaryLength !== undefined) invalid()
  const bufferViews = entries(doc, 'bufferViews')
  for (const view of bufferViews) {
    if (integer(view.buffer) !== 0 || !buffers[0]) invalid()
    const end = integer(view.byteOffset ?? 0) + integer(view.byteLength, 1)
    if (!Number.isSafeInteger(end) || end > integer(buffers[0].byteLength, 1)) invalid()
    if (view.byteStride !== undefined) {
      const stride = integer(view.byteStride, 4)
      if (stride > 252 || stride % 4) invalid()
    }
  }
  for (const image of images) {
    if (!bufferViews[integer(image.bufferView)] || typeof image.mimeType !== 'string') invalid()
  }
  const accessors = entries(doc, 'accessors')
  const accessorBytes: number[] = []
  const extent = (viewIndex: unknown, offset: unknown, count: number, size: number, span: number, alignment: number, interleaved: boolean) => {
    const view = bufferViews[integer(viewIndex)]
    if (!view) invalid()
    const start = integer(offset ?? 0)
    const stride = interleaved ? integer(view.byteStride ?? size, 1) : size
    if ((!interleaved && view.byteStride !== undefined) || stride < size || start % alignment
      || (integer(view.byteOffset ?? 0) + start) % alignment) invalid()
    const end = start + (count - 1) * stride + span
    if (!Number.isSafeInteger(end) || end > integer(view.byteLength, 1)) invalid()
  }
  for (const accessor of accessors) {
    const count = integer(accessor.count, 1)
    // Bufferless accessors allocate zero-filled arrays, so file size alone cannot bound their memory.
    if (count > MAX_MODEL_TRIANGLES * 3) tooComplex()
    const bytes = componentBytes.get(integer(accessor.componentType))
    const width = typeof accessor.type === 'string' ? components.get(accessor.type) : undefined
    if (!bytes || !width) invalid()
    const columns = String(accessor.type).startsWith('MAT') ? Math.sqrt(width) : 1
    const columnBytes = columns === 1 ? width * bytes : columns * bytes
    const columnStride = columns === 1 ? columnBytes : Math.ceil(columnBytes / 4) * 4
    const size = columnStride * columns
    const span = columnStride * (columns - 1) + columnBytes
    accessorBytes.push(count * size)
    if (accessor.bufferView !== undefined) extent(accessor.bufferView, accessor.byteOffset, count, size, span, bytes, true)
    else if (integer(accessor.byteOffset ?? 0)) invalid()
    if (accessor.sparse !== undefined) {
      const sparse = record(accessor.sparse)
      const sparseCount = integer(sparse.count, 1)
      if (sparseCount > count) invalid()
      const indices = record(sparse.indices)
      const values = record(sparse.values)
      if (![5121, 5123, 5125].includes(integer(indices.componentType))) invalid()
      const indexBytes = componentBytes.get(Number(indices.componentType))!
      extent(indices.bufferView, indices.byteOffset, sparseCount, indexBytes, indexBytes, indexBytes, false)
      extent(values.bufferView, values.byteOffset, sparseCount, size, span, bytes, false)
    }
  }
  const meshes = entries(doc, 'meshes')
  const references = new Array<number>(meshes.length).fill(0)
  for (const node of entries(doc, 'nodes')) {
    if (node.mesh === undefined) continue
    const mesh = integer(node.mesh)
    if (!meshes[mesh]) invalid()
    const instancing = node.extensions === undefined ? undefined : record(node.extensions).EXT_mesh_gpu_instancing
    let instances = 1
    if (instancing !== undefined) {
      const attributes = Object.values(record(record(instancing).attributes))
      if (!attributes.length) invalid()
      const counts = attributes.map(index => {
        const accessor = accessors[integer(index)]
        if (!accessor) invalid()
        return integer(accessor.count, 1)
      })
      if (counts.some(count => count !== counts[0])) invalid()
      instances = counts[0]!
    }
    references[mesh]! += instances
  }
  let triangles = 0
  let complexity = 0
  let vertices = 0
  let geometryBytes = 0
  for (const [index, mesh] of meshes.entries()) {
    const primitives = entries(mesh, 'primitives')
    // Per mesh on purpose: the viewport clones geometry for each mesh, so sharing an accessor between meshes does not share memory.
    const positions = new Set<number>()
    const attributes = new Set<number>()
    if (!primitives.length) invalid()
    for (const primitive of primitives) {
      const positionIndex = integer(record(primitive.attributes).POSITION)
      const referenced = [record(primitive.attributes), ...entries(primitive, 'targets')].flatMap(Object.values)
      const position = accessors[positionIndex]
      if (!position || position.type !== 'VEC3') invalid()
      const indexed = primitive.indices !== undefined
      const source = indexed ? accessors[integer(primitive.indices)] : position
      if (!source || (indexed && (source.type !== 'SCALAR' || ![5121, 5123, 5125].includes(Number(source.componentType))))) invalid()
      const count = integer(source.count, 1)
      const mode = integer(primitive.mode ?? 4)
      if (mode > 6 || (mode === 4 && count % 3) || ((mode === 5 || mode === 6) && count < 3)) invalid()
      const faces = mode === 4 ? count / 3 : mode === 5 || mode === 6 ? count - 2 : 0
      const instances = Math.max(1, references[index]!)
      triangles += faces * instances
      // Points and lines also consume GPU work, even though they contribute no triangles.
      complexity += (mode === 0 || mode === 2 ? count : mode === 1 ? Math.ceil(count / 2) : mode === 3 ? count - 1 : faces) * instances
      if (!positions.has(positionIndex)) {
        positions.add(positionIndex)
        vertices += integer(position.count, 1) * instances
      }
      for (const value of referenced) {
        const accessor = integer(value)
        if (!accessors[accessor]) invalid()
        if (attributes.has(accessor)) continue
        attributes.add(accessor)
        geometryBytes += accessorBytes[accessor]! * instances
      }
      if (complexity > MAX_MODEL_TRIANGLES || vertices > MAX_MODEL_TRIANGLES * 3 || geometryBytes > MAX_MODEL_GEOMETRY_BYTES) tooComplex()
    }
  }
  return { triangles }
}
