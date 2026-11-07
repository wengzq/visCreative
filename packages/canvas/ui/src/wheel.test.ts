import { expect, it } from 'vitest'
import { canScroll } from './wheel'

it('Scroll internally only when selected with overflow in the wheel direction; hand boundaries back to the canvas', () => {
  expect(canScroll(false, 50, 200, 600, 100)).toBe(false)
  expect(canScroll(true, 0, 200, 200, 100)).toBe(false)
  expect(canScroll(true, 0, 200, 600, -100)).toBe(false)
  expect(canScroll(true, 400, 200, 600, 100)).toBe(false)
  expect(canScroll(true, 200, 200, 600, 100)).toBe(true)
  expect(canScroll(true, 200, 200, 600, -100)).toBe(true)
  expect(canScroll(true, 200, 200, 600, 100, true)).toBe(false)
  expect(canScroll(true, 200, 200, 600, 0)).toBe(false)
})
