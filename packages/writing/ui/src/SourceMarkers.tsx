import { useMemo, useState } from 'react'
import type { EditorView } from '@codemirror/view'
import { textEditAnchor } from '@vis/protocol'
import { useFormat, useMessages } from '@vis/ui-kit'
import { useEditorMeasure } from './geometry'
import { writingMessages } from './messages'
import type { PassageShot } from './sources'

type MarkerLine = { top: number; left: number; indices: number[] }

export function SourceMarkers({ editor, body, shots, open }: { editor: EditorView | null; body: string; shots: readonly PassageShot[]; open(shot: PassageShot): void }) {
  const m = useMessages(writingMessages)
  const f = useFormat()
  const anchors = useMemo(() => shots.map(shot => textEditAnchor(body, { find: shot.quote })), [body, shots])
  const [lines, setLines] = useState<MarkerLine[]>([])
  useEditorMeasure(editor, anchors, view => {
    const main = view.dom.closest('.vis-writing-main')!.getBoundingClientRect()
    const column = view.contentDOM.getBoundingClientRect()
    const viewport = view.scrollDOM.getBoundingClientRect()
    const groups = new Map<number, MarkerLine>()
    for (const [index, anchor] of anchors.entries()) {
      if (!anchor || anchor.from > view.state.doc.length) continue
      const coords = view.coordsAtPos(anchor.from)
      if (!coords) continue
      const center = (coords.top + coords.bottom) / 2
      if (center < viewport.top + 11 || center > viewport.bottom - 11) continue
      const key = Math.round(coords.top * 2)
      const line = groups.get(key) ?? { top: center - main.top - 11, left: column.left - main.left - 30, indices: [] }
      line.indices.push(index)
      groups.set(key, line)
    }
    return [...groups.values()]
  }, next => setLines(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next))
  return <div className="vis-writing-source-gutter" role="region" aria-label={m.linkedPassages}>
    {lines.map(line => {
      const linked = line.indices.flatMap(index => shots[index] && anchors[index] ? [shots[index]!] : [])
      if (!linked.length) return null
      const label = `${m.linkedShots(f.number(linked.length))}: ${linked.map(shot => shot.label).join('; ')}`
      return <div key={linked.map(shot => `${shot.scriptNodeId}/${shot.shotId}`).join('/')} className="vis-writing-marker-line" style={{ left: line.left, top: line.top }}>
        <button className="vis-writing-shot-marker" aria-label={label} onMouseDown={event => event.preventDefault()} onClick={() => open(linked[0]!)}>
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="3" y="4" width="14" height="12" rx="2" /><path d="M7 4v12M13 4v12M3 8h4m-4 4h4m6-4h4m-4 4h4" /></svg>
          {linked.length > 1 && <span>{f.number(linked.length)}</span>}
        </button>
        <div className="vis-writing-marker-links" role="group" aria-label={m.linkedPassages}>
          {linked.map(shot => <button key={`${shot.scriptNodeId}/${shot.shotId}`} onMouseDown={event => event.preventDefault()} onClick={() => open(shot)}>{shot.label}</button>)}
        </div>
      </div>
    })}
  </div>
}
