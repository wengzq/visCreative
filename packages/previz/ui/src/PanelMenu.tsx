import { useMessages } from '@vis/ui-kit'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { previzMessages } from './messages'

export type PanelMenuActions = { insertBefore(): void; insertAfter(): void; duplicate(): void; importImage(): void; moveEarlier(): void; moveLater(): void; remove(): void }

/** Right-click menu for one panel. Fixed so the scrolling panel list cannot clip it. */
export function PanelMenu({ x, y, first, last, disabled, full, actions, onClose }: {
  x: number; y: number; first: boolean; last: boolean; disabled: boolean; full: boolean; actions: PanelMenuActions; onClose(): void
}) {
  const m = useMessages(previzMessages)
  const menu = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: x, top: y })
  useLayoutEffect(() => {
    const { width, height } = menu.current!.getBoundingClientRect()
    setPosition({ left: Math.max(8, Math.min(x, innerWidth - width - 8)), top: Math.max(8, Math.min(y, innerHeight - height - 8)) })
    menu.current!.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  }, [x, y])
  useEffect(() => {
    const close = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node)) onClose() }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [onClose])
  const item = (label: string, action: () => void, off = false) => <button role="menuitem" disabled={disabled || off} onClick={() => { onClose(); action() }}>{label}</button>
  return <div ref={menu} className="vis-pv-menu" role="menu" aria-label={m.panelMenu} style={position} onContextMenu={event => event.preventDefault()}
    onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose() } }}>
    {item(m.insertBefore, actions.insertBefore, full)}{item(m.insertAfter, actions.insertAfter, full)}{item(m.duplicate, actions.duplicate, full)}{item(m.importHere, actions.importImage)}
    <hr />
    {item(m.up, actions.moveEarlier, first)}{item(m.down, actions.moveLater, last)}
    <hr />
    {item(m.remove, actions.remove)}
  </div>
}
