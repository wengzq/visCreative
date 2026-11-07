import { describe, expect, it } from 'vitest'
import { newId, ulid } from './ids'

describe('ids', () => {
  it('generates prefixed 26-character ULIDs', () => {
    expect(newId('node')).toMatch(/^node_[0-9A-HJKMNP-TV-Z]{26}$/)
  })

  it('sorts by time', () => {
    expect(ulid(1_000) < ulid(2_000)).toBe(true)
    expect(ulid(1_800_000_000_000).slice(0, 10)).toBe(ulid(1_800_000_000_000).slice(0, 10))
  })

  it('no duplicates within the same millisecond', () => {
    const ids = new Set(Array.from({ length: 10_000 }, () => ulid(42)))
    expect(ids.size).toBe(10_000)
  })
})
