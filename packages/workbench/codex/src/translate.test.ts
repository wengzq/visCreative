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
