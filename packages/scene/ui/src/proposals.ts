import type { SceneChange, SceneDoc, SceneProposal } from '@vis/protocol'

const differs = (a: unknown, b: unknown) => JSON.stringify(a) !== JSON.stringify(b)
export type SceneDifference = 'name' | 'position' | 'rotation' | 'scale' | 'visibility' | 'source' | 'camera' | 'aspectRatio' | 'delete' | 'duration'

/** Content comparisons deliberately omit protection flags and saved stills. */
export function sceneChangeDetails(change: SceneChange): { name: string | null; fields: SceneDifference[]; keys: number | null } {
  if (change.target === 'duration') return { name: null, fields: ['duration'], keys: null }
  const name = change.base.name
  if (change.action === 'delete') return { name, fields: ['delete'], keys: null }
  const fields: SceneDifference[] = []
  if (differs(change.base.name, change.item.name)) fields.push('name')
  if (change.target === 'object') {
    for (const field of ['position', 'rotation', 'scale'] as const) if (differs(change.base.transform[field], change.item.transform[field])) fields.push(field)
    if (differs(change.base.hidden, change.item.hidden)) fields.push('visibility')
    if (differs(change.base.source, change.item.source)) fields.push('source')
    const tracks = change.item.tracks
    const keys = tracks ? (tracks.transform?.length ?? 0) + (tracks.hidden?.length ?? 0) + Object.values(tracks.pose ?? {}).reduce((n, track) => n + track.length, 0) : 0
    return { name, fields, keys: differs(change.base.tracks, tracks) ? keys : null }
  }
  if (differs(change.base.camera, change.item.camera)) fields.push('camera')
  if (differs(change.base.aspectRatio, change.item.aspectRatio)) fields.push('aspectRatio')
  return { name, fields, keys: differs(change.base.cameraKeys, change.item.cameraKeys) ? change.item.cameraKeys?.length ?? 0 : null }
}

/** Preview is an overlay on the local document, never a draft edit. Sample it at the playhead afterwards. */
export function sceneProposalPreview(doc: SceneDoc, proposal: SceneProposal): SceneDoc {
  let next = doc
  for (const change of proposal.changes) {
    if (change.status !== 'pending') continue
    if (change.target === 'duration') {
      const { durationS, ...rest } = next
      next = change.durationS === null ? rest : { ...rest, durationS: change.durationS }
    } else if (change.target === 'object') {
      next = { ...next, objects: next.objects.flatMap(object => object.id !== change.id ? [object] : change.action === 'delete' ? [] : [{ ...change.item, createdBy: object.createdBy, userTouched: object.userTouched }]) }
    } else {
      next = { ...next, views: next.views.flatMap(view => view.id !== change.id ? [view] : change.action === 'delete' ? [] : [{ ...change.item, still: view.still, createdBy: view.createdBy, userTouched: view.userTouched }]) }
    }
  }
  return next
}
