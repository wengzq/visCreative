import type { Quat, Vec3 } from '@vis/protocol'
import { expect, it } from 'vitest'
import { Quaternion, Vector3 } from 'three'
import { HUMAN_BODY } from './descriptors'
import { clampJointRotation, jointEuler, jointQuaternion, mirrorPose, pairedJoints, presetPose, reflectJointRotation, resetJointPose, setJointAxis } from './pose'
import type { BodyDescriptor } from './types'

const sameRotation = (a: Quat, b: Quat) => expect(new Quaternion(...a).angleTo(new Quaternion(...b))).toBeCloseTo(0, 6)
const shoulder = HUMAN_BODY.joints.find(joint => joint.id === 'leftShoulder')!

it('clamps normalized parent-local rotations on every axis, including a zero quaternion', () => {
  const joint = { ...shoulder, limits: { min: [-0.2, -0.3, -0.4] as Vec3, max: [0.2, 0.3, 0.4] as Vec3 } }
  const result = clampJointRotation(joint, jointQuaternion([0.8, -0.7, 0.9]).map(value => value * 3) as Quat)
  jointEuler(result).forEach((value, axis) => expect(value).toBeCloseTo([0.2, -0.3, 0.4][axis]!))
  expect(clampJointRotation(joint, [0, 0, 0, 0])).toEqual([0, 0, 0, 1])
})

it.each([
  ['leftElbow', -151, -150], ['leftElbow', -179, -150], ['leftElbow', -181, -150], ['leftElbow', -190, -150],
  ['leftKnee', 151, 150], ['leftKnee', 179, 150], ['leftKnee', 181, 150], ['leftKnee', 190, 150],
  ['leftHip', -121, -120], ['leftHip', -179, -120], ['leftHip', -181, -120], ['leftHip', 179, -120],
] as const)('clamps %s at %s degrees to the nearest wrapped limit %s', (id, degrees, expected) => {
  const joint = HUMAN_BODY.joints.find(joint => joint.id === id)!
  const result = clampJointRotation(joint, jointQuaternion([degrees * Math.PI / 180, 0, 0]))
  expect(jointEuler(result)[0] * 180 / Math.PI).toBeCloseTo(expected)
})

it('keeps every raw preset rotation within its descriptor limits', () => {
  expect(HUMAN_BODY.poses.map(pose => pose.id)).toEqual(['standing', 'walking', 'sitting', 'pointing'])
  for (const pose of HUMAN_BODY.poses) {
    expect(Object.keys(pose.joints)).toHaveLength(HUMAN_BODY.joints.length)
    for (const joint of HUMAN_BODY.joints) {
      const angles = jointEuler(pose.joints[joint.id]!)
      for (let axis = 0; axis < 3; axis++) {
        expect(angles[axis]!, `${pose.id}/${joint.id}/${axis}`).toBeGreaterThanOrEqual(joint.limits.min[axis]! - 1e-9)
        expect(angles[axis]!, `${pose.id}/${joint.id}/${axis}`).toBeLessThanOrEqual(joint.limits.max[axis]! + 1e-9)
      }
    }
  }
})

it('reflects rotations across the sagittal plane instead of reversing flexion', () => {
  const original = jointQuaternion([0.4, 0.3, -0.6])
  const reflected = new Quaternion(...reflectJointRotation(original))
  const vector = new Vector3(0.3, -0.8, 0.5)
  const expected = vector.clone().setX(-vector.x).applyQuaternion(new Quaternion(...original))
  expected.x = -expected.x
  expect(vector.applyQuaternion(reflected).distanceTo(expected)).toBeCloseTo(0)
})

