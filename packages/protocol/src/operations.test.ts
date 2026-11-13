import { describe, expect, it } from 'vitest'
import { METHODS } from './methods'
import { NodeView } from './canvas'
import { EVENT_TYPES } from './events'
import { LOCAL_OPERATION_OUTPUT, LOCAL_OPERATION_PARAMS, LocalOperation, modelOperations, operationKind, promptRef, promptRefs } from './operations'

const base = { requestId: 'r', nodeId: 'n', slotId: 's', expectedRevision: 1 }
const process = (operation: string, params: unknown) => METHODS['media.process'].params.safeParse({ ...base, operation, params }).success

describe('0021 operation catalog', () => {
  it('every local operation has a params schema and an output mode', () => {
    for (const op of LocalOperation.options) {
      expect(LOCAL_OPERATION_PARAMS[op]).toBeDefined()
      if (op === 'video.exportMov') expect(LOCAL_OPERATION_OUTPUT[op]).toBe('download')
      else expect(['replace', 'new_nodes']).toContain(LOCAL_OPERATION_OUTPUT[op])
    }
    expect(operationKind('image.crop')).toBe('image')
    expect(operationKind('video.removeSubtitles')).toBe('video')
    expect(operationKind('generate')).toBeUndefined()
    expect(operationKind('timeline.export')).toBe('timeline')
    expect(LOCAL_OPERATION_OUTPUT['timeline.export']).toBe('new_nodes')
    expect(LOCAL_OPERATION_PARAMS['timeline.export'].safeParse({}).success).toBe(true)
    expect(LOCAL_OPERATION_PARAMS['timeline.export'].safeParse({ x: 1 }).success).toBe(false)
    expect(modelOperations({})).toEqual(['generate'])
    expect(modelOperations({ operations: ['generate', 'image.upscale'] })).toEqual(['generate', 'image.upscale'])
  })

  it('media.process validates params per operation', () => {
    expect(process('image.crop', { x: 0, y: 0, w: 10, h: 10 })).toBe(true)
    expect(process('image.crop', { x: 0, y: 0, w: 0, h: 10 })).toBe(false)
    expect(process('image.crop', { x: 0.5, y: 0, w: 10, h: 10 })).toBe(false)
    expect(process('image.gridSplit', { rows: 3, cols: 2 })).toBe(true)
    expect(process('image.gridSplit', { rows: 4, cols: 2 })).toBe(false)
    expect(process('video.trim', { startMs: 0, endMs: 1000 })).toBe(true)
    expect(process('video.trim', { startMs: 1000, endMs: 1000 })).toBe(false)
    expect(process('audio.trim', { startMs: 0, endMs: 1000, extra: 1 })).toBe(false)
    expect(process('video.extractAudio', {})).toBe(true)
    expect(process('audio.split', { pointsMs: [500, 1500] })).toBe(true)
    expect(process('audio.split', { pointsMs: [1500, 500] })).toBe(false)
    expect(process('audio.split', { pointsMs: [] })).toBe(false)
    expect(process('audio.split', { pointsMs: Array.from({ length: 21 }, (_, i) => (i + 1) * 100) })).toBe(false)
    expect(process('audio.speed', { rate: 1.5 })).toBe(true)
    expect(process('audio.speed', { rate: 1 })).toBe(false)
    expect(process('audio.speed', { rate: 3 })).toBe(false)
    // params cannot borrow another operation
    expect(process('image.crop', { rows: 2, cols: 2 })).toBe(false)
    expect(process('image.blur', {})).toBe(false)
    expect(METHODS['media.process'].params.safeParse({ ...base, operation: 'video.frame', params: { atMs: 0 }, waitMs: 30_001 }).success).toBe(false)
    expect(METHODS['media.process'].params.safeParse({ requestId: 'r', nodeId: 'n', slotId: 's', operation: 'video.frame', params: { atMs: 0 } }).success).toBe(false)
  })

  it('media.analyze and media.get', () => {
    expect(METHODS['media.analyze'].params.safeParse({ operation: 'audio.silence', nodeId: 'n', slotId: 's' }).success).toBe(true)
    expect(METHODS['media.analyze'].params.safeParse({ operation: 'audio.silence', nodeId: 'n', slotId: 's', params: { minSilenceMs: 50 } }).success).toBe(false)
    expect(METHODS['media.get'].params.safeParse({ taskId: 't', waitMs: 1000 }).success).toBe(true)
    const task = { taskId: 't', status: 'succeeded', operation: 'audio.split', nodeId: 'n', slotId: 's', createdAt: 1, assetVersionIds: ['a', 'b'], nodeIds: ['n1', 'n2'] }
    expect(METHODS['media.get'].result.safeParse(task).success).toBe(true)
    expect(EVENT_TYPES).toContain('mediaTask.stateChanged')
    expect(METHODS['media.process'].callers).toEqual(['ui', 'agent'])
  })

  it('media.preview is UI-only and returns peaks, a filmstrip, a poster or a thumbnail', () => {
    expect(METHODS['media.preview'].callers).toEqual(['ui'])
    expect(METHODS['media.preview'].params.safeParse({ assetVersionId: 'a', kind: 'peaks' }).success).toBe(true)
    expect(METHODS['media.preview'].params.safeParse({ assetVersionId: 'a', kind: 'poster' }).success).toBe(true)
    expect(METHODS['media.preview'].result.safeParse({ kind: 'poster', width: 960, height: 540, path: '/cache/poster.jpg' }).success).toBe(true)
    expect(METHODS['media.preview'].result.safeParse({ kind: 'poster', width: 961, height: 540 }).success).toBe(false)
    expect(METHODS['media.preview'].result.safeParse({ kind: 'poster', width: 960, height: 0 }).success).toBe(false)
    expect(METHODS['media.preview'].params.safeParse({ assetVersionId: 'a', kind: 'unknown' }).success).toBe(false)
    expect(METHODS['media.preview'].result.safeParse({ kind: 'peaks', durationMs: 1000, binsPerSecond: 50, peaks: [0, 0.5, 1] }).success).toBe(true)
    expect(METHODS['media.preview'].result.safeParse({ kind: 'peaks', durationMs: 1000, binsPerSecond: 50, peaks: [1.5] }).success).toBe(false)
    expect(METHODS['media.preview'].result.safeParse({ kind: 'filmstrip', durationMs: 1000, frameWidth: 96, frameHeight: 54, intervalMs: 1000, frames: 1 }).success).toBe(true)
  })

  it('generation operations: generate needs a prompt, others need an input', () => {
    const submit = METHODS['generation.submit'].params
    expect(submit.safeParse({ requestId: 'r', kind: 'image' }).success).toBe(false)
    expect(submit.parse({ requestId: 'r', kind: 'image', prompt: 'p' })).toMatchObject({ prompt: 'p' })
    expect(submit.safeParse({ requestId: 'r', kind: 'image', operation: 'image.upscale' }).success).toBe(false)
    expect(submit.parse({ requestId: 'r', kind: 'image', operation: 'image.upscale', inputs: [{ slotId: 's' }] })).toMatchObject({ prompt: '' })
    expect(submit.safeParse({ requestId: 'r', kind: 'image', operation: 'image.blur', prompt: 'p' }).success).toBe(false)
    const catalog = METHODS['providers.list'].result
    const provider = { id: 'mock', type: 'mock', label: 'Mock', needsKey: false, available: true, hasKey: true, models: [{ id: 'm', label: 'M', kind: 'image', paramsSchema: {}, operations: ['generate', 'image.upscale'] }] }
    expect(catalog.safeParse({ videoReferences: 'hosting_required', providerTypes: [], providers: [provider], defaults: {} }).success).toBe(true)
  })

  it('node titles and prompt references', () => {
    const node = { nodeId: 'n', kind: 'image', x: 0, y: 0, w: 320, h: 200, z: 1, layoutRevision: 1, slots: [] }
    expect(NodeView.parse({ ...node, title: '哈士奇' })).toMatchObject({ title: '哈士奇' })
    const apply = (op: unknown) => METHODS['canvas.apply'].params.safeParse({ requestId: 'r', ops: [op] }).success
    expect(apply({ op: 'node.setMeta', nodeId: 'n', title: '三狗男性声线' })).toBe(true)
    expect(apply({ op: 'node.setMeta', nodeId: 'n', title: null })).toBe(true)
    expect(apply({ op: 'node.setMeta', nodeId: 'n', title: '  ' })).toBe(false)
    expect(apply({ op: 'node.create', tempId: 't', kind: 'image', title: '一'.repeat(61) })).toBe(false)
    const prompt = `狗蛋=${promptRef('node_7')}，二狗=${promptRef('node_8')}，又见${promptRef('node_7')}`
    expect(promptRefs(prompt)).toEqual(['node_7', 'node_8'])
    expect(promptRefs('{{ref:}} {{ref:a b}}')).toEqual([])
  })
})
