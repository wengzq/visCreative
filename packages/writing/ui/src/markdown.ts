import { StateEffect, StateField, type EditorState, type Text } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view'

type Range = { from: number; to: number }
export const markdownProtected = StateEffect.define<Range[]>()
const protectedSource = StateField.define<Range[]>({
  create: () => [],
  update(ranges, transaction) {
    for (const effect of transaction.effects) if (effect.is(markdownProtected)) return effect.value
    return transaction.docChanged ? ranges.map(range => ({ from: transaction.changes.mapPos(range.from), to: transaction.changes.mapPos(range.to) })) : ranges
  },
})
const overlaps = (a: Range, b: Range) => a.from <= b.to && b.from <= a.to

function fences(doc: Text): Range[] {
  const ranges: Range[] = []
  let open: { from: number; marker: string } | null = null
  let from = 0
  for (const line of doc.iterLines()) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (marker) {
      if (!open) open = { from, marker }
      else if (marker[0] === open.marker[0] && marker.length >= open.marker.length && /^ {0,3}(?:`+|~+)\s*$/.test(line)) {
        ranges.push({ from: open.from, to: from + line.length })
        open = null
      }
    }
    from += line.length + 1
  }
  if (open) ranges.push({ from: open.from, to: doc.length })
  return ranges
}

const codeFences = StateField.define<Range[]>({
  create: state => fences(state.doc),
  update(ranges, transaction) {
    if (!transaction.docChanged) return ranges
    let changedFence = false
    transaction.changes.iterChanges((from, to, _newFrom, _newTo, inserted) => {
      if (/[`~\n]/.test(inserted.toString()) || /[`~\n]/.test(transaction.startState.sliceDoc(from, to))) changedFence = true
    })
    return changedFence ? fences(transaction.state.doc) : ranges.map(range => ({ from: transaction.changes.mapPos(range.from), to: transaction.changes.mapPos(range.to) }))
  },
})

type Emphasis = Range & { size: number }
const escaped = (text: string, at: number) => {
  let slashes = 0
  while (at > 0 && text[--at] === '\\') slashes++
  return slashes % 2 === 1
}

function inlineMarkdown(text: string): { literals: Range[]; emphasis: Emphasis[] } {
  const literals: Range[] = [], emphasis: Emphasis[] = []
  const ticks = [...text.matchAll(/`+/g)]
  for (let index = 0; index < ticks.length; index++) {
    const start = ticks[index]!
    if (escaped(text, start.index)) continue
    const end = ticks.findIndex((tick, next) => next > index && tick[0].length === start[0].length)
    if (end < 0) continue
    literals.push({ from: start.index, to: ticks[end]!.index + start[0].length })
    index = end
  }
  const stack: { from: number; size: number; marker: string; canClose: boolean }[] = []
  for (const token of text.matchAll(/\*+|_+/g)) {
    const from = token.index, marker = token[0][0]!
    if (escaped(text, from) || literals.some(range => range.from < from + token[0].length && from < range.to)) continue
    const before = text[from - 1] ?? ' ', after = text[from + token[0].length] ?? ' '
    const leftSpace = /\s/.test(before), rightSpace = /\s/.test(after)
    const leftPunct = /[\p{P}\p{S}]/u.test(before), rightPunct = /[\p{P}\p{S}]/u.test(after)
    const left = !rightSpace && (!rightPunct || leftSpace || leftPunct)
    const right = !leftSpace && (!leftPunct || rightSpace || rightPunct)
    const canOpen = left && (marker !== '_' || !right || leftPunct)
    const canClose = right && (marker !== '_' || !left || rightPunct)
    let remaining = token[0].length, consumed = 0
    if (canClose) while (remaining) {
      const index = stack.findLastIndex(open => open.marker === marker)
      if (index < 0) break
      const open = stack[index]!
      // Ambiguous runs that can both open and close follow Markdown's rule of three.
      if ((canOpen || open.canClose) && (open.size + remaining) % 3 === 0 && (open.size % 3 !== 0 || remaining % 3 !== 0)) break
      const size = Math.min(open.size, remaining) >= 2 ? 2 : 1
      emphasis.push({ from: open.from + open.size - size, to: from + consumed + size, size })
      open.size -= size; remaining -= size; consumed += size
      stack.splice(index + 1)
      if (!open.size) stack.splice(index, 1)
    }
    if (canOpen && remaining) stack.push({ from: from + consumed, size: remaining, marker, canClose })
  }
  return { literals, emphasis }
}

class ListMarker extends WidgetType {
  constructor(readonly text: string) { super() }
  eq(other: ListMarker) { return this.text === other.text }
  toDOM() {
    const marker = document.createElement('span')
    marker.className = 'vis-writing-list-marker'
    marker.setAttribute('aria-hidden', 'true')
    marker.textContent = this.text
    return marker
  }
  ignoreEvent() { return false }
}

/** Only rendered lines are decorated; source coordinates and selections always stay intact. */
export function visibleMarkdown(view: Pick<EditorView, 'state' | 'visibleRanges'>): DecorationSet {
  const ranges = []
  const seen = new Set<number>()
  const { state } = view
  const code = state.field(codeFences), protectedRanges = state.field(protectedSource)
  const source = (range: Range) => state.selection.ranges.some(selection => overlaps(selection, range)) || protectedRanges.some(protectedRange => protectedRange.from <= range.to && protectedRange.to > range.from)
  for (const visible of view.visibleRanges) {
    for (let number = state.doc.lineAt(visible.from).number; number <= state.doc.lineAt(visible.to).number; number++) {
      const line = state.doc.line(number)
      if (seen.has(number) || code.some(range => overlaps(range, line))) continue
      seen.add(number)
      const hidden: Range[] = []
      const reveal = source(line)
      const hide = (from: number, to: number) => { if (!reveal && to > from) hidden.push({ from, to }) }
      const quote = /^( {0,3}(?:>[ \t]?)+)/.exec(line.text)
      const prefix = quote?.[0].length ?? 0
      const content = line.text.slice(prefix, prefix + 24_000)
      const heading = /^( {0,3})(#{1,6})[ \t]+/.exec(content)
      const next = number < state.doc.lines ? state.doc.line(number + 1) : null
      const setext = content.trim() && next && /^ {0,3}(=+|-+)\s*$/.exec(next.text)
      if (heading || setext) {
        ranges.push(Decoration.line({ class: `vis-writing-h${heading?.[2]?.length ?? (setext && setext[1]![0] === '=' ? 1 : 2)}` }).range(line.from))
        if (heading) {
          hide(prefix + heading[1]!.length, prefix + heading[0].length)
          const closing = line.length <= 24_000 ? /[ \t]+#+[ \t]*$/.exec(content) : null
          if (closing) hide(prefix + closing.index, line.text.length)
        }
        if (setext && next && !reveal && !source(next)) ranges.push(Decoration.replace({}).range(next.from, next.to))
      }
      if (quote) {
        ranges.push(Decoration.line({ class: 'vis-writing-quote' }).range(line.from))
        hide(0, prefix)
      }
      const list = /^(\s*)([-+*]|\d+[.)])[ \t]+/.exec(content)
      if (list && !heading && !/^ {0,3}(?:[-*_]\s*){3,}$/.test(content)) {
        ranges.push(Decoration.line({ class: 'vis-writing-list' }).range(line.from))
        if (!reveal) ranges.push(Decoration.replace({ widget: new ListMarker(/^\d/.test(list[2]!) ? list[2]!.replace(/\)$/, '.') : '•') }).range(line.from + prefix + list[1]!.length, line.from + prefix + list[0].length))
      }
      if (/^(?: {4}|\t)/.test(content) && !list) continue
      // Very long physical lines use a bounded context around the visible source too.
      const inlineFrom = Math.max(0, visible.from - line.from - 1000)
      const inlineTo = Math.min(line.length, visible.to - line.from + 1000, inlineFrom + 24_000)
      for (const local of inlineMarkdown(line.text.slice(inlineFrom, inlineTo)).emphasis) {
        const span = { ...local, from: local.from + inlineFrom, to: local.to + inlineFrom }
        ranges.push(Decoration.mark({ class: span.size === 2 ? 'vis-writing-bold' : 'vis-writing-italic' }).range(line.from + span.from, line.from + span.to))
        hide(span.from, span.from + span.size)
        hide(span.to - span.size, span.to)
      }
      // Nested emphasis can place adjacent delimiters in the same run.
      const merged: Range[] = []
      for (const range of hidden.sort((a, b) => a.from - b.from)) {
        const previous = merged.at(-1)
        if (previous && range.from <= previous.to) previous.to = Math.max(previous.to, range.to)
        else merged.push({ ...range })
      }
      for (const range of merged) ranges.push(Decoration.replace({}).range(line.from + range.from, line.from + range.to))
    }
  }
  return Decoration.set(ranges, true)
}

