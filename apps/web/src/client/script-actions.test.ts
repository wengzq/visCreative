import { describe, expect, it, vi } from 'vitest'
import type { CanvasOp, NodeView, ScriptDoc, SessionSummary, TranscriptItem } from '@vis/protocol'
import { canvasActions } from './actions'
import { RpcError } from './rpc'
import type { SpaceConnection } from './space'
import { scriptAgentDecoration, scriptMessage, sendScriptRequest, shotNodeOps, withScriptDecorations, type ScriptRequestRecord } from './script-actions'

const doc: ScriptDoc = {
  version: 1, rev: 2, sessionId: 'owner',
  assets: [
    { id: 'scene', rev: 0, kind: 'scene', name: 'Street', description: '', imageNodeId: 'street-image' },
    { id: 'hero', rev: 0, kind: 'character', name: 'Hero', description: '', imageNodeId: 'hero-image' },
    { id: 'prop', rev: 0, kind: 'prop', name: 'Bag', description: '', imageNodeId: 'hero-image' },
    { id: 'missing', rev: 0, kind: 'prop', name: 'Lost', description: '', imageNodeId: 'gone' },
  ],
  shots: [
    { id: 'shot', rev: 3, transition: 'cut', description: 'Walking', sceneId: 'scene', characterIds: ['hero'], propIds: ['prop', 'missing'], framePrompt: 'Use {{ref:hero-image}} on {{ref:street-image}}', videoPrompt: 'Walk slowly' },
  ],
}
const node: NodeView = { nodeId: 'script', kind: 'script', x: 10, y: 20, w: 420, h: 300, z: 1, layoutRevision: 0, inputs: ['text', 'image', 'text'], slots: [
  { slotId: 'main', slotKey: 'main', revision: 4, contentType: 'script', content: { type: 'script', doc } },
] }
const images = ['hero-image', 'street-image'].map(nodeId => ({ ...node, nodeId, kind: 'image' as const, slots: [] }))
const owner: SessionSummary = { sessionId: 'owner', title: 'Writer', workDir: '/project', agentKind: 'codex', workItemId: null, titleSource: 'user', queuePaused: false, silentSince: null, activeTurnId: 'turn', pendingApprovals: 0, createdAt: 0, agentConfig: { model: null, effort: null, serviceTier: null } }

function setup() {
  const call = vi.fn(async (method: string, _params?: unknown): Promise<any> => {
    if (method === 'canvas.get') return { nodes: [node] }
    if (method === 'canvas.apply') return { idMap: { n: 'created' }, eventSeq: 1 }
    if (method === 'session.create') return { ...owner, sessionId: 'created-owner' }
    if (method === 'session.sendMessage') return { messageId: 'message', deliveryState: 'submitted' }
  })
  const refreshNodes = vi.fn(async () => {})
  const conn = { rpc: { call }, refreshNodes, mergeWorkItems: vi.fn(), getView: () => ({ ready: true, space: { spaceId: 'project' }, state: { nodes: new Map([node, ...images].map(node => [node.nodeId, node])) } }) } as unknown as SpaceConnection
  return { conn, call, refreshNodes }
}

