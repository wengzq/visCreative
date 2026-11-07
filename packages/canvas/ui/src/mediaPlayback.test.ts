import { expect, it, vi } from 'vitest'
import { mediaPositionMs, pauseMedia, trackMedia } from './mediaPlayback'

it('Frame selection reads the current player and retains its position when a panel replaces it', () => {
  const element = { currentTime: 1.234, pause: vi.fn() } as unknown as HTMLMediaElement
  const stop = trackMedia('frame-fixture', element)
  expect(mediaPositionMs('frame-fixture')).toBe(1234)
  element.currentTime = 2.5
  pauseMedia('frame-fixture')
  expect(element.pause).toHaveBeenCalledOnce()
  stop()
  expect(mediaPositionMs('frame-fixture')).toBe(2500)
  expect(mediaPositionMs('unknown')).toBe(0)
})
