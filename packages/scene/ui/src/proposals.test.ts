import { EMPTY_SCENE, type SceneChange, type SceneDoc, type SceneProposal } from '@vis/protocol'
import { sampleScene } from '@vis/scene-core'
import { describe, expect, it } from 'vitest'
import { sceneChangeDetails, sceneProposalPreview } from './proposals'

const base = { id: 'bench', name: 'Bench', source: { type: 'prop' as const, propId: 'bench' as const }, hidden: false, transform: { position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number], scale: [1, 1, 1] as [number, number, number] } }
const change: SceneChange = { target: 'object', id: 'bench', action: 'update', base, item: { ...base, transform: { ...base.transform, position: [3, 0, 0] }, tracks: { transform: [{ t: 0, ease: 'linear', value: base.transform }, { t: 2, ease: 'linear', value: { ...base.transform, position: [4, 0, 0] } }] } }, changeId: 'move', status: 'pending' }
const proposal: SceneProposal = { proposalId: 'proposal', nodeId: 'scene', slotId: 'main', baseRevision: 1, sessionId: 'session', summary: 'Move bench', status: 'open', createdAt: 1, changes: [change] }
const doc: SceneDoc = { ...EMPTY_SCENE, durationS: 5, objects: [{ ...base, createdBy: 'agent', userTouched: true }] }

describe('scene proposal presentation', () => {
  it('names changed components and counts all proposed motion keys', () => {
    expect(sceneChangeDetails(change)).toEqual({ name: 'Bench', fields: ['position'], keys: 2 })
    expect(sceneChangeDetails({ ...change, item: base })).toEqual({ name: 'Bench', fields: [], keys: null })
    expect(sceneChangeDetails({ target: 'object', id: base.id, action: 'delete', base, changeId: 'delete', status: 'pending' })).toEqual({ name: 'Bench', fields: ['delete'], keys: null })
    expect(sceneChangeDetails({ target: 'duration', base: 5, durationS: 8, changeId: 'duration', status: 'pending' }).fields).toEqual(['duration'])
  })
  it('overlays only pending changes and preserves protection without mutating the draft', () => {
    const before = structuredClone(doc)
    const result = sceneProposalPreview(doc, proposal)
    expect(result.objects[0]).toMatchObject({ transform: { position: [3, 0, 0] }, createdBy: 'agent', userTouched: true })
    expect(doc).toEqual(before)
    expect(sampleScene(result, 1).objects[0]!.transform.position).toEqual([2, 0, 0])
    expect(sampleScene(doc, 1).objects[0]!.transform.position).toEqual([0, 0, 0])
    for (const status of ['accepted', 'rejected', 'stale', 'superseded'] as const) expect(sceneProposalPreview(doc, { ...proposal, changes: [{ ...change, status }] })).toEqual(doc)
  })
  it('overlays view updates and deletions and removes duration without dropping saved stills', () => {
    const camera = { position: [0, 2, 5] as [number, number, number], target: [0, 1, 0] as [number, number, number], roll: 0, focalLengthMm: 35 }
    const view = { id: 'wide', name: 'Wide', camera, aspectRatio: '16:9' as const }
    const scene = { ...doc, views: [{ ...view, still: 'still', createdBy: 'user' as const, userTouched: true }] }
    const update: SceneChange = { target: 'view', id: view.id, action: 'update', base: view, item: { ...view, camera: { ...camera, focalLengthMm: 50 } }, changeId: 'view', status: 'pending' }
    expect(sceneChangeDetails(update)).toEqual({ name: 'Wide', fields: ['camera'], keys: null })
    const result = sceneProposalPreview(scene, { ...proposal, changes: [update, { target: 'duration', base: 5, durationS: null, changeId: 'duration', status: 'pending' }, { target: 'object', id: base.id, action: 'delete', base, changeId: 'delete', status: 'pending' }] })
    expect(result.durationS).toBeUndefined()
    expect(result.objects).toEqual([])
    expect(result.views[0]).toMatchObject({ still: 'still', userTouched: true, camera: { focalLengthMm: 50 } })
  })
})