describe('Script host actions', () => {
  it('Reuses a script decoration when unrelated transcript content changes', () => {
    const sessions = new Map([[owner.sessionId, owner]])
    const first = withScriptDecorations([node], sessions, new Map(), [], new Map())
    const next = withScriptDecorations([node], sessions, new Map(), [], new Map([['other', { items: [] }]]), first)
    expect(next.get(node.nodeId)).toBe(first.get(node.nodeId))
    expect(next).toBe(first)
    const renamed = withScriptDecorations([node], new Map([[owner.sessionId, { ...owner, title: 'Renamed' }]]), new Map(), [], new Map(), next)
    expect(renamed.get(node.nodeId)).not.toBe(first.get(node.nodeId))
    expect(renamed.get(node.nodeId)?.scriptAgent?.title).toBe('Renamed')
  })

  it('assembles one timeline from live shots, deduplicates asset reads and reports skipped shots', async () => {
    const { conn, call } = setup()
    const script = { ...node, title: 'Story', slots: [{ ...node.slots[0]!, content: { type: 'script' as const, doc: { ...doc, shots: [...doc.shots, { ...doc.shots[0]!, id: 'second', durationSec: 4 }, { ...doc.shots[0]!, id: 'third' }, { ...doc.shots[0]!, id: 'fourth' }] } } }] }
    const output = (nodeId: string, shotId: string, kind: 'image' | 'video'): NodeView => ({ ...node, nodeId, kind, shot: { scriptNodeId: 'script', shotId, role: kind === 'video' ? 'video' : 'first' }, slots: [
      { ...node.slots[0]!, contentType: kind, content: { type: 'asset', assetVersionId: kind === 'video' ? 'video' : 'image', mime: kind === 'video' ? 'video/mp4' : 'image/png' } },
    ] })
    const nodes = [script, output('old', 'shot', 'video'), output('new', 'shot', 'video'), output('still', 'second', 'image'), output('fourth', 'fourth', 'video')]
    call.mockImplementation(async method => {
      if (method === 'canvas.get') return { nodes }
      if (method === 'asset.get') return { durationMs: 2000 }
      return { idMap: { n: 'created' } }
    })
    const notify = vi.fn()
    expect(await canvasActions(conn, notify, 'en').onAssembleScriptTimeline!('script')).toBe('created')
    expect(call.mock.calls.filter(([method]) => method === 'asset.get')).toEqual([['asset.get', { assetVersionId: 'video' }]])
    expect(call).toHaveBeenLastCalledWith('canvas.apply', expect.objectContaining({ description: 'Assemble timeline', ops: [
      { op: 'node.create', tempId: 'n', kind: 'timeline', title: 'Story · Timeline', content: { timelineFrom: ['new', { nodeId: 'still', durationMs: 4000 }, 'fourth'] } },
    ] }))
    expect(notify).toHaveBeenCalledWith({ kind: 'info', text: 'Timeline assembled · 1 shot has no video or first frame' })
  })
  it('routes canvas peaks requests through media.preview', async () => {
    const { conn, call } = setup()
    await canvasActions(conn, vi.fn(), 'en').onPreview!('audio-version', 'peaks')
    expect(call).toHaveBeenCalledExactlyOnceWith('media.preview', { assetVersionId: 'audio-version', kind: 'peaks' })
  })
  it('stops before the duration limit, uses a default script title and reports the remaining shots', async () => {
    const { conn, call } = setup()
    const script = { ...node, slots: [{ ...node.slots[0]!, content: { type: 'script' as const, doc: { ...doc, shots: ['a', 'b', 'c'].map(id => ({ ...doc.shots[0]!, id })) } } }] }
    const outputs: NodeView[] = ['a', 'b', 'c'].map(id => ({ ...node, nodeId: id, kind: 'video', shot: { scriptNodeId: 'script', shotId: id, role: 'video' }, slots: [
      { ...node.slots[0]!, contentType: 'video', content: { type: 'asset', assetVersionId: 'shared-video', mime: 'video/webm' } },
    ] }))
    call.mockImplementation(async method => {
      if (method === 'canvas.get') return { nodes: [script, ...outputs] }
      if (method === 'asset.get') return { durationMs: 900_001 }
      return { idMap: { n: 'created' } }
    })
    const notify = vi.fn()
    await canvasActions(conn, notify, 'en').onAssembleScriptTimeline!('script')
    expect(call).toHaveBeenLastCalledWith('canvas.apply', expect.objectContaining({ ops: [
      { op: 'node.create', tempId: 'n', kind: 'timeline', title: 'Script 1 · Timeline', content: { timelineFrom: ['a'] } },
    ] }))
    expect(notify).toHaveBeenCalledWith({ kind: 'info', text: 'Timeline assembled · 2 shots exceed the timeline limit' })
  })
  it('does not create an empty timeline and reports creation failures with the error toast', async () => {
    const { conn, call } = setup()
    const notify = vi.fn()
    await expect(canvasActions(conn, notify, 'en').onAssembleScriptTimeline!('script')).rejects.toThrow('No shot has a video or first frame yet')
    expect(call.mock.calls.map(([method]) => method)).toEqual(['canvas.get'])
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'error', text: expect.stringContaining('No shot has a video or first frame yet') }))
  })
  it('passes batch planning and lifecycle actions through with the supplied idempotency IDs', async () => {
    const { conn, call } = setup()
    const actions = canvasActions(conn, vi.fn(), 'en')
    const plan = { scriptNodeId: 'script', media: 'video' as const, shotIds: ['shot'], strictShotIds: ['shot'], missingFirstFrames: 'skip' as const, provider: 'mock', model: 'mock-video-1' }
    await actions.onPlanScriptBatch!(plan)
    expect(call).toHaveBeenLastCalledWith('script.batch.plan', plan)
    await actions.onStartScriptBatch!({ ...plan, requestId: 'retry-stable' })
    expect(call).toHaveBeenLastCalledWith('script.batch.start', { ...plan, requestId: 'retry-stable' })
    await actions.onCancelScriptBatch!({ batchId: 'batch', requestId: 'cancel' })
    expect(call).toHaveBeenLastCalledWith('script.batch.cancel', { batchId: 'batch', requestId: 'cancel' })
    await actions.onResumeScriptBatch!({ batchId: 'batch', requestId: 'resume' })
    expect(call).toHaveBeenLastCalledWith('script.batch.resume', { batchId: 'batch', requestId: 'resume' })
  })
  it('composes a visible task and user request with selected shots and deduplicated script/input references', () => {
    expect(scriptMessage(node, { nodeId: node.nodeId, task: 'prompts', text: 'Keep the color palette', shotIds: ['shot'] }, 'en')).toEqual({
      text: 'Write prompts for this script.\n\nSelected shot IDs: shot\n\nKeep the color palette',
      refs: ['script', 'text', 'image'].map(nodeId => ({ nodeId, versionPolicy: 'latest-at-execution' })),
    })
    expect(scriptMessage(node, { nodeId: 'script', task: 'breakdown', text: '' }, 'en').text).toBe('Break down this script into storyboard shots and assets.')
  })

  it.each(['first', 'video'] as const)('creates one undoable %s node with ordered live image inputs, prompt and shot metadata, without submitting', async role => {
    const { conn, call } = setup()
    const actions = canvasActions(conn, vi.fn(), 'en')
    expect(await actions.onCreateShotNode!('script', 'shot', role)).toBe('created')
    expect(call).toHaveBeenCalledWith('canvas.get', { nodeIds: ['script'] })
    const expected = shotNodeOps(node, images, 'shot', role, 'en')
    expect(call).toHaveBeenCalledWith('canvas.apply', expect.objectContaining({ ops: expected }))
    expect(expected).toMatchObject([{
      op: 'node.create', kind: role === 'first' ? 'image' : 'video', inputNodeIds: ['street-image', 'hero-image'],
      title: role === 'first' ? 'Shot 1' : 'Shot 1 · Video',
      shot: { scriptNodeId: 'script', shotId: 'shot', role },
      prompt: role === 'first' ? doc.shots[0]!.framePrompt : 'Walk slowly',
    }])
    expect(call.mock.calls.some(([method]) => method === 'generation.submit')).toBe(false)
  })

  it('reads the current shot and rejects deleted shots before creating anything', () => {
    expect(() => shotNodeOps(node, images, 'gone', 'first', 'en')).toThrow('The script shot no longer exists')
  })

  it('creates an empty image prompt for an asset and never starts generation', async () => {
    const { conn, call } = setup()
    await canvasActions(conn, vi.fn(), 'en').onScriptAssetImage!('script', 'hero')
    expect(call).toHaveBeenCalledWith('canvas.get', { nodeIds: ['script'] })
    expect(call).toHaveBeenCalledWith('canvas.apply', expect.objectContaining({ ops: [expect.objectContaining({ op: 'node.create', kind: 'image', title: 'Hero', prompt: '' })] }))
    expect(call.mock.calls.map(([method]) => method)).toEqual(['canvas.get', 'canvas.apply'])
  })

  it('creates a requested session, saves its ownership, and tracks the returned visible message id', async () => {
    const { conn, call } = setup()
    const record = vi.fn()
    expect(await sendScriptRequest(conn, { nodeId: 'script', task: 'breakdown', text: 'Three shots', session: { new: true, agentKind: 'claude' } }, 'en', record)).toEqual({ sessionId: 'created-owner' })
    expect(call.mock.calls.map(([method]) => method)).toEqual(['canvas.get', 'session.create', 'canvas.apply', 'session.sendMessage'])
    expect(call.mock.calls[1]![1]).toMatchObject({ agentKind: 'claude' })
    expect(call.mock.calls[2]![1]).toMatchObject({ ops: [{ op: 'script.patch', slotId: 'main', ops: [{ kind: 'doc.set', rev: 2, fields: { sessionId: 'created-owner' } }] }] })
    expect(record).toHaveBeenCalledWith({ nodeId: 'script', sessionId: 'created-owner', messageId: 'message', task: 'breakdown' })
  })

  it('uses the stored owner on subsequent requests', async () => {
    const { conn, call } = setup()
    await sendScriptRequest(conn, { nodeId: 'script', task: 'custom', text: 'Make it shorter' }, 'en', vi.fn())
    expect(call.mock.calls.map(([method]) => method)).toEqual(['canvas.get', 'session.sendMessage'])
    expect(call.mock.calls[1]![1]).toMatchObject({ sessionId: 'owner', text: 'Update this script as requested.\n\nMake it shorter' })
  })

  it('rereads script rows on a revision conflict and preserves the error for the editor', async () => {
    const { conn, call, refreshNodes } = setup()
    const conflict = new RpcError('revision_conflict', 'Rows changed')
    call.mockRejectedValueOnce(conflict)
    const ops: CanvasOp[] = [{ op: 'script.patch', slotId: 'main', ops: [{ kind: 'shot.update', shotId: 'shot', rev: 3, fields: { description: 'Changed' } }] }]
    const notify = vi.fn()
    await expect(canvasActions(conn, notify, 'en').onApply!(ops)).rejects.toBe(conflict)
    expect(refreshNodes).toHaveBeenCalledWith(['script'])
    expect(notify).toHaveBeenCalledExactlyOnceWith({
      kind: 'error', text: 'Someone just changed this text. The latest content is shown; your draft was not saved.', copy: 'Changed',
    })
  })
})

