import { beforeEach, describe, expect, it } from 'vitest'
import { VisError } from '@vis/domain'
import type { MediaKind, MethodParams } from '@vis/protocol'
import { eq, openSpaceDb, readEventsAfter, spaceSchema as s, type SpaceDb } from '@vis/storage'
import { createCanvasService, type CanvasService } from './service'

const user = { kind: 'user' } as const
let db: SpaceDb
let canvas: CanvasService
let clock = 1_800_000_000_000

beforeEach(() => {
  db = openSpaceDb(':memory:')
  canvas = createCanvasService({ db, now: () => ++clock })
})

function seedAsset(id: string, kind: MediaKind = 'image', dims: { width?: number; height?: number; durationMs?: number } = {}) {
  db.insert(s.blobs).values({ hash: `h_${id}`, byteSize: 1, createdAt: clock }).onConflictDoNothing().run()
  db.insert(s.assets).values({ id: `ast_${id}`, kind, origin: 'generation', createdAt: clock }).run()
  db.insert(s.assetVersions)
    .values({ id, assetId: `ast_${id}`, version: 1, blobHash: `h_${id}`, mime: { image: 'image/png', video: 'video/mp4', audio: 'audio/wav' }[kind], ...dims, createdAt: clock })
    .run()
  return id
}

function createImageNode(requestId = 'req_img') {
  const r = canvas.apply(user, { requestId, ops: [{ op: 'node.create', tempId: 'n', kind: 'image', x: 0, y: 0, w: 320, h: 320 }] })
  const nodeId = r.idMap.n!
  const slotId = canvas.get({ nodeIds: [nodeId] }).nodes[0]!.slots[0]!.slotId
  return { nodeId, slotId }
}

/** Simulate GenerationService submission: create a Job and binding, and have the slot accept the binding */
function seedBinding(id: string, target: { nodeId: string; slotId: string; expected: number } | { nearNodeId?: string }, kind: MediaKind = 'image') {
  db.insert(s.generationJobs).values({ id: `job_${id}`, kind, provider: 'mock', model: 'm', params: {}, status: 'finalizing', createdAt: clock, updatedAt: clock }).run()
  if ('slotId' in target) {
    db.insert(s.deliveryBindings)
      .values({ id, jobId: `job_${id}`, outputIndex: 0, targetKind: 'slot', nodeId: target.nodeId, slotId: target.slotId, expectedContentRevision: target.expected, status: 'pending' })
      .run()
    db.update(s.slots).set({ acceptedBindingId: id }).where(eq(s.slots.id, target.slotId)).run()
  } else {
    db.insert(s.deliveryBindings).values({ id, jobId: `job_${id}`, outputIndex: 0, targetKind: 'new_node', placement: target, status: 'pending' }).run()
  }
}

const deliver = (input: { bindingId: string; assetVersionId: string }) => db.transaction(tx => canvas.deliverOutput(tx, input))
const bindingStatus = (id: string) => db.select().from(s.deliveryBindings).where(eq(s.deliveryBindings.id, id)).get()!.status