const markdownView = ViewPlugin.fromClass(class {
  decorations: DecorationSet
  constructor(view: EditorView) { this.decorations = visibleMarkdown(view) }
  update(update: ViewUpdate) {
    if (update.docChanged || update.selectionSet || update.viewportChanged || update.startState.field(protectedSource) !== update.state.field(protectedSource)) this.decorations = visibleMarkdown(update.view)
  }
}, { decorations: value => value.decorations })

type TableCell = { text: string; from: number }
type TableRow = TableCell[]
export type MarkdownTable = Range & { rows: TableRow[]; align: ('left' | 'right' | 'center')[] }

function cells(text: string, from: number): TableRow {
  const chunks = text.split(/(?<!\\)\|/)
  const result: TableRow = []
  let offset = from
  for (let index = 0; index < chunks.length; index++) {
    const part = chunks[index]!
    if (!(index === 0 && !part.trim()) && !(index === chunks.length - 1 && !part.trim())) result.push({ text: part.trim().replace(/\\\|/g, '|'), from: offset + (part.search(/\S/) < 0 ? 0 : part.search(/\S/)) })
    offset += part.length + 1
  }
  return result
}

/** Discover complete tables only near the viewport, with bounded lookbehind and row count. */
export function nearbyTables(state: EditorState, viewport: Range, code: readonly Range[] = []): MarkdownTable[] {
  const doc = state.doc
  const result: MarkdownTable[] = []
  const first = Math.max(1, doc.lineAt(Math.min(viewport.from, doc.length)).number - 200)
  const last = Math.min(doc.lines, doc.lineAt(Math.min(viewport.to, doc.length)).number + 200)
  const limit = Math.min(doc.length, viewport.to + 24_000)
  for (let number = first; number < last; number++) {
    const header = doc.line(number)
    if (header.to < viewport.from - 24_000 || header.to > limit || !header.text.includes('|') || code.some(range => overlaps(range, header))) continue
    const delimiter = doc.line(number + 1)
    const separators = cells(delimiter.text, delimiter.from)
    if (!separators.length || !separators.every(cell => /^:?-{3,}:?$/.test(cell.text))) continue
    const row = cells(header.text, header.from)
    if (row.length !== separators.length) continue
    const rows = [row]
    let end = number + 2
    while (end <= doc.lines && end - number < 200 && doc.line(end).to <= limit && doc.line(end).text.includes('|') && doc.line(end).text.trim()) {
      const line = doc.line(end)
      const next = cells(line.text, line.from)
      rows.push(Array.from({ length: row.length }, (_, index) => next[index] ?? { text: '', from: line.to }))
      end++
    }
    // An oversized table stays source text rather than presenting a partial table.
    if (end <= doc.lines && doc.line(end).text.includes('|') && doc.line(end).text.trim()) continue
    const table = { from: header.from, to: doc.line(end - 1).to, rows,
      align: separators.map(cell => cell.text.startsWith(':') && cell.text.endsWith(':') ? 'center' as const : cell.text.endsWith(':') ? 'right' as const : 'left' as const) }
    if (overlaps(table, viewport)) result.push(table)
    number = end - 1
  }
  return result
}

