import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TimelineDoc } from '@vis/protocol'
import { createPlaybackClock, subscribePlaybackFrames } from './player'

const doc: TimelineDoc = { version: 1, tracks: [{ id: 'audio', kind: 'audio', muted: false, volume: 1, clips: [
  { id: 'clip', source: { nodeId: 'node', assetVersionId: 'asset' }, startMs: 0, inMs: 0, outMs: 2000, volume: 1, fadeInMs: 0, fadeOutMs: 0 },
] }] }

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('Audio master clock', () => {
  it('paints immediately on clock events and only requests frames during playback', () => {
    const frames = new Map<number, FrameRequestCallback>()
    let id = 0
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++id, callback); return id })
    vi.stubGlobal('cancelAnimationFrame', (frame: number) => frames.delete(frame))
    class Context {
      currentTime = 0
      resume = vi.fn(async () => {})
      close = vi.fn(async () => {})
    }
    vi.stubGlobal('AudioContext', Context)
    const clock = createPlaybackClock(doc)
    const paint = vi.fn()
    const unsubscribe = subscribePlaybackFrames(clock, paint)
    expect(paint).toHaveBeenLastCalledWith(false)
    expect(frames.size).toBe(0)
    clock.seek(100)
    expect(paint).toHaveBeenLastCalledWith(true)
    expect(frames.size).toBe(0)
    clock.play()
    expect(frames.size).toBe(1)
    const callback = [...frames.values()][0]!
    frames.clear()
    callback(16)
    expect(paint).toHaveBeenLastCalledWith(false)
    expect(frames.size).toBe(1)
    clock.seek(200)
    expect(frames.size).toBe(1)
    clock.pause()
    expect(frames.size).toBe(0)
    clock.play()
    unsubscribe()
    expect(frames.size).toBe(0)
    const notifications = paint.mock.calls.length
    clock.pause()
    expect(paint).toHaveBeenCalledTimes(notifications)
    clock.dispose()
  })

  it('polls audio time without notifying on frames and freezes on pause', () => {
    class Context {
      currentTime = 0
      resume = vi.fn(async () => {})
      close = vi.fn(async () => {})
    }
    vi.stubGlobal('AudioContext', Context)
    const clock = createPlaybackClock(doc)
    const notify = vi.fn()
    const unsubscribe = clock.subscribe(notify)
    clock.play()
    const context = clock.context() as unknown as { currentTime: number }
    context.currentTime = 0.4
    expect(clock.now()).toBe(400)
    expect(notify).toHaveBeenCalledTimes(1)
    clock.pause()
    context.currentTime = 1.4
    expect(clock.now()).toBe(400)
    clock.seek(5000)
    expect(clock.now()).toBe(2000)
    clock.play()
    expect(clock.now()).toBe(0)
    context.currentTime = 1.9
    expect(clock.now()).toBe(500)
    unsubscribe()
    clock.dispose()
  })
  it('emits once at the end and clamps live document changes', () => {
    vi.useFakeTimers()
    class Context {
      currentTime = 0
      resume = vi.fn(async () => {})
      close = vi.fn(async () => {})
    }
    vi.stubGlobal('AudioContext', Context)
    const clock = createPlaybackClock(doc)
    const notify = vi.fn()
    clock.subscribe(notify)
    clock.play()
    const context = clock.context() as unknown as { currentTime: number }
    context.currentTime = 2
    vi.advanceTimersByTime(2000)
    expect(clock.playing()).toBe(false)
    expect(clock.now()).toBe(2000)
    expect(notify).toHaveBeenCalledTimes(2)
    clock.update({ version: 1, tracks: [] })
    expect(clock.now()).toBe(0)
    clock.dispose()
  })
})
