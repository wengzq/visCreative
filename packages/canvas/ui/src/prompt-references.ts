import { numberReferences, PROMPT_REF_PATTERN, promptRef, type NodeView } from '@vis/protocol'

export type PromptReference = { nodeId: string; number: number | undefined; node: NodeView | undefined }
export type PromptPart = { type: 'text'; text: string } | { type: 'reference'; nodeId: string; reference: PromptReference | undefined }

export function numberedReferences(inputIds: readonly string[], nodes: readonly NodeView[]): PromptReference[] {
  const byId = new Map(nodes.map(node => [node.nodeId, node]))
  const numbered = new Map(numberReferences(inputIds.map(nodeId => ({
    nodeId, kind: byId.get(nodeId)?.kind ?? '', hasAsset: byId.get(nodeId)?.slots.some(slot => slot.slotKey === 'main' && slot.content.type === 'asset') ?? false,
  }))).map(reference => [reference.nodeId, reference.number]))
  return [...new Set(inputIds)].map(nodeId => ({ nodeId, number: numbered.get(nodeId), node: byId.get(nodeId) }))
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
