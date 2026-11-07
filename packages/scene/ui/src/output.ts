import type { SceneDraft, SceneEditorHost, SceneViewportController } from './types'

export async function captureSceneStill(draft: SceneDraft, controller: SceneViewportController, host: SceneEditorHost, viewId: string) {
  if (!await draft.flush()) return null
  let latest = draft.getSnapshot()
  const view = latest.doc.views.find(view => view.id === viewId)
  if (!view) throw new Error('The scene view no longer exists')
  latest.beginEdit()
  const blob = await controller.captureView(viewId)
  const assetVersionId = await host.upload(blob, `${view.name.slice(0, 120)}.png`)
  latest = draft.getSnapshot()
  if (latest.conflict) return null
  if (!latest.doc.views.some(view => view.id === viewId)) throw new Error('The scene view no longer exists')
  latest.edit({ ...latest.doc, views: latest.doc.views.map(view => view.id === viewId ? { ...view, still: assetVersionId } : view) }, true)
  if (!await latest.flush()) return null
  // doc.rev is author data. A panel compares the server-owned slot revision after the still write.
  const committed = draft.getSnapshot()
  return { viewId, assetVersionId, sceneRev: committed.baseRevision, name: view.name }
}
