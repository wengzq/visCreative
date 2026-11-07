import { useFormat, useMessages } from '@vis/ui-kit'
import { useEffect, useRef, useState } from 'react'
import { sceneMessages } from './messages'
import type { SceneEditorHost } from './types'

type Target = { nodeId: string; panelId: string }
export function SendDialog({ host, busy, send, dismiss }: {
  host: SceneEditorHost
  busy: boolean
  send(target: Target): Promise<void>
  dismiss(): void
}) {
  const m = useMessages(sceneMessages)
  const f = useFormat()
  const targets = host.nodes.flatMap(node => {
    const content = node.slots.find(slot => slot.slotKey === 'main')?.content
    return content?.type === 'previz' && content.doc.panels.length ? [{ node, panels: content.doc.panels }] : []
  })
  const [nodeId, setNodeId] = useState(() => targets.find(target => target.node.nodeId === host.initialTarget?.nodeId)?.node.nodeId ?? targets[0]?.node.nodeId ?? '')
  const selected = targets.find(target => target.node.nodeId === nodeId)
  const [panelId, setPanelId] = useState(() => selected?.panels.find(panel => panel.id === host.initialTarget?.panelId)?.id ?? selected?.panels[0]?.id ?? '')
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!root.current?.contains(document.activeElement)) {
      const target = busy ? root.current : root.current?.querySelector<HTMLElement>('select, button:not(:disabled)')
      target?.focus()
    }
  }, [busy])
  const panel = selected?.panels.find(panel => panel.id === panelId)
  return <div className="vis-sc-modal-backdrop">
    <div ref={root} className="vis-sc-send-dialog" role="dialog" aria-modal="true" aria-label={m.sendTo} tabIndex={-1}
      onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!busy) dismiss() }
        if (event.key === 'Tab') {
          event.stopPropagation()
          const controls = [...root.current!.querySelectorAll<HTMLElement>('button:not(:disabled), select:not(:disabled)')]
          if (!controls.length) { event.preventDefault(); return }
          const first = controls[0], last = controls.at(-1)
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
          if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
        }
      }}>
      <h2>{m.sendTo}</h2>
      {targets.length ? <>
        <label className="vis-sc-field">{m.choosePreviz}<select aria-label={m.choosePreviz} disabled={busy} value={nodeId} onChange={event => {
          setNodeId(event.target.value)
          setPanelId(targets.find(target => target.node.nodeId === event.target.value)?.panels[0]?.id ?? '')
        }}>{targets.map(target => <option key={target.node.nodeId} value={target.node.nodeId}>{target.node.title ?? m.previz}</option>)}</select></label>
        <label className="vis-sc-field">{m.choosePanel}<select aria-label={m.choosePanel} disabled={busy} value={panelId} onChange={event => setPanelId(event.target.value)}>
          {selected?.panels.map((panel, index) => <option key={panel.id} value={panel.id}>{m.panelNumber(f.number(index + 1))}{panel.note ? ` · ${panel.note}` : ''}</option>)}
        </select></label>
      </> : <p>{m.noTargets}</p>}
      <div className="vis-sc-button-row"><button disabled={busy} onClick={dismiss}>{m.cancel}</button><button disabled={busy || !panel} onClick={() => void send({ nodeId, panelId })}>{m.send}</button></div>
    </div>
  </div>
}
