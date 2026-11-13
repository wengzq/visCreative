import { describe, expect, it } from 'vitest'
import { METHODS } from './methods'
import { ApprovalPayload } from './session'
import { EVENT_TYPES, SpaceSnapshot } from './events'
import { BatchView } from './batch'

const estimate = { shots: 2, jobs: 3, billedJobs: 0, provider: 'mock', model: 'mock-video-1', quotaRemaining: null, frameMode: 'first_last', staleShots: 0, shotsMissingAssetImages: 1, shotsMissingFirstFrame: 0, shotsWithoutPrompt: 0 }
const batch = {
  batchId: 'b', scriptNodeId: 'n', status: 'pending_approval', origin: 'agent', sessionId: 's', media: 'video', createdAt: 1, changedShotIds: ['shot_2'], estimate,
  shots: [{ shotId: 'shot_1', steps: [{ role: 'video', status: 'waiting' }] }, { shotId: 'shot_2', steps: [{ role: 'first', status: 'waiting', source: 'extract', blockedBy: 'waiting_previous' }, { role: 'video', status: 'waiting' }] }],
}

describe('0023 batches and frames', () => {
  it('accepts frames only for video submissions', () => {
    const submit = METHODS['generation.submit'].params
    const frames = { first: { slotId: 'a' }, last: { slotId: 'b', revision: 2 } }
    expect(submit.safeParse({ requestId: 'r', kind: 'video', prompt: 'p', frames }).success).toBe(true)
    expect(submit.safeParse({ requestId: 'r', kind: 'image', prompt: 'p', frames }).success).toBe(false)
    expect(submit.safeParse({ requestId: 'r', kind: 'video', prompt: 'p', frames: { last: { slotId: 'b' } } }).success).toBe(false)
  })

  it('models declare frame modes', () => {
    const provider = { id: 'mock', type: 'mock', label: 'Mock', needsKey: false, available: true, hasKey: true, models: [{ id: 'v', label: 'V', kind: 'video', paramsSchema: {}, frameModes: ['first', 'first_last'] }] }
    expect(METHODS['providers.list'].result.safeParse({ videoReferences: 'hosting_required', providerTypes: [], providers: [provider], defaults: {} }).success).toBe(true)
    expect(METHODS['providers.list'].result.safeParse({ videoReferences: 'hosting_required', providerTypes: [], providers: [{ ...provider, models: [{ ...provider.models[0], frameModes: ['last'] }] }], defaults: {} }).success).toBe(false)
  })

  it('batch views, plans and approval cards', () => {
    expect(BatchView.parse(batch).status).toBe('pending_approval')
    expect(METHODS['script.batch.start'].params.safeParse({ requestId: 'r', scriptNodeId: 'n', media: 'frames' }).success).toBe(true)
    expect(METHODS['script.batch.start'].params.safeParse({ requestId: 'r', scriptNodeId: 'n', media: 'audio' }).success).toBe(false)
    expect(METHODS['script.batch.plan'].params.safeParse({ scriptNodeId: 'n', media: 'video', strictShotIds: ['shot_2'], missingFirstFrames: 'skip' }).success).toBe(true)
    const { batchId: _b, status: _s, origin: _o, createdAt: _c, ...plan } = batch
    expect(METHODS['script.batch.plan'].result.safeParse(plan).success).toBe(true)
    expect(ApprovalPayload.safeParse({ approvalId: 'a', kind: 'generation_batch', summary: '', detail: '', status: 'pending', batchId: 'b' }).success).toBe(true)
    expect(EVENT_TYPES).toContain('scriptBatch.stateChanged')
    expect(SpaceSnapshot.shape.activeScriptBatches).toBeDefined()
  })

  it('only the UI approves, rejects or resumes; Agents can start, read and cancel', () => {
    for (const method of ['script.batch.approve', 'script.batch.reject', 'script.batch.resume'] as const) expect(METHODS[method].callers).toEqual(['ui'])
    for (const method of ['script.batch.plan', 'script.batch.start', 'script.batch.get', 'script.batch.list', 'script.batch.cancel'] as const) expect(METHODS[method].callers).toEqual(['ui', 'agent'])
    // MCP needs a top-level object schema
    expect(METHODS['script.batch.start'].params.def.type).toBe('object')
  })
})
