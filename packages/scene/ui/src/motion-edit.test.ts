import { EMPTY_SCENE, SCENE_LIMITS, SceneDoc, type SceneTransform } from '@vis/protocol'
import { jointQuaternion, sampleScene } from '@vis/scene-core'
import { describe, expect, it } from 'vitest'
import { changeMotionDuration, changeMotionKey, deleteMotionKey, editMotionObject, editMotionValue, keysPastDuration, motionKeys, setMotionKey, type MotionProperty } from './motion-edit'

const at = (x: number): SceneTransform => ({ position: [x, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] })
const transform: MotionProperty = { type: 'transform', id: 'hero' }
const hidden: MotionProperty = { type: 'hidden', id: 'hero' }
const joint: MotionProperty = { type: 'joint', id: 'hero', jointId: 'leftShoulder' }
const camera: MotionProperty = { type: 'camera', id: 'wide' }
const scene = (): SceneDoc => ({
  ...EMPTY_SCENE, durationS: 5,
  objects: [{
    id: 'hero', name: 'Hero', createdBy: 'user', userTouched: true, hidden: false, transform: at(0),
    source: { type: 'figure', bodyId: 'human', heightM: 1.8, pose: {} },
  }],
  views: [{
    id: 'wide', name: 'Wide', createdBy: 'user', userTouched: false, still: null, aspectRatio: '16:9',
    camera: { position: [0, 2, 5], target: [0, 1, 0], roll: 0, focalLengthMm: 35 },
  }],
})
const keyed = () => editMotionValue(setMotionKey(scene(), transform, 0), transform, 2, at(4))

