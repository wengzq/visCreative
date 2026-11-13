import { describe, expect, it } from 'vitest'
import { EMPTY_SCENE, SceneDoc, type JobView, type NodeView, type SceneObject, type SceneView, type TranscriptItem } from '@vis/protocol'
import { extract, runChecks, type Evidence } from './checks'
import { buildFixture, sceneDoc, type Call } from './fixtures'
import scenarios from './scenarios.json'

const transform = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } as const
const figure = (): SceneObject => ({
  id: 'figure', name: 'Seated figure', createdBy: 'agent', userTouched: false, hidden: false,
  transform: structuredClone(transform) as SceneObject['transform'],
  source: { type: 'figure', bodyId: 'human', heightM: 1.8, pose: { leftHip: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2] } },
})
const view = (): SceneView => ({ id: 'wide', name: 'Wide', createdBy: 'agent', userTouched: false, still: null, aspectRatio: '16:9',
  camera: { position: [4, 2, 5], target: [0, 1, 0], roll: 0, focalLengthMm: 35 } })
const doc = (): SceneDoc => ({ ...EMPTY_SCENE, objects: [{
  ...figure(), id: 'bench', name: 'Bench', source: { type: 'group', parts: [
    { name: 'Seat', shape: 'box', size: [1.8, 0.1, 0.5], transform: structuredClone(transform) as SceneObject['transform'] },
    { name: 'Support', shape: 'box', size: [0.1, 0.4, 0.4], transform: structuredClone(transform) as SceneObject['transform'] },
  ] },
}, figure()], views: [view()] })
const node = (nodeId: string, kind: NodeView['kind'], content: NodeView['slots'][number]['content']): NodeView => ({
  nodeId, kind, x: 0, y: 0, w: 200, h: 100, z: 0, layoutRevision: 0,
  slots: [{ slotId: `${nodeId}-main`, slotKey: 'main', revision: 2, contentType: kind === 'scene' ? 'scene' : kind === 'image' ? 'image' : 'video', content }],
})
const evidence = (): Evidence => ({ before: [], after: [], transcript: [], events: [], batches: [], jobs: [], assets: [], approvals: [], workMessages: [], fixtureVars: {}, workDir: '/tmp/scene-eval', ended: true })
const item = (seq: number, kind: TranscriptItem['kind'], payload: unknown): TranscriptItem => ({ itemId: `item${seq}`, createdSeq: seq, revision: 1, turnId: 'turn1', kind, payload, createdAt: seq, updatedAt: seq })
function call(e: Evidence, name: string, input: unknown, output: unknown = {}, error = false) {
  const seq = e.transcript.length + 1, toolUseId = `tool${seq}`
  e.transcript.push(item(seq, 'tool_call', { name: `vis.${name}`, input, toolUseId }), item(seq + 1, 'tool_result', { toolUseId, isError: error, text: typeof output === 'string' ? output : JSON.stringify(output) }))
}
const results = (e: Evidence, ids: string[]) => runChecks(ids, e).map(check => check.result)
function rendered(kind: 'image' | 'video' = 'image') {
  const e = evidence()
  const scene = doc()
  if (kind === 'video') {
    scene.durationS = 5
    scene.objects[1]!.tracks = {
      transform: [{ t: 0, value: { ...figure().transform, position: [-2, 0, 0] }, ease: 'linear' }, { t: 5, value: { ...figure().transform, position: [2, 0, 0] }, ease: 'linear' }],
      pose: Object.fromEntries(['leftHip', 'rightHip'].map(id => [id, [{ t: 0, value: [0, 0, 0, 1], ease: 'linear' }, { t: 1, value: [0.2, 0, 0, 0.98], ease: 'linear' }]])),
    }
    scene.views[0]!.cameraKeys = [{ t: 0, value: view().camera, ease: 'linear' }, { t: 5, value: { ...view().camera, position: [6, 2, 5] }, ease: 'linear' }]
  }
  e.after.push(node('scene', 'scene', { type: 'scene', doc: scene }))
  call(e, 'guide_get', { topic: 'scene' })
  call(e, 'canvas_apply', { ops: [
    { op: 'node.create', tempId: 'stage', kind: 'scene' }, { op: 'scene.set', slotId: 'stage:main', expectedRevision: 1, doc: scene },
  ] }, { idMap: { stage: 'scene' } })
  const mime = kind === 'image' ? 'image/png' : 'video/mp4'
  const output = node('output', kind, { type: 'asset', assetVersionId: 'rendered-asset', mime })
  output.inputs = ['scene']
  e.after.push(output)
  e.assets!.push({ assetVersionId: 'rendered-asset', assetId: 'asset', version: 1, kind, mime, url: 'file:///tmp/scene-render',
    ...(kind === 'video' ? { durationMs: 5000, fps: 24 } : {}),
  })
  e.jobs.push({ jobId: 'render-job', status: 'succeeded', targets: [], outputs: [{ outputIndex: 0, assetVersionId: 'rendered-asset', mime, delivery: { status: 'delivered', nodeId: 'output' } }] } as JobView)
  call(e, 'gen_submit', { kind, provider: 'render', model: 'scene', prompt: 'Check the scene', inputs: [{ slotId: 'scene-main', revision: 2 }],
    params: { viewId: 'wide', width: 640, height: 360, fps: 24, ...(kind === 'image' ? { timeS: 0 } : {}) },
  }, { jobId: 'render-job' })
  return e
}
function protectedScene() {
  const e = evidence()
  const source = doc()
  source.objects[0]!.userTouched = true
  source.views[0]!.createdBy = 'user'
  e.before = [node('scene', 'scene', { type: 'scene', doc: source })]
  e.after = structuredClone(e.before)
  e.fixtureVars = { sceneNodeId: 'scene', sceneObjectId: 'bench', sceneObjectName: 'Bench' }
  return e
}
const current = (e: Evidence) => sceneDoc(e.after.find(node => node.kind === 'scene'))!
const renderInput = (e: Evidence) => (e.transcript.find(item => item.kind === 'tool_call' && (item.payload as any).name === 'vis.gen_submit')!.payload as any).input

