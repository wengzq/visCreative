import { isDeepStrictEqual } from 'node:util'
import { VisError } from '@vis/domain'
import { EMPTY_SCENE, type CanvasOp, type NodeView, type SceneDoc, type SceneObject, type SceneView } from '@vis/protocol'

export function objectContent({ createdBy: _createdBy, userTouched: _userTouched, ...content }: SceneObject) {
  return content
}

export function viewContent({ createdBy: _createdBy, userTouched: _userTouched, still: _still, ...content }: SceneView) {
  return content
}

const protectedItem = (item: SceneObject | SceneView) => item.createdBy !== 'agent' || item.userTouched

function stampAgentScene(previous: SceneDoc, next: SceneDoc): SceneDoc {
  if (previous.durationS !== next.durationS) {
    const end = next.durationS ?? 0
    const outside = (keys: readonly { t: number }[] = []) => keys.some(key => key.t > end)
    const protectedKeys = previous.objects.filter(protectedItem).some(object =>
      outside(object.tracks?.transform) || outside(object.tracks?.hidden) || Object.values(object.tracks?.pose ?? {}).some(outside),
    ) || previous.views.filter(protectedItem).some(view => outside(view.cameraKeys))
    if (protectedKeys) throw VisError.of('forbidden', 'scene.duration_protected', {}, 'The duration cannot leave protected scene keyframes past the end', undefined, undefined, { hint: 'Use scene.propose to propose this change for the author to review' })
  }
  const objects = new Map(next.objects.map(object => [object.id, object]))
  const views = new Map(next.views.map(view => [view.id, view]))
  for (const object of previous.objects) {
    const updated = objects.get(object.id)
    if (protectedItem(object) && (!updated || !isDeepStrictEqual(objectContent(object), objectContent(updated)))) {
      throw VisError.of('forbidden', 'scene.object_protected', { name: object.name }, `Only the author can change or delete ${object.name}`, undefined, undefined, { hint: 'Use scene.propose to propose this change for the author to review' })
    }
  }
  for (const view of previous.views) {
    const updated = views.get(view.id)
    if (protectedItem(view) && (!updated || !isDeepStrictEqual(viewContent(view), viewContent(updated)))) {
      throw VisError.of('forbidden', 'scene.view_protected', { name: view.name }, `Only the author can change or delete ${view.name}`, undefined, undefined, { hint: 'Use scene.propose to propose this change for the author to review' })
    }
  }
  const beforeObjects = new Map(previous.objects.map(object => [object.id, object]))
  const beforeViews = new Map(previous.views.map(view => [view.id, view]))
  return {
    ...next,
    objects: next.objects.map(object => {
      const original = beforeObjects.get(object.id)
      return { ...object, createdBy: original?.createdBy ?? 'agent', userTouched: original?.userTouched ?? false }
    }),
    views: next.views.map(view => {
      const original = beforeViews.get(view.id)
      return { ...view, createdBy: original?.createdBy ?? 'agent', userTouched: original?.userTouched ?? false, still: original?.still ?? null }
    }),
  }
}

/** Compare content by ID so reordering items, saving stills or forging metadata cannot change protection. */
export function stampUserScene(previous: SceneDoc, next: SceneDoc): SceneDoc {
  const before = new Map(previous.objects.map(object => [object.id, object]))
  const beforeViews = new Map(previous.views.map(view => [view.id, view]))
  return {
    ...next,
    objects: next.objects.map(object => {
      const original = before.get(object.id)
      return {
        ...object,
        createdBy: original?.createdBy ?? 'user',
        userTouched: !original || original.userTouched || !isDeepStrictEqual(objectContent(original), objectContent(object)),
      }
    }),
    views: next.views.map(view => {
      const original = beforeViews.get(view.id)
      return {
        ...view,
        createdBy: original?.createdBy ?? 'user',
        userTouched: !original || original.userTouched || !isDeepStrictEqual(viewContent(original), viewContent(view)),
      }
    }),
  }
}

function sceneWrites(nodes: readonly NodeView[], ops: readonly CanvasOp[], caller: 'user' | 'agent'): CanvasOp[] {
  // Separate document identities from aliases: a tempId may shadow a real node or slot ID.
  const docs = new Map<symbol, SceneDoc>()
  const nodeDocs = new Map<string, symbol>()
  const slotDocs = new Map<string, symbol>()
  for (const node of nodes) for (const slot of node.slots) if (slot.content.type === 'scene') {
    const key = Symbol()
    docs.set(key, slot.content.doc)
    nodeDocs.set(node.nodeId, key)
    slotDocs.set(slot.slotId, key)
  }
  return ops.map(op => {
    if (op.op === 'node.create' || op.op === 'frame.create') {
      const key = Symbol()
      nodeDocs.set(op.tempId, key)
      if (op.op === 'node.create') {
        slotDocs.set(`${op.tempId}:main`, key)
        if (op.kind === 'scene') docs.set(key, EMPTY_SCENE)
      }
    }
    if (op.op === 'node.delete') {
      const key = nodeDocs.get(op.nodeId)
      const previous = key && docs.get(key)
      if (caller === 'agent' && previous && (previous.objects.some(protectedItem) || previous.views.some(protectedItem))) {
        throw VisError.of('forbidden', 'scene.user_only', {}, 'Only the author can delete a scene containing protected objects or views', undefined, undefined, { hint: 'Ask the author to delete the scene, or use scene.propose to propose deleting individual objects or views for the author to review' })
      }
      if (key) docs.delete(key)
    }
    if (op.op !== 'scene.set') return op
    const key = slotDocs.get(op.slotId)
    const previous = (key && docs.get(key)) || EMPTY_SCENE
    const doc = caller === 'user' ? stampUserScene(previous, op.doc) : stampAgentScene(previous, op.doc)
    if (key) docs.set(key, doc)
    return { ...op, doc }
  })
}

/** Validate and stamp every Agent operation before the gateway commits any of the batch. */
export function assertAgentSceneWrites(nodes: readonly NodeView[], ops: readonly CanvasOp[]): CanvasOp[] {
  return sceneWrites(nodes, ops, 'agent')
}

export function stampUserSceneWrites(nodes: readonly NodeView[], ops: readonly CanvasOp[]): CanvasOp[] {
  return sceneWrites(nodes, ops, 'user')
}
