import type { BatchView, JobView, NodeView, SlotVersionView, SpaceEvent } from '@vis/protocol'
import { describe, expect, it } from 'vitest'
import { applyEvent, dismissJobs, fromSnapshot, nodeDecorations, reuseNodeDecorations, sortedNodes } from './store'

const node = (nodeId: string, z: number, body = 'a'): NodeView => ({
  nodeId, kind: 'text', x: 0, y: 0, w: 100, h: 100, z, layoutRevision: 1,
  slots: [{ slotId: `slot_${nodeId}`, slotKey: 'main', contentType: 'text', revision: 1, content: { type: 'text', body } }],
})
const ev = (seq: number, type: SpaceEvent['type'], payload: unknown): SpaceEvent => ({ seq, type, entityType: 'x', entityId: 'x', payload })

describe('Event merging', () => {
  const base = fromSnapshot({ nodes: [node('n1', 2), node('n2', 1)], sessions: [], activeJobs: [{ jobId: 'j1', status: 'running', outputs: [], targets: [] }], workItems: [] }, 10)

  it('Reuses unaffected node decorations across delivery and task updates', () => {
    const first = nodeDecorations({ ...base, delivered: new Map([['n1', 10], ['n2', 11]]) })
    const next = nodeDecorations({ ...base, delivered: new Map([['n1', 12], ['n2', 11]]) }, 'en', first.byNode)
    expect(next.byNode.get('n1')).not.toBe(first.byNode.get('n1'))
    expect(next.byNode.get('n2')).toBe(first.byNode.get('n2'))
    const same = nodeDecorations({ ...base, delivered: new Map([['n1', 12], ['n2', 11]]) }, 'en', next.byNode)
    expect(same.byNode).toBe(next.byNode)
  })

  it('Reuses structurally equal nested decoration values and detects nested changes', () => {
    const decoration = {
      running: 1, problems: [{ jobId: 'job', message: 'Retry', detail: { attempts: [1, { code: 'busy' }] } }],
      scriptAgent: { sessionId: 'session', title: 'Agent', task: null, running: true, detail: { steps: [{ done: false }] } },
    }
    const first = new Map([['n1', decoration]])
    expect(reuseNodeDecorations(new Map([['n1', structuredClone(decoration)]]), first)).toBe(first)
    const changed = structuredClone(decoration)
    changed.problems[0]!.detail.attempts = [2]
    expect(reuseNodeDecorations(new Map([['n1', changed]]), first).get('n1')).toBe(changed)
    expect(reuseNodeDecorations(new Map([['n1', { ...decoration, problems: [] }]]), first)).not.toBe(first)
    const changedAgent = structuredClone(decoration)
    changedAgent.scriptAgent.detail.steps[0]!.done = true
    expect(reuseNodeDecorations(new Map([['n1', changedAgent]]), first).get('n1')).toBe(changedAgent)
  })

  it('snapshot: nodes are sorted by hierarchy', () => {
    expect(sortedNodes(base).map(n => n.nodeId)).toEqual(['n2', 'n1'])
  })

  it('pre-0014 session events lack agentConfig; replay fills defaults and preserves existing settings unchanged', () => {
    const old = { sessionId: 'ses_1', agentKind: 'codex', title: '旧会话', titleSource: 'default', workDir: '/w', workItemId: null, queuePaused: false, activeTurnId: null, pendingApprovals: 0, createdAt: 1 }
    const created = applyEvent(base, ev(11, 'session.created', old))
    expect(created.sessions.get('ses_1')!.agentConfig).toEqual({ model: null, effort: null, serviceTier: null })
    const updated = applyEvent(created, ev(12, 'session.updated', { ...old, agentConfig: { model: 'm', effort: 'high' } }))
    expect(updated.sessions.get('ses_1')!.agentConfig).toEqual({ model: 'm', effort: 'high', serviceTier: null })
  })

  it('duplicate or stale events do not change state', () => {
    expect(applyEvent(base, ev(10, 'node.deleted', { nodeId: 'n1' }))).toBe(base)
  })

  it('restores active batches and deduplicates batch progress by sequence without regressing a finished step', () => {
    const batch: BatchView = {
      batchId: 'batch', scriptNodeId: 'n1', status: 'paused', origin: 'user', media: 'video', createdAt: 1, pausedReason: 'quota',
      estimate: { shots: 1, jobs: 1, billedJobs: 0, provider: 'mock', model: 'mock-video-1', quotaRemaining: 0, staleShots: 0, shotsMissingAssetImages: 0, shotsMissingFirstFrame: 0, shotsWithoutPrompt: 0 },
      shots: [{ shotId: 'shot', steps: [{ role: 'video', status: 'waiting', blockedBy: 'quota' }] }],
    }
    const snapshot = fromSnapshot({ nodes: [node('n1', 1)], sessions: [], activeJobs: [], workItems: [], activeScriptBatches: [batch] }, 10)
    expect(snapshot.scriptBatches.get('batch')).toEqual(batch)
    expect(nodeDecorations(snapshot).byNode.get('n1')?.scriptBatches).toEqual([batch])
    const completed = { ...batch, status: 'succeeded', shots: [{ shotId: 'shot', steps: [{ role: 'video', status: 'succeeded', nodeId: 'output' }] }] }
    const next = applyEvent(snapshot, ev(11, 'scriptBatch.stateChanged', completed))
    expect(applyEvent(next, ev(11, 'scriptBatch.stateChanged', batch))).toBe(next)
    expect(applyEvent(next, ev(9, 'scriptBatch.stateChanged', batch))).toBe(next)
    expect(next.scriptBatches.get('batch')).toEqual(completed)
    expect(snapshot.scriptBatches.get('batch')?.status).toBe('paused')
  })

  it('complete node events synchronize generation settings; clearing removes them without changing old state', () => {
    const generation = { provider: 'ark', model: 'image', params: { size: '4K' } }
    const changed = applyEvent(base, ev(11, 'node.updated', { ...node('n1', 2), generation }))
    expect(changed.nodes.get('n1')?.generation).toEqual(generation)
    const cleared = applyEvent(changed, ev(12, 'node.updated', node('n1', 2)))
    expect(cleared.nodes.get('n1')?.generation).toBeUndefined()
    expect(changed.nodes.get('n1')?.generation).toEqual(generation)
  })

  it('decorates scripts with active batches and only their most recent finished batch', () => {
    const batch: BatchView = { batchId: 'old', scriptNodeId: 'n1', status: 'cancelled', origin: 'user', media: 'frames', createdAt: 1,
      estimate: { shots: 0, jobs: 0, billedJobs: 0, provider: 'mock', model: 'image', quotaRemaining: null, staleShots: 0, shotsMissingAssetImages: 0, shotsMissingFirstFrame: 0, shotsWithoutPrompt: 0 }, shots: [] }
    let state = applyEvent(base, ev(11, 'scriptBatch.stateChanged', batch))
    expect(nodeDecorations(state).byNode.get('n1')?.scriptBatches).toEqual([batch])
    const newer = { ...batch, batchId: 'newer', status: 'running' as const, createdAt: 2 }
    state = applyEvent(state, ev(12, 'scriptBatch.stateChanged', newer))
    expect(nodeDecorations(state).byNode.get('n1')?.scriptBatches).toEqual([newer])
    const newest = { ...batch, batchId: 'newest', status: 'succeeded' as const, createdAt: 3 }
    state = applyEvent(state, ev(13, 'scriptBatch.stateChanged', newest))
    expect(nodeDecorations(state).byNode.get('n1')?.scriptBatches).toEqual([newer, newest])
    state = applyEvent(state, ev(14, 'scriptBatch.stateChanged', { ...newer, status: 'cancelled' }))
    expect(nodeDecorations(state).byNode.get('n1')?.scriptBatches).toEqual([newest])
  })

  it('creates, updates, and deletes nodes; slot revisions replace content from the payload', () => {
    let s = applyEvent(base, ev(11, 'node.created', node('n3', 3)))
    s = applyEvent(s, ev(12, 'node.updated', { ...node('n1', 2), x: 50 }))
    s = applyEvent(s, ev(13, 'node.deleted', { nodeId: 'n2' }))
    s = applyEvent(s, ev(14, 'slot.revised', { nodeId: 'n3', slotId: 'slot_n3', revision: 2, slot: { ...node('n3', 3, '第二稿').slots[0], revision: 2 } }))
    expect(s.seq).toBe(14)
    expect(sortedNodes(s).map(n => [n.nodeId, n.x])).toEqual([['n1', 50], ['n3', 0]])
    expect(s.nodes.get('n3')!.slots[0]).toMatchObject({ revision: 2, content: { body: '第二稿' } })
    // Old state is unaffected
    expect(base.nodes.size).toBe(2)
  })

  it('slot revisions invalidate only that slot history; node deletion clears its history without changing the old cache', () => {
    const versions: SlotVersionView[] = [{ revision: 1, content: { type: 'text', body: 'a' }, createdAt: 1, actor: 'user', isCurrent: true }]
    const before = { ...base, histories: new Map([['slot_n1', versions], ['slot_n2', versions]]) }
    const revised = applyEvent(before, ev(11, 'slot.revised', { nodeId: 'n1', slotId: 'slot_n1', slot: { ...node('n1', 2).slots[0], revision: 2 } }))
    expect([...revised.histories.keys()]).toEqual(['slot_n2'])
    expect([...before.histories.keys()]).toEqual(['slot_n1', 'slot_n2'])
    expect(applyEvent(revised, ev(12, 'node.deleted', { nodeId: 'n2' })).histories.size).toBe(0)
  })

  it('deleting input nodes clears editable references but preserves historical generation sources and old state', () => {
    const target = { ...node('target', 3), inputs: ['n1', 'n2'] }
    target.slots[0]!.source = { jobId: 'job', inputNodeIds: ['n1', 'n2'] }
    const before = fromSnapshot({ nodes: [node('n1', 1), node('n2', 2), target], sessions: [], activeJobs: [], workItems: [] }, 10)
    const after = applyEvent(before, ev(11, 'node.deleted', { nodeId: 'n1' }))
    expect(after.nodes.get('target')!.inputs).toEqual(['n2'])
    expect(after.nodes.get('target')!.slots[0]!.source!.inputNodeIds).toEqual(['n1', 'n2'])
    expect(before.nodes.get('target')!.inputs).toEqual(['n1', 'n2'])
    const empty = applyEvent(after, ev(12, 'node.deleted', { nodeId: 'n2' }))
    expect(empty.nodes.get('target')).not.toHaveProperty('inputs')
  })

  it('successful generation jobs are removed; failed jobs remain until dismissed', () => {
    let s = applyEvent(base, ev(11, 'job.stateChanged', { jobId: 'j2', status: 'queued' }))
    expect([...s.jobs.keys()]).toEqual(['j1', 'j2'])
    s = applyEvent(s, ev(12, 'job.stateChanged', { jobId: 'j1', status: 'succeeded' }))
    s = applyEvent(s, ev(13, 'job.stateChanged', { jobId: 'j2', status: 'failed', error: { code: 'provider_error', message: 'Quota exhausted' } }))
    expect([...s.jobs.keys()]).toEqual(['j2'])
    // english-exempt: Expected localized UI notice; preserve the Chinese UI prefix.
    expect(nodeDecorations(s).unanchored.problems).toEqual([{ jobId: 'j2', message: '生成失败：Quota exhausted' }])
    s = dismissJobs(s, ['j2'])
    expect(s.jobs.size).toBe(0)
  })
})

