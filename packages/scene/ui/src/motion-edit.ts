import { SceneDoc, type Quat, type SceneCamera, type SceneEase, type SceneObject, type SceneTransform } from '@vis/protocol'
import { BUILTIN_BODIES, poseRotation, sampleScene } from '@vis/scene-core'

export type MotionProperty =
  | { type: 'transform' | 'hidden'; id: string }
  | { type: 'joint'; id: string; jointId: string }
  | { type: 'camera'; id: string }
type MotionValue = SceneTransform | SceneCamera | Quat | boolean
export type MotionKey = { t: number; value: MotionValue; ease?: SceneEase }
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const valid = (before: SceneDoc, next: SceneDoc): SceneDoc => SceneDoc.safeParse(next).success ? next : before

export const propertyId = (property: MotionProperty) => JSON.stringify(property)
export function motionKeys(doc: SceneDoc, property: MotionProperty): readonly MotionKey[] {
  if (property.type === 'camera') return doc.views.find(view => view.id === property.id)?.cameraKeys ?? []
  const tracks = doc.objects.find(object => object.id === property.id)?.tracks
  return (property.type === 'joint' ? tracks?.pose?.[property.jointId] : tracks?.[property.type]) ?? []
}

function jointValue(object: SceneObject, jointId: string): Quat {
  const source = object.source
  if (source.type !== 'figure') return [0, 0, 0, 1]
  const body = BUILTIN_BODIES.find(body => body.id === source.bodyId)
  const joint = body?.joints.find(joint => joint.id === jointId)
  return body && joint ? poseRotation(body, source.pose, joint) : source.pose[jointId] ?? [0, 0, 0, 1]
}

function propertyValue(doc: SceneDoc, property: MotionProperty): MotionValue | undefined {
  if (property.type === 'camera') return doc.views.find(view => view.id === property.id)?.camera
  const object = doc.objects.find(object => object.id === property.id)
  return object ? property.type === 'joint' ? jointValue(object, property.jointId) : object[property.type] : undefined
}

function writeStatic(doc: SceneDoc, property: MotionProperty, value: MotionValue): SceneDoc {
  if (property.type === 'camera') return { ...doc, views: doc.views.map(view => view.id === property.id ? { ...view, camera: value as SceneCamera } : view) }
  return { ...doc, objects: doc.objects.map(object => {
    if (object.id !== property.id) return object
    if (property.type === 'joint') return object.source.type === 'figure'
      ? { ...object, source: { ...object.source, pose: { ...object.source.pose, [property.jointId]: value as Quat } } } : object
    if (property.type === 'hidden') return { ...object, hidden: value as boolean }
    return { ...object, transform: value as SceneTransform }
  }) }
}

function writeKeys(doc: SceneDoc, property: MotionProperty, keys: readonly MotionKey[]): SceneDoc {
  if (property.type === 'camera') return { ...doc, views: doc.views.map(view => {
    if (view.id !== property.id) return view
    const { cameraKeys, ...rest } = view
    return keys.length ? { ...rest, cameraKeys: keys as NonNullable<typeof cameraKeys> } : rest
  }) }
  return { ...doc, objects: doc.objects.map(object => {
    if (object.id !== property.id) return object
    const { tracks: oldTracks, ...rest } = object
    const tracks = { ...oldTracks }
    if (property.type === 'joint') {
      const pose = { ...tracks.pose }
      if (keys.length) pose[property.jointId] = keys as NonNullable<typeof tracks.pose>[string]
      else delete pose[property.jointId]
      if (Object.keys(pose).length) tracks.pose = pose
      else delete tracks.pose
    } else if (!keys.length) delete tracks[property.type]
    else if (property.type === 'hidden') tracks.hidden = keys as NonNullable<typeof tracks.hidden>
    else tracks.transform = keys as NonNullable<typeof tracks.transform>
    return Object.keys(tracks).length ? { ...rest, tracks } : rest
  }) }
}

