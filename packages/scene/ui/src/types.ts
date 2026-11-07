import type { NodeView, SceneDoc, SceneView } from '@vis/protocol'

export type SceneEditorHost = {
  initialViewId?: string
  initialTarget?: { nodeId: string; panelId: string }
  node: NodeView
  nodes: readonly NodeView[]
  assetUrl(id: string): string
  upload(blob: Blob, name: string): Promise<string>
  importModel(file: File): Promise<string>
  listModels(): Promise<{ assetVersionId: string; name: string }[]>
  commit(doc: SceneDoc, expectedRevision: number): Promise<'ok' | 'conflict'>
  // Creates an image node with the scene as its input.
  saveImage(assetVersionId: string, name: string): Promise<void>
  // Writes the frame to panel.blockout and records the panel's sceneRef.
  sendToPanel(target: { nodeId: string; panelId: string }, source: { viewId: string; assetVersionId: string; sceneRev: number }): Promise<void>
  lastWriter?(): string | undefined
  onClose(): void
}

export type SceneDraft = {
  doc: SceneDoc
  baseRevision: number
  // Async output actions must read the committed slot revision after the final flush.
  getSnapshot(): SceneDraft
  saveState: 'saved' | 'saving' | 'unsaved' | 'conflict'
  saveError: unknown
  conflict: { theirs: SceneDoc; revision: number } | null
  edit(next: SceneDoc, immediate?: boolean): void
  beginEdit(): void
  undo(): void
  canUndo: boolean
  loadTheirs(): void
  flush(): Promise<boolean>
}

export type SceneTool = 'translate' | 'rotate' | 'scale'
export type SceneViewportMode = 'orbit' | 'camera'
export type SceneViewportState = {
  selectedId: string | null
  selectedJointId: string | null
  viewId: string | null
  tool: SceneTool
  mode: SceneViewportMode
  dragging: boolean
  status: 'loading' | 'ready' | 'unavailable' | 'error'
  failedModels: number
  softwareRenderer: boolean
  error: unknown
  initialTarget: { nodeId: string; panelId: string } | null
}

/** Local selection/navigation never writes the document. Only viewport gestures call the edit callbacks. */
export type SceneViewportController = {
  getSnapshot(): SceneViewportState
  subscribe(listener: () => void): () => void
  select(id: string | null): void
  selectJoint(id: string | null): void
  setView(id: string | null): void
  setTool(tool: SceneTool): void
  setMode(mode: SceneViewportMode): void
  frameSelection(): void
  readCamera(): SceneView['camera'] | null
  captureView(viewId: string): Promise<Blob>
}
