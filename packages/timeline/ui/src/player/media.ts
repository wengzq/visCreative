import { isAudioTrack, isMainVideoTrack, type TimelineClip } from '@vis/protocol'
import type { EditorPartProps } from '../types'
import { subscribePlaybackFrames, type AudioClock } from '../player'
import { activeClip, nextVideoClip, upcomingClips, visualClips } from './model'
import { alignMedia, playMedia, releaseMedia, type Sound } from './playback'

export function createMediaPlayer(
  initialVideos: readonly HTMLVideoElement[],
  initialImages: readonly HTMLImageElement[],
  get: () => EditorPartProps,
  onChange: (state: { clipId?: string; audioIds: string[]; loading: boolean; unavailable: boolean }) => void,
  assetKind: (id: string) => string | undefined,
) {
  const videos = [...initialVideos]
  const images = [...initialImages]
  const videoSounds = videos.map(element => ({ element }) as Sound)
  const extraElements: (HTMLVideoElement | HTMLImageElement)[] = []
  const imageListeners: (() => void)[] = []
  const audio = new Map<string, Sound>()
  const assigned = new Map<HTMLVideoElement, string>()
  const assignedImages = new Map<HTMLImageElement, string>()
  let loadingTimer: ReturnType<typeof setTimeout> | undefined
  let loadingSince: number | undefined
  let lastState = ''
  let previousPosition = 0
  let disposed = false
  const isImage = (clip: TimelineClip) => {
    const kind = assetKind(clip.source.assetVersionId)
    if (kind) return kind === 'image'
    const node = get().host.nodes.find(node => node.nodeId === clip.source.nodeId)
    return node?.kind === 'image' || node?.slots.some(slot => slot.content.type === 'asset' && slot.content.assetVersionId === clip.source.assetVersionId && slot.content.mime.startsWith('image/'))
  }
  const listen = (element: EventTarget, events: string[]) => {
    const changed = () => tick()
    events.forEach(event => element.addEventListener(event, changed))
    return () => events.forEach(event => element.removeEventListener(event, changed))
  }
  const listenMedia = (entry: Sound) => {
    entry.unlisten = listen(entry.element, ['loadedmetadata', 'loadeddata', 'seeked', 'canplay', 'error'])
  }
  const prepareVideo = (clip: TimelineClip, preferred: number) => {
    const element = videos.find(video => assigned.get(video) === clip.id) ?? videos[preferred]!
    const entry = videoSounds.find(sound => sound.element === element)!
    const src = get().host.assetUrl(clip.source.assetVersionId)
    if (assigned.get(element) !== clip.id || element.getAttribute('src') !== src) {
      element.pause()
      assigned.set(element, clip.id)
      entry.alignment = undefined
      if (element.getAttribute('src') !== src) {
        element.src = src
        element.load()
      }
      entry.signature = undefined
    }
    return element
  }
  const tick = (force = false) => {
    if (disposed) return
    const { draft, clock, host } = get()
    const position = clock.now()
    force ||= Math.abs(position - previousPosition) > 250
    previousPosition = position
    const videoTrack = draft.doc.tracks.find(isMainVideoTrack)
    const current = activeClip(videoTrack, position)
    const next = nextVideoClip(videoTrack, position)
    const visible = visualClips(videoTrack, position)
    // Back-to-back overlaps occupy both original elements until the next cut starts.
    // A third spare lets that incoming shot load and seek while the current pair still plays.
    if (visible.filter(item => !isImage(item.clip)).length === videos.length && next && !isImage(next) && videos.length === initialVideos.length) {
      const element = document.createElement('video')
      element.playsInline = true
      element.preload = 'auto'
      element.style.visibility = 'hidden'
      initialVideos[0]!.parentElement?.append(element)
      const entry: Sound = { element }
      listenMedia(entry)
      videos.push(element)
      videoSounds.push(entry)
      extraElements.push(element)
    }
    if (visible.filter(item => isImage(item.clip)).length === images.length && next && isImage(next) && images.length === initialImages.length) {
      const element = document.createElement('img')
      element.alt = ''
      element.style.visibility = 'hidden'
      initialImages[0]!.parentElement?.append(element)
      images.push(element)
      extraElements.push(element)
      imageListeners.push(listen(element, ['load', 'error']))
    }
    const activeVideos = new Map<HTMLVideoElement, typeof visible[number]>()
    const activeImages = new Map<HTMLImageElement, typeof visible[number]>()
    for (const item of visible) {
      if (isImage(item.clip)) {
        const image = images.find(image => assignedImages.get(image) === item.clip.id) ?? images.find(image => !activeImages.has(image))!
        assignedImages.set(image, item.clip.id)
        const src = host.assetUrl(item.clip.source.assetVersionId)
        if (image.getAttribute('src') !== src) image.src = src
        activeImages.set(image, item)
      } else {
        const free = videos.findIndex(video => !activeVideos.has(video) && !visible.some(item => assigned.get(video) === item.clip.id))
        const element = prepareVideo(item.clip, free < 0 ? videos.findIndex(video => !activeVideos.has(video)) : free)
        activeVideos.set(element, item)
      }
    }
    if (next && !isImage(next) && activeVideos.size < videos.length) {
      const spare = videos.findIndex(video => !activeVideos.has(video))
      const pending = prepareVideo(next, spare)
      if (!activeVideos.has(pending)) {
        pending.pause()
        alignMedia(videoSounds.find(entry => entry.element === pending)!, next, next.startMs)
      }
    }
    for (const entry of videoSounds) {
      const item = activeVideos.get(entry.element as HTMLVideoElement)
      entry.element.style.visibility = item ? 'visible' : 'hidden'
      entry.element.style.opacity = String(item?.opacity ?? 0)
      entry.element.style.mixBlendMode = item?.blend ? 'plus-lighter' : 'normal'
      if (item && videoTrack) playMedia(entry, item.clip, videoTrack, position, clock as AudioClock, force)
      else entry.element.pause()
    }
    if (next && isImage(next) && activeImages.size < images.length) {
      const image = images.find(image => !activeImages.has(image))!
      assignedImages.set(image, next.id)
      const src = host.assetUrl(next.source.assetVersionId)
      if (image.getAttribute('src') !== src) image.src = src
    }
    for (const image of images) {
      const item = activeImages.get(image)
      image.style.visibility = item ? 'visible' : 'hidden'
      image.style.opacity = String(item?.opacity ?? 0)
      image.style.mixBlendMode = item?.blend ? 'plus-lighter' : 'normal'
    }
    const sounding = upcomingClips(draft.doc, position).filter(({ track }) => isAudioTrack(track))
    const keep = new Set(sounding.map(({ clip }) => clip.id))
    for (const [id, entry] of audio) {
      if (!keep.has(id)) { releaseMedia(entry); audio.delete(id) }
    }
    for (const { track, clip } of sounding) {
      let entry = audio.get(clip.id)
      if (!entry) {
        entry = { element: document.createElement('audio') }
        entry.element.preload = 'auto'
        listenMedia(entry)
        audio.set(clip.id, entry)
      }
      const src = host.assetUrl(clip.source.assetVersionId)
      if (entry.element.getAttribute('src') !== src) {
        entry.element.src = src
        entry.element.load()
        entry.signature = undefined
        entry.alignment = undefined
      }
      playMedia(entry, clip, track, position, clock as AudioClock, force)
    }
    const unavailable = [...activeVideos.keys()].some(video => !!video.error) || [...activeImages.keys()].some(image => image.complete && !image.naturalWidth) ||
      sounding.some(({ clip }) => clip.startMs <= position && !!audio.get(clip.id)?.element.error)
    const waiting = !unavailable && ([...activeVideos.keys()].some(video => video.readyState < 2 || video.seeking) || [...activeImages.keys()].some(image => !image.complete) ||
      sounding.some(({ clip }) => {
        const element = audio.get(clip.id)!.element
        return clip.startMs <= position && (element.readyState < 2 || element.seeking)
      }))
    if (!waiting) {
      loadingSince = undefined
      clearTimeout(loadingTimer)
      loadingTimer = undefined
    } else {
      loadingSince ??= performance.now()
      const remaining = 300 - (performance.now() - loadingSince)
      if (remaining > 0 && loadingTimer === undefined) {
        loadingTimer = setTimeout(() => { loadingTimer = undefined; tick() }, Math.ceil(remaining))
      }
    }
    const state = {
      ...(current ? { clipId: current.id } : {}),
      audioIds: sounding.filter(({ clip }) => clip.startMs <= position).map(({ clip }) => clip.id),
      loading: loadingSince !== undefined && performance.now() - loadingSince >= 300,
      unavailable,
    }
    const key = JSON.stringify(state)
    if (key !== lastState) { lastState = key; onChange(state) }
  }
  videoSounds.forEach(listenMedia)
  imageListeners.push(...images.map(image => listen(image, ['load', 'error'])))
  const unsubscribe = subscribePlaybackFrames(get().clock, clockEvent => tick(clockEvent))
  return {
    update: () => tick(),
    dispose() {
      disposed = true
      clearTimeout(loadingTimer)
      unsubscribe()
      imageListeners.forEach(unlisten => unlisten())
      for (const entry of [...videoSounds, ...audio.values()]) releaseMedia(entry)
      images.forEach(image => image.removeAttribute('src'))
      extraElements.forEach(element => element.remove())
    },
  }
}
