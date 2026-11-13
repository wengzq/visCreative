import { expect, it } from 'vitest'
import { EMPTY_SCENE, type CanvasOp, type NodeView, type SceneDoc, type SceneObject, type SceneView } from '@vis/protocol'
import { assertAgentSceneWrites, stampUserScene, stampUserSceneWrites } from './scene-permissions'

const object = (id = 'figure', fields: Partial<SceneObject> = {}): SceneObject => ({
  id, name: 'Figure', hidden: false, createdBy: 'agent', userTouched: false,
  transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
  source: { type: 'figure', bodyId: 'human', heightM: 1.8, pose: {} },
  ...fields,
})
const doc = (...objects: SceneObject[]): SceneDoc => ({ ...EMPTY_SCENE, objects })
const view = (id = 'wide', fields: Partial<SceneView> = {}): SceneView => ({
  id, name: 'Wide', camera: { position: [0, 2, 5], target: [0, 1, 0], roll: 0, focalLengthMm: 35 },
  aspectRatio: '16:9', still: null, createdBy: 'agent', userTouched: false, ...fields,
})
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
    aspectRatio: '16:9', still: null, createdBy: 'user', userTouched: false,
  }] }
  expect(stampUserScene(previous, next)).toEqual({ ...next, views: [{ ...next.views[0], userTouched: true }] })
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

const set = (source: SceneDoc, slotId = 'slot'): CanvasOp => ({ op: 'scene.set', slotId, expectedRevision: 1, doc: source })
const agentDoc = (previous: SceneDoc, next: SceneDoc) => {
  const op = assertAgentSceneWrites([node(previous)], [set(next)])[0]!
  if (op.op !== 'scene.set') throw new Error('Expected scene write')
  return op.doc
}
const forbidden = (reason: string, params = {}) => expect.objectContaining({ code: 'forbidden', details: { reason, params, ...(['scene.object_protected', 'scene.view_protected', 'scene.duration_protected', 'scene.user_only'].includes(reason) ? { hint: expect.stringContaining('scene.propose') } : {}) } })

it('stamps new Agent objects and views while discarding forged metadata and stills', () => {
  const next = { ...doc(object('new', { createdBy: 'user', userTouched: true })), views: [view('new', { createdBy: 'user', userTouched: true, still: 'forged' })] }
  const original = structuredClone(next)
  expect(agentDoc(EMPTY_SCENE, next)).toEqual({ ...doc(object('new')), views: [view('new')] })
  expect(next).toEqual(original)
  expect(assertAgentSceneWrites([], [{ op: 'node.create', kind: 'scene', tempId: 'fresh' }, set(next, 'fresh:main')])[1]).toMatchObject({ doc: { objects: [object('new')], views: [view('new')] } })
})

it('allows Agent content edits, track edits and deletion of untouched Agent items', () => {
  const before: SceneDoc = { ...doc(object()), views: [view()], durationS: 5 }
  const next: SceneDoc = { ...before, objects: [object('figure', { name: 'Walker', tracks: { hidden: [{ t: 4, value: true }] } })],
    views: [view('wide', { cameraKeys: [{ t: 3, value: view().camera, ease: 'linear' }] })] }
  expect(agentDoc(before, next)).toEqual(next)
  expect(agentDoc(next, EMPTY_SCENE)).toEqual(EMPTY_SCENE)
})

it.each([{ createdBy: 'user' as const, userTouched: false }, { createdBy: 'agent' as const, userTouched: true }])('protects object content and deletion with original names: %j', protection => {
  const original = object('figure', protection)
  for (const objects of [[], [object('figure', { name: 'Forged name' })], [object('figure', { tracks: { hidden: [{ t: 1, value: false }] } })]]) {
    expect(() => agentDoc({ ...doc(original), durationS: 2 }, { ...doc(...objects), durationS: 2 })).toThrow(forbidden('scene.object_protected', { name: 'Figure' }))
  }
  expect(agentDoc(doc(original), doc(object()))).toEqual(doc(original))
})