describe('generation delivery provenance', () => {
  it('seeds a new node with authored markers, live ordered inputs and provider-only settings in its creation event', () => {
    const created = canvas.apply(user, { requestId: 'refs', ops: [
      { op: 'node.create', tempId: 'first', kind: 'text', content: { text: 'First' } },
      { op: 'node.create', tempId: 'gone', kind: 'text', content: { text: 'Gone' } },
    ] })
    const refs = canvas.get({}).nodes
    seedBinding('seeded', {})
    const prompt = `Use {{ref:${created.idMap.first}}}`
    db.update(s.generationJobs).set({ params: { prompt, resolvedPrompt: 'Use Image 1', actualPrompt: 'Sent', revisedPrompt: 'Rewritten', providerConfiguration: {}, frameRefs: {}, width: 128 } }).where(eq(s.generationJobs.id, 'job_seeded')).run()
    db.insert(s.jobInputs).values(refs.map((node, ordinal) => ({ jobId: 'job_seeded', ordinal, slotId: node.slots[0]!.slotId, slotRevision: 1, fromSnapshot: false }))).run()
    canvas.apply(user, { requestId: 'delete-ref', ops: [{ op: 'node.delete', nodeId: created.idMap.gone! }] })
    const result = deliver({ bindingId: 'seeded', assetVersionId: seedAsset('seeded-output') })
    if (result.status !== 'delivered') throw new Error('Not delivered')
    const node = canvas.get({ nodeIds: [result.nodeId] }).nodes[0]!
    expect(node.inputs).toEqual([created.idMap.first])
    expect(node.generation).toEqual({ provider: 'mock', model: 'm', params: { width: 128 } })
    expect(node.slots.find(slot => slot.slotKey === 'prompt')).toMatchObject({ content: { type: 'text', body: prompt }, writer: { actor: 'system' } })
    expect(node.slots.find(slot => slot.slotKey === 'prompt')!.source).toBeUndefined()
    expect(canvas.history({ slotId: node.slots.find(slot => slot.slotKey === 'prompt')!.slotId, limit: 50 }).versions[0]!.source).toBeUndefined()
    expect(readEventsAfter(db, 0).find(event => event.type === 'node.created' && event.entityId === result.nodeId)?.payload).toEqual(node)
  })

  it('links an operation result only to its subject and seeds no prompt or generation choice', () => {
    const subject = canvas.apply(user, { requestId: 'operation-subject', ops: [{ op: 'node.create', tempId: 'n', kind: 'image', content: { assetVersionId: seedAsset('operation-input') } }] })
    const nodeId = subject.idMap.n!
    const slotId = canvas.get({ nodeIds: [nodeId] }).nodes[0]!.slots[0]!.slotId
    seedBinding('operation', { nearNodeId: nodeId })
    db.update(s.generationJobs).set({ operation: 'image.upscale', params: { prompt: 'Sharper', scale: 2 } }).where(eq(s.generationJobs.id, 'job_operation')).run()
    db.insert(s.jobInputs).values({ jobId: 'job_operation', ordinal: 0, slotId, slotRevision: 1, fromSnapshot: false }).run()
    const result = deliver({ bindingId: 'operation', assetVersionId: seedAsset('operation-output') })
    if (result.status !== 'delivered') throw new Error('Not delivered')
    const node = canvas.get({ nodeIds: [result.nodeId] }).nodes[0]!
    expect(node.inputs).toEqual([nodeId])
    expect(node.generation).toBeUndefined()
    expect(node.slots.map(slot => slot.slotKey)).toEqual(['main'])
    expect(canvas.history({ slotId: result.slotId, limit: 50 }).versions[0]!.source).toMatchObject({
      operation: 'image.upscale', params: { scale: 2 }, inputNodeIds: [nodeId],
    })
  })

  it('does not create a prompt slot for an empty authored prompt', () => {
    seedBinding('empty-prompt', {})
    db.update(s.generationJobs).set({ params: { prompt: '' } }).where(eq(s.generationJobs.id, 'job_empty-prompt')).run()
    const result = deliver({ bindingId: 'empty-prompt', assetVersionId: seedAsset('empty-output') })
    if (result.status !== 'delivered') throw new Error('Not delivered')
    expect(canvas.get({ nodeIds: [result.nodeId] }).nodes[0]!.slots.map(slot => slot.slotKey)).toEqual(['main'])
  })

  it('never changes the prompt, inputs or generation choice of an existing target', () => {
    const { idMap } = canvas.apply(user, { requestId: 'existing-target', ops: [
      { op: 'node.create', tempId: 'ref', kind: 'text', content: { text: 'Reference' } },
      { op: 'node.create', tempId: 'target', kind: 'image', prompt: 'Author draft', generation: { provider: 'chosen', model: 'author-model', params: { size: 'large' } }, inputNodeIds: ['ref'] },
    ] })
    const before = canvas.get({ nodeIds: [idMap.target!] }).nodes[0]!
    seedBinding('existing', { nodeId: before.nodeId, slotId: before.slots[0]!.slotId, expected: 0 })
    db.update(s.generationJobs).set({ params: { prompt: 'Agent prompt', width: 256 } }).where(eq(s.generationJobs.id, 'job_existing')).run()
    deliver({ bindingId: 'existing', assetVersionId: seedAsset('existing-output') })
    const after = canvas.get({ nodeIds: [before.nodeId] }).nodes[0]!
    expect(after.inputs).toEqual(before.inputs)
    expect(after.generation).toEqual(before.generation)
    expect(after.slots.find(slot => slot.slotKey === 'prompt')).toEqual(before.slots.find(slot => slot.slotKey === 'prompt'))
  })

  it.each([
    [{ prompt: 'Authored', resolvedPrompt: 'Resolved', actualPrompt: 'Sent', revisedPrompt: 'Revised' }, 'Revised', 'revised'],
    [{ prompt: 'Authored', resolvedPrompt: 'Resolved', actualPrompt: 'Sent' }, 'Sent', 'sent'],
    [{ prompt: 'Authored', resolvedPrompt: 'Resolved' }, 'Resolved', 'resolved'],
    [{ prompt: 'Authored' }, 'Authored', 'authored'],
  ])('chooses the most direct used prompt from %j and hides internal params', (prompts, usedPrompt, usedPromptKind) => {
    seedBinding('history-source', {})
    db.update(s.generationJobs).set({ params: { ...prompts, width: 128, frameRefs: {}, providerConfiguration: {} } }).where(eq(s.generationJobs.id, 'job_history-source')).run()
    const result = deliver({ bindingId: 'history-source', assetVersionId: seedAsset('history-output') })
    if (result.status !== 'delivered') throw new Error('Not delivered')
    expect(canvas.history({ slotId: result.slotId, limit: 50 }).versions[0]!.source).toMatchObject({ prompt: 'Authored', usedPrompt, usedPromptKind, params: { width: 128 } })
    expect(canvas.history({ slotId: result.slotId, limit: 50 }).versions[0]!.source!.params).toEqual({ width: 128 })
    expect(canvas.history({ slotId: result.slotId, limit: 50 }).versions[0]!.source).not.toHaveProperty('operation')
  })
})

