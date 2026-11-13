import type { Quat, SceneObject, SceneView, Vec3 } from '@vis/protocol'
import { BUILTIN_BODIES, jointEuler, poseRotation, setJointAxis } from '@vis/scene-core'
import { MathUtils, Quaternion, Vector3 } from 'three'
import type { SceneTool } from './types'

export type SceneNudge = { axis: 'right' | 'forward' | 'up'; sign: 1 | -1; size: 0 | 1 | 2 }
export type SceneNudgeRun = { id: number; key: string; objectId: string; jointId: string | null; tool: SceneTool }
export type SceneNudgeTarget = {
  tool: SceneTool
  jointId: string | null
  camera: Pick<SceneView['camera'], 'position' | 'target'> | null
}

const keys: Record<string, Pick<SceneNudge, 'axis' | 'sign'>> = {
  ArrowRight: { axis: 'right', sign: 1 }, ArrowLeft: { axis: 'right', sign: -1 },
  ArrowUp: { axis: 'forward', sign: 1 }, ArrowDown: { axis: 'forward', sign: -1 },
  PageUp: { axis: 'up', sign: 1 }, PageDown: { axis: 'up', sign: -1 },
}
// Base, Shift and Alt steps per tool.
const steps: Record<SceneTool, readonly [number, number, number]> = { translate: [0.1, 1, 0.01], rotate: [5, 45, 1], scale: [1.05, 1.25, 1.01] }
const jointAxes = { forward: 0, right: 1, up: 2 } as const
const up = new Vector3(0, 1, 0)
const round = (value: number) => Math.round(value * 1e6) / 1e6 + 0
// A scale step may not leave [0.01, 100], but a component already outside may come back, and one it leaves alone
// (a zero stays zero) never blocks the others.
const distance = (value: number) => Math.max(0.01 - Math.abs(value), Math.abs(value) - 100, 0)
const leavesRange = (before: number, after: number) => after !== before && distance(after) > distance(before)

export function readNudge(event: { key: string; shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean }): SceneNudge | null {
  const key = keys[event.key]
  if (!key || event.ctrlKey || event.metaKey) return null
  return { ...key, size: event.shiftKey ? 1 : event.altKey ? 2 : 0 }
}

/** A repeat continues the active run only for the same key, object, joint and tool; anything else starts run `id`. */
export function nextNudgeRun(active: SceneNudgeRun | null, press: Omit<SceneNudgeRun, 'id'>, repeat: boolean, id: number): SceneNudgeRun {
  const same = active && active.key === press.key && active.objectId === press.objectId && active.jointId === press.jointId && active.tool === press.tool
  return repeat && same ? active : { ...press, id }
}

// Camera roll is ignored: the author steers on the floor, and PageUp/PageDown always mean world up and down.
export function floorAxes(camera: NonNullable<SceneNudgeTarget['camera']>) {
  const forward = new Vector3(camera.target[0] - camera.position[0], 0, camera.target[2] - camera.position[2])
  if (forward.length() < 1e-6) forward.set(0, 0, -1)
  else forward.normalize()
  return { forward, right: forward.clone().cross(up) }
}

/** Returns the same object when the key changes nothing, so the draft records no undo step. */
export function nudgeObject(object: SceneObject, nudge: SceneNudge, target: SceneNudgeTarget): SceneObject {
  const step = steps[target.tool][nudge.size] * (target.tool === 'scale' ? 1 : nudge.sign)
  const source = object.source
  if (target.tool === 'rotate' && target.jointId && source.type === 'figure') {
    const body = BUILTIN_BODIES.find(body => body.id === source.bodyId)
    const joint = body?.joints.find(joint => joint.id === target.jointId)
    if (!body || !joint) return object
    const current = poseRotation(body, source.pose, joint)
    const axis = jointAxes[nudge.axis]
    const next = setJointAxis(joint, current, axis, jointEuler(current)[axis]! + MathUtils.degToRad(step))
    // At a limit or on a locked axis the clamp lands back on the current rotation, give or take conversion noise.
    if (new Quaternion(...next).angleTo(new Quaternion(...current)) < 1e-6) return object
    return { ...object, source: { ...source, pose: { ...source.pose, [joint.id]: next } } }
  }
  if (target.tool === 'scale') {
    const before = object.transform.scale
    const scale = before.map(value => round(nudge.sign > 0 ? value * step : value / step)) as Vec3
    if (scale.some((value, axis) => leavesRange(before[axis]!, value))) return object
    return { ...object, transform: { ...object.transform, scale } }
  }
  if (!target.camera) return object
  const { forward, right } = floorAxes(target.camera)
  const direction = nudge.axis === 'right' ? right : nudge.axis === 'forward' ? forward : up
  if (target.tool === 'translate') {
    const position = new Vector3(...object.transform.position).addScaledVector(direction, step).toArray().map(round) as Vec3
    return { ...object, transform: { ...object.transform, position } }
  }
  // Right turns about world up like a turntable, so the near side moves to screen-right. Up tips the top away from the
  // camera, which is a negative turn about the floor's right axis. PageUp tips the top to screen-right.
  const axis = nudge.axis === 'right' ? up : nudge.axis === 'forward' ? right.clone().negate() : forward
  const turn = new Quaternion().setFromAxisAngle(axis, MathUtils.degToRad(step))
  const rotation = turn.multiply(new Quaternion(...object.transform.rotation).normalize()).normalize().toArray() as Quat
  return { ...object, transform: { ...object.transform, rotation } }
}
