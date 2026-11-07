import type { PrevizDoc } from '@vis/protocol'
import { batchMessages, describeError, useFormat, useLocale, useMessages } from '@vis/ui-kit'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CanvasActions } from './CanvasView'
import { orderedPanelLinks, panelShot, type previzScripts } from './previz'
import { previzMessages } from './previz-messages'
import { ScriptBatchDialog } from './ScriptBatchDialog'

type Scripts = ReturnType<typeof previzScripts>

export function PrevizLinkDialog({ doc, scripts, commit, onClose }: { doc: PrevizDoc; scripts: Scripts; commit(doc: PrevizDoc): Promise<void>; onClose(): void }) {
  const m = useMessages(previzMessages)
  const f = useFormat()
  const { locale } = useLocale()
  const [scriptId, setScriptId] = useState(scripts[0]?.node.nodeId ?? '')
  const [replace, setReplace] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  const script = scripts.find(script => script.node.nodeId === scriptId)
  const preview = script ? orderedPanelLinks(doc, script, replace) : doc
  useEffect(() => { const element = dialog.current; element?.showModal(); return () => element?.close() }, [])
  return createPortal(<dialog ref={dialog} className="vis-dialog vis-previz-link-dialog nodrag nopan" aria-label={m.linkOrder}
    onCancel={event => { event.preventDefault(); event.stopPropagation(); if (!sending) onClose() }} onPointerDown={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
    <header className="vis-dialog-header"><h2>{m.linkOrder}</h2></header><div className="vis-dialog-body">
      <label>{m.script}<select aria-label={m.script} value={scriptId} disabled={sending} onChange={event => setScriptId(event.target.value)}>{scripts.map(script => <option key={script.node.nodeId} value={script.node.nodeId}>{script.node.title ?? m.script}</option>)}</select></label>
      <label><input type="checkbox" aria-label={m.replace} checked={replace} disabled={sending} onChange={event => setReplace(event.target.checked)} />{m.replace}</label>
      <table aria-label={m.linkOrder}><thead><tr><th>{m.strip}</th><th>{m.shot}</th></tr></thead><tbody>{preview.panels.map((panel, index) => {
        const linked = panelShot(panel, scripts)
        return <tr key={panel.id}><td>{m.panel(f.number(index + 1))}</td><td>{linked ? `${m.shotNumber(f.number(linked.index + 1))} · ${linked.shot.description}` : panel.shot ? m.stale : m.unlinked}{doc.panels[index]!.shot && !replace ? ` · ${m.retained}` : ''}</td></tr>
      })}</tbody></table>
      {error ? <p role="alert">{describeError(error, locale)}</p> : null}
    </div><footer className="vis-dialog-footer"><button disabled={sending} onClick={onClose}>{m.cancel}</button><button className="is-primary" disabled={sending || !script} onClick={() => {
      setSending(true); void commit(preview).then(onClose, setError).finally(() => setSending(false))
    }}>{m.confirm}</button></footer>
  </dialog>, document.body)
}

export function PrevizBatchDialog({ doc, scripts, actions, onClose }: { doc: PrevizDoc; scripts: Scripts; actions: CanvasActions; onClose(): void }) {
  const m = useMessages(previzMessages)
  const bm = useMessages(batchMessages)
  const available = scripts.filter(script => doc.panels.some(panel => panel.shot?.scriptNodeId === script.node.nodeId && script.doc.shots.some(shot => shot.id === panel.shot?.shotId)))
  const [scriptId, setScriptId] = useState(available[0]?.node.nodeId ?? '')
  const [media, setMedia] = useState<'frames' | 'video'>('frames')
  const script = available.find(script => script.node.nodeId === scriptId)
  if (!script) return null
  const shotIds = [...new Set(doc.panels.filter(panel => panel.shot?.scriptNodeId === scriptId && script.doc.shots.some(shot => shot.id === panel.shot?.shotId)).map(panel => panel.shot!.shotId))]
  return <ScriptBatchDialog key={`${scriptId}:${media}`} parts={{ view: script.node, slot: script.slot, doc: script.doc, outputs: new Map(), onPatch: async () => {} }} media={media} shotIds={shotIds} actions={actions} onClose={onClose}
    controls={locked => <><label>{m.script}<select aria-label={m.script} disabled={locked} value={scriptId} onChange={event => setScriptId(event.target.value)}>{available.map(script => <option key={script.node.nodeId} value={script.node.nodeId}>{script.node.title ?? m.script}</option>)}</select></label>
      <label>{m.media}<select aria-label={m.media} disabled={locked} value={media} onChange={event => setMedia(event.target.value as 'frames' | 'video')}><option value="frames">{bm.frames}</option><option value="video">{bm.video}</option></select></label></>} />
}
