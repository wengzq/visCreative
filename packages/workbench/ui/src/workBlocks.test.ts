import type { JobView, TranscriptItem } from '@vis/protocol'
import { describe, expect, it } from 'vitest'
import { workBlockStats, workTranscript } from './workBlocks'

const item = (itemId: string, kind: TranscriptItem['kind'], payload: unknown = {}, turnId = 'turn'): TranscriptItem => ({ itemId, kind, payload, turnId, createdSeq: 1, revision: 1, createdAt: 1000, updatedAt: 2000 })
const call = (id: string) => item(id, 'tool_call', { toolUseId: id, name: 'canvas_get' })
const result = (id: string, extra = {}) => item(`${id}-result`, 'tool_result', { toolUseId: id, ...extra })
const job: JobView = { jobId: 'job', status: 'succeeded', outputs: [], targets: [] }
const jobs = new Map([[job.jobId, job]])

describe('Work blocks', () => {
  it('merges reasoning, plans and tools in order, counts calls and failures, and leaves source items unchanged', () => {
    const items = [item('reason', 'reasoning'), item('plan', 'plan'), call('a'), result('a'), call('b'), result('b', { isError: true }), item('reason2', 'reasoning')]
    const before = structuredClone(items)
    const groups = workTranscript(items)
    expect(groups).toHaveLength(1)
    const block = groups[0]!
    expect(block.kind).toBe('work')
    if (block.kind !== 'work') throw new Error('Expected work block')
    expect(block.steps.map(step => step.kind === 'tools' ? step.calls.map(pair => pair.call?.itemId) : step.item.itemId)).toEqual(['reason', 'plan', ['a', 'b'], 'reason2'])
    expect(workBlockStats(block)).toEqual({ tools: 2, failed: 1, startedAt: 1000, endedAt: 2000 })
    expect(items).toEqual(before)
  })

  it.each(['assistant_text', 'approval', 'notice', 'user'] as const)('keeps %s outside the blocks and splits both sides', kind => {
    const barrier = item('barrier', kind)
    expect(workTranscript([item('before', 'reasoning'), barrier, item('after', 'plan')]).map(group => group.kind)).toEqual(['work', 'item', 'work'])
    expect(workTranscript([item('before', 'reasoning'), barrier])[1]).toEqual({ kind: 'item', item: barrier })
  })

  it('keeps a turn in one block when a message is queued during it', () => {
    // Real user items never carry a turn ID.
    const user = (id: string) => ({ ...item(id, 'user'), turnId: null })
    const label = (groups: ReturnType<typeof workTranscript>) => groups.map(group => group.kind === 'item' ? group.item.itemId : group.kind)
    const queued = user('queued')
    const isQueued = (entry: TranscriptItem) => entry === queued

    const running = workTranscript([user('asked'), item('before', 'reasoning'), queued, item('after', 'plan')], undefined, 'turn', isQueued)
    expect(label(running)).toEqual(['asked', 'work', 'queued'])
    expect(running[1]?.kind === 'work' && running[1].active).toBe(true)
    expect(label(workTranscript([user('asked'), queued], undefined, 'turn', isQueued))).toEqual(['asked', 'work', 'queued'])
    expect(label(workTranscript([user('asked'), queued, item('first', 'reasoning')], undefined, 'turn', isQueued))).toEqual(['asked', 'work', 'queued'])
    expect(label(workTranscript([user('asked')], undefined, 'turn'))).toEqual(['asked', 'work'])

    const next = user('next')
    expect(label(workTranscript([item('before', 'reasoning'), next, item('after', 'plan'), item('reply', 'assistant_text'), item('next-work', 'reasoning', {}, 'turn-2')])))
      .toEqual(['work', 'reply', 'next', 'work'])
    expect(label(workTranscript([item('before', 'reasoning'), next, item('next-work', 'reasoning', {}, 'turn-2'), item('late', 'plan')])))
      .toEqual(['work', 'next', 'work', 'work'])
  })

  it('places each result once at its last receipt, outside work, preserving actual time order and subsequent work', () => {
    const groups = workTranscript([call('a'), item('reply', 'assistant_text'), result('a', { text: '{"jobId":"job"}' }), item('after', 'reasoning'), call('b'), result('b', { text: '{"jobId":"job"}' }), item('tail', 'plan')], jobs)
    expect(groups.map(group => group.kind)).toEqual(['work', 'item', 'work', 'result', 'work'])
    expect(groups[3]).toEqual({ kind: 'result', job })
    const late = workTranscript([call('a'), item('reply', 'assistant_text'), result('a', { text: '{"jobId":"job"}' })], jobs)
    expect(late.map(group => group.kind)).toEqual(['work', 'item', 'result'])
    expect(late[0]?.kind === 'work' && workBlockStats(late[0]).tools).toBe(1)
  })

  it('splits at every distinct result and at turn boundaries, with only the current tail active', () => {
    const second = { ...job, jobId: 'second' }
    const groups = workTranscript([item('old', 'reasoning', {}, 'old'), call('a'), result('a', { text: '{"jobId":"job"}' }), call('b'), result('b', { text: '{"jobId":"second"}' }), item('tail', 'reasoning')], new Map([['job', job], ['second', second]]), 'turn')
    expect(groups.map(group => group.kind)).toEqual(['work', 'work', 'result', 'work', 'result', 'work'])
    expect(groups.filter(group => group.kind === 'work').map(block => block.active)).toEqual([false, false, false, true])
    expect(workTranscript([item('reply', 'assistant_text')], undefined, 'turn').map(group => group.kind)).toEqual(['item', 'work'])
    expect(workTranscript([], undefined, 'turn')[0]).toMatchObject({ kind: 'work', active: true, steps: [] })
  })
})

it('preserves the running block identity as the first step arrives and includes time up to the visible reply', () => {
  const user = item('user', 'user', {}, 'turn')
  const before = workTranscript([user], undefined, 'turn').at(-1)!
  const during = workTranscript([user, item('thought', 'reasoning')], undefined, 'turn').at(-1)!
  expect(before.kind === 'work' && before.itemId).toBe(during.kind === 'work' && during.itemId)
  const reply = { ...item('reply', 'assistant_text'), createdAt: 161_000, updatedAt: 161_000 }
  const finished = workTranscript([user, item('thought', 'reasoning'), reply])[1]!
  expect(finished.kind === 'work' && workBlockStats(finished)).toEqual({ tools: 0, failed: 0, startedAt: 1000, endedAt: 161_000 })
})
