import type { NodeView, PrevizDoc } from '@vis/protocol'

export type PrevizEditorHost = {
  initialPanelId?: string | undefined
  node: NodeView
  nodes: readonly NodeView[]
  assetUrl(id: string): string
  upload(blob: Blob, name: string): Promise<string>
  commit(doc: PrevizDoc, expectedRevision: number): Promise<'ok' | 'conflict'>
  lastWriter?(): string | undefined
  onRender?(): void
  onOpenScene?(sceneNodeId: string, viewId: string, panelId: string): void
  onClose(): void
}

export type PrevizDraftHost = PrevizEditorHost & { prepare(doc: PrevizDoc): Promise<PrevizDoc> }
export type PrevizDraft = {
  doc: PrevizDoc
  baseRevision: number
  saveState: 'saved' | 'saving' | 'unsaved' | 'conflict'
  saveError: unknown
  conflict: { theirs: PrevizDoc; revision: number } | null
  edit(next: PrevizDoc, immediate?: boolean): void
  beginEdit(): void
  undo(): void
  canUndo: boolean
  loadTheirs(): void
  flush(): Promise<boolean>
}
