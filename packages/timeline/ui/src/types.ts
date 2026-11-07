import type { AssetKind, FontRef, FontView, MediaPreview, MediaTaskView, NodeView, TimelineDoc } from '@vis/protocol'

/**
 * Everything the editor needs from its host (apps/web today, apps/desktop later). timeline-ui never
 * calls RPC itself, so the same editor mounts in either shell.
 */
export type TimelineEditorHost = {
  /** The timeline node, live from the canvas view; its main slot holds the committed document and revision */
  node: NodeView
  /** Live project nodes for the media bin, clip sources and exports of this timeline. Hosts may omit unrelated nodes and retain this array when its members are unchanged. */
  nodes: readonly NodeView[]
  /** The most recent export task of this node, if the host knows one (progress, failure) */
  exportTask?: MediaTaskView | undefined
  assetUrl(assetVersionId: string): string
  /** Host route serving a cached filmstrip JPEG; call preview(id, 'filmstrip') first so it exists */
  filmstripUrl(assetVersionId: string): string
  preview(assetVersionId: string, kind: 'peaks' | 'filmstrip'): Promise<MediaPreview>
  assetInfo(assetVersionId: string): Promise<{ durationMs?: number; width?: number; height?: number; version?: number; kind?: AssetKind; fps?: number }>
  /** canvas.apply timeline.set; 'conflict' on revision_conflict, rejects on any other error */
  commit(doc: TimelineDoc, expectedRevision: number): Promise<'ok' | 'conflict'>
  /** media.process timeline.export of the given committed revision */
  export(expectedRevision: number): Promise<void>
  download(node: NodeView): void
  rename?(title: string): Promise<void>
  /** Close the editor and focus the node on the canvas */
  showOnCanvas(nodeId: string): void
  /** Name of the session that wrote the current revision, when the host can tell; the banner falls back to generic copy */
  lastWriter?(): string | undefined
  /** 0024d: font.list — built-in fonts and the project's font assets (D2) */
  listFonts?(): Promise<FontView[]>
  /** 0024d: URL of a font file for FontFace in the preview, the same file export uses (D2) */
  fontUrl?(font: FontRef): string
  uploadFont?(): Promise<FontView | undefined>
  /** Opens the existing upload flow; absent hides the media bin's Upload button */
  upload?(): void
  onClose(): void
}

/**
 * Playback position shared by the timeline (playhead, ruler) and the preview player. Readers poll now()
 * from requestAnimationFrame; subscribe only fires on play / pause / seek / end, never per frame.
 */
export type PlaybackClock = {
  now(): number
  playing(): boolean
  play(): void
  pause(): void
  /** Seeks and, while paused, shows the frame under the playhead without audio (scrubbing) */
  seek(ms: number): void
  subscribe(listener: () => void): () => void
}

export type SaveState = 'saved' | 'saving' | 'unsaved' | 'conflict'

/** The editor's working copy. Edits apply locally at once and are committed in the background (RFC 0024 §2). */
export type TimelineDraft = {
  doc: TimelineDoc
  /** Revision the local document is based on */
  baseRevision: number
  saveState: SaveState
  saveError: unknown
  /** Set while a commit hit revision_conflict; editing stays disabled until loadTheirs() */
  conflict: { theirs: TimelineDoc; revision: number } | null
  /**
   * Replace the document with an edited copy. `immediate` commits now (pointer-up); otherwise after 500 ms idle (typing).
   * Caption linkage is applied first; returns 'captions' when it refuses the edit, so callers show m.captions.
   */
  edit(next: TimelineDoc, opts?: { immediate?: boolean }): 'captions' | undefined
  /** RFC 0024 d.4 caption linkage toggle, on by default, remembered per timeline node in this browser */
  captionLinkage: boolean
  setCaptionLinkage(on: boolean): void
  undo(): void
  redo(): void
  canUndo: boolean
  canRedo: boolean
  loadTheirs(): void
  /** Commit any pending edit now; the shell awaits it before closing */
  flush(): Promise<void>
}

/** Props the shell passes to every editor part; selection holds clip IDs */
export type EditorPartProps = {
  host: TimelineEditorHost
  draft: TimelineDraft
  clock: PlaybackClock
  selection: readonly string[]
  select(clipIds: readonly string[]): void
}
