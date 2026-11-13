import type { NodeView, PrevizSceneRef, SceneDoc } from '@vis/protocol'
import { describe, expect, it } from 'vitest'
import { sceneLink } from './scene-link'

const ref: PrevizSceneRef = { sceneNodeId: 'scene', viewId: 'wide', sceneRev: 8 }
const doc: SceneDoc = {
  version: 1, rev: 4, objects: [], views: [{
    id: 'wide', name: 'Wide', still: 'picture', aspectRatio: '16:9', createdBy: 'user', userTouched: false,
    camera: { position: [0, 2, 5], target: [0, 1, 0], roll: 0, focalLengthMm: 35 },
  }],
}
const scene = (overrides: Partial<SceneDoc> = {}, revision = 8): NodeView => ({
  nodeId: 'scene', kind: 'scene', x: 0, y: 0, w: 360, h: 280, z: 1, layoutRevision: 1,
  slots: [{ slotId: 'scene-main', slotKey: 'main', contentType: 'scene', revision, content: { type: 'scene', doc: { ...doc, ...overrides } } }],
})

describe('Previz scene links', () => {
  it('resolves a current link using the server slot revision', () => {
    const node = scene()
    expect(sceneLink(ref, [node])).toEqual({ state: 'current', scene: node, view: doc.views[0] })
  })

  it('keeps a link current when only the client document revision differs', () => {
    expect(sceneLink(ref, [scene({ rev: 20 })])?.state).toBe('current')
    expect(sceneLink(ref, [scene({ rev: 3 })])?.state).toBe('current')
  })

  it('detects a slot revision change when the document revision does not move or is restored by undo', () => {
    expect(sceneLink(ref, [scene({}, 9)])?.state).toBe('changed')
    expect(sceneLink(ref, [scene({ rev: 2 }, 10)])?.state).toBe('changed')
    expect(sceneLink(ref, [scene({}, 7)])?.state).toBe('changed')
  })

  it('treats missing scenes, missing views and non-scene nodes as absent links', () => {
    expect(sceneLink(ref, [])).toBeNull()
    expect(sceneLink(ref, [scene({ views: [] })])).toBeNull()
    expect(sceneLink(ref, [{ ...scene(), kind: 'image' }])).toBeNull()
    expect(sceneLink(ref, [{ ...scene(), slots: [] }])).toBeNull()
    expect(sceneLink(null, [scene()])).toBeNull()
    expect(sceneLink(undefined, [scene()])).toBeNull()
  })

  it('does not mutate the link or its saved picture when the source is dangling', () => {
    const panel = { blockout: 'saved-picture', sceneRef: { ...ref } }
    expect(sceneLink(panel.sceneRef, [scene({ views: [] })])).toBeNull()
    expect(panel).toEqual({ blockout: 'saved-picture', sceneRef: ref })
  })
})
