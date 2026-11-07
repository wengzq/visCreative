import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { manuscriptMarkdown, nearbyTables, markdownProtected, visibleMarkdown } from './markdown'

describe('visible manuscript Markdown', () => {
  const body = '# Heading\n\n| Name | Value |\n| :--- | ---: |\n| <b>literal</b> | two \\| three |\n\nAfter'
  it('parses complete nearby table cells as literal text, with escaped pipes and alignment', () => {
    const state = EditorState.create({ doc: body })
    const tables = nearbyTables(state, { from: 0, to: body.length })
    expect(tables).toHaveLength(1)
    expect(tables[0]?.rows.map(row => row.map(cell => cell.text))).toEqual([['Name', 'Value'], ['<b>literal</b>', 'two | three']])
    expect(tables[0]?.align).toEqual(['left', 'right'])
    expect(state.sliceDoc(tables[0]!.from, tables[0]!.to)).toContain('| <b>literal</b> |')
  })
  it('renders a single-column table with optional outer pipes', () => {
    for (const table of ['| Column |\n| --- |\n| Value |', 'Column |\n--- |\nValue |']) {
      const state = EditorState.create({ doc: table })
      expect(nearbyTables(state, { from: 0, to: state.doc.length })[0]?.rows.map(row => row.map(cell => cell.text))).toEqual([['Column'], ['Value']])
    }
  })
  it('creates block fields alongside editable source and accepts protected review and shot ranges', () => {
    let state = EditorState.create({ doc: body, extensions: manuscriptMarkdown('Edit table') })
    const replacements = () => state.facet(EditorView.decorations).flatMap(value => typeof value === 'function' ? [] : [value.size]).reduce((a, b) => a + b, 0)
    expect(replacements()).toBe(1)
    state = state.update({ effects: markdownProtected.of([{ from: body.indexOf('literal'), to: body.indexOf('literal') + 7 }]) }).state
    expect(replacements()).toBe(0)
    state = state.update({ effects: markdownProtected.of([]) }).state
    expect(replacements()).toBe(1)
    state = state.update({ selection: { anchor: body.indexOf('Value') } }).state
    expect(replacements()).toBe(0)
    expect(state.doc.toString()).toBe(body)
    expect(state.selection.main.head).toBe(body.indexOf('Value'))
  })
  it('builds only nearby tables on a 200,000-character document and leaves oversized or fenced tables as source', () => {
    const prefix = 'Paragraph.\n\n'.repeat(16_667)
    const state = EditorState.create({ doc: prefix + body })
    expect(nearbyTables(state, { from: 0, to: 2000 })).toEqual([])
    expect(nearbyTables(state, { from: prefix.length, to: state.doc.length })).toHaveLength(1)
    expect(nearbyTables(state, { from: prefix.length, to: state.doc.length }, [{ from: prefix.length, to: state.doc.length }])).toEqual([])
    const huge = EditorState.create({ doc: '| A | B |\n| --- | --- |\n' + '| x | y |\n'.repeat(300) })
    expect(nearbyTables(huge, { from: 0, to: 2000 })).toEqual([])
  })
})

const decorated = (state: EditorState, from = 0, to = state.doc.length) => visibleMarkdown({ state, visibleRanges: [{ from, to }] })
const replacements = (state: EditorState, from = 0, to = state.doc.length) => {
  const result: { from: number; to: number; text: string; widget: boolean }[] = []
  decorated(state, from, to).between(from, to, (start, end, value) => {
    if (value.spec.class === undefined) result.push({ from: start, to: end, text: state.sliceDoc(start, end), widget: !!value.spec.widget })
  })
  return result
}

