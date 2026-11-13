import { BoxHelper, type Color, type Object3D, type Scene } from 'three'

export function createProposalOutlines(scene: Scene, color: () => Color) {
  const outlines = new Map<string, BoxHelper>()
  const remove = (id: string, helper: BoxHelper) => {
    scene.remove(helper)
    helper.dispose()
    outlines.delete(id)
  }
  return {
    update(ids: readonly string[], objects: ReadonlyMap<string, Object3D>) {
      const selected = new Set(ids)
      for (const [id, helper] of outlines) if (!selected.has(id)) remove(id, helper)
      for (const id of selected) {
        const object = objects.get(id)
        if (!object) { const helper = outlines.get(id); if (helper) helper.visible = false; continue }
        let helper = outlines.get(id)
        if (!helper) {
          helper = new BoxHelper(object, color())
          helper.material.depthTest = false
          helper.renderOrder = 20
          outlines.set(id, helper)
          scene.add(helper)
        }
        helper.setFromObject(object)
        helper.visible = object.visible
      }
    },
    dispose() { for (const [id, helper] of outlines) remove(id, helper) },
  }
}
