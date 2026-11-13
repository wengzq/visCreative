import { afterEach, expect, it, vi } from 'vitest'
import { Mesh, MeshBasicMaterial, Quaternion, Raycaster, Vector3, type Object3D } from 'three'
import type { Quat, SceneDoc } from '@vis/protocol'
import { jointEuler, jointQuaternion, HUMAN_BODY, sampleScene } from '@vis/scene-core'
import { createSceneDraft } from './draft'
import { SceneViewport, type SceneViewportProps } from './SceneViewport'
import { createSceneViewportController } from './viewport-state'

const hooks = vi.hoisted(() => ({
  refs: [] as { current: unknown }[], effects: [] as { deps: unknown[]; cleanup?: (() => void) | undefined }[],
  pending: [] as (() => void)[], refIndex: 0, effectIndex: 0, element: null as unknown,
  frames: [] as FrameRequestCallback[],
}))
const { Events, controls } = vi.hoisted(() => {
  class Events {
    listeners = new Map<string, Set<(event: any) => void>>()
    addEventListener(name: string, listener: (event: any) => void) {
      if (!this.listeners.has(name)) this.listeners.set(name, new Set())
      this.listeners.get(name)!.add(listener)
    }
    removeEventListener(name: string, listener: (event: any) => void) { this.listeners.get(name)?.delete(listener) }
    emit(name: string, value?: unknown) { this.listeners.get(name)?.forEach(listener => listener({ value })) }
  }
  return { Events, controls: { transform: null as any } }
})
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useRef(value: unknown) {
    const index = hooks.refIndex++
    return hooks.refs[index] ??= { current: index === 0 ? hooks.element : value }
  },
  useEffect(effect: () => (() => void) | void, deps: unknown[]) {
    const index = hooks.effectIndex++
    const previous = hooks.effects[index]
    if (previous && deps.every((value, index) => Object.is(value, previous.deps[index]))) return
    hooks.pending.push(() => {
      previous?.cleanup?.()
      hooks.effects[index] = { deps, cleanup: effect() ?? undefined }
    })
  },
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}))
vi.mock('@vis/ui-kit', () => ({ useMessages: () => ({ viewport: '3D viewport' }), defineMessages: (messages: unknown) => messages }))
vi.mock('three', async original => ({
  ...await original<typeof import('three')>(),
  WebGLRenderer: class {
    domElement = Object.assign(new EventTarget(), { remove: vi.fn() })
    getContext() { return { getExtension: () => null, getParameter: () => 'Test GPU', RENDERER: 0 } }
    setPixelRatio() {}
    setSize() {}
    setRenderTarget() {}
    setViewport() {}
    setScissorTest() {}
    setScissor() {}
    setClearColor() {}
    clear() {}
    render() {}
    dispose() {}
    forceContextLoss() {}
  },
}))
vi.mock('three/addons/controls/TransformControls.js', async () => {
  const { Group } = await import('three')
  return {
    TransformControls: class extends Events {
      object: Object3D | undefined
      enabled = true
      dragging = false
      mode = 'translate'
      space = 'world'
      helper = new Group()
      constructor() { super(); controls.transform = this }
      attach(object: Object3D) { this.object = object }
      detach() { this.object = undefined }
      getHelper() { return this.helper }
      setMode(mode: string) { this.mode = mode }
      setSpace(space: string) { this.space = space }
      setColors() {}
      dispose() {}
    },
  }
})
vi.mock('three/addons/controls/OrbitControls.js', () => ({
  OrbitControls: class extends Events {
    target = new Vector3()
    update() {}
    dispose() {}
  },
}))

