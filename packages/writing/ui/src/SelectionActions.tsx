import { useEffect, useMemo, useRef, useState } from 'react'
import type { EditorView } from '@codemirror/view'
import { useMessages } from '@vis/ui-kit'
import { selectionGeometry, selectionPanelPosition, useEditorMeasure, type PanelPosition, type SelectionRange } from './geometry'
import { writingMessages } from './messages'

export type WritingAction = 'rewrite' | 'continue' | 'expand' | 'ask' | 'shots' | 'extract'

export function SelectionActions({ editor, selection, hasSession, sending, action }: { editor: EditorView | null; selection: SelectionRange; hasSession: boolean; sending: boolean; action(action: WritingAction, selection: SelectionRange): void }) {
  const m = useMessages(writingMessages)
  const bar = useRef<HTMLDivElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const moreButton = useRef<HTMLButtonElement>(null)
  const [more, setMore] = useState(false)
  const [position, setPosition] = useState<{ bar: PanelPosition; menu?: PanelPosition | undefined; revision: unknown } | null>(null)
  const revision = useMemo(() => ({ selection, more, m, hasSession }), [selection, more, m, hasSession])
  useEditorMeasure(editor, revision, view => {
    const geometry = selectionGeometry(view, selection)
    const size = bar.current?.getBoundingClientRect()
    if (!geometry || !size) return null
    const placed = selectionPanelPosition(size, geometry)
    const menuSize = menu.current?.getBoundingClientRect()
    const barRect = { ...placed, right: placed.left + size.width, bottom: placed.top + size.height }
    const menuPosition = menuSize ? selectionPanelPosition(menuSize, geometry, [barRect], [
      { left: placed.left, top: barRect.bottom + 6, side: 'below' },
    ]) : undefined
    return { bar: placed, menu: menuPosition, revision }
  }, next => setPosition(previous => previous?.revision === next?.revision && JSON.stringify(previous?.bar) === JSON.stringify(next?.bar) && JSON.stringify(previous?.menu) === JSON.stringify(next?.menu) ? previous : next))
  useEffect(() => setMore(false), [selection])
  useEffect(() => {
    if (!more) return
    const dismiss = (event: PointerEvent) => { if (!bar.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) setMore(false) }
    document.addEventListener('pointerdown', dismiss)
    return () => document.removeEventListener('pointerdown', dismiss)
  }, [more])
  useEffect(() => {
    if (more && position?.menu && !menu.current?.contains(document.activeElement)) menu.current?.querySelector<HTMLButtonElement>('button')?.focus()
  }, [more, position?.menu])
  const placed = position?.revision === revision ? position : null
  const choose = (name: WritingAction) => { setMore(false); action(name, selection) }
  return <>
    <div ref={bar} className="vis-writing-selection" role="toolbar" aria-label={m.selectionActions} style={{ left: placed?.bar.left ?? 0, top: placed?.bar.top ?? 0, visibility: placed ? 'visible' : 'hidden' }}>
      {hasSession ? <>
        {(['rewrite', 'continue', 'expand', 'ask'] as const).map(name => <button key={name} disabled={sending} onMouseDown={event => event.preventDefault()} onClick={() => choose(name)}>{m[name]}</button>)}
        <button ref={moreButton} aria-expanded={more} aria-haspopup="menu" disabled={sending} onMouseDown={event => event.preventDefault()} onClick={() => setMore(!more)} onKeyDown={event => { if (event.key === 'ArrowDown') { event.preventDefault(); setMore(true) } }}>{m.moreActions}<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg></button>
      </> : <span>{m.noSession}</span>}
    </div>
    {more && <div ref={menu} role="menu" aria-label={m.moreActions} className="vis-writing-selection-menu" style={{ left: placed?.menu?.left ?? 0, top: placed?.menu?.top ?? 0, visibility: placed?.menu ? 'visible' : 'hidden' }} onKeyDown={event => {
      if (event.key === 'Escape') { event.stopPropagation(); event.preventDefault(); setMore(false); moreButton.current?.focus() }
      if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
        event.preventDefault()
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')]
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
        buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus()
      }
    }}>
      {(['shots', 'extract'] as const).map(name => <button key={name} role="menuitem" onMouseDown={event => event.preventDefault()} onClick={() => choose(name)}>{m[name]}</button>)}
    </div>}
  </>
}
