import { useEffect, useRef } from 'react'
import type { EditorView } from '@codemirror/view'

export type Rect = { left: number; right: number; top: number; bottom: number }
export type SelectionRange = { from: number; to: number; text: string }
export type SelectionGeometry = { rects: Rect[]; protected: Rect[]; viewport: Rect; column: Rect }
export type PanelPosition = { left: number; top: number; side: 'above' | 'below' | 'outside' }

/** Keep all geometry reads in CodeMirror's measurement phase, including after scrolling or font loading. */
export function useEditorMeasure<T>(editor: EditorView | null, revision: unknown, read: (editor: EditorView) => T, write: (value: T) => void) {
  const callbacks = useRef({ read, write })
  callbacks.current = { read, write }
  useEffect(() => {
    if (!editor) return
    let active = true
    const key = {}
    const measure = () => editor.requestMeasure({ key, read: view => callbacks.current.read(view), write: value => { if (active) callbacks.current.write(value) } })
    const resize = new ResizeObserver(measure)
    resize.observe(editor.dom)
    resize.observe(editor.contentDOM)
    editor.scrollDOM.addEventListener('scroll', measure, { passive: true })
    window.addEventListener('resize', measure)
    document.fonts.addEventListener('loadingdone', measure)
    measure()
    return () => {
      active = false
      resize.disconnect()
      editor.scrollDOM.removeEventListener('scroll', measure)
      window.removeEventListener('resize', measure)
      document.fonts.removeEventListener('loadingdone', measure)
    }
  }, [editor, revision])
}

export function intersects(a: Rect, b: Rect) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
}

export function selectionGeometry(editor: EditorView, selection: SelectionRange): SelectionGeometry | null {
  if (selection.to > editor.state.doc.length) return null
  const viewport = editor.scrollDOM.getBoundingClientRect()
  const column = editor.contentDOM.getBoundingClientRect()
  const from = editor.domAtPos(selection.from)
  const to = editor.domAtPos(selection.to)
  const range = document.createRange()
  range.setStart(from.node, from.offset)
  range.setEnd(to.node, to.offset)
  const rects = [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0 && intersects(rect, viewport))
  if (!rects.length) return null
  const protectedRects: Rect[] = [...rects]
  const start = editor.coordsAtPos(selection.from)
  const line = editor.state.doc.lineAt(selection.from)
  const lineStart = editor.coordsAtPos(line.from)
  if (start && (line.number > 1 || (lineStart && start.top > lineStart.top + 1))) {
    const style = getComputedStyle(editor.contentDOM)
    protectedRects.push({ left: column.left + parseFloat(style.paddingLeft), right: column.right - parseFloat(style.paddingRight), top: start.top - editor.defaultLineHeight, bottom: start.bottom - editor.defaultLineHeight })
  }
  const next = line.number < editor.state.doc.lines ? editor.state.doc.line(line.number + 1).text : ''
  if (/^ {0,3}#{1,6}\s/.test(line.text) || /^ {0,3}(?:=+|-+)\s*$/.test(line.text) || /^ {0,3}(?:=+|-+)\s*$/.test(next)) {
    const element = from.node.nodeType === Node.ELEMENT_NODE ? from.node as Element : from.node.parentElement
    const heading = element?.closest('.cm-line')
    if (heading) protectedRects.push(heading.getBoundingClientRect())
  }
  return { rects, protected: protectedRects, viewport, column }
}

/** Prefer the selection's top edge, but leave the preceding line and the current heading readable. */
export function selectionPanelPosition(size: { width: number; height: number }, geometry: SelectionGeometry, extra: Rect[] = [], preferred: PanelPosition[] = []): PanelPosition {
  const gap = 8
  const { viewport, column } = geometry
  const top = Math.min(...geometry.protected.map(rect => rect.top))
  const bottom = Math.max(...geometry.protected.map(rect => rect.bottom))
  const first = geometry.rects[0]!
  const left = Math.max(viewport.left + gap, Math.min((first.left + first.right - size.width) / 2, viewport.right - size.width - gap))
  const candidates: PanelPosition[] = [...preferred,
    { left, top: top - size.height - gap, side: 'above' },
    { left, top: bottom + gap, side: 'below' },
    { left: column.left - size.width - gap, top: Math.max(viewport.top + gap, Math.min(top, viewport.bottom - size.height - gap)), side: 'outside' },
    { left: column.right + gap, top: Math.max(viewport.top + gap, Math.min(top, viewport.bottom - size.height - gap)), side: 'outside' },
  ]
  const protectedRects = [...geometry.protected, ...extra]
  for (const candidate of candidates) {
    const rect = { ...candidate, right: candidate.left + size.width, bottom: candidate.top + size.height }
    if (rect.left >= viewport.left + gap && rect.right <= viewport.right - gap && rect.top >= viewport.top + gap && rect.bottom <= viewport.bottom - gap && !protectedRects.some(other => intersects(rect, other))) return candidate
  }
  // A selection can fill the reading viewport. The header remains outside its text and heading rectangles.
  return { left: Math.max(gap, Math.min(left, window.innerWidth - size.width - gap)), top: Math.max(gap, viewport.top - size.height - gap), side: 'outside' }
}
