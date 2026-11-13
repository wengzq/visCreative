import type { Quat, SceneCamera, SceneDoc, SceneEase, SceneTransform, Vec3 } from '@vis/protocol'
import { Quaternion } from 'three'

// RFC 0037 step c. One clock per scene: the editor and the render page both sample through here, so what the
// author scrubs to is what renders.

type Key<T> = { t: number, value: T, ease: SceneEase }

const lerp = (a: number, b: number, u: number) => a + (b - a) * u
const lerpVec3 = (a: Vec3, b: Vec3, u: number): Vec3 => [lerp(a[0], b[0], u), lerp(a[1], b[1], u), lerp(a[2], b[2], u)]
const slerp = (a: Quat, b: Quat, u: number): Quat => {
  // slerpQuaternions takes the shortest arc, so a key pair never spins the long way round.
  const result = new Quaternion().slerpQuaternions(normalized(a), normalized(b), u)
  return result.toArray() as Quat
}
const normalized = (value: Quat) => {
  const quaternion = new Quaternion(...value)
  return quaternion.lengthSq() > 0 ? quaternion.normalize() : quaternion.identity()
}

/** Progress through a segment after the earlier key's ease; `hold` keeps the earlier value until the next key. */
export function easeProgress(ease: SceneEase, u: number): number {
  if (ease === 'hold') return 0
  if (ease === 'easeInOut') return u * u * (3 - 2 * u)
  return u
}

/** Before the first key the first value holds, after the last key the last one does. */
function sampleTrack<T>(keys: readonly Key<T>[], timeS: number, mix: (a: T, b: T, u: number) => T): T {
  const first = keys[0]!
  if (timeS <= first.t) return first.value
  for (let index = 1; index < keys.length; index++) {
    const next = keys[index]!
    if (timeS < next.t) {
      const previous = keys[index - 1]!
      return mix(previous.value, next.value, easeProgress(previous.ease, (timeS - previous.t) / (next.t - previous.t)))
    }
  }
  return keys.at(-1)!.value
}

export const sampleTransform = (keys: readonly Key<SceneTransform>[], timeS: number) => sampleTrack(keys, timeS, (a, b, u) => ({
  position: lerpVec3(a.position, b.position, u),
  rotation: slerp(a.rotation, b.rotation, u),
  scale: lerpVec3(a.scale, b.scale, u),
}))

export const sampleRotation = (keys: readonly Key<Quat>[], timeS: number) => sampleTrack(keys, timeS, slerp)

export const sampleCamera = (keys: readonly Key<SceneCamera>[], timeS: number) => sampleTrack(keys, timeS, (a, b, u) => ({
  position: lerpVec3(a.position, b.position, u),
  target: lerpVec3(a.target, b.target, u),
  roll: lerp(a.roll, b.roll, u),
  focalLengthMm: lerp(a.focalLengthMm, b.focalLengthMm, u),
}))

/** Visibility is stepped: the latest key at or before t wins, and the first key holds before it. */
export function sampleHidden(keys: readonly { t: number, value: boolean }[], timeS: number): boolean {
  let value = keys[0]!.value
  for (const key of keys) if (key.t <= timeS) value = key.value
  return value
}

/**
 * The scene as it stands at `timeS`: a static document with every keyed property replaced by its sampled value and
 * no tracks left. Untracked properties keep their static values. Joint limits are not applied here; the builder
 * applies the body's limits to whatever pose it receives, keyed or not.
 */
export function sampleScene(doc: SceneDoc, timeS: number): SceneDoc {
  const time = Math.min(Math.max(timeS, 0), doc.durationS ?? 0)
  return {
    ...doc,
    objects: doc.objects.map(({ tracks, ...object }) => {
      if (!tracks) return object
      const source = tracks.pose && object.source.type === 'figure'
        ? { ...object.source, pose: { ...object.source.pose, ...Object.fromEntries(Object.entries(tracks.pose).map(([joint, keys]) => [joint, sampleRotation(keys, time)])) } }
        : object.source
      return {
        ...object,
        transform: tracks.transform ? sampleTransform(tracks.transform, time) : object.transform,
        hidden: tracks.hidden ? sampleHidden(tracks.hidden, time) : object.hidden,
        source,
      }
    }),
    views: doc.views.map(({ cameraKeys, ...view }) => cameraKeys ? { ...view, camera: sampleCamera(cameraKeys, time) } : view),
  }
}
