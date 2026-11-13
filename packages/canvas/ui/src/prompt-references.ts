import { numberReferences, PROMPT_REF_PATTERN, promptRef, type MediaKind, type NodeView, type ReferenceInputs } from '@vis/protocol'

export type PromptReference = { nodeId: string; number: number | undefined; node: NodeView | undefined; durationMs?: number | undefined }
export type PromptPart = { type: 'text'; text: string } | { type: 'reference'; nodeId: string; reference: PromptReference | undefined }

export function numberedReferences(inputIds: readonly string[], nodes: readonly NodeView[]): PromptReference[] {
  const byId = new Map(nodes.map(node => [node.nodeId, node]))
  const numbered = new Map(numberReferences(inputIds.map(nodeId => ({
    nodeId, kind: byId.get(nodeId)?.kind ?? '', hasAsset: byId.get(nodeId)?.slots.some(slot => slot.slotKey === 'main' && slot.content.type === 'asset') ?? false,
  }))).map(reference => [reference.nodeId, reference.number]))
  return [...new Set(inputIds)].map(nodeId => ({ nodeId, number: numbered.get(nodeId), node: byId.get(nodeId) }))
}

export type CanvasReference = {
  reference: PromptReference
  title: string
  limit?: { kind: MediaKind | 'total'; max: number } | undefined
}

/** Missing catalog declarations retain the legacy image/audio attach paths. */
export function canvasReferences(nodeId: string, nodes: readonly NodeView[], references: readonly PromptReference[], title: (node: NodeView) => string, limits?: ReferenceInputs, allKinds = false): CanvasReference[] {
  const attached = new Set(references.map(reference => reference.nodeId))
  const counts = { image: 0, video: 0, audio: 0, total: 0 }
  for (const reference of references) {
    const kind = reference.node?.kind
    if (reference.number !== undefined && (kind === 'image' || kind === 'video' || kind === 'audio')) { counts[kind]++; counts.total++ }
  }
  return nodes.flatMap(node => {
    const kind = node.kind
    if (node.nodeId === nodeId || attached.has(node.nodeId) || (kind !== 'image' && kind !== 'video' && kind !== 'audio') || !node.slots.some(slot => slot.slotKey === 'main' && slot.content.type === 'asset')) return []
    const max = allKinds ? undefined : kind === 'image' ? limits?.image : limits?.[kind]?.max
    if (!allKinds && ((limits && !max) || (!limits && kind === 'video'))) return []
    const limit = max !== undefined && counts[kind] >= max ? { kind, max } : limits?.total !== undefined && counts.total >= limits.total ? { kind: 'total' as const, max: limits.total } : undefined
    return [{ reference: { nodeId: node.nodeId, node, number: undefined }, title: title(node), limit }]
  }).sort((a, b) => b.reference.node!.z - a.reference.node!.z || a.title.localeCompare(b.title) || a.reference.nodeId.localeCompare(b.reference.nodeId))
}

export function filterReferenceChoices(references: readonly PromptReference[], canvas: readonly CanvasReference[], query: string, title: (node: NodeView) => string) {
  const search = query.toLowerCase()
  const matches = canvas.filter(candidate => candidate.title.toLowerCase().includes(search))
  return {
    attached: references.filter(reference => reference.node && reference.number !== undefined && title(reference.node).toLowerCase().includes(search)),
    canvas: matches.slice(0, 50),
    hasMore: matches.length > 50,
  }
}

export function promptMention(text: string, selection: PromptSelection) {
  if (selection.start !== selection.end) return null
  const match = /@([^@\n{}]*)$/.exec(text.slice(0, selection.start))
  return match ? { start: match.index, end: selection.end, query: match[1]! } : null
}

export async function pickPromptReference(nodeId: string, attached: boolean, attach: (nodeId: string) => Promise<void>, insert: () => void) {
  if (!attached) await attach(nodeId)
  insert()
}

export function promptParts(text: string, references: readonly PromptReference[]): PromptPart[] {
  const byId = new Map(references.filter(reference => reference.number !== undefined).map(reference => [reference.nodeId, reference]))
  const parts: PromptPart[] = []
  let offset = 0
  for (const match of text.matchAll(PROMPT_REF_PATTERN)) {
    if (match.index > offset) parts.push({ type: 'text', text: text.slice(offset, match.index) })
    parts.push({ type: 'reference', nodeId: match[1]!, reference: byId.get(match[1]!) })
    offset = match.index + match[0].length
  }
  if (offset < text.length) parts.push({ type: 'text', text: text.slice(offset) })
  return parts
}

export function promptText(parts: readonly PromptPart[]): string {
  return parts.map(part => part.type === 'text' ? part.text : promptRef(part.nodeId)).join('')
}

export function hasBrokenReferences(text: string, references: readonly PromptReference[]): boolean {
  return promptParts(text, references).some(part => part.type === 'reference' && !part.reference?.node)
}

export type PromptSelection = { start: number; end: number }
export type PromptSnapshot = PromptSelection & { text: string }

// Keep marker insertion and composition in the same history as ordinary edits.
export class PromptHistory {
  private entries: PromptSnapshot[]
  private index = 0
  constructor(initial: PromptSnapshot) { this.entries = [initial] }
  select(selection: PromptSelection) {
    this.entries[this.index] = { ...this.entries[this.index]!, ...selection }
  }
  record(snapshot: PromptSnapshot) {
    if (snapshot.text === this.entries[this.index]!.text) { this.select(snapshot); return }
    this.entries.splice(this.index + 1)
    this.entries.push(snapshot)
    this.index++
  }
  undo() { if (this.index > 0) return this.entries[--this.index] }
  redo() { if (this.index + 1 < this.entries.length) return this.entries[++this.index] }
}