describe('canvas.apply', () => {
  it.each(['image', 'video', 'audio'] as const)('Create a %s generation node with main first and an initial revision even for an empty prompt', kind => {
    const r = canvas.apply(user, { requestId: 'prompt', ops: [{ op: 'node.create', tempId: 'n', kind, x: 0, y: 0, w: 320, h: 180, prompt: '' }] })
    const [node] = canvas.get({}).nodes
    expect(node!.slots).toMatchObject([
      { slotKey: 'main', contentType: kind, revision: 0, content: { type: 'empty' } },
      { slotKey: 'prompt', contentType: 'text', revision: 1, content: { type: 'text', body: '' } },
    ])
    expect(r.slotRevisions[node!.slots.find(s => s.slotKey === 'prompt')!.slotId]).toBe(1)
    expect(readEventsAfter(db, 0)[0]!.payload).toEqual(node)
  })

  it('Update the prompt via tempId:prompt in the same batch; later updates still check revisions', () => {
    canvas.apply(user, { requestId: 'prompt', ops: [
      { op: 'node.create', tempId: 'n', kind: 'image', x: 0, y: 0, w: 320, h: 320, prompt: '初稿' },
      { op: 'slot.setText', slotId: 'n:prompt', body: '屋顶花园', expectedRevision: 1 },
    ] })
    const prompt = canvas.get({}).nodes[0]!.slots.find(s => s.slotKey === 'prompt')!
    expect(prompt).toMatchObject({ revision: 2, content: { type: 'text', body: '屋顶花园' } })
    expect(() => canvas.apply(user, { requestId: 'stale', ops: [{ op: 'slot.setText', slotId: prompt.slotId, body: '旧草稿', expectedRevision: 1 }] })).toThrow(expect.objectContaining({ code: 'revision_conflict' }))
  })

  it('Text nodes cannot have a prompt; failure leaves no node', () => {
    expect(() => canvas.apply(user, { requestId: 'invalid', ops: [{ op: 'node.create', tempId: 'n', kind: 'text', x: 0, y: 0, w: 320, h: 200, prompt: '' }] })).toThrow(expect.objectContaining({ code: 'invalid_params' }))
    expect(canvas.get({}).nodes).toEqual([])
  })

  it('Create a node and update its slot via tempId:main in the same batch', () => {
    const r = canvas.apply(user, {
      requestId: 'req_1',
      ops: [
        { op: 'node.create', tempId: 'note', kind: 'text', x: 0, y: 0, w: 320, h: 200, content: { text: '初稿' } },
        { op: 'slot.setText', slotId: 'note:main', body: '第二稿', expectedRevision: 1 },
      ],
    })
    const [node] = canvas.get({}).nodes
    expect(node!.nodeId).toBe(r.idMap.note)
    expect(node!.slots[0]).toMatchObject({ slotKey: 'main', revision: 2, content: { type: 'text', body: '第二稿' } })
    expect(r.slotRevisions[node!.slots[0]!.slotId]).toBe(2)
    expect(readEventsAfter(db, 0).map(e => e.type)).toEqual(['node.created', 'slot.revised'])
    expect(readEventsAfter(db, 0)[0]!.payload).toMatchObject({ slots: [{ revision: 1, content: { body: '初稿' } }] })
    expect(readEventsAfter(db, 0)[1]!.payload).toEqual({ nodeId: r.idMap.note, slotId: node!.slots[0]!.slotId, revision: 2, slot: node!.slots[0] })
    expect(r.eventSeq).toBe(2)
  })

  it('Retrying the same requestId returns the original result without duplicate creation; different content yields idempotency_conflict', () => {
    const params: MethodParams<'canvas.apply'> = { requestId: 'req_dup', ops: [{ op: 'node.create', tempId: 'a', kind: 'text', x: 0, y: 0, w: 1, h: 1 }] }
    const first = canvas.apply(user, params)
    expect(canvas.apply(user, params)).toEqual(first)
    expect(canvas.get({}).nodes).toHaveLength(1)
    expect(() => canvas.apply(user, { ...params, description: '不同' })).toThrow(expect.objectContaining({ code: 'idempotency_conflict' }))
  })

  it('Any revision conflict rolls back the entire batch and reports the conflicting slot and current revision', () => {
    const { slotId } = createImageNode()
    const a = seedAsset('astv_1')
    canvas.apply(user, { requestId: 'req_fill', ops: [{ op: 'slot.setAsset', slotId, assetVersionId: a, expectedRevision: 0 }] })

    let error: VisError | undefined
    try {
      canvas.apply(user, {
        requestId: 'req_stale',
        ops: [
          { op: 'node.create', tempId: 'x', kind: 'text', x: 0, y: 0, w: 1, h: 1 },
          { op: 'slot.clear', slotId, expectedRevision: 0 },
        ],
      })
    } catch (e) {
      error = e as VisError
    }
    expect(error).toMatchObject({ code: 'revision_conflict', message: 'Slot content has changed; read it again and retry', conflicts: [{ slotId, expectedRevision: 0, currentRevision: 1 }], details: { reason: 'canvas.revision_conflict', params: {} } })
    expect(canvas.get({}).nodes).toHaveLength(1)
    // Failed requests do not register requestId; after correction, the same requestId can be retried
    expect(() => canvas.apply(user, { requestId: 'req_stale', ops: [{ op: 'slot.clear', slotId, expectedRevision: 1 }] })).not.toThrow()
  })

  it('Layout changes require no version condition and increment the layout revision without affecting content revisions', () => {
    const { nodeId } = createImageNode()
    canvas.apply(user, { requestId: 'req_mv', ops: [{ op: 'node.layout', nodeId, x: 100, y: 50 }] })
    const [node] = canvas.get({}).nodes
    expect(node).toMatchObject({ x: 100, y: 50, w: 320, layoutRevision: 2 })
    expect(node!.slots[0]!.revision).toBe(0)
  })

  it('Content types must be compatible with the slot', () => {
    const { slotId } = createImageNode()
    const video = seedAsset('astv_v', 'video')
    expect(() => canvas.apply(user, { requestId: 'r1', ops: [{ op: 'slot.setText', slotId, body: 'x', expectedRevision: 0 }] })).toThrow(
      expect.objectContaining({ code: 'invalid_params' }),
    )
    expect(() => canvas.apply(user, { requestId: 'r2', ops: [{ op: 'slot.setAsset', slotId, assetVersionId: video, expectedRevision: 0 }] })).toThrow(
      expect.objectContaining({ code: 'invalid_params' }),
    )
  })

  it('Audio slots accept audio assets, reject other types, and retain version history', () => {
    const { idMap } = canvas.apply(user, { requestId: 'audio', ops: [{ op: 'node.create', tempId: 'n', kind: 'audio', x: 0, y: 0, w: 360, h: 140, prompt: '' }] })
    const slotId = canvas.get({ nodeIds: [idMap.n!] }).nodes[0]!.slots[0]!.slotId
    const audio = seedAsset('astv_audio', 'audio', { durationMs: 2000 })
    canvas.apply(user, { requestId: 'fill_audio', ops: [{ op: 'slot.setAsset', slotId, assetVersionId: audio, expectedRevision: 0 }] })
    expect(canvas.get({ nodeIds: [idMap.n!] }).nodes[0]!.slots[0]).toMatchObject({ contentType: 'audio', revision: 1, content: { type: 'asset', assetVersionId: audio, mime: 'audio/wav' } })
    expect(canvas.history({ slotId, limit: 50 }).versions[0]).toMatchObject({ revision: 1, content: { assetVersionId: audio } })
    expect(() => canvas.apply(user, { requestId: 'wrong_audio', ops: [{ op: 'slot.setAsset', slotId, assetVersionId: seedAsset('astv_image'), expectedRevision: 1 }] })).toThrow(expect.objectContaining({ code: 'invalid_params' }))
    expect(canvas.get({ nodeIds: [idMap.n!] }).nodes[0]!.slots[0]!.revision).toBe(1)
  })

  it('Deletion writes a tombstone: reads omit it, later edits return not_found, and assets remain', () => {
    const { nodeId, slotId } = createImageNode()
    const a = seedAsset('astv_1')
    canvas.apply(user, { requestId: 'req_fill', ops: [{ op: 'slot.setAsset', slotId, assetVersionId: a, expectedRevision: 0 }] })
    canvas.apply(user, { requestId: 'req_del', ops: [{ op: 'node.delete', nodeId }] })
    expect(canvas.get({}).nodes).toHaveLength(0)
    expect(() => canvas.apply(user, { requestId: 'r', ops: [{ op: 'slot.clear', slotId, expectedRevision: 1 }] })).toThrow(expect.objectContaining({ code: 'not_found' }))
    expect(db.select().from(s.assetVersions).all()).toHaveLength(1)
  })
})

