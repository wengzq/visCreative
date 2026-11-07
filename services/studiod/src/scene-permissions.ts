import { isDeepStrictEqual } from 'node:util'
import { VisError } from '@vis/domain'
import { EMPTY_SCENE, type CanvasOp, type NodeView, type SceneDoc, type SceneObject } from '@vis/protocol'

export function assertAgentSceneWrites(nodes: readonly NodeView[], ops: readonly CanvasOp[]): void {
  const scenes = new Set(nodes.filter(node => node.kind === 'scene').map(node => node.nodeId))
  for (const op of ops) {
    if (op.op === 'scene.set' || (op.op === 'node.create' && op.kind === 'scene') || (op.op === 'node.delete' && scenes.has(op.nodeId))) {
      throw VisError.of('forbidden', 'scene.user_only', {}, 'Only the user can create, edit or delete scenes')
    }
  }
}

function objectContent({ createdBy: _createdBy, userTouched: _userTouched, ...content }: SceneObject) {
  return content
}

/** Compare content by ID so reordering objects or forging metadata cannot change their protection. */
export function stampUserScene(previous: SceneDoc, next: SceneDoc): SceneDoc {
  const before = new Map(previous.objects.map(object => [object.id, object]))
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
  }
}

export function stampUserSceneWrites(nodes: readonly NodeView[], ops: readonly CanvasOp[]): CanvasOp[] {
  const docs = new Map<string, SceneDoc>()
  for (const node of nodes) for (const slot of node.slots) if (slot.content.type === 'scene') docs.set(slot.slotId, slot.content.doc)
  return ops.map(op => {
    if (op.op === 'node.create' && op.kind === 'scene') docs.set(`${op.tempId}:main`, EMPTY_SCENE)
    if (op.op !== 'scene.set') return op
    const doc = stampUserScene(docs.get(op.slotId) ?? EMPTY_SCENE, op.doc)
    docs.set(op.slotId, doc)
    return { ...op, doc }
  })
}
