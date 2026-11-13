import { z } from 'zod'
import { Id, RequestId, Revision } from './common'

// RFC 0037. Units are metres, Y is up, rotations are quaternions.
export const SCENE_LIMITS = { objects: 64, groupParts: 32, views: 32, name: 200, focalLengthMm: { min: 8, max: 300 }, heightM: { min: 0.1, max: 20 }, joints: 128,
  // Step c: one clock per scene. Keys are counted across every track of the document.
  durationS: { min: 0.1, max: 120 }, keysPerTrack: 512, keys: 8192 } as const

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

// Step c. A key's ease shapes the segment from that key to the next: linear, smoothstep, or hold its value.
export const SceneEase = z.enum(['linear', 'easeInOut', 'hold'])
export type SceneEase = z.infer<typeof SceneEase>
const KeyTime = z.number().finite().min(0).max(SCENE_LIMITS.durationS.max)
const key = <T extends z.ZodType>(value: T) => z.strictObject({ t: KeyTime, value, ease: SceneEase })
const track = <T extends z.ZodType>(value: T) => z.array(key(value)).min(1).max(SCENE_LIMITS.keysPerTrack)

export const SceneCamera = z.strictObject({
  position: Vec3, target: Vec3, roll: Coordinate,
  // Assumes a 36 mm sensor width.
  focalLengthMm: z.number().min(SCENE_LIMITS.focalLengthMm.min).max(SCENE_LIMITS.focalLengthMm.max),
})
export type SceneCamera = z.infer<typeof SceneCamera>

/** A keyed property takes its track's value at time t; a property without a track keeps its static value. */
export const SceneObjectTracks = z.strictObject({
  transform: track(SceneTransform).optional(),
  // Figures only, keyed by joint id. Joint limits apply after interpolation.
  pose: z.record(z.string().min(1).max(SCENE_LIMITS.name), track(Quat)).optional(),
  // Visibility is stepped, so its keys carry no ease.
  hidden: z.array(z.strictObject({ t: KeyTime, value: z.boolean() })).min(1).max(SCENE_LIMITS.keysPerTrack).optional(),
})
export type SceneObjectTracks = z.infer<typeof SceneObjectTracks>

const CreatedBy = z.enum(['user', 'agent'])

export const SceneObject = z.strictObject({
  id: Id,
  name: Name,
  transform: SceneTransform,
  hidden: z.boolean(),
  createdBy: CreatedBy,
  // Stamped by the gateway from the document diff; a value sent by a client is never trusted.
  userTouched: z.boolean(),
  source: SceneObjectSource,
  tracks: SceneObjectTracks.optional(),
})
export type SceneObject = z.infer<typeof SceneObject>

export const SceneAspectRatio = z.enum(['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'])
export type SceneAspectRatio = z.infer<typeof SceneAspectRatio>

export const SceneView = z.strictObject({
  id: Id,
  name: Name,
  camera: SceneCamera,
  aspectRatio: SceneAspectRatio,
  // Latest frame saved from this view, shown on the card. An output pointer: it never counts as touching the view.
  still: Id.nullable(),
  cameraKeys: track(SceneCamera).optional(),
  // Step d: same protection as objects. Defaults keep documents written before step d valid; they are views the user made.
  createdBy: CreatedBy.default('user'),
  userTouched: z.boolean().default(false),
})
export type SceneView = z.infer<typeof SceneView>

export const SceneDoc = z.strictObject({
  version: z.literal(1),
  rev: Revision,
  objects: z.array(SceneObject).max(SCENE_LIMITS.objects),
  views: z.array(SceneView).max(SCENE_LIMITS.views),
  // Step c: absent means a static scene. Any track requires it, and no key may lie past it.
  durationS: z.number().min(SCENE_LIMITS.durationS.min).max(SCENE_LIMITS.durationS.max).optional(),
}).superRefine((doc, ctx) => {
  for (const [key, items] of [['objects', doc.objects], ['views', doc.views]] as const) {
    const ids = new Set<string>()
    items.forEach((item, index) => {
      if (ids.has(item.id)) ctx.addIssue({ code: 'custom', path: [key, index, 'id'], message: 'IDs must be unique' })
      ids.add(item.id)
    })
  }
  let keys = 0
  const checkTrack = (times: readonly number[], path: (string | number)[]) => {
    keys += times.length
    if (doc.durationS === undefined) ctx.addIssue({ code: 'custom', path, message: 'Keyframes require durationS' })
    else if (times.some(time => time > doc.durationS!)) ctx.addIssue({ code: 'custom', path, message: 'Keyframes must lie within durationS' })
    if (times.some((time, index) => index > 0 && time <= times[index - 1]!)) ctx.addIssue({ code: 'custom', path, message: 'Keyframe times must increase strictly' })
  }
  doc.objects.forEach((object, index) => {
    const tracks = object.tracks
    if (!tracks) return
    if (tracks.transform) checkTrack(tracks.transform.map(k => k.t), ['objects', index, 'tracks', 'transform'])
    if (tracks.hidden) checkTrack(tracks.hidden.map(k => k.t), ['objects', index, 'tracks', 'hidden'])
    if (tracks.pose) {
      if (object.source.type !== 'figure') ctx.addIssue({ code: 'custom', path: ['objects', index, 'tracks', 'pose'], message: 'Only figures have pose tracks' })
      for (const [joint, poseTrack] of Object.entries(tracks.pose)) checkTrack(poseTrack.map(k => k.t), ['objects', index, 'tracks', 'pose', joint])
    }
  })
  doc.views.forEach((view, index) => { if (view.cameraKeys) checkTrack(view.cameraKeys.map(k => k.t), ['views', index, 'cameraKeys']) })
  if (keys > SCENE_LIMITS.keys) ctx.addIssue({ code: 'custom', path: [], message: `At most ${SCENE_LIMITS.keys} keyframes per scene` })
})
export type SceneDoc = z.infer<typeof SceneDoc>

