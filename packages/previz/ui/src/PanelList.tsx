import type { PrevizPanel } from '@vis/protocol'
import { useFormat, useMessages } from '@vis/ui-kit'
import { previzMessages } from './messages'

const PANEL_DRAG = 'application/x-vis-previz-panel'
export function PanelList({ panels, selected, disabled, busy, url, select, add, remove, move, importFiles, openMenu }: {
  panels: readonly PrevizPanel[]; selected: string | null; disabled: boolean; busy: boolean
  url(id: string): string; select(id: string): void; add(): void; remove(id: string): void
  move(id: string, index: number): void; importFiles(files: File[], target?: string): void; openMenu(id: string, x: number, y: number): void
}) {
  const m = useMessages(previzMessages)
  const f = useFormat()
  return <aside className="vis-pv-panels" aria-label={m.panels} onDragOver={event => { if (!disabled && event.dataTransfer.types.includes('Files')) event.preventDefault() }}
    onDrop={event => { if (event.dataTransfer.files.length) { event.preventDefault(); event.stopPropagation(); importFiles([...event.dataTransfer.files]) } }}>
    <header><strong>{m.panels}</strong><button aria-label={m.add} disabled={disabled || busy} onClick={add}><ActionIcon kind="add" /></button></header>
    <ol>{panels.map((panel, index) => <li key={panel.id} aria-current={panel.id === selected} draggable={!disabled && !busy}
      onContextMenu={event => { event.preventDefault(); openMenu(panel.id, event.clientX, event.clientY) }}
      onDragStart={event => { event.dataTransfer.setData(PANEL_DRAG, panel.id); event.dataTransfer.effectAllowed = 'move' }}
      onDragOver={event => { if (!disabled && (event.dataTransfer.types.includes(PANEL_DRAG) || event.dataTransfer.types.includes('Files'))) event.preventDefault() }}
      onDrop={event => {
        if (disabled) return
        event.preventDefault(); event.stopPropagation()
        const id = event.dataTransfer.getData(PANEL_DRAG)
        if (id) move(id, index)
        else if (event.dataTransfer.files.length) importFiles([...event.dataTransfer.files], panel.id)
      }}>
      <button className="vis-pv-panel" aria-label={m.panel(f.number(index + 1))} aria-pressed={panel.id === selected} disabled={busy} onClick={() => select(panel.id)}>
        {panel.image ?? panel.blockout ? <img src={url((panel.image ?? panel.blockout)!)} alt="" draggable={false} /> : <span className="vis-pv-panel-blank" />}
        <span>{m.panel(f.number(index + 1))}</span>{panel.note ? <small>{panel.note}</small> : null}
      </button>
      <div className="vis-pv-panel-actions"><button aria-label={m.up} disabled={disabled || busy || !index} onClick={() => move(panel.id, index - 1)}><ActionIcon kind="up" /></button>
        <button aria-label={m.down} disabled={disabled || busy || index === panels.length - 1} onClick={() => move(panel.id, index + 1)}><ActionIcon kind="down" /></button>
        <button aria-label={m.remove} disabled={disabled || busy} onClick={() => remove(panel.id)}><ActionIcon kind="remove" /></button></div>
    </li>)}</ol>
  </aside>
}

function ActionIcon({ kind }: { kind: 'add' | 'up' | 'down' | 'remove' }) {
  const paths = { add: 'M12 5v14M5 12h14', up: 'm6 14 6-6 6 6', down: 'm6 10 6 6 6-6', remove: 'm7 7 10 10M7 17 17 7' }
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[kind]} /></svg>
}
