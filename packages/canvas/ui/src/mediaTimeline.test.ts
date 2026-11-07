import { describe, expect, it } from 'vitest'
import { LOCAL_OPERATION_PARAMS } from '@vis/protocol'
import { addSplitPoint, clampRange, clampTime, durationMs, MAX_SPLIT_POINTS, moveSplitPoint, normalizeSplitPoints, pixelToTime, removeSplitPoint, timelineTime, timeToPercent } from './mediaTimeline'
import { mediaPanelMessages } from './media-messages'
import { messagesFor } from '@vis/ui-kit'

describe('Media timeline coordinates', () => {
  it('Keeps the precise selected milliseconds visible and available to screen readers', () => {
    expect(timelineTime(0)).toBe('0:00.000')
    expect(timelineTime(61_234)).toBe('1:01.234')
    expect(timelineTime(3_600_001)).toBe('60:00.001')
    expect(timelineTime(-100)).toBe('0:00.000')
    expect(timelineTime(NaN)).toBe('0:00.000')
  })

  it('Maps viewport pixels into integer milliseconds and clamps outside the track', () => {
    expect(pixelToTime(160, 60, 200, 3000)).toBe(1500)
    expect(pixelToTime(-20, 60, 200, 3000)).toBe(0)
    expect(pixelToTime(500, 60, 200, 3000)).toBe(3000)
    expect(pixelToTime(60, 60, 0, 3000)).toBe(0)
    expect(timeToPercent(1500, 3000)).toBe(50)
    expect(timeToPercent(-10, 3000)).toBe(0)
    expect(timeToPercent(4000, 3000)).toBe(100)
    expect(timeToPercent(1, 0)).toBe(0)
    expect(durationMs(Infinity)).toBe(0)
    expect(durationMs(1.2345)).toBe(1235)
    expect(clampTime(NaN, 1000)).toBe(0)
  })
})

describe('Trim ranges', () => {
  it('Keeps a positive integer range inside the asset, including crossed and stale handles', () => {
    expect(clampRange(-500, 4000, 3000)).toEqual({ startMs: 0, endMs: 3000 })
    expect(clampRange(2500, 1000, 3000)).toEqual({ startMs: 2500, endMs: 2501 })
    expect(clampRange(5000, 6000, 3000)).toEqual({ startMs: 2999, endMs: 3000 })
    expect(clampRange(0, 1000, 0)).toEqual({ startMs: 0, endMs: 0 })
    expect(clampRange(0, 0, 1)).toEqual({ startMs: 0, endMs: 1 })
  })
})

describe('Split editing', () => {
  it('Normalizes analysis candidates, rejects endpoints, deduplicates and limits to the contract maximum', () => {
    expect(normalizeSplitPoints([500, 0, 1000, 500.1, 100, -1, Infinity, NaN], 1000)).toEqual([100, 500])
    const points = normalizeSplitPoints(Array.from({ length: 30 }, (_, i) => 30 - i), 40)
    expect(points).toHaveLength(MAX_SPLIT_POINTS)
    expect(LOCAL_OPERATION_PARAMS['audio.split'].safeParse({ pointsMs: points }).success).toBe(true)
    expect(addSplitPoint(points, 25, 40)).toEqual(points)
  })

  it('Adds, moves and removes points without crossing neighboring handles or mutating the input', () => {
    const points = [200, 500, 800]
    expect(addSplitPoint(points, 300, 1000)).toEqual([200, 300, 500, 800])
    expect(addSplitPoint(points, 500, 1000)).toEqual(points)
    expect(moveSplitPoint(points, 1, 900, 1000)).toEqual([200, 799, 800])
    expect(moveSplitPoint(points, 1, 0, 1000)).toEqual([200, 201, 800])
    expect(moveSplitPoint(points, 0, -10, 1000)).toEqual([1, 500, 800])
    expect(moveSplitPoint(points, 2, 2000, 1000)).toEqual([200, 500, 999])
    expect(moveSplitPoint(points, -1, 100, 1000)).toEqual(points)
    expect(removeSplitPoint(points, 1)).toEqual([200, 800])
    expect(points).toEqual([200, 500, 800])
  })
})

it('Media panel dictionaries share keys and provide translated split descriptions', () => {
  expect(Object.keys(mediaPanelMessages.en)).toEqual(Object.keys(mediaPanelMessages['zh-CN']))
  expect(messagesFor(mediaPanelMessages, 'en').splitCount('2', '3')).toBe('2 split points · 3 segments')
  expect(messagesFor(mediaPanelMessages, 'zh-CN').splitCount('2', '3')).toBe('2 个切点 · 3 段')
})
