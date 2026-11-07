import { describe, expect, it } from 'vitest'
import { initialVideoLifecycle, shouldReleaseVideo, videoLifecycle, VIDEO_IDLE_DELAY } from './video-lifecycle'

describe('Compact video lifecycle', () => {
  it('starts without a decoder when a poster is available', () => {
    expect(initialVideoLifecycle(true)).toMatchObject({ active: false, frameReady: false, pendingPlay: false })
    expect(initialVideoLifecycle(false)).toMatchObject({ active: true, fallback: true })
    expect(initialVideoLifecycle(true, true).active).toBe(true)
  })

  it.each(['hover', 'focus', 'select'] as const)('mounts for %s and releases only after that attention ends', type => {
    let state = videoLifecycle(videoLifecycle(initialVideoLifecycle(true), { type: 'poster' }), { type, value: true })
    expect(state.active).toBe(true)
    expect(shouldReleaseVideo(state)).toBe(false)
    state = videoLifecycle(state, { type, value: false })
    expect(state.active).toBe(true)
    expect(shouldReleaseVideo(state)).toBe(true)
    expect(VIDEO_IDLE_DELAY).toBe(3000)
    expect(videoLifecycle(state, { type: 'idle' }).active).toBe(false)
  })

  it('keeps play requested during mounting until playback starts', () => {
    let state = videoLifecycle(videoLifecycle(initialVideoLifecycle(true), { type: 'poster' }), { type: 'play' })
    expect(state).toMatchObject({ active: true, pendingPlay: true, frameReady: false })
    expect(shouldReleaseVideo(state)).toBe(false)
    state = videoLifecycle(state, { type: 'visibility', value: true })
    expect(state.pendingPlay).toBe(true)
    expect(state.active).toBe(true)
    state = videoLifecycle(state, { type: 'frame' })
    expect(state.frameReady).toBe(true)
    state = videoLifecycle(state, { type: 'playing', value: true })
    expect(state).toMatchObject({ active: true, playing: true, pendingPlay: false })
    expect(videoLifecycle(state, { type: 'idle' }).active).toBe(true)
    state = videoLifecycle(state, { type: 'playing', value: false })
    expect(shouldReleaseVideo(state)).toBe(true)
    expect(videoLifecycle(state, { type: 'idle' })).toMatchObject({ active: false, frameReady: false })
  })

  it('never releases to a poster that has not loaded', () => {
    let state = videoLifecycle(videoLifecycle(initialVideoLifecycle(true, true), { type: 'frame' }), { type: 'select', value: false })
    expect(shouldReleaseVideo(state)).toBe(false)
    expect(videoLifecycle(state, { type: 'idle' })).toBe(state)
    state = videoLifecycle(state, { type: 'poster' })
    expect(shouldReleaseVideo(state)).toBe(true)
  })

  it('releases immediately offscreen, including playing and pending playback', () => {
    for (const event of [{ type: 'play' }, { type: 'playing', value: true }] as const) {
      let state = videoLifecycle(initialVideoLifecycle(true, true), event)
      state = videoLifecycle(state, { type: 'frame' })
      state = videoLifecycle(state, { type: 'visibility', value: false })
      expect(state).toMatchObject({ active: false, playing: false, pendingPlay: false, frameReady: false })
      expect(videoLifecycle(state, { type: 'play' }).active).toBe(false)
      expect(videoLifecycle(state, { type: 'visibility', value: true }).active).toBe(true)
    }
  })

  it('retains a live fallback after poster failure until it leaves the viewport', () => {
    let state = videoLifecycle(initialVideoLifecycle(true), { type: 'fallback' })
    expect(state).toMatchObject({ active: true, fallback: true })
    expect(shouldReleaseVideo(state)).toBe(false)
    state = videoLifecycle(state, { type: 'visibility', value: false })
    expect(state.active).toBe(false)
    state = videoLifecycle(state, { type: 'visibility', value: true })
    expect(state.active).toBe(true)
  })

  it('keeps a source change offscreen and preserves attention for an onscreen source change', () => {
    const selected = initialVideoLifecycle(true, true)
    const offscreen = videoLifecycle(selected, { type: 'visibility', value: false })
    expect(videoLifecycle(offscreen, { type: 'reset', poster: true, selected: true })).toMatchObject({ active: false, visible: false })
    const hovered = videoLifecycle(initialVideoLifecycle(true), { type: 'hover', value: true })
    expect(videoLifecycle(hovered, { type: 'reset', poster: true, selected: false })).toMatchObject({ active: true, hovered: true, frameReady: false })
  })
})