it.each([{ createdBy: 'user' as const, userTouched: false }, { createdBy: 'agent' as const, userTouched: true }])('protects view content and deletion while ignoring stills: %j', protection => {
  const original = view('wide', { ...protection, still: 'saved' })
  const before: SceneDoc = { ...EMPTY_SCENE, views: [original], durationS: 2 }
  for (const views of [[], [view('wide', { name: 'Forged name' })], [view('wide', { cameraKeys: [{ t: 1, value: original.camera, ease: 'hold' }] })]]) {
    expect(() => agentDoc(before, { ...before, views })).toThrow(forbidden('scene.view_protected', { name: 'Wide' }))
  }
  expect(agentDoc(before, { ...before, views: [view('wide', { still: 'forged' })] })).toEqual(before)
})

it('keeps previous stills even when an editable view changes and accepts reordering protected items', () => {
  const before: SceneDoc = { ...doc(object('a', { createdBy: 'user' }), object('b', { userTouched: true })),
    views: [view('a', { createdBy: 'user', still: 'saved' }), view('b', { still: 'other' })] }
  const next: SceneDoc = { ...before, objects: [...before.objects].reverse(),
    views: [view('b', { name: 'New camera', still: 'forged' }), view('a', { still: null, createdBy: 'agent' })] }
  expect(agentDoc(before, next)).toEqual({ ...next, views: [{ ...next.views[0], still: 'other' }, before.views[0]] })
})

it('protects duration against transform, visibility, pose and camera keys even if a client removes those keys', () => {
  const keyedObjects = [
    object('figure', { tracks: { transform: [{ t: 4, value: object().transform, ease: 'linear' }] } }),
    object('figure', { tracks: { hidden: [{ t: 4, value: false }] } }),
    object('figure', { tracks: { pose: { leftKnee: [{ t: 4, value: [0, 0, 0, 1], ease: 'hold' }] } } }),
  ]
  for (const protection of [{ createdBy: 'user' as const }, { userTouched: true }]) {
    for (const keyed of keyedObjects) {
      const before: SceneDoc = { ...doc({ ...keyed, ...protection }), durationS: 5 }
      for (const next of [{ ...doc(object()), durationS: 3 }, doc(object())]) {
        expect(() => agentDoc(before, next)).toThrow(forbidden('scene.duration_protected'))
      }
    }
    const before: SceneDoc = { ...EMPTY_SCENE, durationS: 5, views: [view('wide', { ...protection, cameraKeys: [{ t: 4, value: view().camera, ease: 'linear' }] })] }
    expect(() => agentDoc(before, { ...EMPTY_SCENE, durationS: 3, views: [view()] })).toThrow(forbidden('scene.duration_protected'))
    expect(agentDoc(before, { ...before, durationS: 4 })).toEqual({ ...before, durationS: 4 })
    expect(agentDoc(before, { ...before, durationS: 7 })).toEqual({ ...before, durationS: 7 })
  }
})

it('allows duration changes without endangered protected keys and trimming Agent-owned motion', () => {
  const protectedStatic = object('protected', { createdBy: 'user' })
  const before: SceneDoc = { ...doc(protectedStatic, object('animated', { tracks: { hidden: [{ t: 5, value: true }] } })), durationS: 6 }
  const next: SceneDoc = { ...doc(protectedStatic, object('animated')), durationS: 2 }
  expect(agentDoc(before, next)).toEqual(next)
  expect(agentDoc(next, doc(protectedStatic))).toEqual(doc(protectedStatic))
  expect(agentDoc(doc(protectedStatic), next)).toEqual(next)
})

