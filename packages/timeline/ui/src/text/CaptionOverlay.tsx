import type { EditorPartProps } from '../types'
import { useEffect, useRef } from 'react'
import { TEXT_PRESETS, fontKey, textClipEndMs, visibleTextTracks } from '@vis/protocol'
import { subscribePlaybackFrames } from '../player'
import { captionFamily, loadCaptionFont } from './fonts'
import './text.css'

/**
 * HTML text drawn over the output frame at the playhead, styled from TEXT_PRESETS like the export.
 * Clicking a text selects its clip. 0024d seam: D2 implements.
 */
export function CaptionOverlay({ host, draft, clock, selection, select }: EditorPartProps) {
  const root = useRef<HTMLDivElement>(null)
  const elements = useRef(new Map<string, HTMLButtonElement>())
  const clips = visibleTextTracks(draft.doc).flatMap(track => track.clips)
  useEffect(() => {
    const container = root.current!
    let active = true
    const layout = () => {
      if (!active) return
      const height = container.clientHeight
      for (const clip of clips) {
        const element = elements.current.get(clip.id)
        if (!element) continue
        const preset = TEXT_PRESETS[clip.style.preset]
        const size = (clip.style.sizePct ?? preset.sizePct) * height / 100
        const position = clip.style.position ?? preset.position
        const shadow = preset.shadowColor
        const rgb = [1, 3, 5].map(offset => parseInt(shadow.slice(offset, offset + 2), 16)).join(',')
        Object.assign(element.style, {
          fontFamily: `"${captionFamily(clip.style.font ?? { builtin: preset.font })}"`,
          fontSize: `${size}px`,
          color: clip.style.color ?? preset.color,
          WebkitTextStroke: `${size * preset.outlineEm * 2}px ${preset.outlineColor}`,
          paintOrder: 'stroke fill',
          textShadow: preset.shadowOpacity ? `${size * preset.shadowEm}px ${size * preset.shadowEm}px 0 rgba(${rgb},${preset.shadowOpacity})` : 'none',
          top: position === 'middle' ? '50%' : position === 'top' ? `${preset.marginPct}%` : 'auto',
          bottom: position === 'bottom' ? `${preset.marginPct}%` : 'auto',
          transform: position === 'middle' ? 'translate(-50%, -50%)' : 'translateX(-50%)',
        })
      }
    }
    const update = () => {
      if (!active) return
      const now = clock.now()
      for (const clip of clips) {
        const element = elements.current.get(clip.id)
        if (!element) continue
        const visible = now >= clip.startMs && now < textClipEndMs(clip)
        const display = visible ? 'block' : 'none'
        if (element.style.display !== display) element.style.display = display
        if (visible) element.style.opacity = String(Math.max(0, Math.min(1, clip.fadeInMs ? (now - clip.startMs) / clip.fadeInMs : 1, clip.fadeOutMs ? (textClipEndMs(clip) - now) / clip.fadeOutMs : 1)))
      }
    }
    const resize = new ResizeObserver(layout)
    resize.observe(container)
    const stop = subscribePlaybackFrames(clock, update)
    layout()
    update()
    const fonts = new Map(clips.map(clip => {
      const font = clip.style.font ?? { builtin: TEXT_PRESETS[clip.style.preset].font }
      return [fontKey(font), font] as const
    }))
    for (const font of fonts.values()) void loadCaptionFont(host, font).then(layout).catch(() => {})
    return () => { active = false; resize.disconnect(); stop() }
  }, [draft.doc, host, clock])
  return <div ref={root} className="vis-tl-captions">{clips.map(clip => <button key={clip.id} ref={element => { if (element) elements.current.set(clip.id, element); else elements.current.delete(clip.id) }} type="button" data-caption-id={clip.id} aria-selected={selection.includes(clip.id)}
    className="vis-tl-caption" onClick={() => select([clip.id])}>{clip.text}</button>)}</div>
}
