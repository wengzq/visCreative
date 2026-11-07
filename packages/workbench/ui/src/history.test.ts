import { describe, expect, it } from 'vitest'
import { anchoredScrollTop } from './history'

describe('Earlier transcript position preservation', () => {
  it('Compensate for the original entry position without counting streaming content height below', () => {
    expect(anchoredScrollTop(120, 20, 720)).toBe(820)
    expect(anchoredScrollTop(120, 20, 20)).toBe(120)
  })
  it('Use the current position after the user continues scrolling during the request', () => {
    expect(anchoredScrollTop(400, -80, 620)).toBe(1100)
  })
})
