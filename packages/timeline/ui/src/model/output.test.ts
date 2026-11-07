import { describe, expect, it } from 'vitest'
import { formatter, messagesFor } from '@vis/ui-kit'
import { timelineShellMessages } from '../shell-messages'
import { effectiveFps, outputDescription, outputFrame, outputFrameRates, outputWithFps, presetFps } from './output'

describe('timeline output frame rate', () => {
  const first = { width: 1080, height: 1920, fps: 29.97 }
  const output = { width: 1280, height: 720, fps: 24 }
  const copy = messagesFor(timelineShellMessages, 'en')
  const number = formatter('en').number
  it('uses the same even implicit frame as export for odd-sized images and overlay presets', () => {
    const image = { width: 321, height: 241, kind: 'image' as const }
    expect(outputFrame(undefined, image)).toEqual({ width: 320, height: 240 })
    expect(outputDescription(undefined, image, number, copy)).toBe('320×240 · Match first clip')
    expect(outputWithFps(undefined, image, 24)).toEqual({ width: 320, height: 240, fps: 24 })
    expect(outputFrame(undefined, undefined)).toMatchObject({ width: 1920, height: 1080 })
    expect(outputFrame(output, image)).toEqual({ width: 1280, height: 720 })
  })
  it('uses the explicit output, source rate or 30 fps in that order', () => {
    expect(effectiveFps(output, first)).toBe(24)
    expect(effectiveFps(undefined, first)).toBe(29.97)
    expect(effectiveFps(undefined, { width: 320, height: 180 })).toBe(30)
    expect(effectiveFps(undefined, undefined)).toBe(30)
  })
  it('names the matched source size and rate in the header', () => {
    expect(outputDescription(undefined, first, number, copy)).toBe('1,080×1,920 · 29.97 fps · Match first clip')
    expect(outputDescription(output, first, number, copy)).toBe('1,280×720 · 24 fps')
  })
  it('omits the unknown source rate from the match-first header', () => {
    expect(outputDescription(undefined, { width: 320, height: 180 }, number, copy)).toBe('320×180 · Match first clip')
    expect(outputDescription(undefined, undefined, number, copy)).toBe('Match first clip')
  })
  it('offers only contract-valid frame rates and rounds and clamps rates for size presets', () => {
    expect(outputFrameRates(undefined, { fps: 48 })).toEqual([24, 25, 30, 48, 50, 60])
    expect(outputFrameRates(undefined, first)).toEqual([24, 25, 30, 50, 60])
    expect(outputFrameRates({ width: 320, height: 180, fps: 26 }, { fps: 120 })).toEqual([24, 25, 26, 30, 50, 60])
    expect(presetFps(undefined, first)).toBe(30)
    expect(presetFps(undefined, { fps: 23.976 })).toBe(24)
    expect(presetFps(undefined, { fps: 120 })).toBe(60)
    expect(presetFps(undefined, { fps: 48 })).toBe(48)
    expect(presetFps(output, first)).toBe(24)
  })
  it('preserves the first clip dimensions when only fps is changed', () => {
    expect(outputWithFps(undefined, { width: 1080, height: 1920 }, 24)).toEqual({ width: 1080, height: 1920, fps: 24 })
  })
  it('waits for complete first clip metadata', () => {
    expect(outputWithFps(undefined, undefined, 24)).toBeNull()
    expect(outputWithFps(undefined, { width: 1080 }, 24)).toBeNull()
  })
  it('keeps an explicit output size even if the first clip differs', () => {
    expect(outputWithFps({ width: 1280, height: 720, fps: 30 }, { width: 1080, height: 1920 }, 60)).toEqual({ width: 1280, height: 720, fps: 60 })
  })
})
