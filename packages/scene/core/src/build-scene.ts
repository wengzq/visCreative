import type { Quat, SceneAspectRatio, SceneDoc, SceneTransform, SceneView, Vec3 } from '@vis/protocol'
import {
  BoxGeometry, CapsuleGeometry, Color, CylinderGeometry, DirectionalLight, Group, HemisphereLight,
  LineBasicMaterial, Material, Mesh, MeshStandardMaterial, Object3D, PerspectiveCamera, PlaneGeometry,
  PointsMaterial, Quaternion, Scene, SphereGeometry, Vector3, DoubleSide,
} from 'three'
import { BUILTIN_BODIES, BUILTIN_PROPS } from './descriptors'
import { disposeMaterials, disposeScene } from './dispose'
import { poseRotation } from './pose'
import type { BodyDescriptor, BodyPart, PropDescriptor } from './types'

export type BuildSceneOptions = {
  bodies?: readonly BodyDescriptor[]
  props?: readonly PropDescriptor[]
  /** Return a new, exclusively owned tree on every call. Loading is the host's responsibility. */
  loadModel?(assetVersionId: string): Object3D | Promise<Object3D>
}
export type BuiltScene = {
  scene: Scene
  camera: PerspectiveCamera
  objects: ReadonlyMap<string, Group>
  joints: ReadonlyMap<string, ReadonlyMap<string, Group>>
  failedModels: ReadonlySet<string>
}

export const DEFAULT_SCENE_CAMERA: SceneView['camera'] = { position: [5, 3, 5], target: [0, 1, 0], roll: 0, focalLengthMm: 35 }
export const sceneAspect = (ratio: SceneAspectRatio): number => {
  const [width, height] = ratio.split(':').map(Number) as [number, number]
  return width / height
}

const quaternion = (value: Quat) => {
  const result = new Quaternion(...value)
  return result.lengthSq() > 0 ? result.normalize() : result.identity()
}
export function applySceneTransform(object: Object3D, transform: SceneTransform) {
  object.position.fromArray(transform.position)
  object.quaternion.copy(quaternion(transform.rotation))
  object.scale.fromArray(transform.scale)
}

export function createSceneCamera(view?: Pick<SceneView, 'camera' | 'aspectRatio'>): PerspectiveCamera {
  const data = view?.camera ?? DEFAULT_SCENE_CAMERA
  const aspect = sceneAspect(view?.aspectRatio ?? '16:9')
  const verticalFov = 2 * Math.atan(36 / (2 * data.focalLengthMm * aspect)) * 180 / Math.PI
  const camera = new PerspectiveCamera(verticalFov, aspect, 0.01, 10_000)
  // three normally treats filmGauge as the longer edge. Our contract always fixes the width.
  camera.filmGauge = 36 / Math.min(aspect, 1)
  camera.position.fromArray(data.position)
  const target = new Vector3(...data.target)
  if (target.distanceToSquared(camera.position) < 1e-12) target.z -= 1
  camera.lookAt(target)
  camera.rotateZ(data.roll)
  camera.updateMatrixWorld()
  return camera
}

const greyMaterial = () => new MeshStandardMaterial({ color: 0x999999, roughness: 1, metalness: 0, side: DoubleSide })
function primitive(part: Pick<BodyPart, 'shape' | 'size'>): Mesh {
  const geometry = part.shape === 'box' ? new BoxGeometry(1, 1, 1)
    : part.shape === 'sphere' ? new SphereGeometry(0.5, 16, 12)
      : part.shape === 'cylinder' ? new CylinderGeometry(0.5, 0.5, 1, 16)
        : part.shape === 'capsule' ? new CapsuleGeometry(0.5, 1, 4, 12)
          : new PlaneGeometry(1, 1)
  const mesh = new Mesh(geometry, greyMaterial())
  mesh.scale.set(...part.size)
  if (part.shape === 'capsule') mesh.scale.y /= 2
  if (part.shape === 'plane') mesh.scale.z = 1
  return mesh
}
function addParts(parent: Object3D, parts: readonly (BodyPart & { name?: string })[]) {
  for (const part of parts) {
    const group = new Group()
    group.name = part.name ?? part.shape
    applySceneTransform(group, part.transform)
    group.add(primitive(part))
    parent.add(group)
  }
}

/** Sets each joint's rotation from the pose. A built figure can be reposed in place with the same result as a rebuild. */
export function applyBodyPose(joints: ReadonlyMap<string, Object3D>, body: BodyDescriptor, pose: Record<string, Quat>) {
  for (const descriptor of body.joints) joints.get(descriptor.id)?.quaternion.fromArray(poseRotation(body, pose, descriptor))
}

