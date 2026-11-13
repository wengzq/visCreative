import { afterEach, expect, it, vi } from 'vitest'
import type { SceneDoc, SceneObject, SceneTransform, SceneView } from '@vis/protocol'
import {
  Box3, BoxGeometry, BufferGeometry, Euler, Group, Material, Mesh, MeshBasicMaterial, MeshStandardMaterial,
  Quaternion, Scene, ShaderMaterial, SphereGeometry, Texture, Vector3,
} from 'three'
import { applyBodyPose, buildScene, createSceneCamera, sceneAspect } from './build-scene'
import { BUILTIN_PROPS, HUMAN_BODY } from './descriptors'
import { disposeScene } from './dispose'
import type { BodyDescriptor } from './types'
import { mirrorPose, presetPose } from './pose'

const identity: SceneTransform = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }
const object = (id: string, source: SceneObject['source'], fields: Partial<SceneObject> = {}): SceneObject => ({
  id, name: id, transform: structuredClone(identity), hidden: false, createdBy: 'user', userTouched: true, source, ...fields,
})
const doc = (objects: SceneObject[] = [], views: SceneView[] = []): SceneDoc => ({ version: 1, rev: 0, objects, views })
const view = (aspectRatio: SceneView['aspectRatio'] = '16:9'): SceneView => ({
  id: 'wide', name: 'Wide', aspectRatio, still: null, createdBy: 'user', userTouched: false,
  camera: { position: [3, 2, 5], target: [0, 1, 0], roll: 0, focalLengthMm: 35 },
})
const scenes: Scene[] = []
afterEach(() => { scenes.splice(0).forEach(disposeScene); vi.restoreAllMocks() })
const build = async (...args: Parameters<typeof buildScene>) => {
  const result = await buildScene(...args)
  scenes.push(result.scene)
  return result
}

it('builds an empty stage without a DOM, renderer or implicit objects', async () => {
  const built = await build(doc(), null)
  expect(built.scene.isScene).toBe(true)
  expect(built.objects.size).toBe(0)
  expect(built.scene.children.filter(child => child instanceof Mesh)).toHaveLength(0)
  expect(built.camera.isPerspectiveCamera).toBe(true)
})

it('preserves object and group-part transforms and primitive dimensions', async () => {
  const rotation = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2).toArray()
  const built = await build(doc([
    object('group', { type: 'group', parts: [{ name: 'seat', shape: 'box', size: [2, 0.2, 1], transform: { ...identity, position: [1, 0.5, 0] } }] }, { transform: { position: [4, 0, 2], rotation, scale: [2, 2, 2] } }),
    object('sphere', { type: 'primitive', shape: 'sphere', size: [2, 4, 6] }),
    object('capsule', { type: 'primitive', shape: 'capsule', size: [1, 2, 1] }),
    object('plane', { type: 'primitive', shape: 'plane', size: [3, 2, 0] }),
    object('cylinder', { type: 'primitive', shape: 'cylinder', size: [2, 3, 2] }),
  ]), null)
  const group = built.objects.get('group')!
  expect(group.userData.sceneObjectId).toBe('group')
  expect(group.children[0]!.name).toBe('seat')
  expect(group.children[0]!.getWorldPosition(new Vector3()).toArray()).toEqual([4, 1, 0])
  expect(new Box3().setFromObject(built.objects.get('sphere')!).getSize(new Vector3()).toArray()).toEqual([2, 4, 6])
  const capsule = new Box3().setFromObject(built.objects.get('capsule')!).getSize(new Vector3())
  expect(capsule.y).toBeCloseTo(2)
  expect(capsule.x).toBeCloseTo(1)
  expect(new Box3().setFromObject(built.objects.get('plane')!).isEmpty()).toBe(false)
})

it('keeps hidden objects in the document tree but marks the whole object invisible', async () => {
  const built = await build(doc([object('hidden', { type: 'prop', propId: 'bench' }, { hidden: true })]), null)
  expect(built.objects.get('hidden')!.visible).toBe(false)
  expect(built.objects.get('hidden')!.children.length).toBeGreaterThan(0)
})

