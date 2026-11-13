import { expect, it, vi } from 'vitest'
import { referenceTimecode } from './reference-duration'

it('formats one shared media timecode with locale-formatted minutes and seconds', () => {
  const number = vi.fn(String)
  expect(referenceTimecode(75.4, number)).toBe('1:15')
  expect(referenceTimecode(2, number)).toBe('0:02')
  expect(number).toHaveBeenCalledWith(1)
  expect(number).toHaveBeenCalledWith(15)
  for (const seconds of [undefined, null, Number.NaN, Number.POSITIVE_INFINITY, -1]) expect(referenceTimecode(seconds, number)).toBeUndefined()
})