/** A tracked edit replaces the entire sampled property, preserving its other components and the key's ease. */
export function editMotionValue(doc: SceneDoc, property: MotionProperty, timeS: number, value: MotionValue, forceKey = false): SceneDoc {
  const keys = motionKeys(doc, property)
  if (!keys.length && !forceKey) return valid(doc, writeStatic(doc, property, value))
  if (doc.durationS === undefined || !Number.isFinite(timeS) || timeS < 0 || timeS > doc.durationS) return doc
  const previous = keys.find(key => key.t === timeS)
  const key: MotionKey = property.type === 'hidden' ? { t: timeS, value } : { t: timeS, value, ease: previous?.ease ?? 'linear' }
  return valid(doc, writeKeys(doc, property, [...keys.filter(key => key.t !== timeS), key].sort((a, b) => a.t - b.t)))
}

export function setMotionKey(doc: SceneDoc, property: MotionProperty, timeS: number): SceneDoc {
  const value = propertyValue(sampleScene(doc, timeS), property)
  return value === undefined ? doc : editMotionValue(doc, property, timeS, value, true)
}

export function deleteMotionKey(doc: SceneDoc, property: MotionProperty, timeS: number): SceneDoc {
  const keys = motionKeys(doc, property)
  const key = keys.find(key => key.t === timeS)
  if (!key) return doc
  const next = writeKeys(doc, property, keys.filter(key => key.t !== timeS))
  return keys.length === 1 ? writeStatic(next, property, key.value) : next
}

export function changeMotionKey(doc: SceneDoc, property: MotionProperty, timeS: number, change: { t?: number; ease?: SceneEase }): SceneDoc {
  const keys = motionKeys(doc, property)
  if (!keys.some(key => key.t === timeS)) return doc
  const next = keys.map(key => key.t !== timeS ? key : property.type === 'hidden'
    ? { t: change.t ?? key.t, value: key.value } : { ...key, ...change })
  return valid(doc, writeKeys(doc, property, next.sort((a, b) => a.t - b.t)))
}

export function motionProperties(doc: SceneDoc): MotionProperty[] {
  return [
    ...doc.objects.flatMap(object => [
      { type: 'transform' as const, id: object.id }, { type: 'hidden' as const, id: object.id },
      ...Object.keys(object.tracks?.pose ?? {}).map(jointId => ({ type: 'joint' as const, id: object.id, jointId })),
    ]),
    ...doc.views.map(view => ({ type: 'camera' as const, id: view.id })),
  ]
}

export const keysPastDuration = (doc: SceneDoc, durationS: number) => motionProperties(doc).reduce((count, property) =>
  count + motionKeys(doc, property).filter(key => key.t > durationS).length, 0)

export function changeMotionDuration(doc: SceneDoc, durationS: number): SceneDoc {
  let next = doc
  for (const property of motionProperties(doc)) {
    for (const key of motionKeys(doc, property)) if (key.t > durationS) next = deleteMotionKey(next, property, key.t)
  }
  return valid(doc, { ...next, durationS })
}

export function editMotionObject(doc: SceneDoc, objectId: string, timeS: number, change: (object: SceneObject) => SceneObject): SceneDoc {
  const sampled = sampleScene(doc, timeS).objects.find(object => object.id === objectId)
  if (!sampled) return doc
  const changed = change(sampled)
  // Non-keyable fields keep today's static editing semantics; tracks always belong to the original document.
  let next = { ...doc, objects: doc.objects.map(object => object.id === objectId
    ? { ...object, name: changed.name, source: changed.source.type === 'figure' && object.source.type === 'figure'
      ? { ...changed.source, pose: object.source.pose } : changed.source } : object) }
  if (!equal(changed.transform, sampled.transform)) next = editMotionValue(next, { type: 'transform', id: objectId }, timeS, changed.transform)
  if (changed.hidden !== sampled.hidden) next = editMotionValue(next, { type: 'hidden', id: objectId }, timeS, changed.hidden)
  if (changed.source.type === 'figure' && sampled.source.type === 'figure') {
    for (const jointId of new Set([...Object.keys(sampled.source.pose), ...Object.keys(changed.source.pose)])) {
      const value = jointValue(changed, jointId)
      if (!equal(value, jointValue(sampled, jointId))) next = editMotionValue(next, { type: 'joint', id: objectId, jointId }, timeS, value)
    }
  }
  return valid(doc, next)
}