class TableWidget extends WidgetType {
  constructor(readonly table: MarkdownTable, readonly label: string) { super() }
  eq(other: TableWidget) { return this.label === other.label && JSON.stringify(this.table) === JSON.stringify(other.table) }
  toDOM(view: EditorView) {
    const box = document.createElement('div')
    box.className = 'vis-writing-table'
    const table = document.createElement('table')
    table.setAttribute('aria-label', this.label)
    table.tabIndex = 0
    const edit = (from: number) => { view.dispatch({ selection: { anchor: from }, scrollIntoView: true }); view.focus() }
    table.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); edit(this.table.rows[0]![0]!.from) } })
    for (const [index, row] of this.table.rows.entries()) {
      const group = index === 0 ? document.createElement('thead') : table.tBodies[0] ?? document.createElement('tbody')
      const tr = document.createElement('tr')
      for (const [column, cell] of row.entries()) {
        const td = document.createElement(index === 0 ? 'th' : 'td')
        td.textContent = cell.text
        td.style.textAlign = this.table.align[column] ?? 'left'
        td.addEventListener('mousedown', event => { event.preventDefault(); edit(cell.from) })
        tr.append(td)
      }
      group.append(tr)
      table.append(group)
    }
    box.append(table)
    return box
  }
  ignoreEvent() { return true }
}

