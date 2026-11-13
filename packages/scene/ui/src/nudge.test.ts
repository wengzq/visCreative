import { expect, it } from 'vitest'
import { MathUtils, Quaternion, Vector3 } from 'three'
import type { SceneObject } from '@vis/protocol'
import { jointEuler, jointQuaternion } from '@vis/scene-core'
import { nextNudgeRun, nudgeObject, readNudge, type SceneNudgeRun, type SceneNudgeTarget } from './nudge'

const box: SceneObject = {
  id: 'box', name: 'Box', createdBy: 'user', userTouched: true, hidden: false,
  transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
  source: { type: 'primitive', shape: 'box', size: [1, 1, 1] },
}
const figure: SceneObject = { ...box, id: 'figure', source: { type: 'figure', bodyId: 'human', heightM: 1.8, pose: {} } }
const front = { position: [0, 1, 5], target: [0, 1, 0] } satisfies SceneNudgeTarget['camera']
const corner = { position: [5, 3, 5], target: [0, 1, 0] } satisfies SceneNudgeTarget['camera']
const press = (key: string, modifiers: { shiftKey?: boolean; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean } = {}) =>
  readNudge({ key, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, ...modifiers })!
const nudge = (object: SceneObject, key: string, target: Partial<SceneNudgeTarget>, modifiers = {}) =>
  nudgeObject(object, press(key, modifiers), { tool: 'translate', jointId: null, camera: front, ...target })
const moved = (key: string, camera: SceneNudgeTarget['camera'], modifiers = {}) => nudge(box, key, { camera }, modifiers).transform.position
const turned = (key: string, point: [number, number, number], camera: SceneNudgeTarget['camera'] = front) =>
  new Vector3(...point).applyQuaternion(new Quaternion(...nudge(box, key, { tool: 'rotate', camera }).transform.rotation))
const kneeDegrees = (object: SceneObject) => {
  if (object.source.type !== 'figure') throw new Error('Expected a figure')
  return jointEuler(object.source.pose.leftKnee ?? [0, 0, 0, 1]).map(MathUtils.radToDeg)
}
const withKnee = (degrees: number): SceneObject => ({ ...figure, source: { type: 'figure', bodyId: 'human', heightM: 1.8, pose: { leftKnee: jointQuaternion([MathUtils.degToRad(degrees), 0, 0]) } } })

it('reads arrows and page keys with Shift and Alt steps and rejects other keys and Ctrl or Meta', () => {
  expect(press('ArrowRight')).toEqual({ axis: 'right', sign: 1, size: 0 })
  expect(press('ArrowDown', { shiftKey: true })).toEqual({ axis: 'forward', sign: -1, size: 1 })
  expect(press('PageUp', { altKey: true })).toEqual({ axis: 'up', sign: 1, size: 2 })
  expect(readNudge({ key: 'a', shiftKey: false, altKey: false, ctrlKey: false, metaKey: false })).toBeNull()
  expect(readNudge({ key: 'ArrowLeft', shiftKey: false, altKey: false, ctrlKey: true, metaKey: false })).toBeNull()
  expect(readNudge({ key: 'PageDown', shiftKey: false, altKey: true, ctrlKey: false, metaKey: true })).toBeNull()
})

it('moves along the camera floor axes from in front of the stage', () => {
  expect(moved('ArrowRight', front)).toEqual([0.1, 0, 0])
  expect(moved('ArrowLeft', front)).toEqual([-0.1, 0, 0])
  expect(moved('ArrowUp', front)).toEqual([0, 0, -0.1])
  expect(moved('ArrowDown', front)).toEqual([0, 0, 0.1])
  expect(moved('PageUp', front)).toEqual([0, 0.1, 0])
  expect(moved('PageDown', front)).toEqual([0, -0.1, 0])
  expect(moved('ArrowRight', front, { shiftKey: true })).toEqual([1, 0, 0])
  expect(moved('ArrowRight', front, { altKey: true })).toEqual([0.01, 0, 0])
})

