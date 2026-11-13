import { expect, it } from 'vitest'
import { translate } from './translate'

it('Completed reasoning prefers summaries, falls back to content for empty summaries, retains fully empty entries, and handles redelivery idempotently', () => {
  const item = { id: 'r', type: 'reasoning', summary: ['一', '二'], content: ['原文'] }
  const expected = [{ itemId: 'cx:t:r', revision: 2, kind: 'reasoning', payload: { text: '一\n\n二' } }]
  expect(translate('started', 't', item)).toEqual([{ itemId: 'cx:t:r', revision: 1, kind: 'reasoning', payload: { text: '' } }])
  expect(translate('completed', 't', item)).toEqual(expected)
  expect(translate('completed', 't', item)).toEqual(expected)
  expect(translate('completed', 't', { ...item, summary: [' '] })[0]?.payload).toEqual({ text: '原文' })
  expect(translate('completed', 't', { ...item, summary: [], content: [] })).toEqual([{ itemId: 'cx:t:r', revision: 2, kind: 'reasoning', payload: { text: '' } }])
  expect(translate('completed', 't', { ...item, summary: ['头'.repeat(2000) + '删' + '尾'.repeat(18_000)] })[0]?.payload).toEqual({ text: `${'头'.repeat(2000)}…（已省略）…${'尾'.repeat(18_000)}` })
})

it('Web searches appear as tool calls with the action and URL, so a claim that a page was unavailable can be checked', () => {
  const open = { id: 'w', type: 'webSearch', query: '', action: { type: 'openPage', url: 'https://example.com/guide' } }
  expect(translate('started', 't', open)).toEqual([{ itemId: 'cx:t:w:call', revision: 1, kind: 'tool_call', payload: { toolUseId: 'w', name: 'web_search', input: { query: '', action: open.action } } }])
  expect(translate('completed', 't', open)[1]).toEqual({ itemId: 'cx:t:w:result', revision: 1, kind: 'tool_result', payload: { toolUseId: 'w', isError: false, text: 'openPage https://example.com/guide' } })
  expect(translate('completed', 't', { id: 'w', type: 'webSearch', query: 'seedance', action: { type: 'search', queries: ['seedance 2.5', 'prompt guide'] } })[1]?.payload).toMatchObject({ text: 'search seedance 2.5 | prompt guide' })
  expect(translate('completed', 't', { id: 'w', type: 'webSearch', query: 'seedance' })).toEqual([
    { itemId: 'cx:t:w:call', revision: 1, kind: 'tool_call', payload: { toolUseId: 'w', name: 'web_search', input: { query: 'seedance' } } },
    { itemId: 'cx:t:w:result', revision: 1, kind: 'tool_result', payload: { toolUseId: 'w', isError: false, text: 'search seedance' } },
  ])
  expect(translate('completed', 't', { id: 'w', type: 'webSearch', query: '', action: { type: 'findInPage', url: 'https://example.com/guide', pattern: '运镜' } })[1]?.payload).toMatchObject({ text: 'findInPage https://example.com/guide 运镜' })
})
