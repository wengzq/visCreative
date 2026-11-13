import { describe, expect, it } from 'vitest'
import { EMPTY_SCENE, SCENE_LIMITS, SceneDoc, type SceneObject, type SceneTransform } from './scene'

const transform = (x = 0): SceneTransform => ({ position: [x, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] })
const camera = { position: [3, 2, 5], target: [0, 1, 0], roll: 0, focalLengthMm: 35 }
const figure = (tracks?: SceneObject['tracks']) => ({
  id: 'hero', name: 'Hero', transform: transform(), hidden: false, createdBy: 'user', userTouched: true,
  source: { type: 'figure', bodyId: 'human', heightM: 1.75, pose: {} }, ...(tracks ? { tracks } : {}),
})
const view = (extra: Record<string, unknown> = {}) => ({ id: 'wide', name: 'Wide', camera, aspectRatio: '16:9', still: null, ...extra })
const parse = (doc: Record<string, unknown>) => SceneDoc.safeParse({ ...EMPTY_SCENE, ...doc })
const issues = (doc: Record<string, unknown>) => { const result = parse(doc); return result.success ? [] : result.error.issues.map(issue => issue.message) }

describe('scene document (RFC 0037)', () => {
  it('keeps documents written before step c and d valid, filling view protection defaults', () => {
    const result = parse({ objects: [figure()], views: [view()] })
    expect(result.success).toBe(true)
    expect(result.data?.views[0]).toMatchObject({ createdBy: 'user', userTouched: false })
    expect(result.data?.durationS).toBeUndefined()
  })

  it('accepts transform, pose, visibility and camera tracks within the duration', () => {
    const result = parse({
      durationS: 4,
      objects: [figure({
        transform: [{ t: 0, value: transform(0), ease: 'linear' }, { t: 4, value: transform(2), ease: 'hold' }],
        pose: { left_knee: [{ t: 1, value: [0, 0, 0, 1], ease: 'easeInOut' }] },
        hidden: [{ t: 0, value: true }, { t: 2, value: false }],
      })],
      views: [view({ cameraKeys: [{ t: 0, value: camera, ease: 'linear' }, { t: 3.5, value: { ...camera, focalLengthMm: 85 }, ease: 'easeInOut' }] })],
    })
    expect(result.success).toBe(true)
  })

  it('requires a duration for keyframes and keeps every key inside it', () => {
    const tracks = { transform: [{ t: 1, value: transform(), ease: 'linear' as const }] }
    expect(issues({ objects: [figure(tracks)] })).toContain('Keyframes require durationS')
    expect(issues({ durationS: 0.5, objects: [figure(tracks)] })).toContain('Keyframes must lie within durationS')
    expect(parse({ durationS: SCENE_LIMITS.durationS.max + 1 }).success).toBe(false)
  })

  it('rejects keys out of order or at the same time', () => {
    const keys = [{ t: 2, value: camera, ease: 'linear' }, { t: 2, value: camera, ease: 'linear' }]
    expect(issues({ durationS: 4, views: [view({ cameraKeys: keys })] })).toContain('Keyframe times must increase strictly')
    expect(issues({ durationS: 4, views: [view({ cameraKeys: [keys[0], { ...keys[1], t: 1 }] })] })).toContain('Keyframe times must increase strictly')
  })

  it('allows pose tracks only on figures and rejects an ease on visibility keys', () => {
    const box = { ...figure({ pose: { spine: [{ t: 0, value: [0, 0, 0, 1], ease: 'linear' }] } }), source: { type: 'primitive', shape: 'box', size: [1, 1, 1] } }
    expect(issues({ durationS: 1, objects: [box] })).toContain('Only figures have pose tracks')
    expect(parse({ durationS: 1, objects: [figure({ hidden: [{ t: 0, value: true, ease: 'linear' } as never] })] }).success).toBe(false)
  })

  it('caps keys per track and across the scene', () => {
    const many = (count: number) => Array.from({ length: count }, (_, index) => ({ t: index / 1000, value: camera, ease: 'linear' }))
    expect(parse({ durationS: 120, views: [view({ cameraKeys: many(SCENE_LIMITS.keysPerTrack + 1) })] }).success).toBe(false)
    const views = Array.from({ length: SCENE_LIMITS.keys / SCENE_LIMITS.keysPerTrack + 1 }, (_, index) => view({ id: `v${index}`, cameraKeys: many(SCENE_LIMITS.keysPerTrack) }))
    expect(issues({ durationS: 120, views })).toContain(`At most ${SCENE_LIMITS.keys} keyframes per scene`)
  })
})
