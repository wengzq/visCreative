import { VisError } from '@vis/domain'
import { extname } from 'node:path'
import { TEXT_PRESETS, fontKey, textClipEndMs, visibleTextTracks, type TimelineDoc } from '@vis/protocol'

/** Files keyed by fontKey(FontRef), with the libass lookup family from readAssFontFamily. */
export type CaptionFonts = ReadonlyMap<string, { path: string; family: string }>

export type CaptionPlan = {
  /** ASS script written as captions.ass in the render directory */
  ass: string
  /** Font files copied into fonts/ in the render directory; libass finds them through fontsdir */
  fonts: { name: string; path: string }[]
}

/**
 * Compile the visible text tracks into one ASS script for the given output size, or undefined when
 * nothing is drawn. Every font a clip uses must be in fonts (timeline.font_missing otherwise).
 */
export function planCaptions(doc: TimelineDoc, output: { width: number; height: number }, fonts: CaptionFonts | undefined): CaptionPlan | undefined {
  const tracks = visibleTextTracks(doc)
  if (!tracks.length) return undefined
  const styles: string[] = []
  const events: string[] = []
  const styleKeys = new Map<string, string>()
  const files = new Map<string, { name: string; path: string }>()
  const number = (value: number) => Number(value.toFixed(4))
  const color = (hex: string, opacity = 1) => `&H${Math.round((1 - opacity) * 255).toString(16).padStart(2, '0')}${hex.slice(5, 7)}${hex.slice(3, 5)}${hex.slice(1, 3)}`.toUpperCase()
  const time = (ms: number) => {
    const cs = Math.round(ms / 10)
    return `${Math.floor(cs / 360000)}:${String(Math.floor(cs / 6000) % 60).padStart(2, '0')}:${String(Math.floor(cs / 100) % 60).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`
  }
  // Like FFmpeg's ASS text encoder, insert a word joiner after literal backslashes.
  // Doubling a backslash still lets libass interpret the second slash in sequences such as \N.
  const escape = (text: string) => text.replace(/\\/g, '\\\u2060').replace(/{/g, '\\{').replace(/}/g, '\\}').replace(/\n/g, '\\N')
  tracks.forEach((track, layer) => {
    for (const clip of track.clips) {
      const preset = TEXT_PRESETS[clip.style.preset]
      const key = fontKey(clip.style.font ?? { builtin: preset.font })
      const font = fonts?.get(key)
      if (!font) throw VisError.of('invalid_params', 'timeline.font_missing', { clipId: clip.id }, 'A caption font is not available in this project')
      if (!files.has(key)) files.set(key, { name: `font-${files.size}${extname(font.path).toLowerCase() === '.otf' ? '.otf' : '.ttf'}`, path: font.path })
      const size = (clip.style.sizePct ?? preset.sizePct) * output.height / 100
      const values = [
        font.family, number(size), color(clip.style.color ?? preset.color), color(clip.style.color ?? preset.color),
        color(preset.outlineColor), color(preset.shadowColor, preset.shadowOpacity),
        0, 0, 0, 0, 100, 100, 0, 0, 1, number(size * preset.outlineEm), number(size * preset.shadowEm),
        { bottom: 2, middle: 5, top: 8 }[clip.style.position ?? preset.position],
        0, 0, Math.round(preset.marginPct * output.height / 100), 1,
      ]
      // Deduplicate the resolved numeric style, independent of optional property order in the document.
      const styleKey = JSON.stringify(values)
      let name = styleKeys.get(styleKey)
      if (!name) {
        name = `Text${styles.length}`
        styleKeys.set(styleKey, name)
        styles.push(`Style: ${name},${values.join(',')}`)
      }
      events.push(`Dialogue: ${layer},${time(clip.startMs)},${time(textClipEndMs(clip))},${name},,0,0,0,,{\\fad(${clip.fadeInMs},${clip.fadeOutMs})}${escape(clip.text)}`)
    }
  })
  return {
    ass: [
      '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${output.width}`, `PlayResY: ${output.height}`,
      'WrapStyle: 2', 'ScaledBorderAndShadow: yes', '',
      '[V4+ Styles]',
      'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
      ...styles, '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text', ...events, '',
    ].join('\n'),
    fonts: [...files.values()],
  }
}