describe('deliverOutput', () => {
  it('Audio delivery creates a 360x140 node; later slot delivery follows revision and idempotency rules', () => {
    seedBinding('bind_audio', {}, 'audio')
    const audio = seedAsset('astv_audio', 'audio', { durationMs: 2000 })
    const created = deliver({ bindingId: 'bind_audio', assetVersionId: audio })
    expect(created).toMatchObject({ status: 'delivered', slotRevision: 1 })
    if (created.status !== 'delivered') throw new Error('Audio was not delivered')
    expect(canvas.get({ nodeIds: [created.nodeId] }).nodes[0]).toMatchObject({ kind: 'audio', w: 360, h: 140, slots: [{ contentType: 'audio', revision: 1, content: { assetVersionId: audio, mime: 'audio/wav' } }] })
    seedBinding('bind_audio_next', { nodeId: created.nodeId, slotId: created.slotId, expected: 1 }, 'audio')
    const next = seedAsset('astv_audio_next', 'audio', { durationMs: 3000 })
    expect(deliver({ bindingId: 'bind_audio_next', assetVersionId: next })).toEqual({ status: 'delivered', nodeId: created.nodeId, slotId: created.slotId, slotRevision: 2 })
    expect(deliver({ bindingId: 'bind_audio_next', assetVersionId: next })).toEqual({ status: 'already_settled' })
    expect(canvas.history({ slotId: created.slotId, limit: 50 }).versions.map(version => version.content)).toMatchObject([{ assetVersionId: next }, { assetVersionId: audio }])
  })

  it('Deliver to the slot when conditions hold; repeated calls are idempotent', () => {
    const { nodeId, slotId } = createImageNode()
    seedBinding('bind_A', { nodeId, slotId, expected: 0 })
    const out = seedAsset('astv_out')

    expect(deliver({ bindingId: 'bind_A', assetVersionId: out })).toEqual({ status: 'delivered', nodeId, slotId, slotRevision: 1 })
    expect(canvas.get({}).nodes[0]!.slots[0]).toMatchObject({ revision: 1, content: { type: 'asset', assetVersionId: out } })
    expect(bindingStatus('bind_A')).toBe('delivered')
    expect(canvas.history({ slotId, limit: 50 }).versions[0]).toMatchObject({ source: { jobId: 'job_bind_A', params: {} } })
    expect(canvas.history({ slotId, limit: 50 }).versions[0]!.source).not.toHaveProperty('prompt')

    expect(deliver({ bindingId: 'bind_A', assetVersionId: out })).toEqual({ status: 'already_settled' })
    expect(canvas.get({}).nodes[0]!.slots[0]!.revision).toBe(1)
  })

  it('A slot that has accepted a newer request rejects older delivery and retains the output as an asset', () => {
    const { nodeId, slotId } = createImageNode()
    seedBinding('bind_A', { nodeId, slotId, expected: 0 })
    seedBinding('bind_B', { nodeId, slotId, expected: 0 })
    const out = seedAsset('astv_A')

    expect(deliver({ bindingId: 'bind_A', assetVersionId: out })).toEqual({ status: 'conflict' })
    expect(canvas.get({}).nodes[0]!.slots[0]!.revision).toBe(0)
    expect(bindingStatus('bind_A')).toBe('conflict')
    expect(db.select().from(s.assetVersions).where(eq(s.assetVersions.id, out)).get()).toBeDefined()
  })

  it('Do not overwrite a slot edited by the user during generation', () => {
    const { nodeId, slotId } = createImageNode()
    seedBinding('bind_A', { nodeId, slotId, expected: 0 })
    canvas.apply(user, { requestId: 'req_user', ops: [{ op: 'slot.setAsset', slotId, assetVersionId: seedAsset('astv_user'), expectedRevision: 0 }] })

    expect(deliver({ bindingId: 'bind_A', assetVersionId: seedAsset('astv_A') })).toEqual({ status: 'conflict' })
    expect(canvas.get({}).nodes[0]!.slots[0]!.content).toMatchObject({ assetVersionId: 'astv_user' })
  })

  it('A deleted target node yields target_missing and is not restored', () => {
    const { nodeId, slotId } = createImageNode()
    seedBinding('bind_A', { nodeId, slotId, expected: 0 })
    canvas.apply(user, { requestId: 'req_del', ops: [{ op: 'node.delete', nodeId }] })

    expect(deliver({ bindingId: 'bind_A', assetVersionId: seedAsset('astv_A') })).toEqual({ status: 'target_missing' })
    expect(canvas.get({}).nodes).toHaveLength(0)
  })

  it('new_node: place to the right of the reference node and size by the asset aspect ratio', () => {
    const { nodeId } = createImageNode()
    seedBinding('bind_N', { nearNodeId: nodeId })
    const r = deliver({ bindingId: 'bind_N', assetVersionId: seedAsset('astv_wide', 'image', { width: 1600, height: 900 }) })
    expect(r.status).toBe('delivered')
    const created = canvas.get({}).nodes.find(n => n.nodeId !== nodeId)!
    expect(created).toMatchObject({ kind: 'image', x: 360, y: 0, w: 320, h: 180 })
    expect(db.select().from(s.deliveryBindings).where(eq(s.deliveryBindings.id, 'bind_N')).get()!.createdNodeId).toBe(created.nodeId)
  })

  it('new_node: place in the result area (right of existing content) when the reference node is deleted', () => {
    const { nodeId } = createImageNode()
    const other = createImageNode('req_other')
    canvas.apply(user, { requestId: 'req_mv', ops: [{ op: 'node.layout', nodeId: other.nodeId, x: 1000, y: -200 }] })
    canvas.apply(user, { requestId: 'req_del', ops: [{ op: 'node.delete', nodeId }] })
    seedBinding('bind_N', { nearNodeId: nodeId })
    deliver({ bindingId: 'bind_N', assetVersionId: seedAsset('astv_1') })
    const created = canvas.get({}).nodes.find(n => n.nodeId !== other.nodeId)!
    expect(created).toMatchObject({ x: 1000 + 320 + 80, y: -200 })
  })
})