function mount(doc: SceneDoc) {
  const element = Object.assign(new EventTarget(), {
    append: vi.fn(), clientWidth: 640, clientHeight: 360, style: {},
    getBoundingClientRect: () => ({ left: 0, right: 640, top: 0, bottom: 360, width: 640, height: 360 }),
    classList: { toggle: vi.fn() }, remove: vi.fn(),
  })
  hooks.element = element
  vi.stubGlobal('document', { documentElement: element, body: element, createElement: () => element })
  vi.stubGlobal('window', { devicePixelRatio: 1 })
  vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '#333333' }))
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { hooks.frames.push(callback); return hooks.frames.length })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  class Observer { observe() {} disconnect() {} }
  vi.stubGlobal('ResizeObserver', Observer)
  vi.stubGlobal('MutationObserver', Observer)
  const controller = createSceneViewportController()
  controller.select('box')
  const props: SceneViewportProps = { controller, doc, assetUrl: id => id, onTransform: vi.fn(), onJointRotation: vi.fn(), onCameraChange: vi.fn() }
  const render = (next: Partial<SceneViewportProps> = {}) => {
    Object.assign(props, next)
    hooks.refIndex = hooks.effectIndex = 0
    SceneViewport({ ...props })
    hooks.pending.splice(0).forEach(effect => effect())
  }
  render()
  const unmount = () => {
    hooks.effects.forEach(effect => { effect.cleanup?.(); effect.cleanup = undefined })
  }
  return { props, controller, render, unmount }
}
afterEach(() => {
  hooks.effects.forEach(effect => effect.cleanup?.())
  hooks.effects = []
  hooks.refs = []
  hooks.pending = []
  hooks.frames = []
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('commits a gizmo drag when its previous save echoes during the gesture', async () => {
  const doc: SceneDoc = { version: 1, rev: 1, views: [], objects: [{
    id: 'box', name: 'Box', createdBy: 'agent', userTouched: false, hidden: false,
    transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
    source: { type: 'primitive', shape: 'box', size: [1, 1, 1] },
  }] }
  const { props, controller, render } = mount(doc)
  await vi.waitFor(() => expect(controller.getSnapshot().status).toBe('ready'))
  const transform = controls.transform!
  const dragged = transform.object!
  transform.emit('mouseDown')
  transform.dragging = true
  transform.emit('dragging-changed', true)
  dragged.position.x = 2
  render({ doc: { ...doc, objects: [{ ...doc.objects[0]!, userTouched: true }] } })
  await new Promise(resolve => setTimeout(resolve, 0))
  transform.emit('mouseUp')
  transform.dragging = false
  transform.emit('dragging-changed', false)
  expect(props.onTransform).toHaveBeenCalledExactlyOnceWith('box', { ...doc.objects[0]!.transform, position: [2, 0, 0] })
})

it('rebuilds a dragged object when the document did not take the drag', async () => {
  const doc: SceneDoc = { version: 1, rev: 1, views: [], objects: [{
    id: 'box', name: 'Box', createdBy: 'agent', userTouched: false, hidden: false,
    transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
    source: { type: 'primitive', shape: 'box', size: [1, 1, 1] },
  }] }
  const { controller, render } = mount(doc)
  await vi.waitFor(() => expect(controller.getSnapshot().status).toBe('ready'))
  const transform = controls.transform!
  const dragged = transform.object!
  transform.emit('mouseDown')
  dragged.position.x = 2
  transform.emit('mouseUp')
  render({ doc: { ...doc, rev: 2 } })
  await vi.waitFor(() => expect(transform.object).not.toBe(dragged))
  expect(transform.object!.position.x).toBe(0)
})

it('rebuilds the previous stage when undo recovers from an invalid descriptor', async () => {
  const doc: SceneDoc = { version: 1, rev: 1, views: [], objects: [] }
  const { controller, render } = mount(doc)
  await vi.waitFor(() => expect(controller.getSnapshot().status).toBe('ready'))
  render({ doc: { ...doc, objects: [{
    id: 'bad', name: 'Bad prop', createdBy: 'user', userTouched: true, hidden: false,
    transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
    source: { type: 'prop', propId: 'missing' },
  }] } })
  await vi.waitFor(() => expect(controller.getSnapshot().status).toBe('error'))
  render({ doc })
  await vi.waitFor(() => expect(controller.getSnapshot().status).toBe('ready'))
})

const figureDoc = (): SceneDoc => ({ version: 1, rev: 1, views: [], objects: [{
  id: 'box', name: 'Figure', createdBy: 'agent', userTouched: false, hidden: false,
  transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
  source: { type: 'figure', bodyId: 'human', heightM: 1.8, pose: {} },
}] })

it('applies sampled motion to the existing stage without rebuilding geometry on each frame', async () => {
  const doc = figureDoc()
  doc.durationS = 2
  const object = doc.objects[0]!
  object.tracks = {
    transform: [{ t: 0, value: object.transform, ease: 'linear' }, { t: 2, value: { ...object.transform, position: [4, 0, 0] }, ease: 'linear' }],
    pose: { leftElbow: [{ t: 0, value: [0, 0, 0, 1], ease: 'linear' }, { t: 2, value: jointQuaternion([-0.8, 0, 0]), ease: 'linear' }] },
    hidden: [{ t: 0, value: false }, { t: 2, value: true }],
  }
  const { controller, render } = mount(sampleScene(doc, 0))
  await vi.waitFor(() => expect(controller.getSnapshot().status).toBe('ready'))
  const figure = controls.transform.object as Object3D
  const elbow = figure.getObjectByName('leftElbow')!
  render({ doc: sampleScene(doc, 1) })
  expect(controls.transform.object).toBe(figure)
  expect(figure.position.x).toBe(2)
  expect(jointEuler(elbow.quaternion.toArray())[0]).toBeCloseTo(-0.4)
  render({ doc: sampleScene(doc, 2) })
  expect(figure.visible).toBe(false)
  expect(controls.transform.object).toBeUndefined()
})

it('keeps a joint drag attached through a save echo, clamps each sample and commits a local rotation once', async () => {
  const doc = figureDoc()
  const { props, controller, render } = mount(doc)
  await vi.waitFor(() => expect(controller.getSnapshot().status).toBe('ready'))
  controller.selectJoint('leftElbow')
  const transform = controls.transform!
  const joint = transform.object!
  expect(joint.name).toBe('leftElbow')
  expect(transform.space).toBe('local')
  transform.emit('mouseDown')
  transform.dragging = true
  transform.emit('dragging-changed', true)
  joint.quaternion.fromArray(jointQuaternion([1, 0.4, 0.5]))
  transform.emit('objectChange')
  expect(jointEuler(joint.quaternion.toArray())[0]).toBeCloseTo(0)
  expect(jointEuler(joint.quaternion.toArray())[2]).toBeCloseTo(0)
  expect(props.onJointRotation).not.toHaveBeenCalled()
  const echo = { ...doc, objects: [{ ...doc.objects[0]!, userTouched: true }] }
  render({ doc: echo })
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(transform.object).toBe(joint)
  expect(controller.getSnapshot().dragging).toBe(true)
  const expected = jointQuaternion([-0.8, 0.2, 0])
  joint.quaternion.fromArray(expected)
  transform.emit('objectChange')
  transform.emit('mouseUp')
  transform.dragging = false
  transform.emit('dragging-changed', false)
  expect(props.onJointRotation).toHaveBeenCalledOnce()
  const args = vi.mocked(props.onJointRotation).mock.calls[0]!
  expect(args.slice(0, 2)).toEqual(['box', 'leftElbow'])
  expect(new Quaternion(...args[2]).angleTo(new Quaternion(...expected))).toBeCloseTo(0)
  expect(props.onTransform).not.toHaveBeenCalled()
  render({ doc: { ...echo, rev: 2 } })
  await vi.waitFor(() => expect(transform.object).not.toBe(joint))
  expect(transform.object!.quaternion.toArray()).toEqual([0, 0, 0, 1])
})

it('keeps move and scale on the whole figure and cancels an unfinished joint drag when leaving selection', async () => {
  const { controller } = mount(figureDoc())
  await vi.waitFor(() => expect(controller.getSnapshot().status).toBe('ready'))
  const transform = controls.transform!
  const figure = transform.object
  controller.selectJoint('leftShoulder')
  const joint = transform.object
  expect(joint).not.toBe(figure)
  controller.setTool('translate')
  expect(transform.object).toBe(figure)
  expect(transform.space).toBe('world')
  controller.setTool('scale')
  expect(transform.object).toBe(figure)
  controller.setTool('rotate')
  expect(transform.object).toBe(joint)
  transform.emit('mouseDown')
  transform.dragging = true
  transform.emit('dragging-changed', true)
  joint.quaternion.fromArray(jointQuaternion([0.4, 0.2, 0.1]))
  transform.emit('objectChange')
  controller.selectJoint(null)
  expect(transform.object).toBe(figure)
  expect(joint.quaternion.toArray()).toEqual([0, 0, 0, 1])
})

it('records one undo entry for a joint gesture with many clamped samples', async () => {
  const doc = figureDoc()
  const commit = vi.fn(async () => 'ok' as const)
  const draft = createSceneDraft({
    node: { nodeId: 'scene', kind: 'scene', x: 0, y: 0, w: 360, h: 280, z: 1, layoutRevision: 1,
      slots: [{ slotId: 'main', slotKey: 'main', contentType: 'scene', revision: 1, content: { type: 'scene', doc } }] },
    commit,
  })
  const { controller, render } = mount(doc)
  render({
    onBeginEdit: () => draft.getSnapshot().beginEdit(),
    onJointRotation: (id, jointId, rotation: Quat) => {
      const latest = draft.getSnapshot()
      latest.edit({ ...latest.doc, objects: latest.doc.objects.map(object => object.id === id && object.source.type === 'figure'
        ? { ...object, source: { ...object.source, pose: { ...object.source.pose, [jointId]: rotation } } } : object) }, true)
    },
  })
  await vi.waitFor(() => expect(controller.getSnapshot().status).toBe('ready'))
  controller.selectJoint(HUMAN_BODY.joints.find(joint => joint.id === 'leftKnee')!.id)
  const transform = controls.transform!
  transform.emit('mouseDown')
  for (const angle of [-1, 0.4, 1, 2, 2.9]) {
    transform.object.quaternion.fromArray(jointQuaternion([angle, 0, 0]))
    transform.emit('objectChange')
  }
  expect(draft.getSnapshot().canUndo).toBe(false)
  expect(commit).not.toHaveBeenCalled()
  transform.emit('mouseUp')
  await draft.getSnapshot().flush()
  expect(commit).toHaveBeenCalledOnce()
  expect(draft.getSnapshot().canUndo).toBe(true)
  expect(draft.getSnapshot().doc.objects[0]!.source).toMatchObject({ pose: { leftKnee: expect.any(Array) } })
  draft.getSnapshot().undo()
  await draft.getSnapshot().flush()
  expect(draft.getSnapshot().canUndo).toBe(false)
  expect(draft.getSnapshot().doc.objects[0]!.source).toMatchObject({ pose: {} })
  draft.dispose()
})

it('selects the closest joint ancestor when clicking a figure part', async () => {
  const { controller } = mount(figureDoc())
  await vi.waitFor(() => expect(controller.getSnapshot().status).toBe('ready'))
  controller.setTool('rotate')
  const hand = controls.transform.object.getObjectByName('leftWrist').children[0].children[0] as Object3D
  vi.spyOn(Raycaster.prototype, 'intersectObjects').mockReturnValueOnce([]).mockReturnValueOnce([{ object: hand, distance: 1, point: new Vector3() }])
  const target = hooks.element as EventTarget
  target.dispatchEvent(Object.assign(new Event('pointerdown'), { button: 0, clientX: 320, clientY: 180 }))
  target.dispatchEvent(Object.assign(new Event('pointerup'), { button: 0, clientX: 320, clientY: 180 }))
  expect(controller.getSnapshot().selectedJointId).toBe('leftWrist')
})

it('leaves a joint click without rotation out of undo history', async () => {
  const { props, controller } = mount(figureDoc())
  await vi.waitFor(() => expect(controller.getSnapshot().status).toBe('ready'))
  controller.selectJoint('rightShoulder')
  const transform = controls.transform!
  transform.emit('mouseDown')
  transform.emit('mouseUp')
  expect(props.onJointRotation).not.toHaveBeenCalled()
})

it('cancels a gizmo grab overtaken by a field commit without overwriting the typed pose or another target', async () => {
  const doc = figureDoc()
  const { props, controller, render } = mount(doc)
  await vi.waitFor(() => expect(controller.getSnapshot().status).toBe('ready'))
  controller.selectJoint('leftElbow')
  const transform = controls.transform!
  const oldJoint = transform.object!
  transform.emit('mouseDown')
  transform.dragging = true
  transform.emit('dragging-changed', true)
  oldJoint.quaternion.fromArray(jointQuaternion([-0.4, 0, 0]))
  transform.emit('objectChange')
  const typed = jointQuaternion([-1.1, 0, 0])
  const object = doc.objects[0]!
  if (object.source.type !== 'figure') throw new Error('Expected a figure')
  render({ doc: { ...doc, rev: 2, objects: [{ ...object, source: { ...object.source, pose: { leftElbow: typed } } }] } })
  expect(controller.getSnapshot().dragging).toBe(false)
  await vi.waitFor(() => expect(transform.object).not.toBe(oldJoint))
  const newJoint = transform.object!
  expect(new Quaternion(...typed).angleTo(newJoint.quaternion)).toBeCloseTo(0)
  controller.selectJoint(null)
  expect(new Quaternion(...typed).angleTo(newJoint.quaternion)).toBeCloseTo(0)
  expect(transform.object!.position.toArray()).toEqual([0, 0, 0])
  transform.emit('mouseUp')
  expect(props.onJointRotation).not.toHaveBeenCalled()
  expect(props.onTransform).not.toHaveBeenCalled()
})

it.each(['translate', 'scale'] as const)('keeps %s on the figure after a plain click on a body part', async tool => {
  const { controller } = mount(figureDoc())
  await vi.waitFor(() => expect(controller.getSnapshot().status).toBe('ready'))
  controller.setTool(tool)
  const figure = controls.transform.object!
  const hand = figure.getObjectByName('leftWrist')!.children[0]!.children[0]!
  vi.spyOn(Raycaster.prototype, 'intersectObjects').mockReturnValueOnce([]).mockReturnValueOnce([{ object: hand, distance: 1, point: new Vector3() }])
  const target = hooks.element as EventTarget
  target.dispatchEvent(Object.assign(new Event('pointerdown'), { button: 0, clientX: 320, clientY: 180 }))
  target.dispatchEvent(Object.assign(new Event('pointerup'), { button: 0, clientX: 320, clientY: 180 }))
  expect(controller.getSnapshot()).toMatchObject({ selectedId: 'box', selectedJointId: null, tool })
  expect(controls.transform.object).toBe(figure)
})

it('switches from Move to Rotate when a joint marker is selected explicitly', async () => {
  const { controller } = mount(figureDoc())
  await vi.waitFor(() => expect(controller.getSnapshot().status).toBe('ready'))
  const helpers = controls.transform.helper.parent as Object3D
  const marker = helpers.children.flatMap(child => child.children).find(child => child.userData.jointId === 'leftElbow')!
  vi.spyOn(Raycaster.prototype, 'intersectObjects').mockReturnValueOnce([{ object: marker, distance: 1, point: new Vector3() }])
  const target = hooks.element as EventTarget
  target.dispatchEvent(Object.assign(new Event('pointerdown'), { button: 0, clientX: 320, clientY: 180 }))
  target.dispatchEvent(Object.assign(new Event('pointerup'), { button: 0, clientX: 320, clientY: 180 }))
  expect(controller.getSnapshot()).toMatchObject({ selectedId: 'box', selectedJointId: 'leftElbow', tool: 'rotate' })
})

it('selects a joint marker that lies under the gizmo, but a gizmo click on bare space keeps the selection', async () => {
  const { controller } = mount(figureDoc())
  await vi.waitFor(() => expect(controller.getSnapshot().status).toBe('ready'))
  controller.selectJoint('leftHip')
  const helpers = controls.transform.helper.parent as Object3D
  const marker = helpers.children.flatMap(child => child.children).find(child => child.userData.jointId === 'leftKnee')!
  const target = hooks.element as EventTarget
  const click = () => {
    target.dispatchEvent(Object.assign(new Event('pointerdown'), { button: 0, clientX: 320, clientY: 180 }))
    target.dispatchEvent(Object.assign(new Event('pointerup'), { button: 0, clientX: 320, clientY: 180 }))
  }
  controls.transform.axis = 'X'
  vi.spyOn(Raycaster.prototype, 'intersectObjects').mockReturnValueOnce([{ object: marker, distance: 1, point: new Vector3() }])
  click()
  expect(controller.getSnapshot()).toMatchObject({ selectedId: 'box', selectedJointId: 'leftKnee', tool: 'rotate' })
  vi.spyOn(Raycaster.prototype, 'intersectObjects').mockReturnValue([])
  click()
  expect(controller.getSnapshot()).toMatchObject({ selectedId: 'box', selectedJointId: 'leftKnee' })
})

it('skips joint world-matrix traversal on frames without a selected figure', async () => {
  const { controller } = mount({ version: 1, rev: 0, views: [], objects: [{
    ...figureDoc().objects[0]!, source: { type: 'primitive', shape: 'box', size: [1, 1, 1] },
  }] })
  await vi.waitFor(() => expect(controller.getSnapshot().status).toBe('ready'))
  const scene = controls.transform.object.parent as Object3D
  const matrices = vi.spyOn(scene, 'updateMatrixWorld')
  hooks.frames[0]!(0)
  expect(matrices).not.toHaveBeenCalled()
})

it('shares marker geometry and two materials across selections and disposes each once on unmount', async () => {
  const { controller, unmount } = mount(figureDoc())
  await vi.waitFor(() => expect(controller.getSnapshot().status).toBe('ready'))
  const helpers = controls.transform.helper.parent as Object3D
  const group = helpers.children.find(child => child.children.some(marker => marker.userData.jointId))!
  const markers = group.children as Mesh[]
  const geometry = markers[0]!.geometry
  const material = markers[0]!.material
  expect(markers.every(marker => marker.geometry === geometry && marker.material === material)).toBe(true)
  const geometryDisposed = vi.spyOn(geometry, 'dispose')
  const materialDisposed = vi.spyOn(material as MeshBasicMaterial, 'dispose')
  controller.selectJoint('leftElbow')
  const selectedMaterial = (markers.find(marker => marker.userData.jointId === 'leftElbow') as Mesh).material as MeshBasicMaterial
  expect(selectedMaterial).not.toBe(material)
  const selectedDisposed = vi.spyOn(selectedMaterial, 'dispose')
  controller.select(null)
  expect(geometryDisposed).not.toHaveBeenCalled()
  expect(materialDisposed).not.toHaveBeenCalled()
  expect(selectedDisposed).not.toHaveBeenCalled()
  controller.select('box')
  expect(group.children.every(marker => (marker as Mesh).geometry === geometry)).toBe(true)
  unmount()
  expect(geometryDisposed).toHaveBeenCalledOnce()
  expect(materialDisposed).toHaveBeenCalledOnce()
  expect(selectedDisposed).toHaveBeenCalledOnce()
})

it('applies a placement-only change in place and keeps the gizmo attached', async () => {
  const doc = figureDoc()
  const { controller, render } = mount(doc)
  await vi.waitFor(() => expect(controller.getSnapshot().status).toBe('ready'))
  const transform = controls.transform!
  const figure = transform.object!
  const moved = { position: [0.5, 0, -0.25], rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2], scale: [1.05, 1.05, 1.05] } as const
  render({ doc: { ...doc, rev: 2, objects: [{ ...doc.objects[0]!, userTouched: true, transform: { position: [...moved.position], rotation: [...moved.rotation], scale: [...moved.scale] } }] } })
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(transform.object).toBe(figure)
  expect(figure.position.toArray()).toEqual([0.5, 0, -0.25])
  expect(figure.scale.toArray()).toEqual([1.05, 1.05, 1.05])
  expect(figure.quaternion.angleTo(new Quaternion(0, Math.SQRT1_2, 0, Math.SQRT1_2))).toBeCloseTo(0)
  expect(figure.matrixWorld.elements[12]).toBe(0.5)
  expect(controller.getSnapshot()).toMatchObject({ status: 'ready', dragging: false })
})

it('applies a pose-only change to the joint in place and keeps the joint gizmo attached', async () => {
  const doc = figureDoc()
  const { controller, render } = mount(doc)
  await vi.waitFor(() => expect(controller.getSnapshot().status).toBe('ready'))
  controller.selectJoint('leftKnee')
  const transform = controls.transform!
  const knee = transform.object!
  expect(knee.name).toBe('leftKnee')
  const bent = jointQuaternion([0.5, 0, 0])
  const object = doc.objects[0]!
  if (object.source.type !== 'figure') throw new Error('Expected a figure')
  render({ doc: { ...doc, rev: 2, objects: [{ ...object, source: { ...object.source, pose: { leftKnee: bent } } }] } })
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(transform.object).toBe(knee)
  expect(new Quaternion(...bent).angleTo(knee.quaternion)).toBeCloseTo(0)
  // Undoing back to the empty pose returns the knee to the standing rotation, as a rebuild would.
  render({ doc: { ...doc, rev: 3 } })
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(transform.object).toBe(knee)
  expect(knee.quaternion.toArray()).toEqual([0, 0, 0, 1])
})

it('still rebuilds when anything besides placement or pose changes', async () => {
  const doc = figureDoc()
  const { controller, render } = mount(doc)
  await vi.waitFor(() => expect(controller.getSnapshot().status).toBe('ready'))
  const transform = controls.transform!
  const figure = transform.object!
  const object = doc.objects[0]!
  if (object.source.type !== 'figure') throw new Error('Expected a figure')
  render({ doc: { ...doc, rev: 2, objects: [{ ...object, transform: { ...object.transform, position: [1, 0, 0] }, source: { ...object.source, heightM: 1.5 } }] } })
  await vi.waitFor(() => expect(transform.object).not.toBe(figure))
  expect(transform.object!.position.toArray()).toEqual([1, 0, 0])
})

it.each(['translate', 'rotate'] as const)('keeps the selection and %s tool when a small gizmo drag that committed ends over a joint marker', async tool => {
  const { props, controller } = mount(figureDoc())
  await vi.waitFor(() => expect(controller.getSnapshot().status).toBe('ready'))
  if (tool === 'rotate') controller.selectJoint('leftHip')
  const transform = controls.transform!
  const helpers = transform.helper.parent as Object3D
  const marker = helpers.children.flatMap(child => child.children).find(child => child.userData.jointId === 'leftKnee')!
  const target = hooks.element as EventTarget
  transform.axis = 'X'
  target.dispatchEvent(Object.assign(new Event('pointerdown'), { button: 0, clientX: 320, clientY: 180 }))
  transform.emit('mouseDown')
  if (tool === 'rotate') transform.object.quaternion.fromArray(jointQuaternion([-0.05, 0, 0]))
  else transform.object.position.x = 0.02
  // TransformControls registers its pointerup first, so its mouseUp commits before the viewport sees the release.
  transform.emit('mouseUp')
  vi.spyOn(Raycaster.prototype, 'intersectObjects').mockReturnValue([{ object: marker, distance: 1, point: new Vector3() }])
  target.dispatchEvent(Object.assign(new Event('pointerup'), { button: 0, clientX: 322, clientY: 181 }))
  expect(tool === 'rotate' ? props.onJointRotation : props.onTransform).toHaveBeenCalledOnce()
  expect(controller.getSnapshot()).toMatchObject({ selectedId: 'box', selectedJointId: tool === 'rotate' ? 'leftHip' : null, tool })
})