it.each(['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'] as const)('uses a 36 mm sensor width for a %s camera', ratio => {
  const data = view(ratio)
  const camera = createSceneCamera(data)
  const horizontalFov = 2 * Math.atan(Math.tan(camera.fov * Math.PI / 360) * camera.aspect)
  expect(camera.aspect).toBeCloseTo(sceneAspect(ratio))
  expect(horizontalFov).toBeCloseTo(2 * Math.atan(36 / (2 * data.camera.focalLengthMm)))
  expect(camera.getFocalLength()).toBeCloseTo(35)
  expect(camera.getFilmWidth()).toBeCloseTo(36)
  expect(camera.position.toArray()).toEqual(data.camera.position)
  expect(camera.getWorldDirection(new Vector3()).dot(new Vector3(...data.camera.target).sub(camera.position).normalize())).toBeCloseTo(1)
})

it('applies camera roll around the viewing axis and selects the requested view', async () => {
  const first = view()
  const second = { ...view(), id: 'close', camera: { ...first.camera, focalLengthMm: 85, roll: Math.PI / 2 } }
  const built = await build(doc([], [first, second]), 'close')
  const expected = createSceneCamera(first)
  expected.rotateZ(Math.PI / 2)
  expect(built.camera.quaternion.angleTo(expected.quaternion)).toBeCloseTo(0)
  expect(built.camera.getFocalLength()).toBeCloseTo(85)
  await expect(buildScene(doc([], [first]), 'missing')).rejects.toThrow('Unknown scene view')
})

it('builds the standing mannequin as a joint tree and scales it by height', async () => {
  const built = await build(doc([
    object('adult', { type: 'figure', bodyId: 'human', heightM: 1.8, pose: {} }),
    object('small', { type: 'figure', bodyId: 'human', heightM: 0.9, pose: {} }),
  ]), null)
  const joints = built.joints.get('adult')!
  expect(joints.size).toBe(HUMAN_BODY.joints.length)
  expect(joints.get('leftKnee')!.parent).toBe(joints.get('leftHip'))
  expect(joints.get('head')!.parent).toBe(joints.get('neck'))
  expect(joints.get('leftKnee')!.getWorldPosition(new Vector3()).y).toBeCloseTo(0.5)
  const adult = new Box3().setFromObject(built.objects.get('adult')!)
  const small = new Box3().setFromObject(built.objects.get('small')!)
  expect(adult.min.y).toBeCloseTo(0)
  expect(adult.max.y).toBeCloseTo(HUMAN_BODY.heightM)
  expect(small.getSize(new Vector3()).y).toBeCloseTo(adult.getSize(new Vector3()).y / 2)
})

it('places anatomical left at positive X for a figure facing positive Z and mirrors the pointing arm', async () => {
  const pose = presetPose(HUMAN_BODY, 'pointing')
  const built = await build(doc([
    object('standing', { type: 'figure', bodyId: 'human', heightM: 1.8, pose: {} }),
    object('pointing', { type: 'figure', bodyId: 'human', heightM: 1.8, pose }),
    object('mirror', { type: 'figure', bodyId: 'human', heightM: 1.8, pose: mirrorPose(HUMAN_BODY, pose, 'swap') }),
  ]), null)
  for (const [id, joint] of built.joints.get('standing')!) {
    if (id.startsWith('left')) expect(joint.getWorldPosition(new Vector3()).x, id).toBeGreaterThan(0)
    if (id.startsWith('right')) expect(joint.getWorldPosition(new Vector3()).x, id).toBeLessThan(0)
  }
  const pointing = built.joints.get('pointing')!
  const wrist = pointing.get('rightWrist')!.getWorldPosition(new Vector3())
  const shoulder = pointing.get('rightShoulder')!.getWorldPosition(new Vector3())
  expect(wrist.x).toBeLessThan(shoulder.x)
  expect(wrist.z).toBeGreaterThan(shoulder.z)
  const mirrored = built.joints.get('mirror')!.get('leftWrist')!.getWorldPosition(new Vector3())
  expect(mirrored.distanceTo(wrist.clone().setX(-wrist.x))).toBeCloseTo(0)
})