describe('scene motion editing', () => {
  it('creates linear keys, inserts them in order, and updates without changing an existing ease', () => {
    let doc = keyed()
    doc = changeMotionKey(doc, transform, 0, { ease: 'hold' })
    doc = editMotionValue(doc, transform, 0, at(1))
    doc = setMotionKey(doc, transform, 1)
    expect(motionKeys(doc, transform)).toEqual([
      { t: 0, value: at(1), ease: 'hold' }, { t: 1, value: at(1), ease: 'linear' }, { t: 2, value: at(4), ease: 'linear' },
    ])
    expect(SceneDoc.safeParse(doc).success).toBe(true)
  })

  it('changes untracked properties statically and auto-keys tracked properties using sampled components', () => {
    const staticDoc = editMotionObject(scene(), 'hero', 1, object => ({ ...object, transform: at(8) }))
    expect(staticDoc.objects[0]!.transform).toEqual(at(8))
    expect(staticDoc.objects[0]!.tracks).toBeUndefined()
    const animated = editMotionObject(keyed(), 'hero', 1, object => ({
      ...object, name: 'Renamed', transform: { ...object.transform, position: [object.transform.position[0], 3, 0] },
    }))
    expect(motionKeys(animated, transform)[1]).toMatchObject({ t: 1, value: { position: [2, 3, 0] }, ease: 'linear' })
    expect(animated.objects[0]!.transform).toEqual(at(0))
    expect(animated.objects[0]!.name).toBe('Renamed')
  })

  it('removes a track on its last key and keeps that key as its static value for every property type', () => {
    for (const property of [transform, hidden, joint, camera]) {
      let doc = setMotionKey(scene(), property, 2)
      const value = property.type === 'transform' ? at(9) : property.type === 'hidden' ? true
        : property.type === 'joint' ? jointQuaternion([0.2, 0.1, 0]) : { ...doc.views[0]!.camera, focalLengthMm: 85 }
      doc = editMotionValue(doc, property, 2, value)
      doc = deleteMotionKey(doc, property, 2)
      expect(motionKeys(doc, property)).toEqual([])
      const sampled = sampleScene(doc, 0)
      if (property.type === 'transform') expect(sampled.objects[0]!.transform).toEqual(value)
      if (property.type === 'hidden') expect(sampled.objects[0]!.hidden).toBe(value)
      if (property.type === 'camera') expect(sampled.views[0]!.camera).toEqual(value)
      if (property.type === 'joint') {
        const source = sampled.objects[0]!.source
        expect(source.type === 'figure' && source.pose.leftShoulder).toEqual(value)
      }
      expect(doc.objects[0]!.tracks).toBeUndefined()
      expect(SceneDoc.safeParse(doc).success).toBe(true)
    }
  })

  it('removes just the chosen key from a longer track and preserves the static value', () => {
    const doc = deleteMotionKey(keyed(), transform, 0)
    expect(motionKeys(doc, transform)).toHaveLength(1)
    expect(doc.objects[0]!.transform).toEqual(at(0))
  })

  it('rejects collisions and times outside the duration and reorders a valid moved key', () => {
    const doc = keyed()
    for (const t of [-1, 2, 6, NaN]) expect(changeMotionKey(doc, transform, 0, { t })).toBe(doc)
    const moved = changeMotionKey(doc, transform, 0, { t: 3 })
    expect(motionKeys(moved, transform).map(key => key.t)).toEqual([2, 3])
    expect(motionKeys(moved, transform)[1]!.value).toEqual(at(0))
    expect(editMotionValue(doc, transform, 6, at(2))).toBe(doc)
  })

  it('uses no ease field for visibility, including when moving a key', () => {
    const doc = changeMotionKey(setMotionKey(scene(), hidden, 0), hidden, 0, { t: 1, ease: 'hold' })
    expect(motionKeys(doc, hidden)).toEqual([{ t: 1, value: false }])
    expect(SceneDoc.safeParse(doc).success).toBe(true)
  })

  it('auto-keys pose resets and camera edits while preserving other joints and camera components', () => {
    let doc = setMotionKey(scene(), joint, 0)
    const rotation = jointQuaternion([0.5, 0, 0])
    doc = editMotionObject(doc, 'hero', 2, object => object.source.type === 'figure'
      ? { ...object, source: { ...object.source, pose: { ...object.source.pose, leftShoulder: rotation } } } : object)
    doc = editMotionObject(doc, 'hero', 2, object => object.source.type === 'figure'
      ? { ...object, source: { ...object.source, pose: {} } } : object)
    expect(motionKeys(doc, joint)[1]).toMatchObject({ t: 2, value: [0, 0, 0, 1] })
    doc = setMotionKey(doc, camera, 0)
    doc = editMotionValue(doc, camera, 2, { ...doc.views[0]!.camera, focalLengthMm: 85 })
    expect(sampleScene(doc, 1).views[0]!.camera.focalLengthMm).toBe(60)
  })

  it('counts and trims keys across every view and object, keeping keys on the new end', () => {
    let doc = keyed()
    for (const property of [hidden, joint, camera]) doc = setMotionKey(doc, property, 4)
    expect(keysPastDuration(doc, 2)).toBe(3)
    const next = changeMotionDuration(doc, 2)
    expect(next.durationS).toBe(2)
    expect(motionKeys(next, transform).map(key => key.t)).toEqual([0, 2])
    expect(keysPastDuration(next, 2)).toBe(0)
    expect(SceneDoc.safeParse(next).success).toBe(true)
    expect(changeMotionDuration(next, 0)).toBe(next)
    expect(changeMotionDuration(next, 121)).toBe(next)
  })

  it('leaves the static document intact if asked to key before adding motion or beyond key limits', () => {
    const { durationS, ...staticDoc } = scene()
    expect(setMotionKey(staticDoc, transform, 0)).toBe(staticDoc)
    const doc = scene()
    doc.objects[0]!.tracks = { transform: Array.from({ length: SCENE_LIMITS.keysPerTrack }, (_, index) => ({ t: index / 128, value: at(index), ease: 'linear' })) }
    expect(setMotionKey(doc, transform, 5)).toBe(doc)
  })
})
