import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MediaTaskView, NodeView, SpaceEvent } from '@vis/protocol'
import type { ProviderCatalog } from '@vis/canvas-ui'
import { canvasActions } from './actions'
import { generationOperations } from './operations'
import { applyEvent, applyMediaProgress, dismissMediaTask, emptyState, fromSnapshot, nodeDecorations, recordMediaTask } from './store'
import type { SpaceConnection } from './space'

const node: NodeView = { nodeId: 'image', kind: 'image', x: 500, y: 100, w: 320, h: 180, z: 0, layoutRevision: 1, inputs: ['old'],
  generation: { provider: 'mock', model: 'preferred', params: { scale: 4 } },
  slots: [{ slotId: 'main', slotKey: 'main', contentType: 'image', revision: 7, content: { type: 'asset', assetVersionId: 'asset', mime: 'image/png' } }],
}
const catalog: ProviderCatalog = { videoReferences: 'hosting_required', providerTypes: [], providers: [{ id: 'mock', type: 'mock', needsKey: false, available: true, hasKey: false, label: 'Mock', models: [
  { id: 'legacy', label: 'Legacy', kind: 'image', paramsSchema: {} },
  { id: 'first', label: 'First', kind: 'image', operations: ['generate', 'image.upscale', 'image.outpaint'], paramsSchema: { properties: { scale: { type: 'integer', default: 2, enum: [2, 4] } } } },
  { id: 'preferred', label: 'Preferred', kind: 'image', operations: ['image.upscale'], paramsSchema: { properties: { scale: { type: 'integer', default: 2, enum: [2, 4] } } } },
] }], defaults: {}, limits: { maxConcurrent: 3, dailyImage: 50, dailyVideo: 10, dailyAudio: 20 } }
const task: MediaTaskView = { taskId: 'task', operation: 'image.crop', nodeId: node.nodeId, slotId: 'main', status: 'queued', createdAt: 1 }
function setup(providers: ProviderCatalog | null = catalog) {
  const state = { ...emptyState(), nodes: new Map([[node.nodeId, node]]) }
  const view = { space: { spaceId: 'project' }, ready: true, state, providers }
  const call = vi.fn(async (method: string, _params?: unknown): Promise<any> => {
    if (method === 'canvas.get') return { nodes: [node] }
    if (method === 'canvas.apply') return { idMap: { 'copy-0': 'copy' }, eventSeq: 1 }
    if (method === 'media.process') return task
    if (method === 'media.get') return { ...task, status: 'succeeded' }
    if (method === 'media.analyze') return { durationMs: 3000, pointsMs: [1000] }
    return { jobId: 'job' }
  })
  const record = vi.fn()
  const notify = vi.fn()
  const conn = { rpc: { call }, token: 'test', getView: () => view, recordMediaTask: record } as unknown as SpaceConnection
  return { actions: canvasActions(conn, notify, 'en'), call, record, notify, view }
}
afterEach(() => vi.unstubAllGlobals())