it('copies either side and swaps an asymmetric pose twice without changing the original', () => {
  const original = {
    ...presetPose(HUMAN_BODY),
    leftShoulder: jointQuaternion([-0.6, 0.3, 0.4]),
    rightShoulder: jointQuaternion([0.2, -0.1, -0.5]),
    leftElbow: jointQuaternion([-0.8, 0.4, 0]),
    rightElbow: jointQuaternion([-0.2, -0.3, 0]),
    chest: jointQuaternion([0.2, 0.3, 0.1]),
  }
  const snapshot = structuredClone(original)
  const copyRight = mirrorPose(HUMAN_BODY, original, 'leftToRight')
  sameRotation(copyRight.rightShoulder!, reflectJointRotation(original.leftShoulder))
  sameRotation(copyRight.leftShoulder!, original.leftShoulder)
  sameRotation(copyRight.chest!, original.chest)
  const copyLeft = mirrorPose(HUMAN_BODY, original, 'rightToLeft')
  sameRotation(copyLeft.leftElbow!, reflectJointRotation(original.rightElbow))
  const swapped = mirrorPose(HUMAN_BODY, original, 'swap')
  sameRotation(swapped.leftShoulder!, reflectJointRotation(original.rightShoulder))
  sameRotation(swapped.chest!, reflectJointRotation(original.chest))
  const restored = mirrorPose(HUMAN_BODY, swapped, 'swap')
  const rotations: Record<string, Quat> = original
  for (const joint of HUMAN_BODY.joints) sameRotation(restored[joint.id]!, rotations[joint.id]!)
  expect(original).toEqual(snapshot)
  const sparse = { leftShoulder: original.leftShoulder }
  const sparseRestored = mirrorPose(HUMAN_BODY, mirrorPose(HUMAN_BODY, sparse, 'swap'), 'swap')
  expect(Object.keys(sparseRestored)).toEqual(['leftShoulder'])
  sameRotation(sparseRestored.leftShoulder!, sparse.leftShoulder)
})

it('resets just one joint or replaces the whole pose with the body standing preset', () => {
  const posed = presetPose(HUMAN_BODY, 'pointing')
  const reset = resetJointPose(HUMAN_BODY, posed, 'rightShoulder')
  sameRotation(reset.rightShoulder!, [0, 0, 0, 1])
  sameRotation(reset.rightElbow!, posed.rightElbow!)
  const standing = presetPose(HUMAN_BODY)
  for (const rotation of Object.values(standing)) sameRotation(rotation, [0, 0, 0, 1])
  reset.rightElbow![0] = 5
  expect(presetPose(HUMAN_BODY).rightElbow).toEqual([0, 0, 0, 1])
})

it('derives pairs for other bodies and leaves a non-human body without pairs unchanged', () => {
  const root = { ...shoulder, id: 'coil', parent: null, parts: [] }
  const body: BodyDescriptor = { id: 'coil-body', heightM: 0.5, joints: [root], poses: [{ id: 'standing', joints: { coil: jointQuaternion([0.3, 0, 0]) } }] }
  const pose = { coil: jointQuaternion([0.5, 0.2, 0.1]) }
  expect(pairedJoints(body)).toEqual([])
  expect(mirrorPose(body, pose, 'swap')).toBe(pose)
  sameRotation(resetJointPose(body, pose, 'coil').coil!, body.poses[0]!.joints.coil!)
  const fins = { ...body, joints: [{ ...root, id: 'frontLeftFin' }, { ...root, id: 'frontRightFin' }] }
  expect(pairedJoints(fins).map(pair => [pair.left.id, pair.right.id])).toEqual([['frontLeftFin', 'frontRightFin']])
})

it('sets one joint axis clamped to its limit before converting, so Y past 90 degrees never flips X and Z', () => {
  const radians = (degrees: Vec3) => degrees.map(value => value * Math.PI / 180) as Vec3
  const degrees = (rotation: Quat) => jointEuler(rotation).map(value => value * 180 / Math.PI)
  const elbow = HUMAN_BODY.joints.find(joint => joint.id === 'leftElbow')!
  const bent = jointQuaternion(radians([-40, 50, 0]))
  degrees(setJointAxis(elbow, bent, 1, 95 * Math.PI / 180)).forEach((value, axis) => expect(value).toBeCloseTo([-40, 80, 0][axis]!))
  degrees(setJointAxis(elbow, bent, 0, -200 * Math.PI / 180)).forEach((value, axis) => expect(value).toBeCloseTo([-150, 50, 0][axis]!))
  const neck = HUMAN_BODY.joints.find(joint => joint.id === 'neck')!
  degrees(setJointAxis(neck, jointQuaternion(radians([10, 55, -5])), 1, 100 * Math.PI / 180)).forEach((value, axis) => expect(value).toBeCloseTo([10, 55, -5][axis]!))
  // Within the limits it matches converting the edited angles and clamping, which is what the inspector did before.
  const edited = jointEuler(bent)
  edited[0] = -1
  sameRotation(setJointAxis(elbow, bent, 0, -1), clampJointRotation(elbow, jointQuaternion(edited)))
  sameRotation(setJointAxis(shoulder, [0, 0, 0, 0], 2, 0.5), jointQuaternion([0, 0, 0.5]))
})
