import { expect, it } from 'vitest'
import { parseTimecode, timecode } from './geometry'

it('keeps source-rate timecode frame fields integral at fractional rates', () => {
  expect(timecode(1500, 29.97)).toBe('00:01.14')
  expect(timecode(1000, 29.97)).toBe('00:01.00')
  expect(timecode(1999, 29.97)).toBe('00:01.29')
  expect(timecode(3_612_500, 23.976)).toBe('01:00:12.11')
  expect(timecode(1000 / 29.97, 29.97)).toBe('00:00.01')
  expect(parseTimecode('00:01.14', 29.97)).toBe(Math.round(1000 + 14 * 1000 / 29.97))
  expect(parseTimecode('00:01.30', 29.97)).toBeNull()
})

it('supports three-digit frame fields for high-rate source clips', () => {
  expect(timecode(1500, 240)).toBe('00:01.120')
  expect(parseTimecode('00:01.120', 240)).toBe(1500)
  expect(parseTimecode('00:01.240', 240)).toBeNull()
})
