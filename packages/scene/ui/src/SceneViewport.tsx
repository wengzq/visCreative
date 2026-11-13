import type { Quat, SceneDoc, SceneTransform, SceneView } from '@vis/protocol'
import { applyBodyPose, applySceneTransform, buildScene, BUILTIN_BODIES, clampJointRotation, createSceneCamera, DEFAULT_SCENE_CAMERA, disposeScene, type BuiltScene } from '@vis/scene-core'
import { useMessages } from '@vis/ui-kit'
import { useEffect, useRef } from 'react'
import {
  Box3, Color, GridHelper, Group, HalfFloatType, Mesh, MeshBasicMaterial, MeshStandardMaterial, Object3D, Quaternion, Raycaster,
  Scene, SphereGeometry, SRGBColorSpace, Vector2, Vector3, Vector4, WebGLRenderer, WebGLRenderTarget,
} from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { TransformControls } from 'three/addons/controls/TransformControls.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { createProposalOutlines } from './proposal-outlines'
import { sceneMessages } from './messages'
import { loadSceneModel } from './model-loader'
import type { SceneViewportController } from './types'
import { cameraViewport, captureDimensions, isSoftwareRenderer } from './viewport-math'
import { useSceneViewportState, viewportBinding } from './viewport-state'

export type SceneViewportProps = {
  controller: SceneViewportController
  doc: SceneDoc
  assetUrl(id: string): string
  outlinedIds?: readonly string[] | undefined
  disabled?: boolean
  onBeginEdit?(): void
  onTransform(id: string, transform: SceneTransform): void
  onJointRotation(id: string, jointId: string, rotation: Quat): void
  onCameraChange(viewId: string, camera: SceneView['camera']): void
}

// Everything that shapes the stage except placement and pose, which can change in place without a rebuild.
// Placement, visibility, poses and motion keys change without new geometry; playback samples them every frame.
const structure = (objects: SceneDoc['objects']) => JSON.stringify(objects.map(({ id, source }) =>
  ({ id, source: source.type === 'figure' ? { ...source, pose: {} } : source })))
const readTransform = (object: Object3D): SceneTransform => ({
  position: object.position.toArray(), rotation: object.quaternion.toArray(), scale: object.scale.toArray(),
})
function cloneModel(template: Object3D): Object3D {
  const result = template.clone(true)
  result.traverse(object => {
    const mesh = object as Mesh
    if (mesh.geometry) mesh.geometry = mesh.geometry.clone()
    // The builder owns its resources. Imported textures remain only on the cached template.
    if (mesh.material) mesh.material = Array.isArray(mesh.material) ? mesh.material.map(() => new MeshStandardMaterial()) : new MeshStandardMaterial()
  })
  return result
}