it('moves along the default camera diagonal and falls back to -Z when looking straight down', () => {
  expect(moved('ArrowRight', corner)).toEqual([0.070711, 0, -0.070711])
  expect(moved('ArrowUp', corner)).toEqual([-0.070711, 0, -0.070711])
  expect(moved('ArrowDown', { position: [0, 10, 0], target: [0, 0, 0] })).toEqual([0, 0, 0.1])
  expect(moved('ArrowRight', { position: [0, 10, 0], target: [0, 0, 0] })).toEqual([0.1, 0, 0])
})

it('rounds positions to six decimals and leaves the object alone without a camera', () => {
  const start = { ...box, transform: { ...box.transform, position: [0.2, 0, 0] as [number, number, number] } }
  expect(nudge(start, 'ArrowRight', {}).transform.position).toEqual([0.3, 0, 0])
  expect(nudge(box, 'ArrowRight', { camera: null })).toBe(box)
})

it('rotates the object in world space as seen from the camera', () => {
  // The near side moves to camera-right like a turntable, from either camera.
  expect(turned('ArrowRight', [0, 0, 1]).x).toBeGreaterThan(0)
  expect(turned('ArrowLeft', [0, 0, 1]).x).toBeLessThan(0)
  const near = new Vector3(1, 0, 1).normalize()
  expect(turned('ArrowRight', [near.x, near.y, near.z], corner).dot(new Vector3(1, 0, -1))).toBeGreaterThan(0)
  // The top tips away from the camera on Up and toward it on Down.
  expect(turned('ArrowUp', [0, 1, 0]).z).toBeLessThan(0)
  expect(turned('ArrowDown', [0, 1, 0]).z).toBeGreaterThan(0)
  expect(turned('ArrowUp', [0, 1, 0], corner).dot(new Vector3(1, 0, 1))).toBeLessThan(0)
  // The top tips to screen-right on PageUp.
  expect(turned('PageUp', [0, 1, 0]).x).toBeGreaterThan(0)
  expect(turned('PageDown', [0, 1, 0]).x).toBeLessThan(0)
  const rotation = nudge(box, 'ArrowRight', { tool: 'rotate' }, { shiftKey: true }).transform.rotation
  expect(MathUtils.radToDeg(new Quaternion(...rotation).angleTo(new Quaternion()))).toBeCloseTo(45)
  expect(nudge(box, 'ArrowRight', { tool: 'rotate' }).transform.position).toEqual([0, 0, 0])
})

it('rotates a selected knee within its limits and leaves locked axes and stops unchanged', () => {
  const knee: Partial<SceneNudgeTarget> = { tool: 'rotate', jointId: 'leftKnee' }
  const bent = nudge(figure, 'ArrowUp', knee)
  expect(kneeDegrees(bent)[0]).toBeCloseTo(5)
  expect(bent.transform).toEqual(figure.transform)
  expect(kneeDegrees(nudge(figure, 'ArrowUp', knee, { shiftKey: true }))[0]).toBeCloseTo(45)
  expect(nudge(figure, 'ArrowDown', knee)).toBe(figure)
  expect(nudge(figure, 'ArrowRight', knee)).toBe(figure)
  expect(nudge(figure, 'ArrowLeft', knee)).toBe(figure)
  expect(nudge(figure, 'PageUp', knee)).toBe(figure)
  expect(kneeDegrees(nudge(withKnee(148), 'ArrowUp', knee))[0]).toBeCloseTo(150)
  const stopped = withKnee(150)
  expect(nudge(stopped, 'ArrowUp', knee)).toBe(stopped)
  // Move and Scale act on the whole figure even with a joint selected.
  expect(nudge(figure, 'ArrowRight', { tool: 'translate', jointId: 'leftKnee' }).transform.position).toEqual([0.1, 0, 0])
  expect(nudge(figure, 'ArrowUp', { tool: 'scale', jointId: 'leftKnee' }).transform.scale).toEqual([1.05, 1.05, 1.05])
})

