import { expect, it } from 'vitest'
import { videoFrameRate } from './frame-rate'

it.each([
  ['25/1', '30/1', 25],
  ['30000/1001', undefined, 29.97],
  ['0/0', '24000/1001', 23.976],
  [undefined, '50/1', 50],
  ['NaN', '25/1', 25],
  ['1/0', '25/1', 25],
  ['0/1', undefined, undefined],
  ['241/1', '30/1', undefined],
  ['1/2', undefined, undefined],
  ['240/1', undefined, 240],
  ['1/1', undefined, 1],
] as const)('normalizes average %s and nominal %s to %s fps', (average, nominal, expected) => {
  expect(videoFrameRate(average, nominal)).toBe(expected)
})
