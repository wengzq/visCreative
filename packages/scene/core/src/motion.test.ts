import { EMPTY_SCENE, type Quat, type SceneCamera, type SceneDoc, type SceneObject, type SceneTransform } from '@vis/protocol'
import { describe, expect, it } from 'vitest'
import { easeProgress, sampleHidden, sampleScene } from './motion'

const at = (x: number, rotation: Quat = [0, 0, 0, 1]): SceneTransform => ({ position: [x, 0, 0], rotation, scale: [1, 1, 1] })
const camera = (focalLengthMm: number): SceneCamera => ({ position: [0, 2, 5], target: [0, 1, 0], roll: 0, focalLengthMm })
const halfTurn: Quat = [0, Math.SQRT1_2, 0, Math.SQRT1_2] // 90 degrees around Y
const figure = (tracks: SceneObject['tracks']): SceneObject => ({
  id: 'hero', name: 'Hero', transform: at(9), hidden: false, createdBy: 'user', userTouched: true,
  source: { type: 'figure', bodyId: 'human', heightM: 1.75, pose: { spine: [0, 0, 0, 1], neck: halfTurn } }, tracks,
})
const scene = (objects: SceneObject[], cameraKeys?: { t: number, value: SceneCamera, ease: 'linear' | 'easeInOut' | 'hold' }[]): SceneDoc => ({
  ...EMPTY_SCENE, durationS: 4, objects,
  views: [{ id: 'wide', name: 'Wide', camera: camera(35), aspectRatio: '16:9', still: null, createdBy: 'user', userTouched: false, ...(cameraKeys ? { cameraKeys } : {}) }],
})

describe('sampleScene', () => {
  it('interpolates per the earlier key ease and holds outside the keys', () => {
    const doc = scene([figure({ transform: [
      { t: 1, value: at(0), ease: 'linear' }, { t: 2, value: at(10), ease: 'easeInOut' }, { t: 3, value: at(20), ease: 'hold' }, { t: 4, value: at(30), ease: 'linear' },
    ] })])
    const x = (t: number) => sampleScene(doc, t).objects[0]!.transform.position[0]
    expect(x(0)).toBe(0)
    expect(x(1.5)).toBeCloseTo(5)
    expect(x(2.25)).toBeCloseTo(10 + 10 * easeProgress('easeInOut', 0.25))
    expect(x(2.25)).toBeLessThan(12.5)
    expect(x(3.9)).toBe(20)
    expect(x(4)).toBe(30)
    expect(x(99)).toBe(30)
  })

  it('removes tracks and keeps untracked properties static', () => {
    const doc = scene([figure({ hidden: [{ t: 0, value: true }, { t: 2, value: false }] })])
    const sampled = sampleScene(doc, 1).objects[0]!
    expect(sampled).not.toHaveProperty('tracks')
    expect(sampled.transform).toEqual(at(9))
    expect(sampled.hidden).toBe(true)
    expect(sampleScene(doc, 2).objects[0]!.hidden).toBe(false)
  })

  it('slerps keyed joints and leaves the other joints of the pose alone', () => {
    const doc = scene([figure({ pose: { spine: [{ t: 0, value: [0, 0, 0, 1], ease: 'linear' }, { t: 4, value: halfTurn, ease: 'linear' }] } })])
    const source = sampleScene(doc, 2).objects[0]!.source
    if (source.type !== 'figure') throw new Error('expected a figure')
    const angle = 2 * Math.acos(source.pose.spine![3])
    expect(angle).toBeCloseTo(Math.PI / 4)
    expect(source.pose.neck).toEqual(halfTurn)
  })

  it('samples each view camera on the shared clock', () => {
    const doc = scene([], [{ t: 0, value: camera(24), ease: 'linear' }, { t: 4, value: camera(85), ease: 'linear' }])
    const view = sampleScene(doc, 1).views[0]!
    expect(view.camera.focalLengthMm).toBeCloseTo(24 + (85 - 24) / 4)
    expect(view).not.toHaveProperty('cameraKeys')
  })

  it('treats the first visibility key as holding before it', () => {
    expect(sampleHidden([{ t: 1, value: true }], 0)).toBe(true)
  })
})