describe('result placeholders (RFC 0047)', () => {
  const reserve = (bindingId: string) => db.transaction(tx => canvas.reservePlaceholder(tx, { bindingId }))
  const binding = (id: string) => db.select().from(s.deliveryBindings).where(eq(s.deliveryBindings.id, id)).get()!

  it('sizes the placeholder from vendor ratio and size strings, else the kind default', () => {
    const cases: [string, MediaKind, Record<string, unknown>, { w: number; h: number }][] = [
      ['ratio', 'video', { ratio: '9:16' }, { w: 320, h: 569 }],
      ['size', 'image', { size: '1536x1024' }, { w: 320, h: 213 }],
      ['star', 'image', { size: '720*1280' }, { w: 180, h: 320 }],
      ['adaptive', 'video', { ratio: 'adaptive' }, { w: 320, h: 180 }],
      ['audio', 'audio', {}, { w: 360, h: 140 }],
    ]
    for (const [id, kind, params, size] of cases) {
      seedBinding(id, {}, kind)
      db.update(s.generationJobs).set({ params }).where(eq(s.generationJobs.id, `job_${id}`)).run()
      reserve(id)
      const placeholder = canvas.get({ nodeIds: [binding(id).createdNodeId!] }).nodes[0]!
      expect(placeholder, id).toMatchObject({ kind, ...size, slots: [{ slotKey: 'main', revision: 0, content: { type: 'empty' } }] })
      expect(binding(id), id).toMatchObject({ targetKind: 'new_node', nodeId: placeholder.nodeId, slotId: placeholder.slots[0]!.slotId, expectedContentRevision: 0 })
    }
  })

  it('delivers into the placeholder and keeps a pre-placeholder binding on create-on-delivery', () => {
    const { nodeId } = createImageNode()
    seedBinding('placed', { nearNodeId: nodeId })
    reserve('placed')
    const placeholderId = binding('placed').createdNodeId!
    expect(deliver({ bindingId: 'placed', assetVersionId: seedAsset('astv_p', 'image', { width: 1600, height: 900 }) })).toMatchObject({ status: 'delivered', nodeId: placeholderId })
    expect(canvas.get({ nodeIds: [placeholderId] }).nodes[0]).toMatchObject({ h: 180, slots: [{ revision: 1, content: { assetVersionId: 'astv_p' } }] })
    expect(binding('placed').createdNodeId).toBe(placeholderId)

    seedBinding('legacy', { nearNodeId: nodeId })
    const legacy = deliver({ bindingId: 'legacy', assetVersionId: seedAsset('astv_l') })
    expect(legacy).toMatchObject({ status: 'delivered' })
    expect(canvas.get({}).nodes).toHaveLength(3)
  })
})

