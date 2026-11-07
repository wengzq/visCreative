/** Default titles follow canvas stacking order, counting all nodes of the same kind. */
export function nodeTitleNumber(view: { nodeId: string; kind: string }, nodes: readonly { nodeId: string; kind: string; z: number }[]): number {
  return Math.max(1, nodes.filter(node => node.kind === view.kind).sort((a, b) => a.z - b.z).findIndex(node => node.nodeId === view.nodeId) + 1)
}

export function nodeTitleNumbers(nodes: readonly { nodeId: string; kind: string; z: number }[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>()
  const numbers = new Map<string, number>()
  for (const node of [...nodes].sort((a, b) => a.z - b.z)) {
    const number = (counts.get(node.kind) ?? 0) + 1
    counts.set(node.kind, number)
    numbers.set(node.nodeId, number)
  }
  return numbers
}