describe('Provider operation routing', () => {
  it('submits the prompt slot first while omitting empty references without changing media numbers', async () => {
    const { actions, call } = setup()
    const target: NodeView = { ...node, inputs: ['empty', 'reference'], slots: [...node.slots, { slotId: 'prompt', slotKey: 'prompt', contentType: 'text', revision: 1, content: { type: 'text', body: '{{ref:reference}}' } }] }
    const reference: NodeView = { ...node, nodeId: 'reference', slots: [{ ...node.slots[0]!, slotId: 'reference-main' }] }
    call.mockResolvedValueOnce({ nodes: [target] }).mockResolvedValueOnce({ nodes: [{ ...node, nodeId: 'empty', slots: [] }, reference] })
    await actions.onGenerate('image', { provider: 'mock', model: 'first', params: {} })
    expect(call).toHaveBeenCalledWith('generation.submit', expect.objectContaining({
      prompt: '{{ref:reference}}', inputs: [{ slotId: 'prompt', revision: 1 }, { slotId: 'reference-main', revision: 7 }],
    }))
  })
  it('has no generated entries without a catalog; legacy models support only generate', () => {
    expect(generationOperations(null)).toEqual({ image: [], video: [], audio: [] })
    expect(generationOperations(catalog)).toEqual({ image: ['image.upscale', 'image.outpaint'], video: [], audio: [] })
  })
  it('hides toolbar operations declared only by unavailable or unconfigured providers', () => {
    const provider = catalog.providers[0]!
    expect(generationOperations({ ...catalog, providers: [{ ...provider, available: false }] }).image).toEqual([])
    expect(generationOperations({ ...catalog, providers: [{ ...provider, needsKey: true, hasKey: false }] }).image).toEqual([])
    expect(generationOperations({ ...catalog, providers: [{ ...provider, needsKey: true, hasKey: true }] }).image).toEqual(['image.upscale', 'image.outpaint'])
  })
  it('submits the explicit operation settings, pins the current subject and creates a new node without writing the draft', async () => {
    const { actions, call } = setup()
    const request = { operation: 'image.outpaint' as const, provider: 'mock', model: 'first', params: { ratio: '16:9' }, prompt: 'Extend {{ref:image}}' }
    await actions.onSubmitOperation!(node.nodeId, request)
    await actions.onSubmitOperation!(node.nodeId, request)
    const submits = call.mock.calls.filter(([method]) => method === 'generation.submit')
    expect(submits[0]).toEqual(['generation.submit', {
      requestId: expect.any(String), kind: 'image', ...request,
      inputs: [{ slotId: 'main', revision: 7 }], targets: [{ outputIndex: 0, kind: 'new_node', nearNodeId: 'image' }],
    }])
    expect(call.mock.calls.map(([method]) => method)).toEqual(['canvas.get', 'generation.submit', 'canvas.get', 'generation.submit'])
    expect((submits[0]![1] as any).requestId).not.toBe((submits[1]![1] as any).requestId)
  })
  it('coalesces simultaneous operation presses until the receipt returns', async () => {
    const { actions, call } = setup()
    const request = { operation: 'image.upscale' as const, provider: 'mock', model: 'preferred', params: { scale: 2 }, prompt: '' }
    await Promise.all([actions.onSubmitOperation!(node.nodeId, request), actions.onSubmitOperation!(node.nodeId, request)])
    expect(call.mock.calls.filter(([method]) => method === 'generation.submit')).toHaveLength(1)
  })
  it('keeps distinct explicit operation requests separate while another receipt is pending', async () => {
    const { actions, call } = setup()
    const request = { operation: 'image.upscale' as const, provider: 'mock', model: 'preferred', params: { scale: 2 }, prompt: '' }
    await Promise.all([actions.onSubmitOperation!(node.nodeId, request), actions.onSubmitOperation!(node.nodeId, { ...request, params: { scale: 4 } })])
    expect(call.mock.calls.filter(([method]) => method === 'generation.submit').map(([, payload]) => (payload as any).params)).toEqual([{ scale: 2 }, { scale: 4 }])
  })
  it('rereads the current subject revision and reports submission errors through the existing notice path', async () => {
    const { actions, call, notify } = setup()
    const request = { operation: 'image.upscale' as const, provider: 'mock', model: 'preferred', params: { scale: 2 }, prompt: '' }
    call.mockResolvedValueOnce({ nodes: [{ ...node, slots: [{ ...node.slots[0]!, revision: 9 }] }] })
    await actions.onSubmitOperation!(node.nodeId, request)
    expect(call).toHaveBeenCalledWith('generation.submit', expect.objectContaining({ inputs: [{ slotId: 'main', revision: 9 }] }))
    call.mockResolvedValueOnce({ nodes: [node] }).mockRejectedValueOnce(new Error('Submission failed'))
    await expect(actions.onSubmitOperation!(node.nodeId, request)).rejects.toThrow('Submission failed')
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'error', text: expect.stringContaining('Submission failed') }))
  })
  it.each([null, { ...catalog, providers: [{ ...catalog.providers[0]!, needsKey: true, hasKey: false }] }])('rejects an unusable explicit choice without switching models or submitting', async providers => {
    const { actions, call, notify } = setup(providers)
    await expect(actions.onSubmitOperation!(node.nodeId, { operation: 'image.upscale', provider: 'mock', model: 'preferred', params: {}, prompt: '' })).rejects.toThrow('No model supports')
    expect(call.mock.calls.some(([method]) => method === 'generation.submit')).toBe(false)
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'error' }))
  })
  it('rejects models that do not declare the operation and mismatched media kinds', async () => {
    const { actions, call } = setup()
    for (const request of [
      { operation: 'image.outpaint' as const, provider: 'mock', model: 'preferred', params: {}, prompt: '' },
      { operation: 'video.upscale' as const, provider: 'mock', model: 'first', params: {}, prompt: '' },
    ]) await expect(actions.onSubmitOperation!(node.nodeId, request)).rejects.toThrow('No model supports')
    expect(call.mock.calls.some(([method]) => method === 'generation.submit')).toBe(false)
  })
})

