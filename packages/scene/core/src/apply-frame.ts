import type { SceneDoc } from '@vis/protocol'
import { Vector3 } from 'three'
import { applySceneTransform, sceneAspect, type BuiltScene } from './build-scene'
import { BUILTIN_BODIES } from './descriptors'
import { poseRotation } from './pose'
import type { BodyDescriptor } from './types'

/** Apply a sampled document while retaining the built tree and its GPU resources. */
export function applySceneFrame(built: BuiltScene, frame: SceneDoc, viewId: string, bodies: readonly BodyDescriptor[] = BUILTIN_BODIES): void {
  const view = frame.views.find(view => view.id === viewId)
  if (!view) throw new Error(`Unknown scene view: ${viewId}`)
  for (const descriptor of frame.objects) {
    const object = built.objects.get(descriptor.id)
    if (!object) continue
    applySceneTransform(object, descriptor.transform)
    object.visible = !descriptor.hidden
    if (descriptor.source.type !== 'figure') continue
    const source = descriptor.source
    const body = bodies.find(body => body.id === source.bodyId)
    if (!body) throw new Error(`Unknown scene body: ${source.bodyId}`)
    const joints = built.joints.get(descriptor.id)
    for (const joint of body.joints) joints?.get(joint.id)?.quaternion.fromArray(poseRotation(body, source.pose, joint))
  }
  const camera = built.camera
  const data = view.camera
  camera.aspect = sceneAspect(view.aspectRatio)
  camera.fov = 2 * Math.atan(36 / (2 * data.focalLengthMm * camera.aspect)) * 180 / Math.PI
  camera.filmGauge = 36 / Math.min(camera.aspect, 1)
  camera.position.fromArray(data.position)
  const target = new Vector3(...data.target)
  if (target.distanceToSquared(camera.position) < 1e-12) target.z -= 1
  camera.lookAt(target)
  camera.rotateZ(data.roll)
  camera.updateProjectionMatrix()
  camera.updateMatrixWorld()
  built.scene.updateMatrixWorld(true)
}
