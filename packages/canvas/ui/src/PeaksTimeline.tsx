import { useEffect, useState, type ReactNode } from 'react'
import { PeaksWaveform, useMessages } from '@vis/ui-kit'
import { loadAudioPeaks, type AudioPeaks, type PreviewLoader } from './peaks'
import { mediaTime } from './VideoPlayer'
import { mediaMessages } from './messages'
import { pixelToTime, timeToPercent } from './mediaTimeline'
import './media-panels.css'

export function useAudioPeaks(assetVersionId: string, preview?: PreviewLoader | undefined, enabled = true): AudioPeaks | undefined {
  const [loaded, setLoaded] = useState<{ id: string; value: AudioPeaks | undefined }>()
  useEffect(() => {
    let active = true
    if (enabled && preview) void loadAudioPeaks(assetVersionId, preview).then(value => { if (active) setLoaded({ id: assetVersionId, value }) })
    return () => { active = false }
  }, [assetVersionId, preview, enabled])
  return enabled && loaded?.id === assetVersionId ? loaded.value : undefined
}

export function PeaksTimeline({ peaks, timeMs, durationMs, onSeek, onPick, label, children, disabled = false }: {
  peaks: AudioPeaks | undefined
  timeMs: number
  durationMs: number
  onSeek?(timeMs: number): void
  onPick?(timeMs: number): void
  label?: string
  children?: ReactNode
  disabled?: boolean
}) {
  const m = useMessages(mediaMessages)
  return <div className="vis-media-waveform">
    {peaks?.peaks.length ? <PeaksWaveform className="vis-audio-waveform" peaks={peaks.peaks} binsPerSecond={peaks.binsPerSecond} fromMs={0} toMs={peaks.durationMs} color="var(--vis-text-dim)" height={48} />
      : <svg className="vis-audio-waveform" viewBox="0 0 320 48" preserveAspectRatio="none" aria-hidden="true"><line x1="0" x2="320" y1="24" y2="24" /></svg>}
    {onSeek ? <input className="vis-media-waveform-seek" aria-label={label ?? m.audioProgress} aria-valuetext={mediaTime(timeMs / 1000)} type="range" min="0" max={durationMs || 1} step="1" value={Math.min(timeMs, durationMs)} disabled={disabled || !durationMs}
      onChange={event => onSeek(Number(event.target.value))}
      onPointerDown={event => {
        if (disabled || !durationMs) return
        event.stopPropagation()
        event.currentTarget.setPointerCapture(event.pointerId)
        const rect = event.currentTarget.getBoundingClientRect()
        const time = pixelToTime(event.clientX, rect.left, rect.width, durationMs)
        if (onPick) onPick(time)
        else onSeek(time)
      }}
      onPointerMove={event => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
        const rect = event.currentTarget.getBoundingClientRect()
        onSeek(pixelToTime(event.clientX, rect.left, rect.width, durationMs))
      }} /> : null}
    <span className="vis-media-playhead" style={{ left: `${timeToPercent(timeMs, durationMs)}%` }} aria-hidden="true" />
    {children}
  </div>
}
