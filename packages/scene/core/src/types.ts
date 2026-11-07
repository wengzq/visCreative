import type { Quat, ScenePrimitiveShape, SceneTransform, Vec3 } from '@vis/protocol'

// A body is data: adding an animal is one more descriptor, with no mesh file and no code change.
export type BodyPart = { shape: ScenePrimitiveShape; size: Vec3; transform: SceneTransform }
export type BodyJoint = {
  id: string
  parent: string | null
  offset: Vec3
  parts: BodyPart[]
  // Euler limits in radians, per axis.
  limits: { min: Vec3; max: Vec3 }
}
export type BodyDescriptor = {
  id: string
  heightM: number
  joints: BodyJoint[]
  // Preset poses belong to one body: a human pose does not fit a four-legged body.
  poses: { id: string; joints: Record<string, Quat> }[]
}
export type PropDescriptor = { id: string; parts: { name: string; shape: ScenePrimitiveShape; size: Vec3; transform: SceneTransform }[] }
