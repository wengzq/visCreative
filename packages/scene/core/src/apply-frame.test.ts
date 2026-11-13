import { expect, it } from 'vitest'
import { SceneDoc } from '@vis/protocol'
import { Quaternion } from 'three'
import { applySceneFrame } from './apply-frame'
import { buildScene } from './build-scene'
import { disposeScene } from './dispose'
import { sampleScene } from './motion'
import { jointQuaternion } from './pose'

it('matches rebuilding sampled transforms, visibility, limited poses and cameras while retaining built resources', async () => {
  const transform = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }
  const camera = { position: [0, 1, 5], target: [0, 1, 0], roll: 0, focalLengthMm: 35 }
  const doc = SceneDoc.parse({
    version: 1, rev: 0, durationS: 1,
    objects: [{
      id: 'figure', name: 'Figure', transform, hidden: false, createdBy: 'user', userTouched: false,
      source: { type: 'figure', bodyId: 'human', heightM: 1.8, pose: {} },
      tracks: {
        transform: [{ t: 0, value: transform, ease: 'linear' }, { t: 1, value: { ...transform, position: [2, 1, 0], scale: [2, 2, 2] }, ease: 'linear' }],
        pose: { leftKnee: [{ t: 0, value: [0, 0, 0, 1], ease: 'linear' }, { t: 1, value: jointQuaternion([-1, 0.7, 0.2]), ease: 'linear' }] },
        hidden: [{ t: 0, value: false }, { t: 0.75, value: true }],
      },
    }],
    views: [{ id: 'wide', name: 'Wide', aspectRatio: '16:9', still: null, camera, cameraKeys: [
      { t: 0, value: camera, ease: 'linear' },
      { t: 1, value: { ...camera, position: [3, 2, 5], roll: 0.3, focalLengthMm: 70 }, ease: 'linear' },
    ] }],
  })
  const built = await buildScene(doc, 'wide')
  const object = built.objects.get('figure')!
  const originalCamera = built.camera
  const children = [...object.children]
  try {
    for (const time of [1, 0.5, 0, 0.8, 0.25]) {
      const frame = sampleScene(doc, time)
      const expected = await buildScene(frame, 'wide')
      try {
        applySceneFrame(built, frame, 'wide')
        expect(built.camera).toBe(originalCamera)
        expect(built.objects.get('figure')).toBe(object)
        expect(object.children).toEqual(children)
        expect(object.matrixWorld.elements).toEqual(expected.objects.get('figure')!.matrixWorld.elements)
        expect(object.visible).toBe(expected.objects.get('figure')!.visible)
        expect(built.camera.matrixWorld.elements).toEqual(expected.camera.matrixWorld.elements)
        expect(built.camera.projectionMatrix.elements).toEqual(expected.camera.projectionMatrix.elements)
        for (const [id, joint] of built.joints.get('figure')!) {
          expect(joint.quaternion.angleTo(expected.joints.get('figure')!.get(id)!.quaternion)).toBeCloseTo(0)
        }
      } finally {
        disposeScene(expected.scene)
      }
    }
    expect(built.joints.get('figure')!.get('leftKnee')!.quaternion.angleTo(new Quaternion())).toBeLessThan(0.4)
    expect(() => applySceneFrame(built, sampleScene(doc, 0), 'missing')).toThrow('Unknown scene view')
  } finally {
    disposeScene(built.scene)
  }
})