describe('Scene evaluation checks', () => {
  it('registers three distinct scene scenarios without replacing skill or batch IDs', () => {
    expect(new Set(scenarios.map(scenario => scenario.id)).size).toBe(scenarios.length)
    for (const [index, id] of ['SC1', 'SC2', 'SC3'].entries()) {
      const scenario = scenarios.find(scenario => scenario.id === id)!
      expect(scenario.title).toContain(`S${index + 1}`)
      expect(scenario.prompts).toHaveLength(1)
      expect(() => runChecks(scenario.checks, evidence())).not.toThrow()
      expect(runChecks(scenario.checks, evidence()).some(check => check.detail === 'Human review required for content quality, accuracy and coherence')).toBe(false)
    }
    for (const id of ['S1', 'S2', 'S3']) expect(scenarios.some(scenario => scenario.id === id)).toBe(true)
    expect(scenarios.find(scenario => scenario.id === 'SC3')!.fixture).toBe('scene-protected')
  })

  it('requires a valid group, posed human, view and local image with provenance', () => {
    const e = rendered()
    const ids = ['scene_guide_read', 'scene_document', 'scene_bench_group', 'scene_render_image', 'scene_local_only']
    expect(results(e, ids)).toEqual(ids.map(() => 'pass'))
    current(e).objects[0]!.source = { type: 'prop', propId: 'bench' }
    expect(results(e, ['scene_bench_group'])).toEqual(['fail'])
    current(e).objects[0] = doc().objects[0]!
    current(e).objects[1]!.source = { type: 'figure', bodyId: 'human', heightM: 1.8, pose: {} }
    expect(results(e, ['scene_bench_group'])).toEqual(['fail'])
    current(e).objects[1]!.userTouched = true
    expect(results(e, ['scene_document'])).toEqual(['fail'])
    current(e).durationS = 0
    expect(results(e, ['scene_document'])).toEqual(['fail'])
  })

  it('requires the guide before writes and rejects failed or uncompleted guide reads', () => {
    const e = rendered()
    e.transcript[1]!.payload = { toolUseId: 'tool1', isError: true, text: 'denied' }
    expect(results(e, ['scene_guide_read'])).toEqual(['fail'])
    e.transcript = e.transcript.slice(2)
    call(e, 'guide_get', { topic: 'scene' })
    expect(results(e, ['scene_guide_read'])).toEqual(['fail'])
    const pending = evidence()
    pending.transcript.push(item(1, 'tool_call', { name: 'vis.guide_get', input: { topic: 'scene' }, toolUseId: 'pending' }))
    expect(results(pending, ['scene_guide_read'])).toEqual(['fail'])
  })

  it('requires figure translation and changing poses with an actual camera move', () => {
    const e = rendered('video')
    expect(results(e, ['scene_walk_motion', 'scene_render_video'])).toEqual(['pass', 'pass'])
    const figure = current(e).objects[1]!
    figure.tracks!.pose = {}
    expect(results(e, ['scene_walk_motion'])).toEqual(['fail'])
    figure.tracks = current(rendered('video')).objects[1]!.tracks!
    const camera = current(e).views[0]!
    camera.cameraKeys![1]!.value = camera.cameraKeys![0]!.value
    expect(results(e, ['scene_walk_motion'])).toEqual(['fail'])
    camera.cameraKeys = current(rendered('video')).views[0]!.cameraKeys!
    figure.tracks!.transform![1]!.value.position = figure.tracks!.transform![0]!.value.position
    expect(results(e, ['scene_walk_motion'])).toEqual(['fail'])
  })

  it('matches the first scene input, view, completed job, delivered asset and measured timing', () => {
    for (const kind of ['image', 'video'] as const) {
      for (const mutate of [
        (e: Evidence) => { renderInput(e).inputs.unshift({ assetVersionId: 'unrelated' }) },
        (e: Evidence) => { renderInput(e).params.viewId = 'missing' },
        (e: Evidence) => { e.jobs[0]!.status = 'failed' },
        (e: Evidence) => { e.after[1]!.inputs = [] },
        (e: Evidence) => { e.assets = [] },
        (e: Evidence) => { e.after[1]!.slots[0]!.content = { type: 'asset', assetVersionId: 'unrelated', mime: 'image/png' } },
        (e: Evidence) => { renderInput(e).inputs[0].revision = 99 },
      ]) {
        const e = rendered(kind)
        mutate(e)
        expect(results(e, [`scene_render_${kind}`])).toEqual(['fail'])
      }
    }
    const image = rendered()
    renderInput(image).params.timeS = 1
    expect(results(image, ['scene_render_image'])).toEqual(['pass'])
    renderInput(image).params.timeS = -1
    expect(results(image, ['scene_render_image'])).toEqual(['fail'])
    const video = rendered('video')
    video.assets![0]!.durationMs = 5041
    expect(results(video, ['scene_render_video'])).toEqual(['pass'])
    video.assets![0]!.durationMs = 5042
    expect(results(video, ['scene_render_video'])).toEqual(['fail'])
    video.assets![0]!.durationMs = 5000
    video.assets![0]!.fps = 30
    expect(results(video, ['scene_render_video'])).toEqual(['fail'])
  })

  it('credits a retained earlier scene revision without substituting a later edited document', () => {
    const e = rendered('video')
    e.after[0]!.slots[0]!.revision = 3
    e.after[0]!.slots[0]!.content = { type: 'scene', doc: EMPTY_SCENE }
    expect(results(e, ['scene_render_video'])).toEqual(['pass'])
    e.transcript = e.transcript.filter(item => ![3, 4].includes(item.createdSeq))
    expect(results(e, ['scene_render_video'])).toEqual(['fail'])
  })

  it('rejects even refused paid/non-scene submissions, batches and unrelated jobs', () => {
    const clean = rendered('video')
    for (const input of [{ provider: 'paid', model: 'scene' }, { provider: 'mock' }, { provider: 'render', model: 'html' }]) {
      const e = structuredClone(clean)
      call(e, 'gen_submit', input, 'denied', true)
      expect(results(e, ['scene_local_only'])).toEqual(['fail'])
    }
    const batch = structuredClone(clean)
    call(batch, 'script_batch_start', {}, 'denied', true)
    expect(results(batch, ['scene_local_only'])).toEqual(['fail'])
    clean.jobs.push({ jobId: 'unobserved', status: 'succeeded', outputs: [], targets: [] } as JobView)
    expect(results(clean, ['scene_local_only'])).toEqual(['fail'])
  })

  it('retains protected objects and views in every successful write and records refusals', () => {
    const e = protectedScene()
    const changed = structuredClone(current(e))
    changed.objects[0]!.transform.position[0] += 0.5
    call(e, 'canvas_apply', { ops: [{ op: 'scene.set', slotId: 'scene-main', expectedRevision: 2, doc: changed }] }, 'scene.object_protected', true)
    expect(results(e, ['scene_protected_preserved'])).toEqual(['pass'])
    expect(runChecks(['scene_protected_preserved'], e)[0]!.detail).toContain('scene.object_protected')
    expect(extract(e.transcript).errors).toHaveLength(1)
    e.transcript[1]!.payload = { toolUseId: 'tool1', isError: false, text: '{}' }
    expect(results(e, ['scene_protected_preserved'])).toEqual(['fail'])
    call(e, 'canvas_apply', { ops: [{ op: 'scene.set', slotId: 'scene-main', expectedRevision: 3, doc: current(e) }] })
    expect(results(e, ['scene_protected_preserved'])).toEqual(['fail'])
    const deleted = protectedScene()
    call(deleted, 'canvas_apply', { ops: [{ op: 'node.delete', nodeId: 'scene' }] })
    expect(results(deleted, ['scene_protected_preserved'])).toEqual(['fail'])
    const missing = protectedScene()
    missing.after = []
    expect(results(missing, ['scene_protected_preserved'])).toEqual(['fail'])
    const camera = protectedScene()
    current(camera).views[0]!.camera.roll = 1
    expect(results(camera, ['scene_protected_preserved'])).toEqual(['fail'])
  })

  it('checks actual UI fixture edits with a fake RPC and never starts an Agent', async () => {
    let nodes: NodeView[] = []
    const writes: SceneDoc[] = []
    const methods: string[] = []
    const call = (async (method: string, params: any) => {
      methods.push(method)
      if (method === 'canvas.get') return { nodes }
      if (method !== 'canvas.apply') throw new Error(`Unexpected fixture method: ${method}`)
      for (const op of params.ops) {
        if (op.op === 'node.create') nodes = [node('stage', 'scene', { type: 'scene', doc: EMPTY_SCENE })]
        if (op.op === 'scene.set') {
          writes.push(structuredClone(op.doc))
          const source = SceneDoc.parse(op.doc)
          const stamped = { ...source, objects: source.objects.map(object => ({ ...object, createdBy: 'user' as const, userTouched: true })) }
          nodes[0]!.slots[0]!.content = { type: 'scene', doc: stamped }
          nodes[0]!.slots[0]!.revision++
        }
      }
      return { idMap: { stage: 'stage' } }
    }) as Call
    const fixture = await buildFixture('scene-protected', call, '/tmp/scene-fixture', () => {}, '/tmp/repository')
    expect(fixture.vars.sceneNodeId).toBe('stage')
    expect(fixture.nodeIds).toEqual(['stage'])
    expect(writes).toHaveLength(2)
    expect(writes[0]!.objects[0]!.transform.position).toEqual([0, 0, 0])
    expect(writes[1]!.objects[0]!.transform.position).toEqual([0.25, 0, 0])
    expect(sceneDoc(nodes[0])!.objects[0]).toMatchObject({ createdBy: 'user', userTouched: true })
    expect(methods.every(method => ['canvas.apply', 'canvas.get'].includes(method))).toBe(true)
  })

  it('leaves creative and proposal quality to review and requires a completed closing reply', () => {
    const e = protectedScene()
    expect(results(e, ['scene_proposal'])).toEqual(['fail'])
    e.transcript.push(item(1, 'assistant_text', { text: 'I suggest moving the bench half a metre to the right; please make that adjustment in the scene editor.' }))
    expect(results(e, ['scene_proposal'])).toEqual(['fail'])
    const { createdBy: _createdBy, userTouched: _userTouched, ...bench } = current(e).objects[0]!
    const proposal = { slotId: 'scene-main', baseRevision: 2, summary: 'Move the bench right', changes: [{ target: 'object', id: 'bench', action: 'update', item: { ...bench, transform: { ...bench.transform, position: [0.75, 0, 0] } } }] }
    call(e, 'scene_propose', proposal, 'scene.change_invalid', true)
    e.transcript.push(item(4, 'assistant_text', { text: 'A proposal is waiting.' }))
    expect(results(e, ['scene_proposal'])).toEqual(['fail'])
    call(e, 'scene_propose', proposal)
    e.transcript.push(item(7, 'assistant_text', { text: 'A proposal is waiting in the scene editor.' }))
    expect(results(e, ['scene_proposal', 'scene_protected_preserved', 'scene_bench_quality', 'scene_walk_quality'])).toEqual(['review', 'pass', 'review', 'review'])
    call(e, 'canvas_get', {})
    expect(results(e, ['scene_proposal'])).toEqual(['fail'])
    e.transcript.push(item(10, 'assistant_text', { text: 'Here is my proposal.' }))
    e.ended = false
    expect(results(e, ['scene_proposal'])).toEqual(['fail'])
  })
})