const tableViewport = StateEffect.define<Range>()
type TableState = { viewport: Range; protected: Range[]; decorations: DecorationSet }

/** Block replacements must come from a StateField so CodeMirror can measure their height. */
export function manuscriptMarkdown(tableLabel: string) {
  const build = (state: EditorState, value: Omit<TableState, 'decorations'>): TableState => ({ ...value,
    decorations: Decoration.set(nearbyTables(state, value.viewport, state.field(codeFences)).filter(table =>
      !state.selection.ranges.some(range => overlaps(range, table)) && !value.protected.some(range => overlaps(range, table)))
      .map(table => Decoration.replace({ block: true, widget: new TableWidget(table, tableLabel) }).range(table.from, table.to)), true),
  })
  const tables = StateField.define<TableState>({
    create: state => build(state, { viewport: { from: 0, to: Math.min(6000, state.doc.length) }, protected: [] }),
    update(value, transaction) {
      let viewport = value.viewport, protectedRanges = value.protected
      if (transaction.docChanged) {
        viewport = { from: transaction.changes.mapPos(viewport.from), to: transaction.changes.mapPos(viewport.to) }
        protectedRanges = protectedRanges.map(range => ({ from: transaction.changes.mapPos(range.from), to: transaction.changes.mapPos(range.to) }))
      }
      let refresh = transaction.docChanged || !!transaction.selection
      for (const effect of transaction.effects) {
        if (effect.is(tableViewport)) { viewport = effect.value; refresh = true }
        if (effect.is(markdownProtected)) { protectedRanges = effect.value; refresh = true }
      }
      return refresh ? build(transaction.state, { viewport, protected: protectedRanges }) : value
    },
    provide: field => EditorView.decorations.from(field, value => value.decorations),
  })
  const viewport = ViewPlugin.fromClass(class {
    scheduled = false
    destroyed = false
    constructor(view: EditorView) { this.schedule(view) }
    update(update: ViewUpdate) { if (update.viewportChanged || update.geometryChanged) this.schedule(update.view) }
    schedule(view: EditorView) {
      if (this.scheduled) return
      this.scheduled = true
      queueMicrotask(() => {
        this.scheduled = false
        if (this.destroyed) return
        const before = view.state.field(tables).viewport
        if (view.viewport.from >= before.from && view.viewport.to <= before.to) return
        view.dispatch({ effects: tableViewport.of({ from: Math.max(0, view.viewport.from - 2000), to: Math.min(view.state.doc.length, view.viewport.to + 2000) }) })
      })
    }
    destroy() { this.destroyed = true }
  })
  return [codeFences, protectedSource, tables, viewport, markdownView]
}
