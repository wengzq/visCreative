import type { NodeView, PrevizPanel } from '@vis/protocol'
import { useFormat, useMessages } from '@vis/ui-kit'
import { useState } from 'react'
import { previzMessages } from './messages'
import { sceneLink } from './scene-link'

export function SceneViewControl({ panel, nodes, disabled, url, open }: {
  panel: PrevizPanel
  nodes: readonly NodeView[]
  disabled: boolean
  url(id: string): string
  open(sceneNodeId: string, viewId: string, panelId: string): Promise<void>
}) {
  const m = useMessages(previzMessages)
  const f = useFormat()
  const link = sceneLink(panel.sceneRef, nodes)
  const scenes = nodes.flatMap(node => {
    const content = node.slots.find(slot => slot.slotKey === 'main')?.content
    return node.kind === 'scene' && content?.type === 'scene' ? [{ node, doc: content.doc }] : []
  })
  const [sceneId, setSceneId] = useState(link?.scene.nodeId ?? '')
  const [viewId, setViewId] = useState(link?.view.id ?? '')
  const scene = scenes.find(scene => scene.node.nodeId === sceneId)
  const view = scene?.doc.views.find(view => view.id === viewId) ?? scene?.doc.views[0]
  return <section className="vis-pv-scene" aria-label={m.sceneView}>
    {panel.blockout ? <img className="vis-pv-blockout" src={url(panel.blockout)} alt={m.blockout} /> : null}
    {link?.state === 'changed' ? <div className="vis-pv-scene-changed" role="status"><span>{m.sceneChanged} · </span><button disabled={disabled} onClick={() => void open(link.scene.nodeId, link.view.id, panel.id)}>{m.updateScene}</button></div> : null}
    <label>{m.chooseScene}<select aria-label={m.chooseScene} disabled={disabled} value={scene?.node.nodeId ?? ''} onChange={event => { setSceneId(event.target.value); setViewId('') }}>
      <option value="">{m.chooseScene}</option>{scenes.map(({ node }, index) => <option key={node.nodeId} value={node.nodeId}>{node.title ?? m.sceneNumber(f.number(index + 1))}</option>)}
    </select></label>
    <label>{m.chooseView}<select aria-label={m.chooseView} disabled={disabled || !scene?.doc.views.length} value={view?.id ?? ''} onChange={event => setViewId(event.target.value)}>
      {!view ? <option value="">{m.chooseView}</option> : null}{scene?.doc.views.map(view => <option key={view.id} value={view.id}>{view.name}</option>)}
    </select></label>
    <button disabled={disabled || !scene || !view} onClick={() => { if (scene && view) void open(scene.node.nodeId, view.id, panel.id) }}>{m.useSceneView}</button>
  </section>
}
