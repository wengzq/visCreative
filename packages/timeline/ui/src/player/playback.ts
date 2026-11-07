import { clipEndMs, effectiveFades, sourceTimeAt, type TimelineClip, type TimelineTrack } from '@vis/protocol'
import type { AudioClock } from '../player'
import { gainRamp, shouldRealign } from './model'

export type Sound = { element: HTMLMediaElement; source?: MediaElementAudioSourceNode; gain?: GainNode; track?: GainNode; signature?: string | undefined; alignment?: string | undefined; unlisten?: () => void }

export function releaseMedia(sound: Sound) {
  sound.unlisten?.()
  sound.element.pause()
  sound.element.removeAttribute('src')
  sound.element.load()
  sound.source?.disconnect()
  sound.gain?.disconnect()
  sound.track?.disconnect()
}

export function alignMedia(entry: Sound, clip: TimelineClip, position: number, force = false) {
  const { element } = entry
  const alignment = JSON.stringify([clip.source.assetVersionId, clip.startMs, clip.inMs, clip.outMs, clip.speed])
  force ||= entry.alignment !== alignment
  element.playbackRate = clip.speed ?? 1
  element.preservesPitch = true
  const expected = sourceTimeAt(clip, Math.max(clip.startMs, position))
  if (element.readyState >= 1 && (force || shouldRealign(element.currentTime, expected))) {
    try { element.currentTime = expected / 1000 } catch { return }
  }
  // Spare and sounding media share this record so promotion preserves the decoded frame.
  if (element.readyState >= 1) entry.alignment = alignment
}

export function playMedia(entry: Sound, clip: TimelineClip, track: TimelineTrack, position: number, clock: AudioClock, force = false) {
  const fades = effectiveFades(track, track.clips.indexOf(clip))
  const alignment = JSON.stringify([clip.source.assetVersionId, clip.startMs, clip.inMs, clip.outMs, clip.speed])
  force ||= entry.alignment !== alignment
  const playing = clock.playing() && position >= clip.startMs && position < clipEndMs(clip)
  if (playing) {
    const context = clock.context()
    if (!entry.source) {
      entry.source = context.createMediaElementSource(entry.element)
      entry.gain = context.createGain()
      entry.track = context.createGain()
      entry.source.connect(entry.gain).connect(entry.track).connect(context.destination)
    }
    entry.element.muted = false
    entry.track!.gain.setValueAtTime(track.muted ? 0 : track.volume, context.currentTime)
    const signature = JSON.stringify([clip, track.id, fades])
    if (force || entry.signature !== signature || entry.element.paused) {
      entry.signature = signature
      const gain = entry.gain!.gain
      gain.cancelScheduledValues(context.currentTime)
      const ramp = gainRamp(clip, position, fades)
      ramp.forEach((point, index) => {
        const at = context.currentTime + Math.max(0, point.ms - position) / 1000
        if (!index || (point.ms === clipEndMs(clip) && !fades.fadeOutMs)) gain.setValueAtTime(point.gain, at)
        else gain.linearRampToValueAtTime(point.gain, at)
      })
    }
    alignMedia(entry, clip, position, force)
    if (entry.element.paused) void entry.element.play().catch(() => {})
  } else {
    entry.element.pause()
    if (entry.gain) entry.gain.gain.setValueAtTime(0, clock.context().currentTime)
    entry.signature = undefined
    alignMedia(entry, clip, position, force)
  }
}