it('Deliver text input to a new result node with provenance; rendering code again writes a new version to the same slot', () => {
  const created = canvas.apply(user, { requestId: 'texts', ops: [
    { op: 'node.create', tempId: 'code', kind: 'text', format: 'code', content: { text: '<html>v1</html>' } },
    { op: 'node.create', tempId: 'story', kind: 'text', content: { text: '分镜' } },
  ] })
  const code = canvas.get({ nodeIds: [created.idMap.code!] }).nodes[0]!
  const story = canvas.get({ nodeIds: [created.idMap.story!] }).nodes[0]!
  seedBinding('render1', { nearNodeId: code.nodeId }, 'video')
  db.insert(s.jobInputs).values([code, story].map((node, ordinal) => ({ jobId: 'job_render1', ordinal, slotId: node.slots[0]!.slotId, slotRevision: 1, fromSnapshot: false }))).run()
  const first = deliver({ bindingId: 'render1', assetVersionId: seedAsset('video1', 'video') })
  expect(first.status).toBe('delivered')
  if (first.status !== 'delivered') throw new Error('Not delivered')
  expect(canvas.get({ nodeIds: [first.nodeId] }).nodes[0]!.slots[0]!.source).toEqual({ jobId: 'job_render1', inputNodeIds: [code.nodeId, story.nodeId] })
  canvas.apply(user, { requestId: 'edit-code', ops: [{ op: 'slot.setText', slotId: code.slots[0]!.slotId, body: '<html>v2</html>', expectedRevision: 1 }] })
  seedBinding('render2', { nodeId: first.nodeId, slotId: first.slotId, expected: 1 }, 'video')
  db.insert(s.jobInputs).values({ jobId: 'job_render2', ordinal: 0, slotId: code.slots[0]!.slotId, slotRevision: 2, fromSnapshot: false }).run()
  expect(deliver({ bindingId: 'render2', assetVersionId: seedAsset('video2', 'video') })).toMatchObject({ status: 'delivered', nodeId: first.nodeId, slotRevision: 2 })
  expect(canvas.get({}).nodes).toHaveLength(3)
  expect(canvas.history({ slotId: first.slotId, limit: 50 }).versions).toMatchObject([
    { revision: 2, source: { inputNodeIds: [code.nodeId] } },
    { revision: 1, source: { inputNodeIds: [code.nodeId, story.nodeId] } },
  ])
})


it('Work documents can still guide generation placement, but other work documents do not obstruct results', () => {
  const r = canvas.apply(user, { requestId: 'working-inputs', ops: [
    { op: 'node.create', tempId: 'code', kind: 'text', x: 100, y: 100, w: 100, h: 100, purpose: 'working' },
    { op: 'node.create', tempId: 'hidden', kind: 'text', x: 240, y: 100, purpose: 'working' },
  ] })
  seedBinding('working-source', { nearNodeId: r.idMap.code! }, 'video')
  const result = deliver({ bindingId: 'working-source', assetVersionId: seedAsset('working-result', 'video') })
  if (result.status !== 'delivered') throw new Error('Not delivered')
  expect(canvas.get({ nodeIds: [result.nodeId] }).nodes[0]).toMatchObject({ x: 240, y: 100 })
})

