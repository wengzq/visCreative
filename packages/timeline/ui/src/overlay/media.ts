import { clipEndMs, overlayTracks, type TimelineClip, type TimelineDoc, type TimelineTrack } from '@vis/protocol'
import type { EditorPartProps } from '../types'
import { subscribePlaybackFrames, type AudioClock } from '../player'
import { alignMedia, playMedia, releaseMedia, type Sound } from '../player/playback'

export const PREVIEW_OVERLAY_VIDEOS = 1
export type OverlayPreviewState = { loading: boolean; unavailable: boolean; limited: boolean }
type Slot = { element: HTMLImageElement | HTMLVideoElement; kind: 'image' | 'video'; clip?: TimelineClip | undefined; sound?: Sound | undefined; unlisten(): void }

export function playingOverlayVideos(doc: TimelineDoc, position: number, isVideo: (clip: TimelineClip) => boolean) {
  return overlayTracks(doc).flatMap(track => track.clips.filter(clip => clip.startMs <= position && clipEndMs(clip) > position && isVideo(clip))).reverse()
}

/** Slots keep their decoded frame when a preloaded clip becomes current. */
export function createOverlayMediaPlayer(
  containers: readonly HTMLDivElement[],
  get: () => EditorPartProps & { track: TimelineTrack },
  isVideo: (clip: TimelineClip) => boolean,
  paint: (container: HTMLDivElement, clip: TimelineClip | undefined, visible: boolean, media: HTMLImageElement | HTMLVideoElement) => void,
  onChange: (state: OverlayPreviewState) => void,
) {
  const slots: Slot[] = []
  let disposed = false
  let loadingSince: number | undefined
  let loadingTimer: ReturnType<typeof setTimeout> | undefined
  let lastState = ''
  const createSlot = (container: HTMLDivElement, kind: Slot['kind']): Slot => {
    const element = document.createElement(kind === 'image' ? 'img' : 'video')
    if (kind === 'image') (element as HTMLImageElement).alt = ''
    else { (element as HTMLVideoElement).playsInline = true; (element as HTMLVideoElement).preload = 'auto' }
    container.prepend(element)
    const events = kind === 'image' ? ['load', 'error'] : ['loadedmetadata', 'loadeddata', 'seeked', 'canplay', 'error']
    const changed = () => tick()
    events.forEach(event => element.addEventListener(event, changed))
    return { element, kind, ...(kind === 'video' ? { sound: { element: element as HTMLVideoElement } } : {}),
      unlisten: () => events.forEach(event => element.removeEventListener(event, changed)) }
  }
  const release = (slot: Slot, remove = false) => {
    slot.unlisten()
    if (slot.sound) releaseMedia(slot.sound)
    else slot.element.removeAttribute('src')
    if (remove) slot.element.remove()
  }
  const tick = (force = false) => {
    if (disposed) return
    const { track, clock, draft, host } = get()
    const position = clock.now()
    const active = track.clips.find(clip => clip.startMs <= position && clipEndMs(clip) > position)
    const next = track.clips.find(clip => clip.startMs > position && clip.startMs <= position + 500)
    const activeIndex = active ? Math.max(0, slots.findIndex(slot => slot.clip?.id === active.id)) : -1
    const wanted: (TimelineClip | undefined)[] = [undefined, undefined]
    if (active) wanted[activeIndex] = active
    const nextIndex = active ? activeIndex === 0 ? 1 : 0 : Math.max(0, slots.findIndex(slot => slot.clip?.id === next?.id))
    if (next) wanted[nextIndex] = next
    const visibleVideos = playingOverlayVideos(draft.doc, position, isVideo)
    const allowed = new Set(visibleVideos.slice(0, PREVIEW_OVERLAY_VIDEOS).map(clip => clip.id))
    let waiting = false
    let unavailable = false
    for (let index = 0; index < containers.length; index++) {
      const container = containers[index]!
      const clip = wanted[index]
      let slot = slots[index]!
      const changed = slot.clip?.id !== clip?.id || slot.clip?.source.assetVersionId !== clip?.source.assetVersionId
      if (clip && slot.kind !== (isVideo(clip) ? 'video' : 'image')) {
        release(slot, true)
        slot = slots[index] = createSlot(container, isVideo(clip) ? 'video' : 'image')
      }
      slot.clip = clip
      const current = !!clip && clip.id === active?.id
      const visible = current && !track.hidden
      if (!clip) {
        if (slot.element.hasAttribute('src')) {
          if (slot.sound) {
            slot.sound.element.pause()
            slot.element.removeAttribute('src')
            slot.sound.element.load()
            slot.sound.alignment = undefined
            slot.sound.signature = undefined
          } else slot.element.removeAttribute('src')
        }
      } else {
        const src = host.assetUrl(clip.source.assetVersionId)
        if (slot.element.getAttribute('src') !== src) {
          if (slot.sound) { slot.sound.element.pause(); slot.sound.alignment = undefined; slot.sound.signature = undefined }
          slot.element.src = src
          slot.sound?.element.load()
        } else if (changed && slot.sound) { slot.sound.alignment = undefined; slot.sound.signature = undefined }
        if (slot.sound) {
          if (current && (allowed.has(clip.id) || track.hidden || !clock.playing())) {
            playMedia(slot.sound, clip, track, position, clock as AudioClock, force)
          } else {
            slot.sound.element.pause()
            slot.sound.element.muted = true
            slot.sound.signature = undefined
            // Excess visible videos freeze during playback; clock events still seek every frame exactly.
            if (!current || !clock.playing() || force || changed || !slot.sound.alignment) alignMedia(slot.sound, clip, current ? position : clip.startMs, current && (force || changed))
          }
          if (current) {
            unavailable ||= !!slot.sound.element.error
            waiting ||= slot.sound.element.readyState < 2 || slot.sound.element.seeking
          }
        } else if (visible) {
          const image = slot.element as HTMLImageElement
          unavailable ||= image.complete && !image.naturalWidth
          waiting ||= !image.complete
        }
      }
      paint(container, clip, visible, slot.element)
    }
    waiting &&= !unavailable
    if (!waiting) { loadingSince = undefined; clearTimeout(loadingTimer); loadingTimer = undefined }
    else {
      loadingSince ??= performance.now()
      const remaining = 300 - (performance.now() - loadingSince)
      if (remaining > 0 && loadingTimer === undefined) loadingTimer = setTimeout(() => { loadingTimer = undefined; tick() }, Math.ceil(remaining))
    }
    const state = { loading: loadingSince !== undefined && performance.now() - loadingSince >= 300, unavailable,
      limited: clock.playing() && visibleVideos.length > PREVIEW_OVERLAY_VIDEOS }
    const key = JSON.stringify(state)
    if (lastState !== key) { lastState = key; onChange(state) }
  }
  containers.forEach(container => slots.push(createSlot(container, 'image')))
  const stop = subscribePlaybackFrames(get().clock, force => tick(force))
  return {
    update: () => tick(),
    dispose() { disposed = true; stop(); clearTimeout(loadingTimer); slots.forEach(slot => release(slot, true)) },
  }
}