it('adds a new body entirely as data, applies its preset and clamps joint rotation limits', async () => {
  const preset = new Quaternion().setFromEuler(new Euler(0.25, 0, 0)).toArray()
  const tooFar = new Quaternion().setFromEuler(new Euler(1, 0.5, 0)).toArray()
  const body: BodyDescriptor = {
    id: 'test-body', heightM: 1, joints: [
      { id: 'root', parent: null, offset: [0, 0, 0], parts: [], limits: { min: [-0.5, 0, 0], max: [0.5, 0, 0] } },
      { id: 'tip', parent: 'root', offset: [0, 1, 0], parts: [{ shape: 'sphere', size: [0.1, 0.1, 0.1], transform: identity }], limits: { min: [0, 0, 0], max: [0, 0, 0] } },
    ], poses: [{ id: 'standing', joints: { root: preset } }],
  }
  const built = await build(doc([
    object('default', { type: 'figure', bodyId: body.id, heightM: 1, pose: {} }),
    object('posed', { type: 'figure', bodyId: body.id, heightM: 2, pose: { root: tooFar } }),
  ]), null, { bodies: [body] })
  expect(built.joints.get('default')!.get('root')!.rotation.x).toBeCloseTo(0.25)
  expect(built.joints.get('posed')!.get('root')!.rotation.x).toBeCloseTo(0.5)
  expect(built.joints.get('posed')!.get('root')!.rotation.y).toBeCloseTo(0)
  expect(built.objects.get('posed')!.children[0]!.scale.y).toBe(2)
})

it('scales a posed figure and its forward kinematics by height and retains a hidden figure pose', async () => {
  const pose = presetPose(HUMAN_BODY, 'pointing')
  const built = await build(doc([
    object('adult', { type: 'figure', bodyId: 'human', heightM: 1.8, pose }),
    object('small', { type: 'figure', bodyId: 'human', heightM: 0.9, pose }),
    object('hidden', { type: 'figure', bodyId: 'human', heightM: 1.8, pose }, { hidden: true }),
  ]), null)
  const adult = built.joints.get('adult')!
  const small = built.joints.get('small')!
  for (const joint of HUMAN_BODY.joints) {
    expect(small.get(joint.id)!.getWorldPosition(new Vector3()).distanceTo(adult.get(joint.id)!.getWorldPosition(new Vector3()).multiplyScalar(0.5))).toBeCloseTo(0)
    expect(small.get(joint.id)!.quaternion.angleTo(adult.get(joint.id)!.quaternion)).toBeCloseTo(0)
  }
  expect(built.objects.get('hidden')!.visible).toBe(false)
  expect(built.joints.get('hidden')!.get('rightShoulder')!.quaternion.angleTo(new Quaternion(...pose.rightShoulder!))).toBeCloseTo(0)
  const standing = await build(doc([object('adult', { type: 'figure', bodyId: 'human', heightM: 1.8, pose: {} })]), null)
  expect(adult.get('rightWrist')!.getWorldPosition(new Vector3()).distanceTo(standing.joints.get('adult')!.get('rightWrist')!.getWorldPosition(new Vector3()))).toBeGreaterThan(0.4)
})

it('builds all built-in props and renders every mesh with neutral grey materials', async () => {
  expect(BUILTIN_PROPS.map(prop => prop.id)).toEqual(expect.arrayContaining(['bench', 'chair', 'table', 'wall', 'door', 'car']))
  const built = await build(doc(BUILTIN_PROPS.map(prop => object(prop.id, { type: 'prop', propId: prop.id }))), null)
  for (const prop of BUILTIN_PROPS) expect(built.objects.get(prop.id)!.children).toHaveLength(prop.parts.length)
  built.scene.traverse(child => {
    if (!(child instanceof Mesh)) return
    const material = child.material as MeshStandardMaterial
    expect(material.color.r).toBe(material.color.g)
    expect(material.color.g).toBe(material.color.b)
    expect(material.map).toBeNull()
  })
})

it('uses only the injected model loader and disposes imported material maps when making models grey', async () => {
  const model = new Group()
  const texture = new Texture()
  const disposeTexture = vi.spyOn(texture, 'dispose')
  const material = new MeshBasicMaterial({ color: 'red', map: texture })
  const disposeMaterial = vi.spyOn(material, 'dispose')
  model.add(new Mesh(new BoxGeometry(), material))
  const loadModel = vi.fn(async () => model)
  const built = await build(doc([object('model', { type: 'model', assetVersionId: 'model-version' })]), null, { loadModel })
  expect(loadModel).toHaveBeenCalledExactlyOnceWith('model-version')
  expect(built.objects.get('model')!.children[0]).toBe(model)
  expect((model.children[0] as Mesh).material).toBeInstanceOf(MeshStandardMaterial)
  expect(disposeTexture).toHaveBeenCalledOnce()
  expect(disposeMaterial).toHaveBeenCalledOnce()
})