export function SceneViewport(props: SceneViewportProps) {
  const m = useMessages(sceneMessages)
  const state = useSceneViewportState(props.controller)
  const container = useRef<HTMLDivElement>(null)
  const latest = useRef(props)
  latest.current = props
  const runtime = useRef<{ updateDoc(doc: SceneDoc): void; updateInteraction(): void; retryModels(): void } | null>(null)

  useEffect(() => {
    const element = container.current!
    const controller = props.controller
    const binding = viewportBinding(controller)
    let renderer: WebGLRenderer
    try {
      renderer = new WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
    } catch {
      binding.update({ status: 'unavailable', dragging: false })
      return
    }
    renderer.outputColorSpace = SRGBColorSpace
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    element.append(renderer.domElement)
    const interaction = document.createElement('div')
    interaction.className = 'vis-sc-interaction'
    element.append(interaction)
    const gl = renderer.getContext()
    const debug = gl.getExtension('WEBGL_debug_renderer_info')
    const rendererName = String(gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER))
    binding.update({ softwareRenderer: isSoftwareRenderer(rendererName), status: 'loading', error: null })

    let dead = false
    let contextLost = false
    let buildVersion = 0
    let frame = 0
    let built: BuiltScene | null = null
    let doc = latest.current.doc
    // The structure of the document the current stage was built from, kept beside `built` so updates compare one side.
    let builtStructure = ''
    let width = 1
    let height = 1
    let viewSignature = ''
    let buildSignature = ''
    let rebuilding = false
    const helpers = new Scene()
    const grid = new GridHelper(100, 100)
    helpers.add(grid)
    const outlines = createProposalOutlines(helpers, () => new Color(getComputedStyle(element).getPropertyValue('--vis-accent').trim()))
    const jointHelpers = new Group()
    helpers.add(jointHelpers)
    const jointGeometry = new SphereGeometry(1, 10, 8)
    const jointMaterial = new MeshBasicMaterial({ depthTest: false, depthWrite: false })
    const selectedJointMaterial = new MeshBasicMaterial({ depthTest: false, depthWrite: false })
    let helperJoints: ReadonlyMap<string, Group> | undefined
    const orbitCamera = createSceneCamera()
    let camera = orbitCamera
    const orbit = new OrbitControls(camera, interaction)
    orbit.target.fromArray(DEFAULT_SCENE_CAMERA.target)
    orbit.enableDamping = false
    orbit.update()
    const transform = new TransformControls(camera, interaction)
    helpers.add(transform.getHelper())
    const raycaster = new Raycaster()
    const cache = new Map<string, Promise<Object3D>>()
    const modelAbort = new AbortController()
    const captures = new Set<WebGLRenderTarget>()
    let dragStart: { id: string; jointId: string | null; object: Object3D; transform: SceneTransform } | null = null
    let navigationStart = ''
    let pointerStart: { x: number; y: number; gizmo: boolean } | null = null
    // Whether the gizmo gesture begun by the current press wrote a change.
    let gestureCommitted = false
    let captureInFlight = false
    let background = new Color()

    const viewport = () => controller.getSnapshot().mode === 'camera' ? cameraViewport(width, height, camera.aspect) : { x: 0, y: 0, width, height }
    const syncJoints = () => {
      const state = controller.getSnapshot()
      const joints = state.selectedId && built?.objects.get(state.selectedId)?.visible ? built.joints.get(state.selectedId) : undefined
      if (joints !== helperJoints) {
        jointHelpers.clear()
        helperJoints = joints
        for (const [id] of joints ?? []) {
          const marker = new Mesh(jointGeometry, jointMaterial)
          marker.userData.jointId = id
          marker.renderOrder = 10
          jointHelpers.add(marker)
        }
      }
      if (!jointHelpers.children.length) return
      built?.scene.updateMatrixWorld(true)
      for (const child of jointHelpers.children) {
        const marker = child as Mesh<SphereGeometry, MeshBasicMaterial>
        const id = marker.userData.jointId as string
        helperJoints?.get(id)?.getWorldPosition(marker.position)
        marker.scale.setScalar(Math.max(0.012, camera.position.distanceTo(marker.position) * (id === state.selectedJointId ? 0.009 : 0.006)))
        marker.material = id === state.selectedJointId ? selectedJointMaterial : jointMaterial
      }
      jointHelpers.updateMatrixWorld(true)
    }
    const draw = () => {
      frame = 0
      if (dead || contextLost || !built) return
      syncJoints()
      outlines.update(latest.current.outlinedIds ?? [], built.objects)
      const rect = viewport()
      renderer.setRenderTarget(null)
      renderer.setViewport(0, 0, width, height)
      renderer.setScissorTest(false)
      renderer.setClearColor(background)
      renderer.clear()
      renderer.setViewport(rect.x, rect.y, rect.width, rect.height)
      renderer.setScissor(rect.x, rect.y, rect.width, rect.height)
      renderer.setScissorTest(true)
      renderer.autoClear = true
      renderer.render(built.scene, camera)
      renderer.autoClear = false
      renderer.render(helpers, camera)
      renderer.autoClear = true
      renderer.setScissorTest(false)
    }
    const invalidate = () => {
      if (!dead && !contextLost && !frame) frame = requestAnimationFrame(draw)
    }
    const cancelTransform = () => {
      const start = dragStart
      dragStart = null
      if (start) applySceneTransform(start.object, start.transform)
      pointerStart = null
      transform.dragging = false
      binding.update({ dragging: false })
      invalidate()
    }
    const placeInteraction = () => {
      const rect = viewport()
      Object.assign(interaction.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` })
      interaction.classList.toggle('is-camera', controller.getSnapshot().mode === 'camera')
    }
    const updateOrbitAspect = () => {
      const lens = orbitCamera.getFocalLength()
      orbitCamera.aspect = width / height
      orbitCamera.filmGauge = 36 / Math.min(orbitCamera.aspect, 1)
      orbitCamera.setFocalLength(lens)
    }
    const orientCamera = () => {
      if (camera === orbitCamera) return
      const view = doc.views.find(view => view.id === controller.getSnapshot().viewId)
      camera.lookAt(orbit.target)
      camera.rotateZ(view?.camera.roll ?? 0)
      camera.updateMatrixWorld()
    }
    const applyState = () => {
      if (dead) return
      const state = controller.getSnapshot()
      const view = doc.views.find(view => view.id === state.viewId)
      const signature = state.mode === 'camera' && view ? JSON.stringify(view) : 'orbit'
      if (signature !== viewSignature) {
        viewSignature = signature
        camera = state.mode === 'camera' && view ? createSceneCamera(view) : orbitCamera
        if (camera === orbitCamera) {
          updateOrbitAspect()
          orbit.target.copy(orbitCamera.userData.orbitTarget as Vector3 ?? new Vector3(...DEFAULT_SCENE_CAMERA.target))
        } else {
          orbit.target.fromArray(view!.camera.target)
        }
        orbit.object = camera
        transform.camera = camera
        orbit.update()
        orientCamera()
      }
      const object = state.selectedId ? built?.objects.get(state.selectedId) : null
      const joint = state.selectedId && state.selectedJointId && state.tool === 'rotate' ? built?.joints.get(state.selectedId)?.get(state.selectedJointId) : null
      const target = joint ?? object
      if (dragStart && (latest.current.disabled || rebuilding || dragStart.object !== target)) cancelTransform()
      transform.setMode(state.tool)
      transform.setSpace(joint ? 'local' : 'world')
      transform.enabled = !latest.current.disabled && !contextLost && !rebuilding
      if (target && object?.visible && transform.enabled) {
        if (transform.object !== target) transform.attach(target)
      } else transform.detach()
      orbit.enabled = !transform.dragging && !contextLost
      syncJoints()
      placeInteraction()
      invalidate()
    }
    const resize = () => {
      width = Math.max(1, element.clientWidth)
      height = Math.max(1, element.clientHeight)
      renderer.setSize(width, height)
      updateOrbitAspect()
      placeInteraction()
      invalidate()
    }
    const theme = () => {
      const style = getComputedStyle(element)
      background = new Color(style.getPropertyValue('--vis-bg').trim())
      jointMaterial.color.set(style.getPropertyValue('--vis-accent').trim())
      selectedJointMaterial.color.set(style.getPropertyValue('--vis-warn').trim())
      if (built) built.scene.background = background.clone()
      transform.setColors(
        style.getPropertyValue('--vis-danger').trim(), style.getPropertyValue('--vis-ok').trim(),
        style.getPropertyValue('--vis-accent').trim(), style.getPropertyValue('--vis-warn').trim(),
      )
      const colours = [style.getPropertyValue('--vis-text-faint').trim(), style.getPropertyValue('--vis-panel-border').trim()]
      const attribute = grid.geometry.getAttribute('color')
      const major = new Color(colours[0]!)
      const minor = new Color(colours[1]!)
      for (let index = 0; index < attribute.count; index++) {
        const original = grid.geometry.userData.majorIndices as Set<number> | undefined
        const colour = original?.has(index) ? major : minor
        attribute.setXYZ(index, colour.r, colour.g, colour.b)
      }
      attribute.needsUpdate = true
      invalidate()
    }
    const gridColours = grid.geometry.getAttribute('color')
    const majorIndices = new Set<number>()
    for (let index = 0; index < gridColours.count; index++) if (gridColours.getX(index) === gridColours.getX(200)) majorIndices.add(index)
    grid.geometry.userData.majorIndices = majorIndices

    const loadModel = async (id: string) => {
      let pending = cache.get(id)
      if (!pending) {
        pending = loadSceneModel(id, value => latest.current.assetUrl(value), modelAbort.signal)
        // A failure stays cached until Retry, so each edit does not refetch a missing model once per object.
        cache.set(id, pending)
      }
      const template = await pending
      if (dead) throw new Error('The scene viewport has closed')
      return cloneModel(template)
    }
    const updateDoc = (next: SceneDoc) => {
      doc = next
      // Save echoes stamp protection metadata and stills without changing the rendered stage.
      const signature = JSON.stringify({
        objects: doc.objects.map(({ createdBy, userTouched, ...object }) => object),
      })
      const shape = structure(doc.objects)
      const state = controller.getSnapshot()
      if (!doc.objects.some(object => object.id === state.selectedId)) controller.select(null)
      if (!doc.views.some(view => view.id === state.viewId)) controller.setView(doc.views[0]?.id ?? null)
      if (!doc.views.length && controller.getSnapshot().mode === 'camera') controller.setMode('orbit')
      if (built && signature === buildSignature && state.status === 'ready') { buildVersion++; rebuilding = false; applyState(); return }
      // A held arrow key changes placement about 30 times a second. A gizmo grab, a forced rebuild or one in flight
      // keeps the rebuild path, so cancelling and resynchronising behave as before.
      if (built && state.status === 'ready' && !rebuilding && !dragStart && buildSignature && shape === builtStructure) {
        // Every placement and pose is set the way buildScene sets it, so the stage matches a rebuild even after a stray gizmo sample.
        for (const object of doc.objects) {
          applySceneTransform(built.objects.get(object.id)!, object.transform)
          built.objects.get(object.id)!.visible = !object.hidden
          const source = object.source
          const body = source.type === 'figure' ? BUILTIN_BODIES.find(body => body.id === source.bodyId) : undefined
          const joints = built.joints.get(object.id)
          if (source.type === 'figure' && body && joints) applyBodyPose(joints, body, source.pose)
        }
        built.scene.updateMatrixWorld(true)
        buildSignature = signature
        buildVersion++
        applyState()
        return
      }
      const version = ++buildVersion
      rebuilding = true
      cancelTransform()
      transform.detach()
      void buildScene(doc, null, { loadModel }).then(next => {
        if (dead || version !== buildVersion) { disposeScene(next.scene); return }
        cancelTransform()
        transform.detach()
        if (built) disposeScene(built.scene)
        built = next
        builtStructure = shape
        buildSignature = signature
        rebuilding = false
        next.scene.background = background.clone()
        binding.update({ status: 'ready', error: null, failedModels: next.failedModels.size })
        applyState()
      }).catch(error => {
        if (!dead && version === buildVersion) {
          rebuilding = false
          binding.update({ status: 'error', error })
        }
      })
      applyState()
    }
    const retryModels = () => {
      for (const id of built?.failedModels ?? []) cache.delete(id)
      buildSignature = ''
      updateDoc(doc)
    }
    const readCamera = (): SceneView['camera'] => ({
      position: camera.position.toArray(),
      target: orbit.target.toArray(),
      roll: controller.getSnapshot().mode === 'camera' ? doc.views.find(view => view.id === controller.getSnapshot().viewId)?.camera.roll ?? 0 : 0,
      focalLengthMm: camera.getFocalLength(),
    })
    const captureView = async (viewId: string): Promise<Blob> => {
      if (dead || contextLost || captureInFlight || controller.getSnapshot().status !== 'ready' || !built) throw new Error('The scene viewport is not ready')
      captureInFlight = true
      let capture: BuiltScene | null = null
      try {
        const capturedDoc = latest.current.doc
        const view = capturedDoc.views.find(view => view.id === viewId)
        if (!view) throw new Error('The scene view no longer exists')
        // Build from the current draft, even when an older viewport build is still awaiting a model.
        capture = await buildScene(capturedDoc, viewId, { loadModel })
        if (dead || contextLost) throw new Error('The scene viewport is not available')
        const size = captureDimensions(view.aspectRatio)
        const target = new WebGLRenderTarget(size.width, size.height, { depthBuffer: false })
        // Keep linear lighting in floating point until the final sRGB conversion, avoiding dark-band quantization.
        const linear = new WebGLRenderTarget(size.width, size.height, { type: HalfFloatType, depthBuffer: true })
        const output = new OutputPass()
        captures.add(target)
        captures.add(linear)
        const pixels = new Uint8Array(size.width * size.height * 4)
        const previousTarget = renderer.getRenderTarget()
        const previousViewport = renderer.getViewport(new Vector4())
        const previousScissor = renderer.getScissor(new Vector4())
        const previousScissorTest = renderer.getScissorTest()
        const previousAutoClear = renderer.autoClear
        try {
          renderer.setRenderTarget(linear)
          renderer.setViewport(0, 0, size.width, size.height)
          renderer.setScissorTest(false)
          renderer.autoClear = true
          renderer.render(capture.scene, capture.camera)
          output.render(renderer, target, linear, 0, false)
          // A synchronous read keeps the single renderer's state atomic with respect to viewport draws.
          renderer.readRenderTargetPixels(target, 0, 0, size.width, size.height, pixels)
        } finally {
          renderer.setRenderTarget(previousTarget)
          renderer.setViewport(previousViewport)
          renderer.setScissor(previousScissor)
          renderer.setScissorTest(previousScissorTest)
          renderer.autoClear = previousAutoClear
          target.dispose()
          linear.dispose()
          output.dispose()
          captures.delete(target)
          captures.delete(linear)
          disposeScene(capture.scene)
          capture = null
          invalidate()
        }
        const canvas = document.createElement('canvas')
        canvas.width = size.width
        canvas.height = size.height
        const context = canvas.getContext('2d')
        if (!context) throw new Error('Could not create the captured image')
        const image = context.createImageData(size.width, size.height)
        const row = size.width * 4
        for (let y = 0; y < size.height; y++) image.data.set(pixels.subarray((size.height - 1 - y) * row, (size.height - y) * row), y * row)
        context.putImageData(image, 0, 0)
        return await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Could not encode the captured image')), 'image/png'))
      } finally {
        if (capture) disposeScene(capture.scene)
        captureInFlight = false
      }
    }
    binding.connect({
      readCamera, captureView,
      frameSelection() {
        if (controller.getSnapshot().mode !== 'orbit') controller.setMode('orbit')
        const state = controller.getSnapshot()
        const selected = state.selectedId
        const figure = selected ? built?.objects.get(selected) : undefined
        const object = selected && state.selectedJointId ? built?.joints.get(selected)?.get(state.selectedJointId) : figure
        if (!figure?.visible || !object) return
        const bounds = new Box3().setFromObject(object)
        if (bounds.isEmpty()) return
        const centre = bounds.getCenter(new Vector3())
        const radius = Math.max(bounds.getSize(new Vector3()).length() / 2, 0.1)
        const halfAngle = Math.min(camera.fov * Math.PI / 360, Math.atan(Math.tan(camera.fov * Math.PI / 360) * camera.aspect))
        const distance = radius / Math.sin(halfAngle) * 1.15
        const direction = camera.position.clone().sub(orbit.target).normalize()
        if (!direction.lengthSq()) direction.set(1, 0.5, 1).normalize()
        camera.position.copy(centre).addScaledVector(direction, distance)
        orbit.target.copy(centre)
        orbit.update()
        invalidate()
      },
    })

    const dragChanged = (event: { value: unknown }) => {
      binding.update({ dragging: Boolean(event.value) })
      orbit.enabled = !event.value
      invalidate()
    }
    const beginTransform = () => {
      const state = controller.getSnapshot()
      const id = state.selectedId
      if (!id || !transform.object || !transform.enabled || latest.current.disabled || rebuilding) return
      dragStart = { id, jointId: state.tool === 'rotate' ? state.selectedJointId : null, object: transform.object, transform: readTransform(transform.object) }
      latest.current.onBeginEdit?.()
    }
    const clampTransform = () => {
      const start = dragStart
      if (start?.jointId && transform.object === start.object) {
        const source = doc.objects.find(object => object.id === start.id)?.source
        const body = source?.type === 'figure' ? BUILTIN_BODIES.find(body => body.id === source.bodyId) : undefined
        const joint = body?.joints.find(joint => joint.id === start.jointId)
        if (joint) transform.object.quaternion.fromArray(clampJointRotation(joint, transform.object.quaternion.toArray()))
      }
      invalidate()
    }
    const endTransform = () => {
      clampTransform()
      const start = dragStart
      dragStart = null
      if (!start || transform.object !== start.object || latest.current.disabled) return
      const next = readTransform(transform.object)
      if (start.jointId && new Quaternion(...start.transform.rotation).angleTo(transform.object.quaternion) < 1e-7) {
        applySceneTransform(transform.object, start.transform)
        return
      }
      if (JSON.stringify(start.transform) === JSON.stringify(next)) return
      // The gizmo moved the built object in place, so the stage no longer matches the document it was built from.
      buildSignature = ''
      gestureCommitted = true
      if (start.jointId) latest.current.onJointRotation(start.id, start.jointId, next.rotation)
      else latest.current.onTransform(start.id, next)
    }
    const orbitStart = () => {
      navigationStart = JSON.stringify(readCamera())
      if (controller.getSnapshot().mode === 'camera' && !latest.current.disabled) latest.current.onBeginEdit?.()
    }
    const orbitChanged = () => {
      // OrbitControls resets roll in lookAt. Apply the authored roll without changing the world's up axis.
      orientCamera()
      invalidate()
    }
    const orbitEnd = () => {
      if (camera === orbitCamera) orbitCamera.userData.orbitTarget = orbit.target.clone()
      const state = controller.getSnapshot()
      const data = readCamera()
      if (state.mode === 'camera' && state.viewId && !latest.current.disabled && navigationStart && navigationStart !== JSON.stringify(data)) latest.current.onCameraChange(state.viewId, data)
      navigationStart = ''
    }
    const pointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return
      pointerStart = { x: event.clientX, y: event.clientY, gizmo: Boolean(transform.axis) || transform.dragging }
      gestureCommitted = false
    }
    const pointerUp = (event: PointerEvent) => {
      const start = pointerStart
      pointerStart = null
      if (!start || event.button !== 0 || transform.dragging || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4 || !built) return
      // TransformControls connected in its constructor, before this listener, so a gizmo release has already gone through
      // endTransform here. Were the order reversed, `transform.dragging` would still be set above and the press would
      // never reach the markers, so a gesture still cannot both commit and reselect.
      if (start.gizmo && gestureCommitted) return
      const rect = interaction.getBoundingClientRect()
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) return
      const pointer = new Vector2((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1)
      raycaster.setFromCamera(pointer, camera)
      syncJoints()
      const marker = raycaster.intersectObjects(jointHelpers.children, false)[0]?.object
      // A knee sits about one ring radius from the hip or the figure root, so its marker lies under the rotate gizmo's
      // pick area. A gizmo press that committed nothing was a click, so the marker under it wins.
      if (marker) { controller.selectJoint(marker.userData.jointId as string); return }
      if (start.gizmo) return
      const candidates = [...built.objects.values()].filter(object => object.visible)
      const hit = raycaster.intersectObjects(candidates, true).find(hit => {
        let object: Object3D | null = hit.object
        while (object) { if (!object.visible) return false; object = object.parent }
        return true
      })
      let selected: string | null = null
      let jointId: string | null = null
      let object = hit?.object
      while (object) {
        if (!jointId && typeof object.userData.jointId === 'string') jointId = object.userData.jointId as string
        if (typeof object.userData.sceneObjectId === 'string') { selected = object.userData.sceneObjectId as string; break }
        object = object.parent ?? undefined
      }
      if (jointId && selected === controller.getSnapshot().selectedId && controller.getSnapshot().tool === 'rotate') controller.selectJoint(jointId)
      else controller.select(selected)
    }
    const cancelPointer = () => {
      cancelTransform()
    }
    const preventMenu = (event: Event) => event.preventDefault()
    const lost = (event: Event) => {
      event.preventDefault()
      contextLost = true
      cancelPointer()
      binding.update({ status: 'unavailable', dragging: false })
      orbit.enabled = false
      transform.enabled = false
    }
    const restored = () => {
      contextLost = false
      binding.update({ status: built ? 'ready' : 'loading' })
      applyState()
    }
    transform.addEventListener('dragging-changed', dragChanged)
    transform.addEventListener('mouseDown', beginTransform)
    transform.addEventListener('mouseUp', endTransform)
    transform.addEventListener('change', invalidate)
    transform.addEventListener('objectChange', clampTransform)
    orbit.addEventListener('change', orbitChanged)
    orbit.addEventListener('start', orbitStart)
    orbit.addEventListener('end', orbitEnd)
    interaction.addEventListener('pointerdown', pointerDown)
    interaction.addEventListener('pointerup', pointerUp)
    interaction.addEventListener('pointercancel', cancelPointer)
    interaction.addEventListener('contextmenu', preventMenu)
    renderer.domElement.addEventListener('webglcontextlost', lost)
    renderer.domElement.addEventListener('webglcontextrestored', restored)
    const unsubscribe = controller.subscribe(applyState)
    const resizeObserver = new ResizeObserver(resize)
    resizeObserver.observe(element)
    const themeObserver = new MutationObserver(theme)
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] })
    themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] })
    runtime.current = { updateDoc, updateInteraction: applyState, retryModels }
    theme()
    resize()
    return () => {
      dead = true
      buildVersion++
      modelAbort.abort()
      runtime.current = null
      cancelAnimationFrame(frame)
      resizeObserver.disconnect()
      themeObserver.disconnect()
      unsubscribe()
      binding.connect(null)
      interaction.removeEventListener('pointerdown', pointerDown)
      interaction.removeEventListener('pointerup', pointerUp)
      interaction.removeEventListener('pointercancel', cancelPointer)
      interaction.removeEventListener('contextmenu', preventMenu)
      renderer.domElement.removeEventListener('webglcontextlost', lost)
      renderer.domElement.removeEventListener('webglcontextrestored', restored)
      transform.removeEventListener('change', invalidate)
      transform.removeEventListener('objectChange', clampTransform)
      transform.removeEventListener('dragging-changed', dragChanged)
      transform.removeEventListener('mouseDown', beginTransform)
      transform.removeEventListener('mouseUp', endTransform)
      orbit.removeEventListener('change', orbitChanged)
      orbit.removeEventListener('start', orbitStart)
      orbit.removeEventListener('end', orbitEnd)
      transform.detach()
      helpers.remove(transform.getHelper())
      transform.dispose()
      orbit.dispose()
      if (built) disposeScene(built.scene)
      outlines.dispose()
      helpers.remove(jointHelpers)
      jointHelpers.clear()
      jointGeometry.dispose()
      jointMaterial.dispose()
      selectedJointMaterial.dispose()
      disposeScene(helpers)
      for (const pending of cache.values()) void pending.then(model => { disposeScene(model) }, () => {})
      cache.clear()
      captures.forEach(target => target.dispose())
      captures.clear()
      renderer.dispose()
      renderer.forceContextLoss()
      renderer.domElement.remove()
      interaction.remove()
    }
  }, [props.controller])
  useEffect(() => { runtime.current?.updateDoc(props.doc) }, [props.doc, props.controller])
  useEffect(() => { runtime.current?.updateInteraction() }, [props.disabled, props.outlinedIds])

  return <div className="vis-sc-viewport">
    <div ref={container} className="vis-sc-surface" role="img" aria-label={m.viewport} tabIndex={0} />
    {state.status === 'unavailable' ? <p className="vis-sc-viewport-notice" role="alert">{m.noWebgl}</p> : null}
    {state.status === 'loading' ? <p className="vis-sc-viewport-notice" role="status">{m.loading}</p> : null}
    {state.status === 'error' ? <div className="vis-sc-viewport-notice" role="alert"><p>{m.loadFailed}</p><button onClick={() => runtime.current?.updateDoc(props.doc)}>{m.retryView}</button></div> : null}
    {state.status === 'ready' && state.failedModels ? <div className="vis-sc-software vis-sc-model-notice" role="alert"><span>{m.modelsFailed}</span><button onClick={() => runtime.current?.retryModels()}>{m.retryModels}</button></div> : null}
    {state.softwareRenderer && state.status !== 'unavailable' ? <p className="vis-sc-software" role="status">{m.softwareRenderer}</p> : null}
  </div>
}
