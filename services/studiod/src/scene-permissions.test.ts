import { expect, it } from 'vitest'
import { EMPTY_SCENE, type NodeView, type SceneDoc, type SceneObject } from '@vis/protocol'
import { assertAgentSceneWrites, stampUserScene, stampUserSceneWrites } from './scene-permissions'

const object = (id = 'figure', fields: Partial<SceneObject> = {}): SceneObject => ({
  id, name: 'Figure', hidden: false, createdBy: 'agent', userTouched: false,
  transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
  source: { type: 'figure', bodyId: 'human', heightM: 1.8, pose: {} },
  ...fields,
})
const doc = (...objects: SceneObject[]): SceneDoc => ({ ...EMPTY_SCENE, objects })
const node = (source: SceneDoc): NodeView => ({
  nodeId: 'scene', kind: 'scene',
  slots: [{ slotId: 'slot', content: { type: 'scene', doc: source } }],
} as NodeView)

it('stamps new user objects regardless of client metadata without mutating either document', () => {
  const next = doc(object())
  const original = structuredClone(next)
  expect(stampUserScene(EMPTY_SCENE, next).objects).toEqual([object('figure', { createdBy: 'user', userTouched: true })])
  expect(next).toEqual(original)
  expect(EMPTY_SCENE.objects).toEqual([])
})

it('ignores metadata-only edits, preserves original authorship and never clears existing protection', () => {
  const before = doc(object('untouched'), object('protected', { createdBy: 'user', userTouched: true }))
  const next = doc(object('untouched', { createdBy: 'user', userTouched: true }), object('protected'))
  expect(stampUserScene(before, next).objects).toEqual(before.objects)
})

it('compares objects by ID and content rather than array or property order', () => {
  const first = object('first')
  const second = object('second')
  const reordered = { ...first, transform: { scale: first.transform.scale, rotation: first.transform.rotation, position: first.transform.position } }
  expect(stampUserScene(doc(first, second), doc(second, reordered)).objects.every(object => !object.userTouched)).toBe(true)
})

it('leaves object protection unchanged when only the document revision and camera views change', () => {
  const previous = doc(object())
  const next: SceneDoc = { ...previous, rev: 1, views: [{
    id: 'wide', name: 'Wide', camera: { position: [0, 2, 5], target: [0, 1, 0], roll: 0, focalLengthMm: 35 },
    aspectRatio: '16:9', still: null,
  }] }
  expect(stampUserScene(previous, next)).toEqual(next)
})

it('marks changed names, transforms, visibility and figure data as touched while keeping their creator', () => {
  const original = object()
  const changes: Partial<SceneObject>[] = [
    { name: 'Moved figure' }, { hidden: true },
    { transform: { ...original.transform, position: [1, 0, 0] } },
    { source: { type: 'figure', bodyId: 'human', heightM: 1.7, pose: { elbow: [0.5, 0, 0, 0.866] } } },
    { source: { type: 'primitive', shape: 'box', size: [1, 1, 1] } },
  ]
  for (const fields of changes) {
    expect(stampUserScene(doc(original), doc(object('figure', fields))).objects[0]).toMatchObject({ ...fields, createdBy: 'agent', userTouched: true })
  }
})

it('evaluates every write in a UI batch, retaining protection after a change is reverted', () => {
  const before = doc(object())
  const changed = doc(object('figure', { name: 'Changed' }))
  const ops = stampUserSceneWrites([node(before)], [
    { op: 'scene.set', slotId: 'slot', expectedRevision: 1, doc: changed },
    { op: 'scene.set', slotId: 'slot', expectedRevision: 2, doc: before },
    { op: 'node.create', kind: 'scene', tempId: 'fresh' },
    { op: 'scene.set', slotId: 'fresh:main', expectedRevision: 1, doc: before },
  ])
  expect(ops[1]).toMatchObject({ doc: { objects: [{ userTouched: true, createdBy: 'agent' }] } })
  expect(ops[3]).toMatchObject({ doc: { objects: [{ userTouched: true, createdBy: 'user' }] } })
})

it('refuses scene writes for the entire Agent batch even after an earlier operation', () => {
  const source = node(EMPTY_SCENE)
  for (const ops of [
    [{ op: 'scene.set', slotId: 'slot', expectedRevision: 1, doc: EMPTY_SCENE }],
    [{ op: 'node.create', kind: 'scene', tempId: 'fresh' }],
    [{ op: 'node.delete', nodeId: 'scene' }],
    [{ op: 'node.setMeta', nodeId: 'scene', title: 'Renamed' }, { op: 'node.delete', nodeId: 'scene' }],
    [{ op: 'node.create', kind: 'image', tempId: 'scene' }, { op: 'node.delete', nodeId: 'scene' }],
  ] as const) {
    expect(() => assertAgentSceneWrites([source], ops)).toThrow(expect.objectContaining({ code: 'forbidden', details: expect.objectContaining({ reason: 'scene.user_only' }) }))
  }
  expect(() => assertAgentSceneWrites([source], [{ op: 'node.layout', nodeId: 'scene', x: 1 }])).not.toThrow()
})