describe('Script Agent decorations', () => {
  const requests: ScriptRequestRecord[] = [{ nodeId: 'script', sessionId: 'owner', messageId: 'message', task: 'prompts' }]
  const item = { itemId: 'entry', kind: 'user', turnId: 'turn', payload: { messageId: 'message' } } as TranscriptItem
  it('labels only the turn containing the sent message and falls back to generic activity for other turns', () => {
    const sessions = new Map([['owner', owner]])
    expect(scriptAgentDecoration(node, sessions, requests, [item])).toEqual({ sessionId: 'owner', title: 'Writer', task: 'prompts', running: true })
    expect(scriptAgentDecoration(node, sessions, requests, [{ ...item, turnId: 'older' }])).toMatchObject({ task: null, running: true })
    expect(scriptAgentDecoration(node, new Map([['owner', { ...owner, activeTurnId: null }]]), requests, [item])).toMatchObject({ task: null, running: false })
    expect(scriptAgentDecoration(node, new Map(), requests)).toBeUndefined()
    const base = new Map([['script', { running: 2, problems: [] }]])
    const decorated = withScriptDecorations([node], sessions, base, requests, new Map([['owner', { items: [item] }]]))
    expect(decorated.get('script')).toMatchObject({ running: 2, scriptAgent: { task: 'prompts', running: true } })
    expect(base.get('script')).not.toHaveProperty('scriptAgent')
  })
})
