import { z } from 'zod'
import { Id, Revision } from './common'

// RFC 0037. Units are metres, Y is up, rotations are quaternions.
export const SCENE_LIMITS = { objects: 64, groupParts: 32, views: 32, name: 200, focalLengthMm: { min: 8, max: 300 }, heightM: { min: 0.1, max: 20 }, joints: 128 } as const

const Coordinate = z.number().finite()
export const Vec3 = z.tuple([Coordinate, Coordinate, Coordinate])
export type Vec3 = z.infer<typeof Vec3>
export const Quat = z.tuple([Coordinate, Coordinate, Coordinate, Coordinate])
export type Quat = z.infer<typeof Quat>

export const SceneTransform = z.strictObject({ position: Vec3, rotation: Quat, scale: Vec3 })
export type SceneTransform = z.infer<typeof SceneTransform>

export const ScenePrimitiveShape = z.enum(['box', 'cylinder', 'sphere', 'capsule', 'plane'])
export type ScenePrimitiveShape = z.infer<typeof ScenePrimitiveShape>

const Name = z.string().min(1).max(SCENE_LIMITS.name)

export const SceneObjectSource = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('figure'),
    bodyId: Id,
    heightM: z.number().min(SCENE_LIMITS.heightM.min).max(SCENE_LIMITS.heightM.max),
    pose: z.record(z.string().min(1).max(SCENE_LIMITS.name), Quat),
  }),
  z.strictObject({ type: z.literal('primitive'), shape: ScenePrimitiveShape, size: Vec3 }),
  z.strictObject({
    type: z.literal('group'),
    parts: z.array(z.strictObject({ name: Name, shape: ScenePrimitiveShape, size: Vec3, transform: SceneTransform })).min(1).max(SCENE_LIMITS.groupParts),
  }),
  z.strictObject({ type: z.literal('prop'), propId: Id }),
  z.strictObject({ type: z.literal('model'), assetVersionId: Id }),
])
export type SceneObjectSource = z.infer<typeof SceneObjectSource>

export const SceneObject = z.strictObject({
  id: Id,
  name: Name,
  transform: SceneTransform,
  hidden: z.boolean(),
  createdBy: z.enum(['user', 'agent']),
  // Stamped by the gateway from the document diff; a value sent by a client is never trusted.
  userTouched: z.boolean(),
  source: SceneObjectSource,
})
export type SceneObject = z.infer<typeof SceneObject>

export const SceneAspectRatio = z.enum(['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'])
export type SceneAspectRatio = z.infer<typeof SceneAspectRatio>

export const SceneView = z.strictObject({
  id: Id,
  name: Name,
  // focalLengthMm assumes a 36 mm sensor width.
  camera: z.strictObject({ position: Vec3, target: Vec3, roll: Coordinate, focalLengthMm: z.number().min(SCENE_LIMITS.focalLengthMm.min).max(SCENE_LIMITS.focalLengthMm.max) }),
  aspectRatio: SceneAspectRatio,
  // Latest frame saved from this view, shown on the card.
  still: Id.nullable(),
})
export type SceneView = z.infer<typeof SceneView>

export const SceneDoc = z.strictObject({
  version: z.literal(1),
  rev: Revision,
  objects: z.array(SceneObject).max(SCENE_LIMITS.objects),
  views: z.array(SceneView).max(SCENE_LIMITS.views),
}).superRefine((doc, ctx) => {
  for (const [key, items] of [['objects', doc.objects], ['views', doc.views]] as const) {
    const ids = new Set<string>()
    items.forEach((item, index) => {
      if (ids.has(item.id)) ctx.addIssue({ code: 'custom', path: [key, index, 'id'], message: 'IDs must be unique' })
      ids.add(item.id)
    })
  }
})
export type SceneDoc = z.infer<typeof SceneDoc>

export const EMPTY_SCENE: SceneDoc = { version: 1, rev: 0, objects: [], views: [] }

/** A panel's link back to the view its blockout came from. The panel keeps its picture without it. */
export const PrevizSceneRef = z.strictObject({ sceneNodeId: Id, viewId: Id, sceneRev: Revision })
export type PrevizSceneRef = z.infer<typeof PrevizSceneRef>
