import type { NodeView, PrevizDoc, PrevizPanel } from '@vis/protocol'

export function newestBlockout(nodes: readonly NodeView[], previzNodeId: string) {
  return nodes.filter(node => node.kind === 'video' && node.inputs?.includes(previzNodeId) && (!node.shot || node.shot.role === 'previz')
    && node.slots.some(slot => slot.slotKey === 'main' && slot.content.type === 'asset'))
    .sort((a, b) => a.nodeId.slice(5, 15).localeCompare(b.nodeId.slice(5, 15))).at(-1)
}

/** A blockout often spans several shots and a node holds one shot link, so shots come from the panels of the previz it renders. */
export function shotBlockouts(nodes: readonly NodeView[], scriptNodeId: string): ReadonlyMap<string, NodeView> {
  const blockouts = new Map<string, NodeView>()
  for (const node of nodes) {
    const content = node.slots.find(slot => slot.slotKey === 'main')?.content
    if (content?.type !== 'previz') continue
    const blockout = newestBlockout(nodes, node.nodeId)
    if (!blockout) continue
    for (const panel of content.doc.panels) if (panel.shot?.scriptNodeId === scriptNodeId) blockouts.set(panel.shot.shotId, blockout)
  }
  return blockouts
}

export function previzScripts(nodes: readonly NodeView[]) {
  return nodes.flatMap(node => {
    const slot = node.slots.find(slot => slot.slotKey === 'main')
    return slot?.content.type === 'script' ? [{ node, slot, doc: slot.content.doc }] : []
  })
}
export function panelShot(panel: PrevizPanel, scripts: ReturnType<typeof previzScripts>) {
  const script = scripts.find(script => script.node.nodeId === panel.shot?.scriptNodeId)
  const index = script?.doc.shots.findIndex(shot => shot.id === panel.shot?.shotId) ?? -1
  return script && index >= 0 ? { script, index, shot: script.doc.shots[index]! } : null
}

export function orderedPanelLinks(doc: PrevizDoc, script: ReturnType<typeof previzScripts>[number], replace: boolean): PrevizDoc {
  return { ...doc, panels: doc.panels.map((panel, index) => {
    if (panel.shot && !replace) return panel
    const shot = script.doc.shots[index]
    return { ...panel, rev: panel.rev + 1, shot: shot ? { scriptNodeId: script.node.nodeId, shotId: shot.id } : null }
  }) }
}

