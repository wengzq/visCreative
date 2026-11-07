import { PlayIcon, useMessages } from '@vis/ui-kit'
import { useEffect, useReducer, useRef, useState } from 'react'
import './video-player.css'
import { Icon } from './Icon'
import { mediaMessages } from './messages'
import type { SlotView } from '@vis/protocol'
import { mediaPanelMessages } from './media-messages'
import { trackMedia } from './mediaPlayback'
import { initialVideoLifecycle, POSTER_WAIT_DELAY, shouldReleaseVideo, videoLifecycle, VIDEO_IDLE_DELAY } from './video-lifecycle'
import './media-panels.css'

// Media timecodes and playback rates are technical values and use no digit grouping.
export const mediaTime = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`
export const isEditing = (target: EventTarget | null) => target instanceof HTMLElement && Boolean(target.closest('input, textarea, select, [contenteditable="true"], .vis-tl-editor'))

export function VideoPlayer({ src, posterSrc, source, hasAlpha = false, compact = false, selected = false, previewWithinPlayer = false, onMetadata, onLoadedData }: { src: string; posterSrc?: string; hasAlpha?: boolean | undefined; source?: SlotView['source']; compact?: boolean; selected?: boolean; previewWithinPlayer?: boolean; onLoadedData?(): void; onMetadata?(width: number, height: number, duration: number): void }) {
  const m = useMessages(mediaMessages)
  const panelMessages = useMessages(mediaPanelMessages)
  const video = useRef<HTMLVideoElement>(null)
  const root = useRef<HTMLDivElement>(null)
  const [lifecycle, dispatch] = useReducer(videoLifecycle, undefined, () => initialVideoLifecycle(Boolean(posterSrc), selected))
  const mounted = !compact || lifecycle.active
  const releaseWhenIdle = shouldReleaseVideo(lifecycle)
  const visible = useRef(lifecycle.visible)
  visible.current = lifecycle.visible
  const [fullscreen, setFullscreen] = useState(false)
  useEffect(() => {
    const element = video.current
    if (!element) return
    const untrack = trackMedia(src, element)
    return () => { element.pause(); untrack() }
  }, [src, mounted])
  useEffect(() => {
    const changed = () => setFullscreen(document.fullscreenElement === root.current)
    document.addEventListener('fullscreenchange', changed)
    return () => document.removeEventListener('fullscreenchange', changed)
  }, [])
  const playing = lifecycle.playing
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [buffered, setBuffered] = useState(0)
  const [muted, setMuted] = useState(compact)
  const [volume, setVolume] = useState(1)
  const [rate, setRate] = useState(1)
  const [loop, setLoop] = useState(true)
  const [awake, setAwake] = useState(true)
  const [hover, setHover] = useState<number | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const wake = () => {
    setAwake(true)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setAwake(false), 2000)
  }
  const play = async (v = video.current) => {
    if (!v) return
    try { await v.play() } catch {
      if (video.current !== v || (compact && !visible.current)) return
      v.muted = true
      setMuted(true)
      try { await v.play() } catch {
        if (video.current === v && (!compact || visible.current)) dispatch({ type: 'pause' })
      }
    }
  }
  const toggle = () => {
    const v = video.current
    if (v && !v.paused) { v.pause(); dispatch({ type: 'pause' }) }
    else if (compact) dispatch({ type: 'play' })
    else void play()
  }
  const seek = (value: number) => {
    const next = Math.max(0, Math.min(duration, value))
    if (video.current) video.current.currentTime = next
    setTime(next)
    wake()
  }
  useEffect(() => { dispatch({ type: 'reset', poster: Boolean(posterSrc), selected }) }, [src, posterSrc, compact])
  useEffect(() => { dispatch({ type: 'select', value: selected }) }, [selected])
  useEffect(() => {
    if (!compact || !posterSrc) return
    // Lives outside the render so the request survives the <img> unmounting when a frame arrives.
    const image = new Image()
    image.onload = () => dispatch({ type: 'poster' })
    image.onerror = () => dispatch({ type: 'fallback' })
    image.src = posterSrc
    return () => { image.onload = image.onerror = null }
  }, [compact, posterSrc])
  const waitingForPoster = compact && Boolean(posterSrc) && lifecycle.visible && !lifecycle.active && !lifecycle.posterReady && !lifecycle.fallback
  useEffect(() => {
    if (!waitingForPoster) return
    const slow = setTimeout(() => dispatch({ type: 'posterSlow' }), POSTER_WAIT_DELAY)
    return () => clearTimeout(slow)
  }, [waitingForPoster])
  useEffect(() => {
    if (!compact || !root.current) return
    const node = previewWithinPlayer ? root.current : root.current.closest<HTMLElement>('.react-flow__node') ?? root.current
    const enter = () => dispatch({ type: 'hover', value: true })
    const leave = () => dispatch({ type: 'hover', value: false })
    const focus = () => dispatch({ type: 'focus', value: true })
    const blur = (event: FocusEvent) => {
      if (!(event.relatedTarget instanceof Node) || !node.contains(event.relatedTarget)) dispatch({ type: 'focus', value: false })
    }
    node.addEventListener('pointerenter', enter)
    node.addEventListener('pointerleave', leave)
    node.addEventListener('focusin', focus)
    node.addEventListener('focusout', blur)
    if (node.matches(':hover')) enter()
    if (node.contains(document.activeElement)) focus()
    return () => {
      node.removeEventListener('pointerenter', enter)
      node.removeEventListener('pointerleave', leave)
      node.removeEventListener('focusin', focus)
      node.removeEventListener('focusout', blur)
    }
  }, [compact, src, previewWithinPlayer])
  useEffect(() => {
    if (compact && lifecycle.pendingPlay && mounted) void play()
  }, [compact, lifecycle.pendingPlay, mounted])
  useEffect(() => {
    if (!compact || !releaseWhenIdle) return
    const idle = setTimeout(() => dispatch({ type: 'idle' }), VIDEO_IDLE_DELAY)
    return () => clearTimeout(idle)
  }, [compact, releaseWhenIdle])
  useEffect(() => {
    if (!compact) void play()
    const observer = new IntersectionObserver(entries => {
      if (!compact) return
      const intersecting = entries.some(entry => entry.isIntersecting)
      visible.current = intersecting
      if (!intersecting) video.current?.pause()
      dispatch({ type: 'visibility', value: intersecting })
    })
    if (root.current) observer.observe(root.current)
    return () => { observer.disconnect(); clearTimeout(timer.current) }
  }, [src, compact])
  useEffect(() => {
    if (compact) return
    const key = (event: KeyboardEvent) => {
      if (isEditing(event.target) || (event.key === ' ' && event.target instanceof HTMLElement && event.target.closest('button, a'))) return
      const v = video.current!
      switch (event.key.toLowerCase()) {
        case ' ': toggle(); break
        case ',': v.pause(); seek(v.currentTime - 1 / 30); break
        case '.': v.pause(); seek(v.currentTime + 1 / 30); break
        case 'j': seek(v.currentTime - 5); break
        case 'l': seek(v.currentTime + 5); break
        case 'm': setMuted(!v.muted); break
        default: return
      }
      event.preventDefault()
      event.stopPropagation()
      wake()
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  })
  const progress = <div className="vis-video-progress" onPointerMove={event => {
    const rect = event.currentTarget.getBoundingClientRect()
    setHover(Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)))
  }} onPointerLeave={() => setHover(null)}>
    <span className="vis-video-buffer" style={{ width: `${duration ? buffered / duration * 100 : 0}%` }} />
    <span className="vis-video-elapsed" style={{ width: `${duration ? time / duration * 100 : 0}%` }} />
    <input aria-label={m.videoProgress} title={m.videoProgressHint} type="range" min="0" max={duration || 1} step="0.001" value={time} onChange={e => seek(Number(e.target.value))} />
    {!compact && hover !== null ? <span className="vis-video-tooltip" style={{ left: `${hover * 100}%` }}>{mediaTime(hover * duration)}</span> : null}
  </div>
  return <div ref={root} className={`vis-video-player${hasAlpha ? ' vis-alpha-media' : ''}${compact ? ' is-compact' : ''}${playing ? ' is-playing' : ''}${awake || !playing ? ' is-awake' : ''}`} onPointerMove={wake}>
    {compact && posterSrc && !lifecycle.fallback && !lifecycle.frameReady ? <img className="vis-video-poster" src={posterSrc} alt="" draggable={false} onLoad={onLoadedData} onError={() => dispatch({ type: 'fallback' })} /> : null}
    {mounted ? <video ref={video} className={compact && !lifecycle.frameReady ? 'is-loading' : undefined} src={src} onLoadedData={() => { dispatch({ type: 'frame' }); onLoadedData?.() }} preload="metadata" playsInline muted={muted} loop={loop} onLoadedMetadata={e => {
      const v = e.currentTarget
      setDuration(Number.isFinite(v.duration) ? v.duration : 0)
      if (compact && time > 0) v.currentTime = Math.min(time, Number.isFinite(v.duration) ? v.duration : time)
      onMetadata?.(v.videoWidth, v.videoHeight, v.duration)
    }} onPlay={() => { dispatch({ type: 'playing', value: true }); wake() }} onPause={() => dispatch({ type: 'playing', value: false })} onEnded={() => dispatch({ type: 'pause' })} onTimeUpdate={e => setTime(e.currentTarget.currentTime)} onVolumeChange={e => { setMuted(e.currentTarget.muted); setVolume(e.currentTarget.volume) }} onProgress={e => {
      const b = e.currentTarget.buffered
      if (b.length) setBuffered(b.end(b.length - 1))
    }} /> : null}
    <div className="vis-video-controls nodrag nopan" onPointerDown={e => e.stopPropagation()} onDoubleClick={e => e.stopPropagation()}>
      <button className="vis-video-play" aria-label={playing ? m.pause : m.play} title={playing ? m.pauseHint : m.playHint} onClick={toggle}>{playing ? <Icon kind="pause" size={16} /> : <PlayIcon />}</button>
      <span className="vis-video-time">{mediaTime(time)}</span>
      {progress}
      <span className="vis-video-time">{mediaTime(duration)}</span>
      <div className="vis-video-volume"><button aria-label={muted ? m.unmute : m.mute} title={m.muteHint} onClick={() => setMuted(!muted)}><Icon kind={muted || volume === 0 ? 'muted' : 'volume'} size={16} /></button><input aria-label={m.volume} title={m.volume} type="range" min="0" max="1" step="0.01" value={muted ? 0 : volume} onChange={e => { if (video.current) video.current.volume = Number(e.target.value); setMuted(false) }} /></div>
      {!compact ? <><button aria-label={m.playbackSpeed} title={m.changePlaybackSpeed} onClick={() => { const next = [0.5, 1, 1.5, 2][([0.5, 1, 1.5, 2].indexOf(rate) + 1) % 4]!; setRate(next); video.current!.playbackRate = next }}>{m.playbackRate(rate)}</button>
        <button aria-label={m.loop} title={m.loop} aria-pressed={loop} onClick={() => setLoop(!loop)}><Icon kind="loop" size={16} /></button></> : null}
      <button aria-label={fullscreen ? m.exitFullscreen : m.fullscreen} title={fullscreen ? m.exitFullscreen : m.fullscreen} onClick={() => { void (document.fullscreenElement ? document.exitFullscreen() : root.current!.requestFullscreen()).catch(() => {}) }}><Icon kind={fullscreen ? 'exitFullscreen' : 'fullscreen'} size={16} /></button>
    </div>
    {source?.jobId ? <span className="vis-video-generated">{panelMessages.aiGenerated}</span> : null}
  </div>
}
