import { useEffect, useMemo } from 'react'
import { timelineDurationMs, type TimelineDoc } from '@vis/protocol'
import type { PlaybackClock } from './types'

export type AudioClock = PlaybackClock & { context(): AudioContext; update(doc: TimelineDoc): void; dispose(): void }

export function subscribePlaybackFrames(clock: PlaybackClock, paint: (clockEvent: boolean) => void) {
  let frame = 0
  const update = (clockEvent = false) => {
    cancelAnimationFrame(frame)
    frame = 0
    paint(clockEvent)
    if (clock.playing()) frame = requestAnimationFrame(() => update())
  }
  const unsubscribe = clock.subscribe(() => update(true))
  update()
  return () => { unsubscribe(); cancelAnimationFrame(frame) }
}

export function createPlaybackClock(doc: TimelineDoc): AudioClock {
  let duration = timelineDurationMs(doc)
  let audio: AudioContext | undefined
  let position = 0
  let startedAt = 0
  let running = false
  let endTimer: ReturnType<typeof setTimeout> | undefined
  const listeners = new Set<() => void>()
  const emit = () => { for (const listener of listeners) listener() }
  const now = () => Math.min(duration, position + (running ? (audio!.currentTime - startedAt) * 1000 : 0))
  const context = () => audio ??= new AudioContext()
  const armEnd = () => {
    clearTimeout(endTimer)
    if (!running) return
    endTimer = setTimeout(() => {
      if (now() < duration) { armEnd(); return }
      running = false
      position = duration
      emit()
    }, Math.max(16, duration - now()))
  }
  return {
    now, context,
    playing: () => running,
    play() {
      if (running || !duration) return
      const ctx = context()
      if (position >= duration) position = 0
      startedAt = ctx.currentTime
      running = true
      void ctx.resume().catch(() => { running = false; emit() })
      armEnd()
      emit()
    },
    pause() {
      if (!running) return
      position = now()
      running = false
      clearTimeout(endTimer)
      emit()
    },
    seek(ms) {
      position = Math.max(0, Math.min(duration, Number.isFinite(ms) ? ms : 0))
      if (running) startedAt = context().currentTime
      armEnd()
      emit()
    },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    update(next) {
      const previous = duration
      duration = timelineDurationMs(next)
      if (position > duration || (running && now() >= duration)) {
        position = duration
        running = false
        emit()
      }
      if (previous !== duration) armEnd()
    },
    dispose() { clearTimeout(endTimer); listeners.clear(); void audio?.close() },
  }
}

export function usePlaybackClock(doc: TimelineDoc): AudioClock {
  const clock = useMemo(() => createPlaybackClock(doc), [])
  useEffect(() => clock.update(doc), [clock, doc])
  useEffect(() => () => clock.dispose(), [clock])
  return clock
}
