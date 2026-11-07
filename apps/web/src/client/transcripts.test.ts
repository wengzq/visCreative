import type { TranscriptItem } from '@vis/protocol'
import { describe, expect, it } from 'vitest'
import { appendDelta, emptyTranscripts, mergePage, upsertItem } from './transcripts'

const item = (itemId: string, createdSeq: number, text: string, revision = 1): TranscriptItem => ({
  itemId, createdSeq, revision, turnId: 't', kind: 'assistant_text', payload: { text }, createdAt: 0, updatedAt: 0,
})

describe('Session transcripts', () => {
  it('pagination: prepends older pages and takes hasMore from the older page', () => {
    let s = mergePage(emptyTranscripts(), 's1', { items: [item('c', 3, 'c'), item('d', 4, 'd')], hasMore: true }, false)
    s = mergePage(s, 's1', { items: [item('a', 1, 'a'), item('b', 2, 'b')], hasMore: false }, true)
    expect(s.transcripts.get('s1')).toMatchObject({ hasMore: false, items: [{ itemId: 'a' }, { itemId: 'b' }, { itemId: 'c' }, { itemId: 'd' }] })
  })

  it('streaming fragments accumulate; final entries remove drafts and late fragments are discarded', () => {
    let s = mergePage(emptyTranscripts(), 's1', { items: [], hasMore: false }, false)
    s = appendDelta(s, { sessionId: 's1', itemId: 'm', revision: 1, delta: '画布' })
    s = appendDelta(s, { sessionId: 's1', itemId: 'm', revision: 1, delta: '是空的' })
    expect(s.drafts.get('s1')?.get('m')?.payload).toEqual({ text: '画布是空的' })
    s = upsertItem(s, 's1', item('m', 1, '画布是空的'))
    expect(s.drafts.get('s1')?.has('m')).toBe(false)
    expect(appendDelta(s, { sessionId: 's1', itemId: 'm', revision: 1, delta: '迟到' })).toBe(s)
    expect(s.transcripts.get('s1')!.items.map(i => i.itemId)).toEqual(['m'])
  })

  it('reasoning deltas preserve identity and start time; final entries take precedence after completion', () => {
    let s = mergePage(emptyTranscripts(), 's1', { items: [], hasMore: false }, false)
    s = appendDelta(s, { sessionId: 's1', itemId: 'thought', revision: 1, kind: 'reasoning', turnId: 't', delta: '先看' })
    const first = s.drafts.get('s1')!.get('thought')!
    s = appendDelta(s, { sessionId: 's1', itemId: 'thought', revision: 2, kind: 'reasoning', turnId: 't', delta: '画布' })
    expect(s.drafts.get('s1')!.get('thought')).toMatchObject({ kind: 'reasoning', turnId: 't', createdAt: first.createdAt, payload: { text: '先看画布' } })
    const final = { ...item('thought', 1, '最终摘要', 2), kind: 'reasoning' as const }
    s = upsertItem(s, 's1', final)
    expect(s.drafts.get('s1')?.size).toBe(0)
    expect(s.transcripts.get('s1')!.items).toEqual([final])
    expect(appendDelta(s, { sessionId: 's1', itemId: 'thought', revision: 2, kind: 'reasoning', delta: '迟到' })).toBe(s)
  })

  it('empty reasoning-start entries do not block revision 2 deltas; late starts do not clear drafts', () => {
    const started = { ...item('thought', 1, ''), kind: 'reasoning' as const }
    let s = mergePage(emptyTranscripts(), 's1', { items: [started], hasMore: false }, false)
    const delta = { sessionId: 's1', itemId: 'thought', revision: 2, kind: 'reasoning' as const, turnId: 't', delta: '推理摘要' }
    s = appendDelta(s, delta)
    expect(s.drafts.get('s1')?.get('thought')).toMatchObject({ createdAt: started.createdAt, payload: { text: '推理摘要' } })
    s = upsertItem(s, 's1', started)
    expect(s.drafts.get('s1')?.get('thought')?.payload).toEqual({ text: '推理摘要' })
    s = upsertItem(s, 's1', { ...started, revision: 2, payload: { text: '完整摘要' } })
    expect(s.drafts.get('s1')?.size).toBe(0)
    expect(appendDelta(s, delta)).toBe(s)
  })

  it('accepts only higher revisions of an entry; unopened sessions do not cache entries', () => {
    let s = mergePage(emptyTranscripts(), 's1', { items: [item('m', 1, 'v2', 2)], hasMore: false }, false)
    s = upsertItem(s, 's1', item('m', 1, 'v1', 1))
    expect((s.transcripts.get('s1')!.items[0]!.payload as any).text).toBe('v2')
    s = upsertItem(s, 's2', item('x', 1, 'x'))
    expect(s.transcripts.has('s2')).toBe(false)
  })
})
