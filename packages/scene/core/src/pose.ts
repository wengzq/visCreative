import type { Quat, Vec3 } from '@vis/protocol'
import { Euler, Quaternion } from 'three'
import type { BodyDescriptor, BodyJoint } from './types'

export type BodyPose = Record<string, Quat>
export type PoseMirror = 'leftToRight' | 'rightToLeft' | 'swap'
const identity: Quat = [0, 0, 0, 1]

export function jointEuler(rotation: Quat): Vec3 {
  const quaternion = new Quaternion(...rotation)
  if (quaternion.lengthSq() === 0) quaternion.identity()
  else quaternion.normalize()
  const euler = new Euler().setFromQuaternion(quaternion, 'XYZ')
  return [euler.x, euler.y, euler.z]
}

export function jointQuaternion(angles: Vec3): Quat {
  return new Quaternion().setFromEuler(new Euler(...angles, 'XYZ')).toArray().map(value => Object.is(value, -0) ? 0 : value) as Quat
}

export function clampJointRotation(joint: BodyJoint, rotation: Quat): Quat {
  const distance = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)))
  const angles = jointEuler(rotation).map((value, axis) => {
    const min = joint.limits.min[axis]!
    const max = joint.limits.max[axis]!
    if (value >= min && value <= max) return value
    // Quaternion conversion wraps at pi; choose the nearby stop instead of snapping to the other end.
    return distance(value, min) <= distance(value, max) ? min : max
  }) as Vec3
  return jointQuaternion(angles)
}

export function standingRotation(body: BodyDescriptor, joint: BodyJoint): Quat {
  const standing = body.poses.find(pose => pose.id === 'standing') ?? body.poses[0]
  return clampJointRotation(joint, standing?.joints[joint.id] ?? identity)
}

export function poseRotation(body: BodyDescriptor, pose: BodyPose, joint: BodyJoint): Quat {
  return pose[joint.id] ? clampJointRotation(joint, pose[joint.id]!) : standingRotation(body, joint)
}

export function presetPose(body: BodyDescriptor, presetId = 'standing'): BodyPose {
  const preset = body.poses.find(pose => pose.id === presetId)
  return Object.fromEntries(body.joints.map(joint => [joint.id, poseRotation(body, preset?.joints ?? {}, joint)]))
}

export function resetJointPose(body: BodyDescriptor, pose: BodyPose, jointId: string): BodyPose {
  const joint = body.joints.find(joint => joint.id === jointId)
  return joint ? { ...pose, [joint.id]: standingRotation(body, joint) } : pose
}

export function pairedJoints(body: BodyDescriptor): { left: BodyJoint; right: BodyJoint }[] {
  const joints = new Map(body.joints.map(joint => [joint.id, joint]))
  return body.joints.flatMap(left => {
    const rightId = left.id.replace(/left/i, side => side === 'LEFT' ? 'RIGHT' : side === 'Left' ? 'Right' : 'right')
    const right = rightId === left.id ? undefined : joints.get(rightId)
    return right ? [{ left, right }] : []
  })
}

// Reflecting across X=0 negates the Y and Z components of an axial rotation.
export function reflectJointRotation(rotation: Quat): Quat {
  return [rotation[0], -rotation[1], -rotation[2], rotation[3]]
}

export function mirrorPose(body: BodyDescriptor, pose: BodyPose, direction: PoseMirror): BodyPose {
  const pairs = pairedJoints(body)
  if (!pairs.length) return pose
  const result = { ...pose }
  const paired = new Set(pairs.flatMap(({ left, right }) => [left.id, right.id]))
  const copy = (source: BodyJoint, target: BodyJoint) => {
    if (direction === 'swap' && !pose[source.id]) { delete result[target.id]; return }
    result[target.id] = clampJointRotation(target, reflectJointRotation(poseRotation(body, pose, source)))
  }
  for (const { left, right } of pairs) {
    if (direction !== 'rightToLeft') copy(left, right)
    if (direction !== 'leftToRight') copy(right, left)
  }
  if (direction === 'swap') {
    for (const joint of body.joints) {
      if (!paired.has(joint.id) && pose[joint.id]) result[joint.id] = clampJointRotation(joint, reflectJointRotation(pose[joint.id]!))
    }
  }
  return result
}