it('keeps the stage usable with a visible placeholder when one model fails to load', async () => {
  const built = await build(doc([
    object('box', { type: 'primitive', shape: 'box', size: [1, 1, 1] }),
    object('bad', { type: 'model', assetVersionId: 'bad-model' }, { transform: { ...identity, position: [3, 0, 0] } }),
    object('good', { type: 'model', assetVersionId: 'good-model' }),
  ], [view()]), 'wide', {
    loadModel: async id => {
      if (id === 'bad-model') throw new Error('Missing model')
      return new Mesh(new BoxGeometry(), new MeshBasicMaterial())
    },
  })
  expect(built.objects.size).toBe(3)
  const placeholder = built.objects.get('bad')!
  expect(placeholder.visible).toBe(true)
  expect(placeholder.children[0]).toBeInstanceOf(Mesh)
  expect(new Box3().setFromObject(placeholder).isEmpty()).toBe(false)
  expect(placeholder.position.x).toBe(3)
  expect([...built.failedModels]).toEqual(['bad-model'])
  expect(built.objects.get('good')!.children[0]).toBeInstanceOf(Mesh)
})

it('releases each geometry, material and texture once even when shared across a scene', () => {
  const scene = new Scene()
  const box = new BoxGeometry()
  const sphere = new SphereGeometry()
  const shared = new Texture()
  const extra = new Texture()
  const basic = new MeshBasicMaterial({ map: shared })
  const shader = new ShaderMaterial({ uniforms: { nested: { value: [shared, extra] } } })
  scene.add(new Mesh(box, basic), new Mesh(box, [basic, shader]), new Mesh(sphere, shader))
  scene.background = shared
  scene.environment = extra
  const resources = [box, sphere, shared, extra, basic, shader].map(resource => vi.spyOn(resource, 'dispose'))
  expect(disposeScene(scene)).toEqual({ geometries: 2, materials: 2, textures: 2 })
  resources.forEach(dispose => expect(dispose).toHaveBeenCalledOnce())
})

it('cleans partially built scenes after an invalid descriptor', async () => {
  const geometries = vi.spyOn(BufferGeometry.prototype, 'dispose')
  const materials = vi.spyOn(Material.prototype, 'dispose')
  await expect(buildScene(doc([object('box', { type: 'primitive', shape: 'box', size: [1, 1, 1] }), object('bad', { type: 'prop', propId: 'missing' })]), null)).rejects.toThrow('Unknown scene prop')
  expect(geometries).toHaveBeenCalledOnce()
  expect(materials).toHaveBeenCalledOnce()
  await expect(buildScene(doc([object('bad', { type: 'prop', propId: 'missing' })]), null)).rejects.toThrow('Unknown scene prop')
  const cyclic: BodyDescriptor = { id: 'cycle', heightM: 1, poses: [], joints: [{ id: 'a', parent: 'a', offset: [0, 0, 0], parts: [], limits: { min: [0, 0, 0], max: [0, 0, 0] } }] }
  await expect(buildScene(doc([object('bad', { type: 'figure', bodyId: cyclic.id, heightM: 1, pose: {} })]), null, { bodies: [cyclic] })).rejects.toThrow('Cyclic body joints')
})

it('reposes built joints exactly as a fresh build of the new pose would', async () => {
  const sitting = presetPose(HUMAN_BODY, 'sitting')
  const built = await build(doc([object('hero', { type: 'figure', bodyId: 'human', heightM: 1.8, pose: presetPose(HUMAN_BODY, 'pointing') })]), null)
  const fresh = await build(doc([object('hero', { type: 'figure', bodyId: 'human', heightM: 1.8, pose: sitting })]), null)
  applyBodyPose(built.joints.get('hero')!, HUMAN_BODY, sitting)
  for (const joint of HUMAN_BODY.joints) expect(built.joints.get('hero')!.get(joint.id)!.quaternion.toArray()).toEqual(fresh.joints.get('hero')!.get(joint.id)!.quaternion.toArray())
  applyBodyPose(built.joints.get('hero')!, HUMAN_BODY, {})
  expect(built.joints.get('hero')!.get('leftKnee')!.quaternion.toArray()).toEqual([0, 0, 0, 1])
})