it('scales uniformly and refuses a step that leaves the scale range', () => {
  const scaled = (object: SceneObject, key: string, modifiers = {}) => nudge(object, key, { tool: 'scale' }, modifiers).transform.scale
  expect(scaled(box, 'ArrowUp')).toEqual([1.05, 1.05, 1.05])
  expect(scaled(box, 'ArrowRight', { shiftKey: true })).toEqual([1.25, 1.25, 1.25])
  expect(scaled(box, 'PageUp', { altKey: true })).toEqual([1.01, 1.01, 1.01])
  expect(scaled(box, 'ArrowDown')).toEqual([0.952381, 0.952381, 0.952381])
  expect(scaled(box, 'ArrowLeft')).toEqual([0.952381, 0.952381, 0.952381])
  const tiny = { ...box, transform: { ...box.transform, scale: [0.01, 2, 2] as [number, number, number] } }
  expect(nudge(tiny, 'PageDown', { tool: 'scale' })).toBe(tiny)
  const huge = { ...box, transform: { ...box.transform, scale: [1, 1, 100] as [number, number, number] } }
  expect(nudge(huge, 'ArrowUp', { tool: 'scale' })).toBe(huge)
  expect(nudge(huge, 'ArrowDown', { tool: 'scale' }).transform.scale).toEqual([0.952381, 0.952381, 95.238095])
})

it('keeps the rotation a unit quaternion over many steps', () => {
  let object = box
  for (let index = 0; index < 50; index++) object = nudge(object, index % 2 ? 'ArrowUp' : 'PageUp', { tool: 'rotate', camera: corner })
  expect(new Quaternion(...object.transform.rotation).length()).toBeCloseTo(1, 12)
})

const posed = (jointId: string, degrees: [number, number, number]): SceneObject => ({
  ...figure, source: { type: 'figure', bodyId: 'human', heightM: 1.8, pose: { [jointId]: jointQuaternion(degrees.map(MathUtils.degToRad) as [number, number, number]) } },
})
const jointDegrees = (object: SceneObject, jointId: string) => {
  if (object.source.type !== 'figure') throw new Error('Expected a figure')
  return jointEuler(object.source.pose[jointId]!).map(MathUtils.radToDeg)
}
const expectDegrees = (actual: number[], expected: [number, number, number]) => actual.forEach((value, axis) => expect(value).toBeCloseTo(expected[axis]!, 6))

// Before the fix these gave (-150, 80, 0) for the elbow and (-35, 55, -35) for the neck.
it.each([
  ['leftElbow', [0, 50, 0], { shiftKey: true }, [0, 80, 0]],
  ['leftElbow', [-40, 50, 0], { shiftKey: true }, [-40, 80, 0]],
  ['neck', [10, 50, -5], { shiftKey: true }, [10, 55, -5]],
  ['neck', [10, 20, -5], {}, [10, 25, -5]],
  ['leftWrist', [0, 88, 0], {}, [0, 90, 0]],
] as const)('steps %s from %j without wrapping through the Euler flip', (jointId, from, modifiers, expected) => {
  expectDegrees(jointDegrees(nudge(posed(jointId, [...from]), 'ArrowRight', { tool: 'rotate', jointId }, modifiers), jointId), [...expected])
})

it('steps a turned wrist to its 90 degree Y stop without flipping X or Z', () => {
  // Before the fix this gave (70, 87, -25). At exactly 90 degrees only X + Z survives the decomposition, so compare orientations.
  const next = nudge(posed('leftWrist', [20, 88, -10]), 'ArrowRight', { tool: 'rotate', jointId: 'leftWrist' })
  expect(jointQuat(next, 'leftWrist').angleTo(quat([20, 90, -10]))).toBeLessThan(1e-6)
})

it.each([
  ['leftElbow', [0, 80, 0], {}],
  // Before the fix this gave (-150, 55, 0): 125 degrees decomposes as (180, 55, 180).
  ['leftElbow', [0, 80, 0], { shiftKey: true }],
  ['leftElbow', [-40, 80, 0], { shiftKey: true }],
  ['neck', [0, 55, 0], { shiftKey: true }],
  ['neck', [10, 55, -5], { shiftKey: true }],
] as const)('leaves %s at its Y stop %j unchanged with modifiers %j', (jointId, from, modifiers) => {
  const object = posed(jointId, [...from])
  expect(nudge(object, 'ArrowRight', { tool: 'rotate', jointId }, modifiers)).toBe(object)
})

