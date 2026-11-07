import { isDeepStrictEqual } from 'node:util'
import { VisError } from '@vis/domain'
import { EMPTY_PREVIZ, type CanvasOp, type NodeView, type PrevizDoc } from '@vis/protocol'

/** Evaluate the whole batch so a preceding write cannot hide a protected picture. */
export function assertAgentPrevizWrites(nodes: readonly NodeView[], ops: readonly CanvasOp[]): void {
  const docs = new Map<string, PrevizDoc>()
  const slots = new Map<string, string>()
  for (const node of nodes) for (const slot of node.slots) if (slot.content.type === 'previz') {
    docs.set(node.nodeId, slot.content.doc)
    slots.set(slot.slotId, node.nodeId)
  }
  const refuse = () => { throw VisError.of('forbidden', 'previz.drawing_protected', {}, 'Agents cannot change or remove existing previz pictures') }
  for (const op of ops) {
    if (op.op === 'node.create' && op.kind === 'previz') {
      docs.set(op.tempId, EMPTY_PREVIZ)
      slots.set(`${op.tempId}:main`, op.tempId)
    }
    if (op.op === 'node.delete' && docs.get(op.nodeId)?.panels.some(panel => panel.underlay || panel.sketch || panel.image)) refuse()
    if (op.op !== 'previz.set') continue
    const nodeId = slots.get(op.slotId)
    const previous = nodeId && docs.get(nodeId)
    if (!previous) continue
    const next = new Map(op.doc.panels.map(panel => [panel.id, panel]))
    for (const panel of previous.panels) for (const key of ['underlay', 'sketch', 'image'] as const) {
      if (panel[key] && next.get(panel.id)?.[key] !== panel[key]) refuse()
    }
    // panel.blockout decides what later generation follows, so only the user's Use blockout frames action sets it.
    const before = new Map(previous.panels.map(panel => [panel.id, panel]))
    if (op.doc.panels.some(panel => panel.blockout !== (before.get(panel.id)?.blockout ?? null))) {
      throw VisError.of('forbidden', 'previz.blockout_user_only', {}, 'Only the user can set panel.blockout, with Use blockout frames on the previz card')
    }
    const panelIds = new Set([...before.keys(), ...next.keys()])
    if ([...panelIds].some(id => !isDeepStrictEqual(before.get(id)?.sceneRef ?? null, next.get(id)?.sceneRef ?? null))) {
      throw VisError.of('forbidden', 'previz.scene_ref_user_only', {}, 'Only the user can change a panel scene reference')
    }
    docs.set(nodeId, op.doc)
  }
}