function addBody(parent: Group, body: BodyDescriptor, heightM: number, pose: Record<string, Quat>): ReadonlyMap<string, Group> {
  if (!(body.heightM > 0)) throw new Error(`Invalid body height: ${body.id}`)
  const rig = new Group()
  rig.name = body.id
  rig.scale.setScalar(heightM / body.heightM)
  parent.add(rig)
  const joints = new Map<string, Group>()
  for (const descriptor of body.joints) {
    if (joints.has(descriptor.id)) throw new Error(`Duplicate body joint: ${descriptor.id}`)
    const joint = new Group()
    joint.name = descriptor.id
    joint.userData.jointId = descriptor.id
    joint.position.fromArray(descriptor.offset)
    joints.set(descriptor.id, joint)
  }
  applyBodyPose(joints, body, pose)
  for (const descriptor of body.joints) {
    const joint = joints.get(descriptor.id)!
    const seen = new Set([descriptor.id])
    let ancestor = descriptor.parent
    while (ancestor !== null) {
      if (seen.has(ancestor)) throw new Error(`Cyclic body joints: ${body.id}`)
      seen.add(ancestor)
      const next = body.joints.find(item => item.id === ancestor)
      if (!next) throw new Error(`Unknown parent joint: ${ancestor}`)
      ancestor = next.parent
    }
    const target = descriptor.parent === null ? rig : joints.get(descriptor.parent)!
    target.add(joint)
    addParts(joint, descriptor.parts)
  }
  return joints
}

function neutralizeModel(root: Object3D) {
  const originals = new Set<Material>()
  const objects: Object3D[] = []
  root.traverse(object => objects.push(object))
  for (const object of objects) {
    object.animations = []
    if ('isLight' in object || 'isCamera' in object) { object.removeFromParent(); continue }
    const renderable = object as Mesh & { isSkinnedMesh?: boolean; isLine?: boolean; isPoints?: boolean }
    if (!renderable.material) continue
    for (const material of Array.isArray(renderable.material) ? renderable.material : [renderable.material]) originals.add(material)
    renderable.material = renderable.isLine ? new LineBasicMaterial({ color: 0x999999 })
      : renderable.isPoints ? new PointsMaterial({ color: 0x999999, size: 0.02 }) : greyMaterial()
    if (renderable.isSkinnedMesh) {
      // A plain mesh ignores skinning and displays the imported geometry as a static prop.
      const mesh = new Mesh(renderable.geometry, renderable.material)
      mesh.name = renderable.name
      mesh.position.copy(renderable.position)
      mesh.quaternion.copy(renderable.quaternion)
      mesh.scale.copy(renderable.scale)
      mesh.visible = renderable.visible
      for (const child of [...renderable.children]) mesh.add(child)
      renderable.parent?.add(mesh)
      renderable.removeFromParent()
      const skinned = renderable as Mesh & { skeleton?: { dispose(): void } }
      skinned.skeleton?.dispose()
    }
  }
  disposeMaterials(originals)
}

/** Builds without a renderer, browser globals or a GPU. */
export async function buildScene(doc: SceneDoc, viewId: string | null, options: BuildSceneOptions = {}): Promise<BuiltScene> {
  const view = viewId === null ? undefined : doc.views.find(view => view.id === viewId)
  if (viewId !== null && !view) throw new Error(`Unknown scene view: ${viewId}`)
  const scene = new Scene()
  scene.background = new Color(0xd9d9d9)
  const objects = new Map<string, Group>()
  const joints = new Map<string, ReadonlyMap<string, Group>>()
  const failedModels = new Set<string>()
  const bodies = options.bodies ?? BUILTIN_BODIES
  const props = options.props ?? BUILTIN_PROPS
  scene.add(new HemisphereLight(0xffffff, 0x777777, 2))
  const key = new DirectionalLight(0xffffff, 2.5)
  key.position.set(4, 8, 5)
  scene.add(key)
  try {
    for (const descriptor of doc.objects) {
      const object = new Group()
      object.name = descriptor.name
      object.userData.sceneObjectId = descriptor.id
      object.visible = !descriptor.hidden
      applySceneTransform(object, descriptor.transform)
      objects.set(descriptor.id, object)
      scene.add(object)
      const source = descriptor.source
      if (source.type === 'primitive') object.add(primitive(source))
      else if (source.type === 'group') addParts(object, source.parts)
      else if (source.type === 'prop') {
        const prop = props.find(prop => prop.id === source.propId)
        if (!prop) throw new Error(`Unknown scene prop: ${source.propId}`)
        addParts(object, prop.parts)
      } else if (source.type === 'figure') {
        const body = bodies.find(body => body.id === source.bodyId)
        if (!body) throw new Error(`Unknown scene body: ${source.bodyId}`)
        joints.set(descriptor.id, addBody(object, body, source.heightM, source.pose))
      } else {
        if (!options.loadModel) throw new Error('A model loader is required')
        let model: Object3D
        try {
          model = await options.loadModel(source.assetVersionId)
        } catch {
          // One unavailable asset must not prevent editing or capturing the rest of the stage.
          failedModels.add(source.assetVersionId)
          const placeholder = primitive({ shape: 'box', size: [1, 1, 1] })
          placeholder.position.y = 0.5
          const material = placeholder.material as MeshStandardMaterial
          material.wireframe = true
          object.add(placeholder)
          continue
        }
        object.add(model)
        neutralizeModel(model)
      }
    }
    scene.updateMatrixWorld(true)
    return { scene, camera: createSceneCamera(view), objects, joints, failedModels }
  } catch (error) {
    disposeScene(scene)
    throw error
  }
}