const job = (jobId: string, status: JobView['status'], targets: JobView['targets']): JobView => ({ jobId, status, outputs: [], targets })

describe('Generation state on nodes', () => {
  const base = fromSnapshot({ nodes: [node('n1', 1), node('n2', 2)], sessions: [], activeJobs: [], workItems: [] }, 10)

  it('fill jobs appear on target nodes and creation jobs on anchor nodes; delivered jobs are no longer active', () => {
    let s = applyEvent(base, ev(11, 'job.stateChanged', { jobId: 'j1', status: 'queued', job: job('j1', 'queued', [{ outputIndex: 0, kind: 'slot', status: 'pending', nodeId: 'n1', slotId: 'slot_n1' }]) }))
    s = applyEvent(s, ev(12, 'job.stateChanged', {
      jobId: 'j2', status: 'running',
      job: job('j2', 'running', [{ outputIndex: 0, kind: 'new_node', status: 'pending', nearNodeId: 'n1' }, { outputIndex: 1, kind: 'new_node', status: 'pending', nearNodeId: 'n1' }]),
    }))
    s = applyEvent(s, ev(13, 'job.stateChanged', { jobId: 'j3', status: 'running', job: job('j3', 'running', [{ outputIndex: 0, kind: 'new_node', status: 'pending' }]) }))
    let d = nodeDecorations(s)
    expect(d.byNode.get('n1')).toEqual({ running: 2, problems: [], activeJobs: [s.jobs.get('j1'), s.jobs.get('j2')] })
    expect(d.byNode.has('n2')).toBe(false)
    expect(d.unanchored.running).toBe(1)

    s = applyEvent(s, ev(14, 'node.created', node('n3', 3)))
    s = applyEvent(s, ev(15, 'binding.stateChanged', { bindingId: 'b', jobId: 'j3', status: 'delivered', nodeId: 'n3' }))
    s = applyEvent(s, ev(16, 'job.stateChanged', { jobId: 'j3', status: 'succeeded', job: job('j3', 'succeeded', [{ outputIndex: 0, kind: 'new_node', status: 'delivered', nodeId: 'n3' }]) }))
    d = nodeDecorations(s)
    expect(s.jobs.has('j3')).toBe(false)
    expect(d.byNode.get('n3')).toEqual({ running: 0, problems: [], deliveredSeq: 15 })
    expect(d.unanchored.running).toBe(0)
  })

  it('a placeholder carries its job state and problems, falling back to the reference once it is gone (RFC 0047)', () => {
    let s = applyEvent(base, ev(11, 'job.stateChanged', {
      jobId: 'j1', status: 'running', job: job('j1', 'running', [{ outputIndex: 0, kind: 'new_node', status: 'pending', nearNodeId: 'n1', nodeId: 'n2', slotId: 'slot_n2' }]),
    }))
    expect(nodeDecorations(s).byNode.get('n2')).toMatchObject({ running: 1 })
    expect(nodeDecorations(s).byNode.has('n1')).toBe(false)
    s = applyEvent(s, ev(12, 'job.stateChanged', {
      jobId: 'j1', status: 'failed', error: { code: 'provider_error', message: 'boom' },
      job: { ...job('j1', 'failed', [{ outputIndex: 0, kind: 'new_node', status: 'no_output', nearNodeId: 'n1', nodeId: 'n2', slotId: 'slot_n2' }]), error: { code: 'provider_error', message: 'boom' } },
    }))
    expect(nodeDecorations(s).byNode.get('n2')!.problems).toHaveLength(1)
    s = applyEvent(s, ev(13, 'node.deleted', { nodeId: 'n2' }))
    expect(nodeDecorations(s).byNode.get('n1')!.problems).toHaveLength(1)
  })

  it('success with conflicts or no output shows notices on the corresponding nodes', () => {
    const s = applyEvent(base, ev(11, 'job.stateChanged', {
      jobId: 'j1', status: 'succeeded',
      job: job('j1', 'succeeded', [
        { outputIndex: 0, kind: 'slot', status: 'conflict', nodeId: 'n1', slotId: 'slot_n1' },
        { outputIndex: 1, kind: 'slot', status: 'delivered', nodeId: 'n2', slotId: 'slot_n2' },
      ]),
    }))
    const d = nodeDecorations(s)
    // english-exempt: Expected localized UI notice for a conflicting target.
    expect(d.byNode.get('n1')!.problems).toEqual([{ jobId: 'j1', message: '目标已有更新，结果没有回填' }])
    expect(d.byNode.has('n2')).toBe(false)
  })

  it('receiving a fresh snapshot clears highlight records', () => {
    const s = applyEvent(base, ev(11, 'binding.stateChanged', { bindingId: 'b', jobId: 'j', status: 'delivered', nodeId: 'n1' }))
    expect(s.delivered.get('n1')).toBe(11)
    expect(fromSnapshot({ nodes: [], sessions: [], activeJobs: [], workItems: [] }, 20).delivered.size).toBe(0)
  })

  it('cancellation is terminal and retains a retry notice and explanation that the provider may continue charging', () => {
    const cancelled = { ...job('cancelled', 'cancelled', [{ outputIndex: 0, kind: 'slot' as const, status: 'no_output' as const, nodeId: 'n1' }]), providerCancelled: false }
    const state = applyEvent(base, ev(11, 'job.stateChanged', { jobId: cancelled.jobId, status: cancelled.status, job: cancelled }))
    // english-exempt: Expected localized UI notice explaining local cancellation and possible provider charges.
    expect(nodeDecorations(state).byNode.get('n1')).toEqual({ running: 0, problems: [{ jobId: 'cancelled', message: '已取消本地等待，服务端可能仍在执行并计费' }] })
    expect(dismissJobs(state, ['cancelled']).jobs.size).toBe(0)
  })

  it('unknown and recheckable results include recheckable in node notices', () => {
    const unknown = { ...job('lost', 'unknown', [{ outputIndex: 0, kind: 'slot' as const, status: 'no_output' as const, nodeId: 'n1' }]), recheckable: true, error: { code: 'retries_exhausted', message: 'Ark query temporarily failed' } }
    const state = applyEvent(base, ev(11, 'job.stateChanged', { jobId: unknown.jobId, status: unknown.status, job: unknown }))
    // english-exempt: Expected localized UI notice, including the app-generated provider diagnostic.
    expect(nodeDecorations(state).byNode.get('n1')!.problems).toEqual([{ jobId: 'lost', message: '结果未知：Ark 查询暂时失败', recheckable: true }])
    expect(nodeDecorations(state, 'en').byNode.get('n1')!.problems).toEqual([{ jobId: 'lost', message: 'Result unknown: Ark query temporarily failed', recheckable: true }])
    expect(state.jobs.get('lost')?.error).toEqual({ code: 'retries_exhausted', message: 'Ark query temporarily failed' })
  })

  it('queue reasons and cancellation request times reach nodes; dismissing notices does not remove active jobs', () => {
    const queued = { ...job('queued', 'queued', [{ outputIndex: 0, kind: 'slot' as const, status: 'pending' as const, nodeId: 'n1' }]), queueReason: 'concurrency_limit' as const, cancelRequestedAt: 12 }
    const state = applyEvent(base, ev(11, 'job.stateChanged', { jobId: queued.jobId, status: queued.status, job: queued }))
    expect(nodeDecorations(state).byNode.get('n1')?.activeJobs).toEqual([queued])
    expect(dismissJobs(state, ['queued']).jobs.has('queued')).toBe(true)
  })
})
