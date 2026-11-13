import { useEffect, useRef, useState } from 'react'
import { useMessages } from '@vis/ui-kit'
import { Icon } from './Icon'
import { isEditing, mediaTime } from './VideoPlayer'
import { PeaksTimeline, useAudioPeaks } from './PeaksTimeline'
import type { PreviewLoader } from './peaks'
import { durationMs } from './mediaTimeline'
import { trackMedia } from './mediaPlayback'
import { mediaMessages } from './messages'
import './audio-player.css'

let playingAudio: HTMLAudioElement | null = null

export function AudioPlayer({ assetId, src, selected = false, onMetadata, onPreview }: { assetId: string; src: string; selected?: boolean; onMetadata?(duration: number): void; onPreview?: PreviewLoader | undefined }) {
  const m = useMessages(mediaMessages)
  const audio = useRef<HTMLAudioElement>(null)
  const peaks = useAudioPeaks(assetId, onPreview)
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [error, setError] = useState(false)
  const toggle = () => {
    const element = audio.current
    if (!element) return
    if (!element.paused) element.pause()
    else void element.play().catch(() => setError(true))
  }
  useEffect(() => audio.current ? trackMedia(src, audio.current) : undefined, [assetId, src])
  useEffect(() => {
    const element = audio.current
    return () => { element?.pause(); if (playingAudio === element) playingAudio = null }
  }, [src])
  useEffect(() => {
    if (!selected) return
    const key = (event: KeyboardEvent) => {
      if (document.querySelector('.vis-lightbox') && !audio.current?.closest('.vis-lightbox')) return
      if (event.code !== 'Space' || event.repeat || event.altKey || event.metaKey || event.ctrlKey || isEditing(event.target) || (event.target instanceof HTMLElement && event.target.closest('button, a'))) return
      event.preventDefault()
      toggle()
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [selected])
  return <div className="vis-audio-player" onDoubleClick={event => event.stopPropagation()}>
    <audio ref={audio} src={src} preload="metadata" onLoadedMetadata={event => { setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0); setTime(0); setError(false); onMetadata?.(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0) }} onTimeUpdate={event => setTime(event.currentTarget.currentTime)} onPlay={event => {
      if (playingAudio !== event.currentTarget) playingAudio?.pause()
      playingAudio = event.currentTarget
      setPlaying(true)
      setError(false)
    }} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} onError={() => setError(true)} />
    {/* Only the seek strip and play button keep the pointer; the rest of the player stays a drag surface for its node */}
    <div className="nodrag nopan">
      <PeaksTimeline peaks={peaks} timeMs={durationMs(time)} durationMs={durationMs(duration)} onSeek={value => {
        if (audio.current) { audio.current.currentTime = value / 1000; setTime(audio.current.currentTime) }
      }} />
    </div>
    <div className="vis-audio-controls vis-media-times">
      <span>{mediaTime(time)}</span>
      <button className="nodrag nopan" aria-label={playing ? m.pause : m.play} onClick={toggle}><Icon kind={playing ? 'pause' : 'play'} size={18} /></button>
      <span>{mediaTime(duration)}</span>
    </div>
    {error ? <span role="status">{m.cannotPlayAudio}</span> : null}
  </div>
}
