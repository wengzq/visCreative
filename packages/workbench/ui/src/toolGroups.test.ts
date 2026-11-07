import type { JobView, TranscriptItem } from '@vis/protocol'
import { describe, expect, it } from 'vitest'
import { generationJob, groupTranscript, transcriptGenerationJobIds } from './toolGroups'

const item = (itemId: string, kind: TranscriptItem['kind'], payload: unknown = {}): TranscriptItem => ({
  itemId, createdSeq: 1, revision: 1, turnId: 't', kind, payload, createdAt: 0, updatedAt: 0,
})
const call = (id: string) => item(`call-${id}`, 'tool_call', { toolUseId: id, name: id, input: { id } })
const result = (id: string, isError = false) => item(`result-${id}`, 'tool_result', { toolUseId: id, text: id, isError })

describe('Tool-linked generation jobs', () => {
  const job: JobView = { jobId: 'job', status: 'cancelled', providerCancelled: false, outputs: [], targets: [] }
  const jobs = new Map([[job.jobId, job]])
  it('Link live cancellation status from submission receipts while preserving original tool records', () => {
    const receipt = item('receipt', 'tool_result', { text: JSON.stringify({ jobId: 'job', status: 'queued' }) })
    expect(generationJob({ result: receipt }, jobs)).toBe(job)
    expect(receipt.payload).toEqual({ text: '{"jobId":"job","status":"queued"}' })
  })
  it('Query and cancel calls link from inputs; safely skip non-JSON and truncated results', () => {
    const request = item('request', 'tool_call', { input: { jobId: 'job' } })
    expect(generationJob({ call: request, result: result('plain text') }, jobs)).toBe(job)
    expect(generationJob({ result: result('{"jobId":') }, jobs)).toBeUndefined()
    expect(generationJob({ result: result('null') }, jobs)).toBeUndefined()
    expect(generationJob({ call: request }, undefined)).toBeUndefined()
  })
  it('Historical job queries extract only tool records, deduplicate, and skip corrupt or ID-less content', () => {
    const receipt = (id: string, jobId: string) => item(id, 'tool_result', { text: JSON.stringify({ jobId, status: 'queued' }) })
    expect(transcriptGenerationJobIds([
      item('text', 'assistant_text', { text: '{"jobId":"not-a-tool"}' }),
      receipt('first', 'job'), receipt('duplicate', 'job'),
      item('get', 'tool_call', { name: 'vis.generation_get', input: { jobId: 'queried' } }),
      result('not JSON'), result('{"jobId":'), receipt('empty', ''),
    ])).toEqual(['job', 'queried'])
  })
})

describe('Tool call grouping', () => {
  it('Preserve ordinary messages and empty records', () => {
    const user = item('user', 'user')
    const text = item('text', 'assistant_text')
    const notice = item('notice', 'notice')
    expect(groupTranscript([])).toEqual([])
    expect(groupTranscript([user, text, notice])).toEqual([user, text, notice].map(item => ({ kind: 'item', item })))
  })

  it('Merge consecutive alternating calls and results into one stable group', () => {
    const a = call('a'), ar = result('a'), b = call('b'), br = result('b')
    const initial = groupTranscript([a])
    expect(groupTranscript([a, ar, b, br])).toEqual([
      { kind: 'tools', itemId: a.itemId, calls: [{ call: a, result: ar }, { call: b, result: br }] },
    ])
    expect(initial).toEqual([{ kind: 'tools', itemId: a.itemId, calls: [{ call: a }] }])
  })

  it('Show approvals separately while keeping tool results paired with their original calls', () => {
    const a = call('a'), ar = result('a'), approval = item('approval', 'approval')
    expect(groupTranscript([a, approval, ar])).toEqual([
      { kind: 'tools', itemId: a.itemId, calls: [{ call: a, result: ar }] },
      { kind: 'item', item: approval },
    ])
  })

  it('Match parallel calls and out-of-order results by tool id without changing call order', () => {
    const a = call('a'), ar = result('a'), b = call('b'), br = result('b')
    expect(groupTranscript([a, b, br, ar])).toEqual([
      { kind: 'tools', itemId: a.itemId, calls: [{ call: a, result: ar }, { call: b, result: br }] },
    ])
    expect(groupTranscript([ar, a])).toEqual([
      { kind: 'tools', itemId: ar.itemId, calls: [{ call: a, result: ar }] },
    ])
  })

  it('Ordinary messages separate groups; late results rejoin their calls; orphan results stay in place', () => {
    const a = call('a'), ar = result('a'), text = item('text', 'assistant_text'), orphan = result('orphan')
    expect(groupTranscript([a, text, ar, orphan])).toEqual([
      { kind: 'tools', itemId: a.itemId, calls: [{ call: a, result: ar }] },
      { kind: 'item', item: text },
      { kind: 'tools', itemId: ar.itemId, calls: [{ result: orphan }] },
    ])
  })

  it('Late results create no empty groups; later calls preserve message boundaries and tool segment ids', () => {
    const a = call('a'), ar = result('a'), text = item('text', 'assistant_text'), b = call('b')
    expect(groupTranscript([a, text, ar])).toEqual([
      { kind: 'tools', itemId: a.itemId, calls: [{ call: a, result: ar }] },
      { kind: 'item', item: text },
    ])
    expect(groupTranscript([a, text, ar, b])).toEqual([
      { kind: 'tools', itemId: a.itemId, calls: [{ call: a, result: ar }] },
      { kind: 'item', item: text },
      { kind: 'tools', itemId: ar.itemId, calls: [{ call: b }] },
    ])
  })

  it('Preserve failed results and still-waiting calls without modifying source records', () => {
    const failed = call('failed'), failure = result('failed', true), pending = call('pending')
    const items = [failed, failure, pending]
    const snapshot = structuredClone(items)
    expect(groupTranscript(items)).toEqual([
      { kind: 'tools', itemId: failed.itemId, calls: [{ call: failed, result: failure }, { call: pending }] },
    ])
    expect(items).toEqual(snapshot)
  })

  it('Entries without tool ids do not match each other; retain all entries with duplicate ids', () => {
    const missingCall = item('call', 'tool_call', null), missingResult = item('result', 'tool_result')
    const first = call('same'), second = { ...call('same'), itemId: 'call-second' }
    const firstResult = result('same'), secondResult = { ...result('same'), itemId: 'result-second' }
    expect(groupTranscript([missingCall, missingResult, first, second, firstResult, secondResult])).toEqual([
      { kind: 'tools', itemId: missingCall.itemId, calls: [
        { call: missingCall }, { result: missingResult },
        { call: first, result: firstResult }, { call: second, result: secondResult },
      ] },
    ])
  })

  it('Match duplicate ids across messages one-to-one, keeping extra results visible', () => {
    const first = call('same'), second = { ...call('same'), itemId: 'call-second' }, text = item('text', 'assistant_text')
    const firstResult = result('same'), secondResult = { ...result('same'), itemId: 'result-second' }
    const extraResult = { ...result('same'), itemId: 'result-extra' }
    expect(groupTranscript([first, text, second, firstResult, secondResult, extraResult])).toEqual([
      { kind: 'tools', itemId: first.itemId, calls: [{ call: first, result: firstResult }] },
      { kind: 'item', item: text },
      { kind: 'tools', itemId: second.itemId, calls: [{ call: second, result: secondResult }, { result: extraResult }] },
    ])
  })
})