describe('Local media host actions', () => {
  it('waits on the original task without resubmitting and preserves revision and parameters', async () => {
    const { actions, call, record } = setup()
    const request = { operation: 'image.crop' as const, nodeId: 'image', slotId: 'main', expectedRevision: 7, params: { x: 0, y: 0, w: 10, h: 20 } }
    expect(await actions.onMediaProcess!(request)).toMatchObject({ status: 'succeeded' })
    expect(call.mock.calls).toEqual([
      ['media.process', { ...request, requestId: expect.any(String), waitMs: 0 }],
      ['media.get', { taskId: 'task', waitMs: 30_000 }],
    ])
    expect(record.mock.calls.map(([task]) => task.status)).toEqual(['queued', 'succeeded'])
    await actions.onMediaProcess!(request)
    expect((call.mock.calls[0]![1] as any).requestId).not.toBe((call.mock.calls[2]![1] as any).requestId)
  })
  it('retains failed tasks for dismissal and propagates structured failure to the panel', async () => {
    const { actions, call, record, notify } = setup()
    call.mockResolvedValueOnce({ ...task, status: 'failed', error: { code: 'revision_conflict', message: 'Changed during processing' } })
    await expect(actions.onMediaProcess!({ operation: 'image.crop', nodeId: 'image', slotId: 'main', expectedRevision: 7, params: { x: 0, y: 0, w: 10, h: 10 } })).rejects.toMatchObject({ code: 'revision_conflict' })
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }))
    expect(notify).toHaveBeenCalled()
    expect(call).toHaveBeenCalledTimes(1)
  })
  it('routes silence analysis and stops waiting when the selected project changes', async () => {
    const { actions, call, view } = setup()
    expect(await actions.onMediaAnalyze!('audio', 'audio-main')).toEqual({ durationMs: 3000, pointsMs: [1000] })
    expect(call).toHaveBeenCalledWith('media.analyze', { operation: 'audio.silence', nodeId: 'audio', slotId: 'audio-main' })
    call.mockImplementationOnce(async () => { view.space.spaceId = 'other'; return task })
    await expect(actions.onMediaProcess!({ operation: 'image.crop', nodeId: 'image', slotId: 'main', expectedRevision: 7, params: { x: 0, y: 0, w: 1, h: 1 } })).rejects.toThrow('project has changed')
    expect(call).toHaveBeenCalledTimes(2)
  })
  it('uploads all references then creates linked nodes in one undoable batch, retaining the latest input order', async () => {
    const { actions, call } = setup()
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ kind: 'image', assetVersionId: 'upload', width: 800, height: 400 }) })
    vi.stubGlobal('fetch', fetch)
    await actions.onUploadReference!('image', [new File(['test'], 'reference.png')])
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/upload?'), expect.objectContaining({ method: 'POST', body: expect.any(File) }))
    expect(call.mock.calls).toEqual([
      ['canvas.get', { nodeIds: ['image'] }],
      ['canvas.apply', expect.objectContaining({ ops: [
        { op: 'node.create', tempId: 'reference-0', kind: 'image', x: 140, y: 100, w: 320, h: 160, content: { assetVersionId: 'upload' } },
        { op: 'node.setInputs', nodeId: 'image', inputNodeIds: ['old', 'reference-0'] },
      ] })],
    ])
  })
  it('copies explicit or fallback titles with a suffix within the contract limit', async () => {
    const { actions, call } = setup()
    await actions.onClone([{ ...node, title: 'A'.repeat(60) }], { x: 0, y: 0 })
    const title = (call.mock.calls[0]![1] as any).ops[0].title
    expect(title).toHaveLength(60)
    expect(title).toMatch(/ copy$/)
    await actions.onClone([node], { x: 0, y: 0 })
    expect((call.mock.calls[1]![1] as any).ops[0].title).toBe('Image 1 copy')
  })
  it('copies the displayed default title when insertion order differs from canvas z order', async () => {
    const { actions, call, view } = setup()
    view.state.nodes = new Map([
      ['later', { ...node, nodeId: 'later', z: 20 }],
      ['image', node],
    ])
    await actions.onClone([{ ...node, nodeId: 'later', z: 20 }], { x: 0, y: 0 })
    expect((call.mock.calls[0]![1] as any).ops[0].title).toBe('Image 2 copy')
  })
})

