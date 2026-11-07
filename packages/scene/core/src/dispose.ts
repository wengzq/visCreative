import { Material, Object3D, Scene, Texture, type BufferGeometry } from 'three'

export type DisposalCounts = { geometries: number; materials: number; textures: number }

export function disposeMaterials(materials: Iterable<Material>, extraTextures: Iterable<Texture> = []): { materials: number; textures: number } {
  const unique = new Set(materials)
  const textures = new Set(extraTextures)
  const visited = new Set<object>()
  const visit = (value: unknown) => {
    if (!value || typeof value !== 'object' || visited.has(value)) return
    visited.add(value)
    if (value instanceof Texture) { textures.add(value); return }
    if (Array.isArray(value)) value.forEach(visit)
    else if (Object.getPrototypeOf(value) === Object.prototype) Object.values(value).forEach(visit)
    else if ('value' in value) visit(value.value)
  }
  for (const material of unique) Object.values(material).forEach(visit)
  textures.forEach(texture => texture.dispose())
  unique.forEach(material => material.dispose())
  return { materials: unique.size, textures: textures.size }
}

/** Disposes each shared resource once. The caller owns the entire supplied tree. */
export function disposeScene(root: Object3D): DisposalCounts {
  const geometries = new Set<BufferGeometry>()
  const materials = new Set<Material>()
  const skeletons = new Set<{ dispose(): void }>()
  root.traverse(object => {
    const renderable = object as Object3D & { geometry?: BufferGeometry; material?: Material | Material[]; skeleton?: { boneTexture?: Texture | null; dispose(): void } }
    if (renderable.geometry) geometries.add(renderable.geometry)
    if (renderable.material) for (const material of Array.isArray(renderable.material) ? renderable.material : [renderable.material]) materials.add(material)
    // Static model conversion normally removes skins; this also covers a loader's unused bone texture.
    if (renderable.skeleton) skeletons.add(renderable.skeleton)
  })
  skeletons.forEach(skeleton => skeleton.dispose())
  const extraTextures = root instanceof Scene ? new Set([root.background, root.environment].filter((value): value is Texture => value instanceof Texture)) : new Set<Texture>()
  const result = disposeMaterials(materials, extraTextures)
  geometries.forEach(geometry => geometry.dispose())
  return { geometries: geometries.size, ...result }
}