describe('cursor-aware manuscript preview', () => {
  const body = '# Heading ##\n**bold** and *italic* and __strong__ and _soft_\n> Quoted **words**\n- Item\n2) Second\nEnd'
  const create = (doc = body) => EditorState.create({ doc, selection: { anchor: doc.length }, extensions: manuscriptMarkdown('Edit table') })
  it('replaces heading, emphasis, quote and list delimiters on inactive lines without editing source', () => {
    const state = create()
    expect(replacements(state).map(range => range.text)).toEqual(['# ', ' ##', '**', '**', '*', '*', '__', '__', '_', '_', '> ', '**', '**', '- ', '2) '])
    expect(replacements(state).filter(range => range.widget).map(range => range.text)).toEqual(['- ', '2) '])
    const classes: string[] = []
    decorated(state).between(0, state.doc.length, (_from, _to, value) => { if (value.spec.class) classes.push(value.spec.class) })
    expect(classes).toEqual(expect.arrayContaining(['vis-writing-h1', 'vis-writing-bold', 'vis-writing-italic', 'vis-writing-quote', 'vis-writing-list']))
    expect(state.doc.toString()).toBe(body)
  })
  it('reveals every selected line and preserves both selection endpoints, including backward selections', () => {
    for (const backwards of [false, true]) {
      let state = create()
      const from = body.indexOf('bold') + 2, to = body.indexOf('Quoted') + 3
      state = state.update({ selection: { anchor: backwards ? to : from, head: backwards ? from : to } }).state
      expect(replacements(state).map(range => range.text)).toEqual(['# ', ' ##', '- ', '2) '])
      expect(state.selection.main.anchor).toBe(backwards ? to : from)
      expect(state.selection.main.head).toBe(backwards ? from : to)
      expect(state.sliceDoc(from, to)).toBe(body.slice(from, to))
      state = state.update({ selection: { anchor: 0 } }).state
      expect(replacements(state).map(range => range.text)).not.toContain('# ')
      expect(replacements(state).map(range => range.text)).toContain('**')
    }
  })
  it('reveals whole lines for review and shot anchors, including after source positions move', () => {
    let state = create()
    const from = body.indexOf('words')
    state = state.update({ effects: markdownProtected.of([{ from, to: from + 5 }]) }).state
    expect(replacements(state).filter(range => range.from >= state.doc.line(3).from && range.to <= state.doc.line(3).to)).toEqual([])
    expect(state.selection.main.head).toBe(body.length)
    state = state.update({ changes: { from: 0, insert: 'Preface\n' } }).state
    const line = state.doc.line(4)
    expect(replacements(state).filter(range => range.from >= line.from && range.to <= line.to)).toEqual([])
    state = state.update({ effects: markdownProtected.of([]) }).state
    expect(replacements(state).filter(range => range.from >= line.from && range.to <= line.to).map(range => range.text)).toEqual(['> ', '**', '**'])
  })
  it('does not reveal the following heading when a protected passage ends at its start', () => {
    let state = create('# First\nPassage\n# Second\nEnd')
    const to = state.doc.line(3).from
    state = state.update({ effects: markdownProtected.of([{ from: 0, to }]) }).state
    expect(replacements(state).map(range => range.from)).toEqual([to])
  })
  it('keeps fenced and indented code, inline code, escapes and intraword underscores literal', () => {
    const source = '```md\n# Code **bold**\n```\n    **indented**\n`**literal**` and \\*escaped* and snake_case_word\nEnd'
    expect(replacements(create(source))).toEqual([])
    expect(replacements(create('``code ` **literal**`` and **bold**\nEnd')).map(range => range.text)).toEqual(['**', '**'])
    expect(replacements(create('`code`**bold** and *italic*`code`\nEnd')).map(range => range.text)).toEqual(['**', '**', '*', '*'])
    expect(replacements(create('**unclosed and * spaced *\nEnd'))).toEqual([])
  })
  it('renders nested and combined emphasis without overlapping replacement ranges', () => {
    const state = create('***both*** and **bold *nested*** and *outer **inner***\nEnd')
    const hidden = replacements(state)
    expect(hidden.map(range => range.text)).toEqual(['***', '***', '**', '*', '***', '*', '**', '***'])
    for (let index = 1; index < hidden.length; index++) expect(hidden[index]!.from).toBeGreaterThanOrEqual(hidden[index - 1]!.to)
  })
  it('reveals setext underline markers when either heading line is selected', () => {
    let state = create('Heading\n=======\nEnd')
    expect(replacements(state).map(range => range.text)).toEqual(['======='])
    for (const anchor of [0, 9]) {
      state = state.update({ selection: { anchor } }).state
      expect(replacements(state)).toEqual([])
      expect(state.selection.main.head).toBe(anchor)
    }
  })
  it('bounds inline parsing even when one physical line spans 200,000 characters', () => {
    const state = create('**word** '.repeat(25_000) + '\nEnd')
    const result = replacements(state, 100_000, 101_000)
    expect(result.length).toBeGreaterThan(0)
    expect(result.length).toBeLessThan(1000)
    expect(decorated(state, 100_000, 101_000).size).toBeLessThan(2000)
  })
  it('limits inline decorations to the viewport on a 200,000-character manuscript', () => {
    const state = create(('# Heading\n**bold** and *italic*\n\n').repeat(7000))
    expect(state.doc.length).toBeGreaterThan(200_000)
    const from = state.doc.line(9000).from, to = state.doc.line(9020).to
    const result = replacements(state, from, to)
    expect(result.length).toBeGreaterThan(0)
    expect(result.length).toBeLessThan(50)
    expect(result.every(range => range.from >= from && range.to <= to)).toBe(true)
  })
})
