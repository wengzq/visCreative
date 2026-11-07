import type { Quat, ScenePrimitiveShape, SceneTransform, Vec3 } from '@vis/protocol'
import type { BodyDescriptor, BodyJoint, BodyPart, PropDescriptor } from './types'
import { jointQuaternion } from './pose'

const identity: Quat = [0, 0, 0, 1]
const transform = (position: Vec3, rotation: Quat = identity): SceneTransform => ({ position, rotation, scale: [1, 1, 1] })
const part = (shape: ScenePrimitiveShape, size: Vec3, position: Vec3 = [0, 0, 0]): BodyPart => ({ shape, size, transform: transform(position) })
const radians = (degrees: Vec3): Vec3 => degrees.map(value => value * Math.PI / 180) as Vec3
const joint = (id: string, parent: string | null, offset: Vec3, parts: BodyPart[], min: Vec3, max: Vec3): BodyJoint => ({
  id, parent, offset, parts, limits: { min: radians(min), max: radians(max) },
})

const humanJoints: BodyJoint[] = [
  joint('pelvis', null, [0, 0.94, 0], [part('box', [0.28, 0.2, 0.18])], [-30, -90, -30], [30, 90, 30]),
  joint('spine', 'pelvis', [0, 0.18, 0], [part('capsule', [0.28, 0.26, 0.2])], [-35, -40, -25], [35, 40, 25]),
  joint('chest', 'spine', [0, 0.25, 0], [part('capsule', [0.38, 0.36, 0.22], [0, -0.04, 0])], [-25, -35, -25], [25, 35, 25]),
  joint('neck', 'chest', [0, 0.19, 0], [part('cylinder', [0.1, 0.12, 0.1], [0, 0.03, 0])], [-35, -55, -35], [35, 55, 35]),
  joint('head', 'neck', [0, 0.11, 0], [part('sphere', [0.24, 0.26, 0.24])], [-25, -30, -20], [25, 30, 20]),
  ...(['left', 'right'] as const).flatMap(side => {
    // The mannequin faces +Z, so its anatomical left is +X.
    const sign = side === 'left' ? 1 : -1
    return [
      joint(`${side}Shoulder`, 'chest', [sign * 0.24, 0.07, 0], [part('sphere', [0.14, 0.14, 0.14]), part('capsule', [0.11, 0.29, 0.11], [0, -0.145, 0])], [-180, -90, -180], [180, 90, 180]),
      joint(`${side}Elbow`, `${side}Shoulder`, [0, -0.29, 0], [part('sphere', [0.1, 0.1, 0.1]), part('capsule', [0.09, 0.26, 0.09], [0, -0.13, 0])], [-150, -80, 0], [0, 80, 0]),
      joint(`${side}Wrist`, `${side}Elbow`, [0, -0.26, 0], [part('box', [0.09, 0.15, 0.045], [0, -0.055, 0])], [-70, -90, -25], [70, 90, 25]),
      joint(`${side}Hip`, 'pelvis', [sign * 0.11, -0.02, 0], [part('sphere', [0.16, 0.16, 0.16]), part('capsule', [0.15, 0.42, 0.15], [0, -0.21, 0])], [-120, -45, -45], [45, 45, 45]),
      joint(`${side}Knee`, `${side}Hip`, [0, -0.42, 0], [part('sphere', [0.12, 0.12, 0.12]), part('capsule', [0.12, 0.4, 0.12], [0, -0.2, 0])], [0, 0, 0], [150, 0, 0]),
      joint(`${side}Ankle`, `${side}Knee`, [0, -0.4, 0], [part('box', [0.13, 0.12, 0.25], [0, -0.04, 0.06])], [-40, -25, -20], [40, 25, 20]),
    ]
  }),
]

const pose = (id: string, angles: Record<string, Vec3> = {}): BodyDescriptor['poses'][number] => ({
  id,
  joints: Object.fromEntries(humanJoints.map(joint => [joint.id, jointQuaternion(radians(angles[joint.id] ?? [0, 0, 0]))])),
})

export const HUMAN_BODY: BodyDescriptor = {
  id: 'human',
  heightM: 1.8,
  joints: humanJoints,
  poses: [
    pose('standing'),
    pose('walking', {
      leftHip: [-30, 0, 0], rightHip: [25, 0, 0], leftKnee: [10, 0, 0], rightKnee: [40, 0, 0],
      leftShoulder: [25, 0, 0], rightShoulder: [-25, 0, 0], leftElbow: [-15, 0, 0], rightElbow: [-25, 0, 0],
    }),
    pose('sitting', {
      leftHip: [-90, 0, 0], rightHip: [-90, 0, 0], leftKnee: [90, 0, 0], rightKnee: [90, 0, 0],
      leftShoulder: [-20, 0, 0], rightShoulder: [-20, 0, 0], leftElbow: [-60, 0, 0], rightElbow: [-60, 0, 0],
    }),
    pose('pointing', { rightShoulder: [-80, 0, -15], rightElbow: [-10, 0, 0], rightWrist: [0, 0, 0] }),
  ],
}

const box = (name: string, size: Vec3, position: Vec3): PropDescriptor['parts'][number] => ({ name, shape: 'box', size, transform: transform(position) })
const legs = (width: number, depth: number, height: number) => [-1, 1].flatMap(x => [-1, 1].map(z => box(`leg-${x}-${z}`, [0.07, height, 0.07], [x * width / 2, height / 2, z * depth / 2])))

export const BUILTIN_BODIES: readonly BodyDescriptor[] = [HUMAN_BODY]
export const BUILTIN_PROPS: readonly PropDescriptor[] = [
  { id: 'bench', parts: [box('seat', [1.8, 0.1, 0.5], [0, 0.45, 0]), box('back', [1.8, 0.55, 0.07], [0, 0.77, -0.22]), ...legs(1.45, 0.34, 0.4)] },
  { id: 'chair', parts: [box('seat', [0.48, 0.08, 0.48], [0, 0.45, 0]), box('back', [0.48, 0.5, 0.06], [0, 0.73, -0.21]), ...legs(0.36, 0.36, 0.41)] },
  { id: 'table', parts: [box('top', [1.6, 0.08, 0.85], [0, 0.75, 0]), ...legs(1.4, 0.65, 0.71)] },
  { id: 'wall', parts: [box('wall', [3, 2.5, 0.16], [0, 1.25, 0])] },
  { id: 'door', parts: [box('door', [0.9, 2.1, 0.08], [0, 1.05, 0]), box('left-frame', [0.08, 2.2, 0.14], [-0.49, 1.1, 0]), box('right-frame', [0.08, 2.2, 0.14], [0.49, 1.1, 0]), box('top-frame', [1.06, 0.08, 0.14], [0, 2.16, 0])] },
  {
    id: 'car',
    parts: [
      box('chassis', [4.2, 0.55, 1.8], [0, 0.6, 0]), box('cabin', [2.1, 0.7, 1.65], [-0.1, 1.18, 0]),
      ...[-1, 1].flatMap(x => [-1, 1].map(z => ({
        name: `wheel-${x}-${z}`, shape: 'cylinder' as const, size: [0.7, 0.18, 0.7] as Vec3,
        transform: transform([x * 1.3, 0.35, z * 0.88], [Math.SQRT1_2, 0, 0, Math.SQRT1_2]),
      }))),
    ],
  },
]
