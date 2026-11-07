import { expect, it } from 'vitest'
import { TransientEvent } from './index'

it('transient text supports the legacy format; reasoning streams can include a kind and this system turn ID', () => {
  const old = { sessionId: 's', itemId: 'i', revision: 1, delta: '内容' }
  expect(TransientEvent.parse(old)).toEqual(old)
  expect(TransientEvent.parse({ ...old, kind: 'reasoning', turnId: 't' })).toEqual({ ...old, kind: 'reasoning', turnId: 't' })
  expect(TransientEvent.safeParse({ ...old, kind: 'plan' }).success).toBe(false)
})