describe('Media task snapshots and event state', () => {
  it('applies transient progress without advancing seq and ignores stale or terminal updates', () => {
    const initial = fromSnapshot({ nodes: [node], sessions: [], activeJobs: [], workItems: [], activeMediaTasks: [task] }, 10)
    const next = applyMediaProgress(initial, { taskId: task.taskId, progress: 0.5 })
    expect(next.seq).toBe(10)
    expect(nodeDecorations(next).byNode.get('image')?.mediaTask?.progress).toBe(0.5)
    expect(applyMediaProgress(next, { taskId: task.taskId, progress: 0.4 })).toBe(next)
    const done = recordMediaTask(next, { ...task, status: 'succeeded' })
    expect(applyMediaProgress(done, { taskId: task.taskId, progress: 0.9 })).toBe(done)
  })
  const event = (seq: number, payload: MediaTaskView): SpaceEvent => ({ seq, type: 'mediaTask.stateChanged', payload, entityId: payload.taskId, entityType: 'mediaTask' })
  it('restores progress from snapshots and merges events by sequence without regressing terminal tasks', () => {
    const initial = fromSnapshot({ nodes: [node], sessions: [], activeJobs: [], workItems: [], activeMediaTasks: [task] }, 10)
    expect(nodeDecorations(initial).byNode.get('image')?.mediaTask?.status).toBe('queued')
    const running = applyEvent(initial, event(11, { ...task, status: 'running', progress: 0.5 }))
    expect(nodeDecorations(running).byNode.get('image')?.mediaTask?.progress).toBe(0.5)
    expect(applyEvent(running, event(10, task))).toBe(running)
    const done = applyEvent(running, event(12, { ...task, status: 'succeeded' }))
    expect(nodeDecorations(done).byNode.get('image')?.mediaTask).toBeUndefined()
    expect(recordMediaTask(done, task)).toBe(done)
  })
  it('dismisses failures only and prefers the most recent task for a node', () => {
    let state = { ...emptyState(), nodes: new Map([[node.nodeId, node]]) }
    state = recordMediaTask(state, { ...task, status: 'failed', error: { code: 'media.failed', message: 'Failed' } })
    expect(nodeDecorations(state).byNode.get('image')?.mediaTask?.status).toBe('failed')
    expect(dismissMediaTask(state, 'task').mediaTasks.size).toBe(0)
    const next = recordMediaTask(state, { ...task, taskId: 'newer', createdAt: 2, status: 'running' })
    expect(nodeDecorations(next).byNode.get('image')?.mediaTask?.taskId).toBe('newer')
    expect(dismissMediaTask(next, 'newer')).toBe(next)
  })
})
