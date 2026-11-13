import { BoxGeometry, Color, Mesh, MeshBasicMaterial, Scene, type BoxHelper } from 'three'
import { expect, it, vi } from 'vitest'
import { createProposalOutlines } from './proposal-outlines'

it('removes every proposal helper and disposes its geometry and material on teardown', () => {
  const scene = new Scene()
  const object = new Mesh(new BoxGeometry(), new MeshBasicMaterial())
  const outlines = createProposalOutlines(scene, () => new Color('red'))
  outlines.update(['bench', 'marker'], new Map([['bench', object], ['marker', object]]))
  const helpers = [...scene.children] as BoxHelper[]
  const resources = helpers.map(helper => ({ geometry: vi.spyOn(helper.geometry, 'dispose'), material: vi.spyOn(helper.material, 'dispose') }))
  outlines.dispose()
  expect(scene.children).toEqual([])
  for (const resource of resources) {
    expect(resource.geometry).toHaveBeenCalledTimes(1)
    expect(resource.material).toHaveBeenCalledTimes(1)
  }
  outlines.dispose()
  for (const resource of resources) expect(resource.geometry).toHaveBeenCalledTimes(1)
  object.geometry.dispose()
  object.material.dispose()
})
