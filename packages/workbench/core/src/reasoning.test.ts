import { expect, it } from 'vitest'
import { truncateReasoning } from './reasoning'

it('Only truncate above 20,000 characters, retaining the first 2,000 and last 18,000 without splitting Unicode code points', () => {
  expect(truncateReasoning('文'.repeat(20_000))).toBe('文'.repeat(20_000))
  const head = '😀'.repeat(2000)
  const tail = '尾'.repeat(18_000)
  expect(truncateReasoning(`${head}删${tail}`)).toBe(`${head}…（已省略）…${tail}`)
  expect(truncateReasoning('')).toBe('')
})
