import type { NodeView, PrevizSceneRef, SceneView } from '@vis/protocol'

export type SceneLink = { state: 'current' | 'changed'; scene: NodeView; view: SceneView }

export function sceneLink(ref: PrevizSceneRef | null | undefined, nodes: readonly NodeView[]): SceneLink | null {
  if (!ref) return null
  const scene = nodes.find(node => node.nodeId === ref.sceneNodeId && node.kind === 'scene')
  const slot = scene?.slots.find(slot => slot.slotKey === 'main')
  const content = slot?.content
  if (!scene || !slot || content?.type !== 'scene') return null
  const view = content.doc.views.find(view => view.id === ref.viewId)
  if (!view) return null
  return { state: slot.revision === ref.sceneRev ? 'current' : 'changed', scene, view }
}