export const EMPTY_SCENE: SceneDoc = { version: 1, rev: 0, objects: [], views: [] }

/** A panel's link back to the view its blockout came from. The panel keeps its picture without it. */
export const PrevizSceneRef = z.strictObject({ sceneNodeId: Id, viewId: Id, sceneRev: Revision })
export type PrevizSceneRef = z.infer<typeof PrevizSceneRef>


// Proposals carry content only; ownership and view stills remain server-controlled.
export const SceneObjectContent = SceneObject.omit({ createdBy: true, userTouched: true })
export type SceneObjectContent = z.infer<typeof SceneObjectContent>
export const SceneViewContent = SceneView.omit({ createdBy: true, userTouched: true, still: true })
export type SceneViewContent = z.infer<typeof SceneViewContent>
const Duration = z.number().min(SCENE_LIMITS.durationS.min).max(SCENE_LIMITS.durationS.max).nullable()
const ChangeInputs = [
  z.strictObject({ target: z.literal('object'), id: Id, action: z.literal('update'), item: SceneObjectContent }),
  z.strictObject({ target: z.literal('object'), id: Id, action: z.literal('delete') }),
  z.strictObject({ target: z.literal('view'), id: Id, action: z.literal('update'), item: SceneViewContent }),
  z.strictObject({ target: z.literal('view'), id: Id, action: z.literal('delete') }),
  z.strictObject({ target: z.literal('duration'), durationS: Duration }),
] as const
export const SceneChangeInput = z.union(ChangeInputs)
export type SceneChangeInput = z.infer<typeof SceneChangeInput>
const ChangeState = { changeId: Id, status: z.enum(['pending', 'accepted', 'rejected', 'stale', 'superseded']) }
export const SceneChange = z.union([
  ChangeInputs[0].extend({ ...ChangeState, base: SceneObjectContent }),
  ChangeInputs[1].extend({ ...ChangeState, base: SceneObjectContent }),
  ChangeInputs[2].extend({ ...ChangeState, base: SceneViewContent }),
  ChangeInputs[3].extend({ ...ChangeState, base: SceneViewContent }),
  ChangeInputs[4].extend({ ...ChangeState, base: Duration }),
])
export type SceneChange = z.infer<typeof SceneChange>
export const SceneProposal = z.strictObject({
  proposalId: Id, nodeId: Id, slotId: Id, baseRevision: Revision, sessionId: Id,
  summary: z.string().trim().min(1).max(2000), changes: z.array(SceneChange).min(1).max(97),
  status: z.enum(['open', 'resolved']), createdAt: z.int(),
})
export type SceneProposal = z.infer<typeof SceneProposal>
export const SceneChangeRef = z.strictObject({ proposalId: Id, changeId: Id })
export type SceneChangeRef = z.infer<typeof SceneChangeRef>
const ChangeRefs = z.array(SceneChangeRef).min(1).max(1940)
  .refine(refs => new Set(refs.map(ref => `${ref.proposalId}/${ref.changeId}`)).size === refs.length, 'Change references must be unique')
export const scene = {
  propose: {
    params: z.strictObject({ requestId: RequestId, slotId: Id, baseRevision: Revision, summary: z.string().trim().min(1).max(2000), changes: z.array(SceneChangeInput).min(1).max(97) }),
    result: SceneProposal,
  },
  proposalList: {
    params: z.object({ slotId: Id.optional(), status: z.enum(['open', 'resolved', 'all']).default('open') }),
    result: z.object({ proposals: z.array(SceneProposal) }),
  },
  proposalResolve: {
    params: z.discriminatedUnion('action', [
      z.strictObject({ requestId: RequestId, slotId: Id, action: z.literal('accept'), changes: ChangeRefs, expectedRevision: Revision }),
      z.strictObject({ requestId: RequestId, slotId: Id, action: z.literal('reject'), changes: ChangeRefs }),
    ]),
    result: z.object({ proposals: z.array(SceneProposal), revision: Revision.optional() }),
  },
} as const
