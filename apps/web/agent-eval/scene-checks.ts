import { isDeepStrictEqual } from 'node:util'
import { scene, SceneDoc, type SceneObject, type SceneView } from '@vis/protocol'
import { mainSlot, sceneDoc } from './fixtures'
import type { Check, Evidence, ToolCall } from './checks'

export function sceneCheck(id: string, e: Evidence, calls: ToolCall[]): Check {
  const check = (ok: boolean, detail: string): Check => ({ id, result: ok ? 'pass' : 'fail', detail })
  const review = (detail: string): Check => ({ id, result: 'review', detail })
  const successful = (call: ToolCall) => call.hasResult && !call.error
  const parsed = (call: ToolCall): any => { try { return JSON.parse(call.output) } catch { return undefined } }
  const nodes = e.after.filter(node => node.kind === 'scene' && !e.before.some(before => before.nodeId === node.nodeId))
  const scenes = nodes.flatMap(node => {
    const doc = sceneDoc(node)
    return doc ? [{ node, doc }] : []
  })
  const ops = calls.filter(call => call.name === 'canvas_apply').flatMap(call =>
    (Array.isArray(call.input?.ops) ? call.input.ops : []).filter((op: any) => op && typeof op === 'object').map((op: any) => ({ op, call })),
  )
  const resolveNode = (nodeId: string, call: ToolCall) => parsed(call)?.idMap?.[nodeId] ?? nodeId
  const resolveSlot = (slotId: string, call: ToolCall) => {
    if (typeof slotId !== 'string' || !slotId.endsWith(':main')) return slotId
    const nodeId = resolveNode(slotId.slice(0, -5), call)
    return [...e.after, ...e.before].find(node => node.nodeId === nodeId)?.slots.find(slot => slot.slotKey === 'main')?.slotId ?? slotId
  }
  const renderCalls = calls.filter(call => call.name === 'gen_submit' && successful(call) && call.input.provider === 'render' && call.input.model === 'scene')
  const renders = renderCalls.flatMap(call => {
    const input = call.input.inputs?.[0]
    const node = e.after.find(node => node.kind === 'scene' && mainSlot(node).slotId === input?.slotId)
    if (!node) return []
    let doc = mainSlot(node).revision === input.revision ? sceneDoc(node) : undefined
    if (!doc) {
      const written = ops.findLast(({ op, call: write }) => successful(write) && write.seq < call.seq && op.op === 'scene.set' && resolveSlot(op.slotId, write) === input.slotId && op.expectedRevision + 1 === input.revision)
      const validated = SceneDoc.safeParse(written?.op.doc)
      if (validated.success) doc = validated.data
    }
    const job = e.jobs.find(job => job.jobId === parsed(call)?.jobId && job.status === 'succeeded')
    if (!doc || !job || !doc.views.some(view => view.id === call.input.params?.viewId)) return []
    return job.outputs.map(output => ({
      call, doc, node, output,
      asset: e.assets?.find(asset => asset.assetVersionId === output.assetVersionId),
      delivered: e.after.find(node => node.nodeId === output.delivery.nodeId),
    }))
  })
  const delivered = (kind: 'image' | 'video') => renders.filter(render => render.call.input.kind === kind)
  const validDelivery = (render: typeof renders[number], kind: 'image' | 'video') =>
    render.output.delivery.status === 'delivered' && render.delivered?.kind === kind && render.delivered.inputs?.includes(render.node.nodeId) === true &&
    render.asset?.kind === kind && render.asset.mime.startsWith(`${kind}/`) &&
    render.delivered.slots.some(slot => slot.content.type === 'asset' && slot.content.assetVersionId === render.output.assetVersionId)
  const different = (keys: readonly { value: unknown }[] = []) => keys.length >= 2 && keys.some(key => !isDeepStrictEqual(key.value, keys[0]!.value))
  switch (id) {
    case 'scene_guide_read': {
      const firstWrite = ops.find(({ op, call }) => successful(call) && (op.op === 'scene.set' || (op.op === 'node.create' && op.kind === 'scene')))
      return check(calls.some(call => call.name === 'guide_get' && successful(call) && call.input.topic === 'scene' && (!firstWrite || call.seq < firstWrite.call.seq)), 'The scene guide was read successfully before the first successful scene write')
    }
    case 'scene_document': return check(scenes.length > 0 && scenes.every(({ doc }) => SceneDoc.safeParse(doc).success && [...doc.objects, ...doc.views].every(item => item.createdBy === 'agent' && !item.userTouched)), 'New scene documents are valid and their objects and views have authoritative untouched Agent ownership')
    case 'scene_bench_group': return check(scenes.some(({ doc }) =>
      doc.objects.some(object => object.source.type === 'group' && object.source.parts.length >= 2) &&
      doc.objects.some(object => object.source.type === 'figure' && object.source.bodyId === 'human' && Object.values(object.source.pose).some(quat => !isDeepStrictEqual(quat, [0, 0, 0, 1]))) &&
      doc.views.length > 0,
    ), 'A new scene has an assembled group prop, a posed human figure and a view; bench construction, sitting contact and wide framing require visual review')
    case 'scene_walk_motion': return check(scenes.some(({ doc }) =>
      !!doc.durationS && doc.objects.some(object => object.source.type === 'figure' && different(object.tracks?.transform?.map(key => ({ value: key.value.position }))) &&
        Object.values(object.tracks?.pose ?? {}).filter(different).length >= 2) &&
      doc.views.some(view => different(view.cameraKeys)),
    ), 'The same scene has figure translation, changing pose keys on at least two joints and a camera move; gait, direction and framing require review')
    case 'scene_render_image': {
      const images = delivered('image')
      return check(images.length > 0 && images.every(render => validDelivery(render, 'image') && typeof render.call.input.params?.timeS === 'number' &&
        Number.isFinite(render.call.input.params.timeS) && render.call.input.params.timeS >= 0), 'A completed render/scene image uses the scene revision first, a valid view and nonnegative frame time, and delivers an image linked to the scene')
    }
    case 'scene_render_video': {
      const videos = delivered('video')
      return check(videos.length > 0 && videos.every(render => validDelivery(render, 'video') && !!render.doc.durationS && !!render.asset?.durationMs && !!render.asset.fps &&
        Math.abs(render.asset.durationMs - render.doc.durationS * 1000) <= 1000 / render.asset.fps &&
        Math.abs(render.asset.fps - (render.call.input.params?.fps ?? 24)) < 0.01), 'A completed render/scene video is linked to its scene input and its measured duration and FPS match that scene and request')
    }
    case 'scene_local_only': {
      const ids = new Set(renderCalls.map(call => parsed(call)?.jobId).filter(Boolean))
      return check(calls.filter(call => call.name === 'gen_submit').every(call => call.input.provider === 'render' && call.input.model === 'scene') &&
        !calls.some(call => call.name === 'script_batch_start') && !e.batches.length && e.jobs.every(job => ids.has(job.jobId)), 'All observed generation attempts and jobs use free local render/scene, with no batch or unaccounted job')
    }
    case 'scene_protected_preserved': {
      const beforeNode = e.before.find(node => node.nodeId === e.fixtureVars.sceneNodeId)
      const before = sceneDoc(beforeNode)
      const after = sceneDoc(e.after.find(node => node.nodeId === beforeNode?.nodeId))
      const protectedItem = (item: SceneObject | SceneView) => item.createdBy !== 'agent' || item.userTouched
      const content = (item: SceneObject | SceneView) => {
        const { createdBy: _creator, userTouched: _touched, ...rest } = item
        if ('still' in rest) { const { still: _still, ...view } = rest; return view }
        return rest
      }
      const preserved = (doc: SceneDoc | undefined) => !!before && !!doc && (['objects', 'views'] as const).every(field =>
        before[field].filter(protectedItem).every(item => {
          const next = doc[field].find(candidate => candidate.id === item.id)
          return next && next.createdBy === item.createdBy && next.userTouched === item.userTouched && isDeepStrictEqual(content(item), content(next))
        }),
      )
      const writes = ops.filter(({ op }) => op.op === 'scene.set' || op.op === 'node.delete')
      const relevant = writes.filter(({ op, call }) => op.op === 'scene.set' ? resolveSlot(op.slotId, call) === (beforeNode && mainSlot(beforeNode).slotId) : resolveNode(op.nodeId, call) === beforeNode?.nodeId)
      const refused = relevant.filter(({ call }) => call.error).map(({ call }) => ({ seq: call.seq, error: call.output }))
      return check(!!before?.objects.some(protectedItem) && preserved(after) && relevant.filter(({ call }) => successful(call)).every(({ op }) =>
        op.op === 'scene.set' && preserved(SceneDoc.safeParse(op.doc).data),
      ), `Protected content remains unchanged in persisted state and every exposed successful write; denied attempts: ${JSON.stringify(refused)}`)
    }
    case 'scene_proposal': {
      const lastTool = Math.max(0, ...e.transcript.filter(item => item.kind === 'tool_call' || item.kind === 'tool_result').map(item => item.createdSeq))
      const text = e.transcript.filter(item => item.kind === 'assistant_text' && item.createdSeq > lastTool).map(item => (item.payload as any)?.text ?? '').join('\n')
      const source = e.before.find(node => node.nodeId === e.fixtureVars.sceneNodeId)
      const proposals = calls.filter(call => call.name === 'scene_propose' && successful(call)).filter(call => {
        const input = scene.propose.params.safeParse({ requestId: 'evaluation', ...call.input })
        return input.success && source && input.data.slotId === mainSlot(source).slotId && input.data.baseRevision === mainSlot(source).revision
          && input.data.changes.some(change => change.target === 'object' && change.id === e.fixtureVars.sceneObjectId && change.action === 'update')
      })
      if (!proposals.length) return check(false, 'A successful scene.propose call must propose an update to the author-touched object at its current revision')
      return e.ended && text.trim() ? review(`Review the proposed content and closing reply for the requested change and an author action, with no claim that protected content was edited: ${text}`) : check(false, 'A completed session must contain a reply after its last tool activity')
    }
    case 'scene_bench_quality': return review('Inspect the local image for an assembled bench, a figure sitting in contact with it and the requested wide view; do not score a house style')
    case 'scene_walk_quality': return review('Watch the video and inspect extracted frames for walking rather than sliding, travel direction, camera motion and the author-requested timing')
    default: throw new Error(`Unknown scene check: ${id}`)
  }
}