it('allows scene deletion only with no protected objects or views, including within a batch', () => {
  const remove: CanvasOp = { op: 'node.delete', nodeId: 'scene' }
  for (const source of [EMPTY_SCENE, doc(object()), { ...EMPTY_SCENE, views: [view()] }]) {
    expect(() => assertAgentSceneWrites([node(source)], [remove])).not.toThrow()
  }
  for (const source of [doc(object('figure', { createdBy: 'user' })), doc(object('figure', { userTouched: true })),
    { ...EMPTY_SCENE, views: [view('wide', { createdBy: 'user' })] }, { ...EMPTY_SCENE, views: [view('wide', { userTouched: true })] }]) {
    expect(() => assertAgentSceneWrites([node(source)], [{ op: 'node.setMeta', nodeId: 'scene', title: 'Renamed' }, remove])).toThrow(forbidden('scene.user_only'))
    expect(() => assertAgentSceneWrites([node(source)], [set(EMPTY_SCENE), remove])).toThrow()
  }
  const ops: CanvasOp[] = [{ op: 'node.create', kind: 'scene', tempId: 'fresh' }, set(doc(object('new', { createdBy: 'user', userTouched: true })), 'fresh:main'), { op: 'node.delete', nodeId: 'fresh' }]
  expect(() => assertAgentSceneWrites([], ops)).not.toThrow()
})

it('tracks authoritative state across a batch and resolves temp aliases like the canvas writer', () => {
  const source = node(doc(object('figure', { createdBy: 'user' })))
  const ops: CanvasOp[] = [{ op: 'node.create', kind: 'scene', tempId: 'scene' }, set(doc(object('new')), 'scene:main'), { op: 'node.delete', nodeId: 'scene' }]
  expect(() => assertAgentSceneWrites([source], ops)).not.toThrow()
  expect(() => assertAgentSceneWrites([source], [...ops, set(EMPTY_SCENE)])).toThrow(forbidden('scene.object_protected', { name: 'Figure' }))
  expect(() => assertAgentSceneWrites([source], [{ op: 'node.create', kind: 'image', tempId: 'scene' }, { op: 'node.delete', nodeId: 'scene' }])).not.toThrow()
  const writes = assertAgentSceneWrites([], [
    { op: 'node.create', kind: 'scene', tempId: 'fresh' },
    set({ ...EMPTY_SCENE, views: [view('wide', { still: 'forged' })] }, 'fresh:main'),
    set({ ...EMPTY_SCENE, views: [view('wide', { name: 'Changed', still: 'forged-again', userTouched: true })] }, 'fresh:main'),
  ])
  expect(writes[2]).toMatchObject({ doc: { views: [view('wide', { name: 'Changed' })] } })
})

it('stamps new UI views, protects changed camera content and retains metadata on still-only and reorder edits', () => {
  const before: SceneDoc = { ...EMPTY_SCENE, durationS: 5, views: [view('wide', { still: 'saved' }), view('close', { createdBy: 'user', userTouched: true })] }
  const next: SceneDoc = { ...before, views: [view('close'), view('wide', { still: 'new-still', createdBy: 'user', userTouched: true })] }
  expect(stampUserScene(before, next).views).toEqual([before.views[1], { ...before.views[0], still: 'new-still' }])
  for (const fields of [{ name: 'Renamed' }, { aspectRatio: '1:1' as const }, { camera: { ...view().camera, roll: 0.5 } },
    { cameraKeys: [{ t: 2, value: view().camera, ease: 'hold' as const }] }]) {
    expect(stampUserScene(before, { ...before, views: [view('wide', fields)] }).views[0]).toMatchObject({ createdBy: 'agent', userTouched: true })
  }
  const writes = stampUserSceneWrites([node(before)], [set({ ...before, views: [view('wide', { name: 'Renamed' })] }), set(before)])
  expect(writes[1]).toMatchObject({ doc: { views: [view('wide', { still: 'saved', userTouched: true }), before.views[1]] } })
  expect(stampUserScene(EMPTY_SCENE, { ...EMPTY_SCENE, views: [view()] }).views).toEqual([view('wide', { createdBy: 'user', userTouched: true })])
})
