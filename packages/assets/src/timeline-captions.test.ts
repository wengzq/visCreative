import { describe, expect, it } from 'vitest'
import { BUILTIN_FONTS, BUILTIN_FONT_FAMILIES, TEXT_PRESETS, type TextClip, type TextPreset, type TimelineDoc } from '@vis/protocol'
import { planCaptions, type CaptionFonts } from './timeline-captions'
import { renderTimeline } from './timeline-render'

const fonts: CaptionFonts = new Map(BUILTIN_FONTS.map(id => [`builtin:${id}`, { family: BUILTIN_FONT_FAMILIES[id], path: `/fonts/${id}.ttf` }]))
const clip = (patch: Partial<TextClip> = {}): TextClip => ({ id: 'caption', startMs: 1230, durationMs: 2000, text: 'First\nSecond', style: { preset: 'subtitle' }, fadeInMs: 200, fadeOutMs: 300, ...patch })
const doc = (...clips: TextClip[]): TimelineDoc => ({ version: 1, tracks: [], textTracks: [{ id: 'text', hidden: false, clips }] })
const compile = (document: TimelineDoc, height = 1080, available = fonts) => planCaptions(document, { width: 1920, height }, available)!
const style = (script: string) => script.split('\n').find(line => line.startsWith('Style: '))!.split(',')

describe('ASS caption compilation', () => {
  it('sets output geometry and explicit wrapping, escapes user text and writes fades and centisecond times', () => {
    const plan = compile(doc(clip({ text: '{hello}\\N\\h\nSecond' })))
    expect(plan.ass).toContain('PlayResX: 1920\nPlayResY: 1080\nWrapStyle: 2\nScaledBorderAndShadow: yes')
    expect(plan.ass).toContain('Dialogue: 0,0:00:01.23,0:00:03.23,Text0,,0,0,0,,{\\fad(200,300)}\\{hello\\}\\\u2060N\\\u2060h\\NSecond')
    expect(plan.fonts).toEqual([{ name: 'font-0.ttf', path: '/fonts/noto-sans-sc.ttf' }])
  })
  it.each(Object.keys(TEXT_PRESETS) as TextPreset[])('uses shared %s preset numbers', preset => {
    const values = style(compile(doc(clip({ style: { preset } })), 1000).ass)
    const p = TEXT_PRESETS[preset]
    expect(values[1]).toBe(BUILTIN_FONT_FAMILIES[p.font])
    expect(Number(values[2])).toBe(p.sizePct * 10)
    expect(Number(values[16])).toBeCloseTo(p.sizePct * 10 * p.outlineEm, 4)
    expect(Number(values[17])).toBeCloseTo(p.sizePct * 10 * p.shadowEm, 4)
    expect(Number(values[18])).toBe(p.position === 'middle' ? 5 : 2)
    expect(Number(values[21])).toBe(p.marginPct * 10)
    expect(values[6]?.slice(2, 4)).toBe(Math.round((1 - p.shadowOpacity) * 255).toString(16).padStart(2, '0').toUpperCase())
  })
  it('scales size, outline, shadow and margins with height', () => {
    const full = style(compile(doc(clip({ style: { preset: 'variety' } }))).ass)
    const half = style(compile(doc(clip({ style: { preset: 'variety' } })), 540).ass)
    for (const i of [2, 16, 17, 21]) expect(Number(full[i])).toBeCloseTo(Number(half[i]) * 2, 3)
  })
  it('supports uploaded font and overrides while deduplicating resolved styles and font copies', () => {
    const available = new Map(fonts).set('asset:uploaded', { path: '/project/fontblob', family: 'Project Font' })
    const c = clip({ style: { preset: 'cinema', font: { assetVersionId: 'uploaded' }, sizePct: 10, color: '#123456', position: 'top' } })
    const plan = compile(doc(c, { ...c, id: 'other', startMs: 4000 }), 1000, available)
    expect(plan.ass.match(/^Style: /gm)).toHaveLength(1)
    const values = style(plan.ass)
    expect(values[1]).toBe('Project Font')
    expect(values[2]).toBe('100')
    expect(values[3]).toBe('&H00563412')
    expect(values[18]).toBe('8')
    expect(plan.fonts).toHaveLength(1)
  })
  it('omits hidden tracks and places a second visible track above the first', () => {
    const document = doc(clip())
    document.textTracks!.push({ id: 'above', hidden: false, clips: [clip({ id: 'upper' })] })
    expect(compile(document).ass).toContain('Dialogue: 1,')
    document.textTracks![0]!.hidden = true
    expect(compile(document).ass.match(/Dialogue: /g)).toHaveLength(1)
    document.textTracks![1]!.hidden = true
    expect(planCaptions(document, { width: 1920, height: 1080 }, fonts)).toBeUndefined()
  })
  it('fails when the resolved font map lacks a used font', () => {
    expect(() => compile(doc(clip()), 1080, new Map())).toThrow(expect.objectContaining({ details: expect.objectContaining({ reason: 'timeline.font_missing' }) }))
  })
  it('reports an unavailable caption filter before probing or rendering', async () => {
    await expect(renderTimeline(doc(clip()), new Map(), { encoder: { name: 'none', args: [], hardware: false }, ffmpegPath: process.execPath }))
      .rejects.toMatchObject({ code: 'unavailable', details: { reason: 'media.captions_unavailable' } })
  })
})
