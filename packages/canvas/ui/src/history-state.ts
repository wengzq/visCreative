import type { NodeView, SlotVersionView } from '@vis/protocol'

export type CanvasHistorySource = {
  subscribe(listener: () => void): () => void
  getSnapshot(): { nodes: ReadonlyMap<string, NodeView>; histories: ReadonlyMap<string, SlotVersionView[]> }
}

export function historySelection(source: CanvasHistorySource | undefined, view: NodeView | undefined, slotId: string, fallback: SlotVersionView[] | undefined) {
  let returned = fallback
  return () => {
    const snapshot = source?.getSnapshot()
    // A newer external node version must wait for the matching React props.
    if (snapshot && view && snapshot.nodes.get(view.nodeId) === view) returned = snapshot.histories.get(slotId)
    return returned
  }
}
