import type { EditorPartProps } from '../types'
import { useEffect, useState } from 'react'
import { BUILTIN_FONTS, BUILTIN_FONT_FAMILIES, TEXT_PRESETS, fontKey, type FontView, type TextClip, type TextStyle } from '@vis/protocol'
import { useFormat, useMessages } from '@vis/ui-kit'
import { timelineEditorMessages } from '../messages'
import { deleteText, locateText, updateText } from '../model/text'
import { captionFamily, loadCaptionFont } from './fonts'
import './text.css'

/** Shown instead of the clip inspector when the selection is one text clip. 0024d seam: D2 implements. */
export function TextInspector({ host, draft, clipId, select }: EditorPartProps & { clipId: string }) {
  const m = useMessages(timelineEditorMessages)
  const f = useFormat()
  const clip = locateText(draft.doc, clipId)?.clip
  const [fonts, setFonts] = useState<FontView[]>(BUILTIN_FONTS.map(builtin => ({ font: { builtin }, family: BUILTIN_FONT_FAMILIES[builtin], label: BUILTIN_FONT_FAMILIES[builtin] })))
  const [notice, setNotice] = useState('')
  const [wide, setWide] = useState(false)
  const [text, setText] = useState(clip?.text ?? '')
  useEffect(() => setText(clip?.text ?? ''), [clip?.id, clip?.text])
  useEffect(() => {
    let active = true
    void host.listFonts?.().then(list => { if (active) setFonts(list) }).catch(() => { if (active) setNotice(m.fontFailed) })
    return () => { active = false }
  }, [host, m])
  useEffect(() => {
    if (!clip) return
    let active = true
    const preset = TEXT_PRESETS[clip.style.preset]
    const font = clip.style.font ?? { builtin: preset.font }
    void loadCaptionFont(host, font).then(() => {
      if (!active) return
      const context = document.createElement('canvas').getContext('2d')
      if (!context) return
      const frame = document.querySelector('.vis-tl-output-frame')
      const ratio = draft.doc.output ? draft.doc.output.width / draft.doc.output.height : frame ? frame.clientWidth / frame.clientHeight : 16 / 9
      context.font = `${(clip.style.sizePct ?? preset.sizePct) * 10}px "${captionFamily(font)}"`
      setWide(clip.text.split('\n').some(line => context.measureText(line).width > ratio * 1000 * 0.9))
    }).catch(() => { if (active) setNotice(m.fontFailed) })
    return () => { active = false }
  }, [clip, host, draft.doc.output, m])
  if (!clip) return null
  const preset = TEXT_PRESETS[clip.style.preset]
  const font = clip.style.font ?? { builtin: preset.font }
  const apply = (patch: Partial<Omit<TextClip, 'id'>>, immediate = true) => {
    const result = updateText(draft.doc, clip.id, patch)
    if (!result.ok) { setNotice(result.reason === 'overlap' ? m.textOverlap : m[result.reason]); return }
    const refused = draft.edit(result.doc, { immediate })
    setNotice(refused ? m[refused] : '')
  }
  const style = (patch: Partial<TextStyle>) => apply({ style: { ...clip.style, ...patch } })
  const number = (label: string, value: number, min: number, max: number, commit: (value: number) => void) => <label className="vis-tl-field"><span>{label}</span>
    <input aria-label={label} type="number" min={min} max={max} step="any" key={`${clip.id}:${label}:${value}`} defaultValue={value}
      onBlur={event => { const next = Number(event.currentTarget.value); if (Number.isFinite(next) && next >= min && next <= max) commit(next); else setNotice(m.invalid) }}
      onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }} /></label>
  return <aside className="vis-tl-inspector has-selection" aria-label={m.textContent}>
    <fieldset disabled={!!draft.conflict}><legend>{m.textContent}</legend>
      <label className="vis-tl-field"><span>{m.textContent}</span><textarea className="vis-tl-text-input" aria-label={m.textContent} value={text} maxLength={200}
        onChange={event => {
          const value = event.currentTarget.value
          if (value.split('\n').length > 3) { setNotice(m.textHint); return }
          setText(value)
          if (value.trim()) apply({ text: value }, false)
        }} onBlur={() => { if (!text.trim()) { setText(clip.text); setNotice(m.textHint) } }} /></label>
      <p className="vis-tl-text-hint">{m.textHint} {f.number(text.length)}/ {f.number(200)}</p>
      {wide && <p className="vis-tl-text-hint is-warning" role="status">{m.textWide}</p>}
      <label className="vis-tl-field"><span>{m.textPreset}</span><select aria-label={m.textPreset} value={clip.style.preset}
        onChange={event => apply({ style: { preset: event.target.value as TextStyle['preset'] } })}>
        {(['subtitle', 'variety', 'cinema', 'title'] as const).map(id => <option key={id} value={id}>{m[id]}</option>)}</select></label>
      <label className="vis-tl-field"><span>{m.font}</span><select aria-label={m.font} value={fontKey(font)} onChange={event => {
        if (event.target.value === 'upload') {
          void host.uploadFont?.().then(uploaded => {
            if (uploaded) { setFonts(current => [...current.filter(font => fontKey(font.font) !== fontKey(uploaded.font)), uploaded]); style({ font: uploaded.font }) }
          }).catch(() => setNotice(m.fontFailed))
        } else {
          const chosen = fonts.find(font => fontKey(font.font) === event.target.value)
          if (chosen) style({ font: chosen.font })
        }
      }}>
        {fonts.map(item => <option key={fontKey(item.font)} value={fontKey(item.font)}>{'builtin' in item.font ? m[item.font.builtin] : item.label}</option>)}
        {host.uploadFont && <option value="upload">{m.uploadFont}</option>}
      </select></label>
      {host.uploadFont && <p className="vis-tl-text-hint">{m.fontLicense}</p>}
      {number(m.textSize, clip.style.sizePct ?? preset.sizePct, 2, 20, sizePct => style({ sizePct }))}
      <label className="vis-tl-field"><span>{m.textColor}</span><input aria-label={m.textColor} type="color" value={clip.style.color ?? preset.color} onChange={event => style({ color: event.currentTarget.value })} /></label>
      <label className="vis-tl-field"><span>{m.textPosition}</span><select aria-label={m.textPosition} value={clip.style.position ?? preset.position} onChange={event => style({ position: event.target.value as TextStyle['position'] })}>
        {(['bottom', 'middle', 'top'] as const).map(id => <option key={id} value={id}>{m[id]}</option>)}</select></label>
      {number(`${m.fadeIn} (${m.seconds})`, clip.fadeInMs / 1000, 0, Math.min(10, (clip.durationMs - clip.fadeOutMs) / 1000), seconds => apply({ fadeInMs: Math.round(seconds * 1000) }))}
      {number(`${m.fadeOut} (${m.seconds})`, clip.fadeOutMs / 1000, 0, Math.min(10, (clip.durationMs - clip.fadeInMs) / 1000), seconds => apply({ fadeOutMs: Math.round(seconds * 1000) }))}
      <button onClick={() => { draft.edit(deleteText(draft.doc, [clip.id]), { immediate: true }); select([]) }}>{m.deleteClip}</button>
    </fieldset>
    {notice && <p role="alert">{notice}</p>}
  </aside>
}
