import type { JobView, TranscriptItem } from '@vis/protocol'
import { describe, expect, it } from 'vitest'
import { generationResults, resultOutputs, resultState } from './generationResults'
import { markdownImageLink } from './AgentMarkdown'

const item = (itemId: string, kind: TranscriptItem['kind'], payload: unknown): TranscriptItem => ({ itemId, kind, payload, createdSeq: 1, revision: 1, turnId: 'turn', createdAt: 0, updatedAt: 0 })
const receipt = (id: string, jobId: string) => item(id, 'tool_result', { text: JSON.stringify({ jobId }) })
const job = (jobId: string): JobView => ({ jobId, status: 'succeeded', outputs: [], targets: [] })

describe('Session generation results', () => {
  it('shows each job once at its last tool mention, in transcript order, without unavailable jobs', () => {
    const first = job('first'), second = job('second'), third = job('third')
    const items = [
      receipt('submit-first', 'first'), receipt('submit-second', 'second'),
      item('reply', 'assistant_text', { text: 'Checking results' }),
      receipt('get-third', 'third'), receipt('get-first', 'first'), receipt('get-first-again', 'first'), receipt('get-missing', 'missing'),
    ]
    const results = generationResults(items, new Map([first, second, third].map(job => [job.jobId, job])))
    expect([...results]).toEqual([['submit-second', [second]], ['get-third', [third]], ['get-first-again', [first]]])
    expect(generationResults(items, undefined).size).toBe(0)
  })

  it.each([
    ['queued', 'running'], ['running', 'running'], ['finalizing', 'running'], ['succeeded', 'succeeded'],
    ['failed', 'failed'], ['cancelled', 'cancelled'], ['unknown', 'unknown'],
  ] as const)('maps %s to the %s card state', (status, state) => {
    expect(resultState(status)).toBe(state)
  })

  it('limits outputs to four until expanded, preserving provider order', () => {
    const many = { ...job('many'), outputs: Array.from({ length: 7 }, (_, outputIndex) => ({ outputIndex, assetVersionId: `asset-${outputIndex}`, mime: 'image/png', delivery: { status: 'delivered' as const } })) }
    expect(resultOutputs(many, false).map(output => output.outputIndex)).toEqual([0, 1, 2, 3])
    expect(resultOutputs(many, true)).toEqual(many.outputs)
    expect(resultOutputs(job('empty'), false)).toEqual([])
  })
})

describe('Agent Markdown image links', () => {
  it.each(['https://example.com/image.png', 'http://example.com/image.png'])('allows an explicit web link: %s', src => {
    expect(markdownImageLink(src)).toBe(src)
  })

  it.each([undefined, '', '/assets/private', '//example.com/tracker', 'file:///secret', 'data:image/png;base64,abc', 'javascript:alert(1)', 'https://'])('renders other image sources as text: %s', src => {
    expect(markdownImageLink(src)).toBeUndefined()
  })
})