describe('Writing media adjusts height to the asset ratio', () => {
  const read = (nodeId: string) => canvas.get({ nodeIds: [nodeId] }).nodes[0]!
  const agent = { kind: 'agent', sessionId: 'fit-session' } as const
  beforeEach(() => {
    db.insert(s.sessions).values({ id: agent.sessionId, agentKind: 'codex', title: '', createdAt: clock }).run()
  })

  it('Generation delivery resizes 320x320 to 320x180, emits events in the same operation, and adds no undo entry', () => {
    const { nodeId, slotId } = createImageNode()
    const history = db.select().from(s.undoEntries).all()
    seedBinding('fit-binding', { nodeId, slotId, expected: 0 })
    const input = { bindingId: 'fit-binding', assetVersionId: seedAsset('wide', 'image', { width: 1920, height: 1080 }) }
    deliver(input)
    expect(read(nodeId)).toMatchObject({ w: 320, h: 180, layoutRevision: 2 })
    expect(db.select().from(s.undoEntries).all()).toEqual(history)
    const events = readEventsAfter(db, 0).filter(event => ['slot.revised', 'node.updated', 'binding.stateChanged'].includes(event.type))
    expect(events.map(event => event.type)).toEqual(['slot.revised', 'node.updated', 'binding.stateChanged'])
    expect(new Set(events.map(event => event.operationId)).size).toBe(1)
    expect(events[1]!.payload).toEqual(read(nodeId))
    expect(deliver(input)).toEqual({ status: 'already_settled' })
    expect(read(nodeId).layoutRevision).toBe(2)
  })

  it.each(['image', 'video'] as const)('Agent writes of %s resize the node without undo entries', kind => {
    const created = canvas.apply(agent, { requestId: 'seed', ops: [{ op: 'node.create', tempId: 'n', kind, w: 320, h: 320 }] })
    const nodeId = created.idMap.n!
    const slotId = read(nodeId).slots[0]!.slotId
    const result = canvas.apply(agent, { requestId: 'fit', ops: [{ op: 'slot.setAsset', slotId, expectedRevision: 0, assetVersionId: seedAsset('wide', kind, { width: 1920, height: 1080 }) }] })
    expect(read(nodeId)).toMatchObject({ w: 320, h: 180, layoutRevision: 2 })
    expect(db.select().from(s.undoEntries).all()).toEqual([])
    expect(readEventsAfter(db, 0).at(-1)).toMatchObject({ type: 'node.updated', operationId: result.operationId })
  })

  it('User asset replacement restores height and asset in the same undo or redo step', () => {
    const { nodeId, slotId } = createImageNode()
    const original = seedAsset('original', 'image', { width: 100, height: 100 })
    canvas.apply(agent, { requestId: 'original', ops: [{ op: 'slot.setAsset', slotId, expectedRevision: 0, assetVersionId: original }] })
    const historyCount = db.select().from(s.undoEntries).all().length
    const wide = seedAsset('wide', 'image', { width: 1920, height: 1080 })
    canvas.apply(user, { requestId: 'fit', ops: [{ op: 'slot.setAsset', slotId, expectedRevision: 1, assetVersionId: wide }] })
    expect(db.select().from(s.undoEntries).all()).toHaveLength(historyCount + 1)
    expect(read(nodeId)).toMatchObject({ h: 180, layoutRevision: 2 })
    canvas.undo({ requestId: 'undo-fit' })
    expect(read(nodeId)).toMatchObject({ h: 320, layoutRevision: 3, slots: [{ content: { assetVersionId: original } }] })
    canvas.redo({ requestId: 'redo-fit' })
    expect(read(nodeId)).toMatchObject({ h: 180, layoutRevision: 4, slots: [{ content: { assetVersionId: wide } }] })
  })

  it.each([
    [{}, 320], [{ width: 1920 }, 320], [{ height: 1080 }, 320],
    [{ width: 100, height: 100 }, 320], [{ width: 320, height: 318 }, 320],
    [{ width: 320, height: 322 }, 320], [{ width: 320, height: 317 }, 317],
    [{ width: 1, height: 100 }, 1280], [{ width: 100, height: 1 }, 80],
  ])('Asset dimensions %j resize to %i; differences of at most 2px do not write layout', (dims, h) => {
    const { nodeId, slotId } = createImageNode()
    const result = canvas.apply(user, { requestId: 'fit', ops: [{ op: 'slot.setAsset', slotId, expectedRevision: 0, assetVersionId: seedAsset('asset', 'image', dims) }] })
    expect(read(nodeId)).toMatchObject({ w: 320, h, layoutRevision: h === 320 ? 1 : 2 })
    expect(readEventsAfter(db, 0).filter(event => event.operationId === result.operationId && event.type === 'node.updated')).toHaveLength(h === 320 ? 0 : 1)
  })

  it('A later operation conflict rolls back the asset, height, events, and undo entries together', () => {
    const { nodeId, slotId } = createImageNode()
    const assetVersionId = seedAsset('wide', 'image', { width: 1920, height: 1080 })
    const before = read(nodeId)
    const events = readEventsAfter(db, 0)
    const history = db.select().from(s.undoEntries).all()
    expect(() => canvas.apply(user, { requestId: 'conflict', ops: [
      { op: 'slot.setAsset', slotId, expectedRevision: 0, assetVersionId },
      { op: 'slot.clear', slotId, expectedRevision: 0 },
    ] })).toThrow(expect.objectContaining({ code: 'revision_conflict' }))
    expect(read(nodeId)).toEqual(before)
    expect(readEventsAfter(db, 0)).toEqual(events)
    expect(db.select().from(s.undoEntries).all()).toEqual(history)
  })

  it('Audio, text, and non-main slots do not resize the node', () => {
    const created = canvas.apply(user, { requestId: 'seed', ops: [
      { op: 'node.create', tempId: 'audio', kind: 'audio', w: 320, h: 320 },
      { op: 'node.create', tempId: 'text', kind: 'text', w: 320, h: 320 },
      { op: 'node.create', tempId: 'image', kind: 'image', w: 320, h: 320 },
    ] })
    const audio = read(created.idMap.audio!)
    const text = read(created.idMap.text!)
    const image = read(created.idMap.image!)
    db.insert(s.slots).values({ id: 'secondary', nodeId: image.nodeId, slotKey: 'secondary', contentType: 'image' }).run()
    canvas.apply(user, { requestId: 'write', ops: [
      { op: 'slot.setAsset', slotId: audio.slots[0]!.slotId, expectedRevision: 0, assetVersionId: seedAsset('audio', 'audio', { width: 1920, height: 1080 }) },
      { op: 'slot.setText', slotId: text.slots[0]!.slotId, expectedRevision: 0, body: '文本' },
      { op: 'slot.setAsset', slotId: 'secondary', expectedRevision: 0, assetVersionId: seedAsset('wide', 'image', { width: 1920, height: 1080 }) },
    ] })
    for (const nodeId of Object.values(created.idMap)) expect(read(nodeId)).toMatchObject({ h: 320, layoutRevision: 1 })
  })

  it('Taller frame members expand ancestor frames; undo and redo restore dimensions and membership', () => {
    const created = canvas.apply(user, { requestId: 'seed', ops: [
      { op: 'frame.create', tempId: 'outer', title: '外框', x: -40, y: -40, w: 480, h: 480 },
      { op: 'frame.create', tempId: 'inner', title: '内框', x: 0, y: 0, w: 400, h: 400 },
      { op: 'node.create', tempId: 'n', kind: 'image', x: 40, y: 40, w: 320, h: 320 },
    ] })
    const { outer, inner, n } = created.idMap
    const slotId = read(n!).slots[0]!.slotId
    canvas.apply(user, { requestId: 'fit', ops: [{ op: 'slot.setAsset', slotId, expectedRevision: 0, assetVersionId: seedAsset('tall', 'image', { width: 1, height: 100 }) }] })
    expect(read(n!)).toMatchObject({ h: 1280, frameId: inner })
    expect(read(inner!)).toMatchObject({ h: 1360, frameId: outer })
    expect(read(outer!)).toMatchObject({ h: 1440 })
    canvas.undo({ requestId: 'undo-fit' })
    expect(read(n!)).toMatchObject({ h: 320, frameId: inner })
    expect(read(inner!)).toMatchObject({ h: 400, frameId: outer })
    expect(read(outer!)).toMatchObject({ h: 480 })
    canvas.redo({ requestId: 'redo-fit' })
    expect(read(n!)).toMatchObject({ h: 1280, frameId: inner })
    expect(read(inner!)).toMatchObject({ h: 1360, frameId: outer })
    expect(read(outer!)).toMatchObject({ h: 1440 })
  })

  it.each([
    [{}, 320, 180], [{ w: 640 }, 640, 360], [{ w: 640, h: 200 }, 640, 200],
  ])('Agent creation with an asset derives default height from the asset and preserves explicit dimensions %j', (size, w, h) => {
    const assetVersionId = seedAsset('wide', 'image', { width: 1920, height: 1080 })
    const created = canvas.apply(agent, { requestId: 'seed', ops: [{ op: 'node.create', tempId: 'n', kind: 'image', content: { assetVersionId }, ...size }] })
    expect(read(created.idMap.n!)).toMatchObject({ w, h, layoutRevision: 1 })
  })
})