const quat = (degrees: readonly number[]) => new Quaternion(...jointQuaternion(degrees.map(MathUtils.degToRad) as [number, number, number]))
const jointQuat = (object: SceneObject, jointId: string) => {
  if (object.source.type !== 'figure') throw new Error('Expected a figure')
  return new Quaternion(...object.source.pose[jointId]!)
}

// At exactly 90 degrees on Y, XYZ Euler is in gimbal lock: only X + Z survives the decomposition, so [20, 90, 10] reads
// back as [30, 90, 0]. That is the same orientation, so compare orientations rather than angles.
it.each([
  ['leftShoulder', [20, 80, 10]], ['pelvis', [20, 80, 10]], ['pelvis', [-10, -80, 5]], ['leftWrist', [20, 60, -10]],
] as const)('steps %s from %j to its 90 degree Y limit without flipping X or Z, then stays there', (jointId, from) => {
  const target = { tool: 'rotate', jointId } as const
  const key = from[1] > 0 ? 'ArrowRight' : 'ArrowLeft'
  const atLimit = nudge(posed(jointId, [...from]), key, target, { shiftKey: true })
  expect(jointQuat(atLimit, jointId).angleTo(quat([from[0], Math.sign(from[1]) * 90, from[2]]))).toBeLessThan(1e-6)
  expect(nudge(atLimit, key, target)).toBe(atLimit)
})

it('lets a scale step move an out-of-range component back toward the range and never blocks on an unchanged zero', () => {
  const scaled = (scale: [number, number, number], key: string) => {
    const object = { ...box, transform: { ...box.transform, scale } }
    const next = nudge(object, key, { tool: 'scale' })
    return next === object ? null : next.transform.scale
  }
  expect(scaled([200, 1, 1], 'ArrowDown')).toEqual([190.47619, 0.952381, 0.952381])
  expect(scaled([200, 1, 1], 'ArrowUp')).toBeNull()
  expect(scaled([0.001, 1, 1], 'ArrowUp')).toEqual([0.00105, 1.05, 1.05])
  expect(scaled([0.001, 1, 1], 'ArrowDown')).toBeNull()
  expect(scaled([0, 1, 1], 'ArrowUp')).toEqual([0, 1.05, 1.05])
  expect(scaled([0, 1, 1], 'ArrowDown')).toEqual([0, 0.952381, 0.952381])
  expect(scaled([-200, 2, 2], 'ArrowDown')).toEqual([-190.47619, 1.904762, 1.904762])
})

it('continues a run only for repeats of the same key on the same object, joint and tool', () => {
  const press = { key: 'ArrowRight', objectId: 'box', jointId: null, tool: 'translate' } as const
  const tap = nextNudgeRun(null, press, false, 1)
  expect(tap).toEqual({ ...press, id: 1 })
  // A hold continues its own run.
  expect(nextNudgeRun(tap, press, true, 2)).toBe(tap)
  // A new press starts another run even on the same target.
  expect(nextNudgeRun(tap, press, false, 2).id).toBe(2)
  // The editor clears the run on keyup and on other keys, so Ctrl+Right released into a hold, or a hold that began
  // with nothing selected, arrives as a repeat without an active run.
  expect(nextNudgeRun(null, press, true, 2).id).toBe(2)
  // Changing the object, joint, tool or key mid-hold starts a new run.
  const changes: Partial<Omit<SceneNudgeRun, 'id'>>[] = [{ objectId: 'other' }, { jointId: 'leftKnee' }, { tool: 'rotate' }, { key: 'ArrowUp' }]
  for (const change of changes) expect(nextNudgeRun(tap, { ...press, ...change }, true, 2)).toEqual({ ...press, ...change, id: 2 })
})