it('creates readable bounded long-text cards without resizing existing notes on content edits', () => {
  const { idMap } = canvas.apply(user, { requestId: 'text-sizes', ops: [
    { op: 'node.create', tempId: 'short', kind: 'text', content: { text: 'Short note' } },
    { op: 'node.create', tempId: 'long', kind: 'text', content: { text: 'Paragraph. '.repeat(200) } },
    { op: 'node.create', tempId: 'huge', kind: 'text', content: { text: 'x'.repeat(200_000) } },
    { op: 'node.create', tempId: 'explicit', kind: 'text', w: 420, h: 300, content: { text: 'Long '.repeat(1000) } },
  ] })
  const get = (key: string) => canvas.get({ nodeIds: [idMap[key]!] }).nodes[0]!
  expect(get('short')).toMatchObject({ w: 320, h: 200 })
  expect(get('long')).toMatchObject({ w: 560, h: 720 })
  expect(get('huge')).toMatchObject({ w: 640, h: 720 })
  expect(get('explicit')).toMatchObject({ w: 420, h: 300 })
  const slot = get('short').slots[0]!
  canvas.apply(user, { requestId: 'grow-text-only', ops: [{ op: 'slot.setText', slotId: slot.slotId, expectedRevision: slot.revision, body: 'x'.repeat(10000) }] })
  expect(get('short')).toMatchObject({ w: 320, h: 200 })
})

describe('Fitting a grown media card', () => {
  it('pushes the cards it newly reaches down its column, grows the frame, and undoes in one step', () => {
    const { idMap } = canvas.apply(user, { requestId: 'layout', ops: [
      { op: 'frame.create', tempId: 'f', title: 'Cast', x: 0, y: 0, w: 800, h: 900 },
      { op: 'node.create', tempId: 'top', kind: 'image', x: 24, y: 56, w: 320, h: 180 },
      { op: 'node.create', tempId: 'mid', kind: 'image', x: 24, y: 276, w: 320, h: 180 },
      { op: 'node.create', tempId: 'low', kind: 'image', x: 24, y: 496, w: 320, h: 180 },
      { op: 'node.create', tempId: 'beside', kind: 'image', x: 404, y: 276, w: 320, h: 180 },
    ] })
    const layout = () => Object.fromEntries(canvas.get({}).nodes.map(node => [node.nodeId, { y: node.y, h: node.h }]))
    const before = layout()
    const top = canvas.get({ nodeIds: [idMap.top!] }).nodes[0]!
    canvas.apply(user, { requestId: 'portrait', ops: [{ op: 'slot.setAsset', slotId: top.slots[0]!.slotId, assetVersionId: seedAsset('astv_portrait', 'image', { width: 640, height: 960 }), expectedRevision: 0 }] })
    const after = layout()
    expect(after[idMap.top!]).toEqual({ y: 56, h: 480 })
    expect(after[idMap.mid!]).toEqual({ y: 576, h: 180 })
    expect(after[idMap.low!]).toEqual({ y: 796, h: 180 })
    expect(after[idMap.beside!]).toEqual(before[idMap.beside!])
    expect(after[idMap.f!]!.h).toBeGreaterThanOrEqual(796 + 180 + 40)
    expect(canvas.get({ nodeIds: [idMap.low!] }).nodes[0]!.frameId).toBe(idMap.f)
    canvas.undo({ requestId: 'undo' })
    expect(layout()).toEqual(before)
  })

  const grow = (requestId: string, ops: Parameters<typeof canvas.apply>[1]['ops']) => {
    const { idMap } = canvas.apply(user, { requestId, ops })
    const top = canvas.get({ nodeIds: [idMap.top!] }).nodes[0]!
    canvas.apply(user, { requestId: requestId + '_fit', ops: [{ op: 'slot.setAsset', slotId: top.slots[0]!.slotId, assetVersionId: seedAsset(requestId + '_asset', 'image', { width: 640, height: 960 }), expectedRevision: 0 }] })
    return { idMap, y: (id: string) => canvas.get({ nodeIds: [idMap[id]!] }).nodes[0]!.y }
  }

  it('leaves cards alone when the growth still keeps a gap above them', () => {
    const { y } = grow('loose', [
      { op: 'frame.create', tempId: 'f', title: 'Loose', x: 0, y: 0, w: 800, h: 1400 },
      { op: 'node.create', tempId: 'top', kind: 'image', x: 24, y: 56, w: 320, h: 180 },
      { op: 'node.create', tempId: 'far', kind: 'image', x: 24, y: 700, w: 320, h: 180 },
    ])
    expect(y('far')).toBe(700)
  })

  it('does not push cards on the open canvas', () => {
    const { y } = grow('open', [
      { op: 'node.create', tempId: 'top', kind: 'image', x: 0, y: 0, w: 320, h: 180 },
      { op: 'node.create', tempId: 'below', kind: 'image', x: 0, y: 220, w: 320, h: 180 },
    ])
    expect(y('below')).toBe(220)
  })

  it('leaves the layout to the author when a pushed card would land on a nested frame', () => {
    const { y } = grow('nested', [
      { op: 'frame.create', tempId: 'f', title: 'Outer', x: 0, y: 0, w: 1000, h: 1400 },
      { op: 'node.create', tempId: 'top', kind: 'image', x: 24, y: 56, w: 320, h: 180 },
      { op: 'node.create', tempId: 'below', kind: 'image', x: 24, y: 276, w: 320, h: 180 },
      { op: 'frame.create', tempId: 'inner', title: 'Inner', x: 24, y: 560, w: 400, h: 300 },
    ])
    expect(y('below')).toBe(276)
  })
})
