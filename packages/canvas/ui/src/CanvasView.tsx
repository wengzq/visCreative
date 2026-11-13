import { MovExportDialog } from './MovExportDialog'
import { ChevronRightIcon, CloseIcon, IconButton, describeError, useFormat, useLocale, useMessages } from '@vis/ui-kit'
import { messages } from './messages'
import { nodeWheel } from './wheel'
import { constrainedMoves, growFrames, leaveFrameOps, memberMoveOps, movedFrameBounds } from './frameBounds'
import { arrangeCanvas } from './organization'
import { EmptyShortcuts, ShortcutDialog } from './shortcuts'
import { CodeRender } from './CodeRender'
import { OrganizationPreview } from './OrganizationPreview'
import {
  applyNodeChanges, Background, BackgroundVariant, getNodesBounds, getViewportForBounds, Handle, MiniMap, type NodeChange, type OnNodeDrag, type NodeMouseHandler, type NodeProps,
  NodeResizer, NodeToolbar, Panel, Position, type Viewport,
  ReactFlow, ReactFlowProvider, useNodesInitialized, useReactFlow, useStore,
} from '@xyflow/react'
import type { BatchView, CanvasOp, GenerationOperation, JobView, MediaKind, MediaTaskView, MethodParams, NodeKind, NodeView, SlotView, SlotVersionView } from '@vis/protocol'
import type { ScriptActions, ScriptAgentState } from './script-ui'
import { createContext, Fragment, memo, type CSSProperties, type DependencyList, type DragEvent, type MouseEvent, type ReactNode, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import '@xyflow/react/dist/style.css'
import './canvas.css'
import { AudioPlayer } from './AudioPlayer'
import { Icon } from './Icon'
import { Lightbox, mediaSlot, openPreview } from './Lightbox'
import { isEditing } from './VideoPlayer'
import { useGenerationChoice } from './ModelPicker'
import { PromptPanel } from './PromptPanel'
import type { GenerationChoice } from './params'
import type { OperationRequest } from './operation-panel'
import { isOperationSource } from './generation-provenance'
import { extensionPosition, freePosition, inputEdges, nodeSize, FRAME_COLORS, FRAME_MIN_SIZE, frameMembers, frameMoveOps } from './graph'
import { useNodeVersions, VersionMedia } from './VersionStrip'
import { WRITING_LIMITS, writingWordCount, LocalOperation } from '@vis/protocol'
import { OPERATION_PANELS } from './operations-ui'
import { NodeOperationsToolbar } from './NodeOperationsToolbar'
import { NodeTitle } from './NodeTitle'
import { toolbarMessages } from './toolbar-messages'
import type { ToolbarEntry } from './toolbar'
import { ScriptNodeContent } from './ScriptNode'
import { TimelineNodeContent } from './TimelineNode'
import { canCreateTimeline, timelineReadingOrder } from './timeline-card'
import { timelineMessages } from './timeline-messages'
import { previzMessages } from './previz-messages'
import { PrevizNodeContent } from './PrevizNode'
import { sceneMessages } from './scene-messages'
import './scene-node.css'
import type { ScriptPartProps } from './script-ui'
import { ScriptAgentBar } from './scriptParts'
import { scriptMessages } from './script-messages'
import { PromptRefInput, type PromptRefInputHandle } from './PromptRefInput'
import { ReferenceStrip } from './ReferenceStrip'
import { numberedReferences } from './prompt-references'
import { moveFlowNodes, selectFlowNodes, toFlowNode, type VisNode, type VisNodeData } from './flow-nodes'
import { shallowEqual, useShallowValue, useStableCallback } from './render-state'
import { nodeTitleNumbers } from './node-title'
import { MarkdownBody } from './MarkdownBody'
import { lowTextDetail, markdownOpening, textOverview } from './text-detail'
import { zoomedViewport } from './viewport'
import { frameRunningStates } from './frame-running'
import { historySelection, type CanvasHistorySource } from './history-state'
import type { PreviewLoader } from './peaks'

// Show menu shortcut hints for the current platform
const MOD = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+'

export type Layout = { x: number; y: number; w: number; h: number }
export type TextCommitResult = 'ok' | 'conflict'

// 0023: script node actions are defined in script-ui.ts
export type CanvasActions = ScriptActions & {
  onPreview?: PreviewLoader | undefined
  onOpenPreviz?(nodeId: string, panelId?: string): void
  onOpenScene?(nodeId: string): void
  onPrevizPanel?(request: { nodeId: string; panelId: string; action: 'set_frame' | 'generate'; prompt: string; requestId: string; choice?: GenerationChoice }): Promise<void>
  onPrevizDraft?(nodeId: string, text: string): void
  onPrevizExtract?(nodeId: string, assetVersionId: string, fillDurations?: boolean): Promise<void>
  onOpenWriting?(nodeId: string, quote?: string): void
  onImportWriting?(at: { x: number; y: number }): void
  onCreatePreviz?(at: { x: number; y: number }): Promise<string>
  onCreateScene?(at: { x: number; y: number }): Promise<string>
  onOpenTimeline?(nodeId: string): void
  onCreateTimeline?(at: { x: number; y: number }): Promise<string>
  onCreateTimelineFrom?(nodeIds: string[]): Promise<string>
  onApply?(ops: CanvasOp[], description?: string): Promise<void>
  onRenderCode?(nodeId: string, requestId: string): Promise<{ jobId: string; revision: number }>
  onGetRenderJob?(jobId: string): Promise<JobView>
  onLoadHistory?(slotId: string): Promise<void>
  onRestoreVersion?(slotId: string, assetVersionId: string, expectedRevision: number, version: number): Promise<'ok' | 'conflict'>
  onSaveVersion?(node: NodeView, assetVersionId: string, version: number, at: { x: number; y: number }): Promise<string>
  /** Called when dragging or resizing ends; restore the server position on failure */
  onLayout(nodeId: string, layout: Layout): Promise<void>
  /** All layouts from one drag must be submitted in one canvas.apply. */
  onMove(ops: Extract<CanvasOp, { op: 'node.layout' | 'frame.move' }>[]): Promise<void>
  onDelete(nodeIds: string[]): void
  /** Submit text; return conflict if someone edited first, and display the latest content */
  onTextCommit(slotId: string, body: string, expectedRevision: number): Promise<TextCommitResult>
  /** Double-click on empty space */
  onCreateText(at: { x: number; y: number }): void
  onCreateGenNode(kind: 'image' | 'video' | 'audio', at: { x: number; y: number }): void
  onSetInputs(nodeId: string, inputNodeIds: string[]): Promise<void>
  onSetGeneration?(nodeId: string, generation: NodeView['generation']): Promise<void>
  onExtend(nodeId: string, kind: 'text' | 'image' | 'video' | 'audio', at: { x: number; y: number }): Promise<string>
  onGenerate(nodeId: string, choice?: GenerationChoice): Promise<void>
  onCancelGeneration?(jobId: string): Promise<void>
  onRegenerate?(jobId: string): Promise<void>
  onRegenerateNode?(nodeId: string, jobId: string): Promise<void>
  /** Jobs with unknown results keep querying the original external job rather than resubmitting */
  onRecheck?(jobId: string): Promise<void>
  onClone(nodes: NodeView[], at: { x: number; y: number }): Promise<string[]>
  onExtendReferences(nodeIds: string[], kind: 'image' | 'video' | 'audio', at: { x: number; y: number }): Promise<string>
  onDownload(nodes: NodeView[]): void
  onReference?(nodeIds: string[]): void
  /** Drop local files at a position in canvas coordinates */
  onDropFiles(files: File[], at: { x: number; y: number }): void
  /** Host-defined drag sources resolve through the same canvas coordinate conversion as local files. */
  onDropData?(data: DataTransfer, at: { x: number; y: number }): boolean
  /** Drag data types onDropData handles; other drags (links, text from other pages) keep the browser default. */
  dropDataTypes?: readonly string[]
  /** Selected nodes changed (for references sent to the Agent) */
  onSelectionChange?(nodeIds: string[]): void
  // 0021: node operations. Components call only through the operation catalog and never know the provider
  /** Local processing (media.process); returns the task, and the host pushes progress back to the node via decorations.mediaTask */
  onMediaProcess?(request: MediaProcessRequest, onStarted?: (task: MediaTaskView) => void): Promise<MediaTaskView>
  onResolveAsset?(assetVersionId: string): Promise<import('@vis/protocol').AssetVersionView>
  onMediaCancel?(taskId: string): Promise<MediaTaskView>
  onMediaDismiss?(taskId: string): Promise<MediaTaskView>
  onMediaDownload?(taskId: string): void
  /** Silence detection (media.analyze audio.silence); returns candidate split points */
  onMediaAnalyze?(nodeId: string, slotId: string): Promise<{ durationMs: number; pointsMs: number[] }>
  /** Generation operation (generation.submit with operation); uses the node main slot as input and creates a new node for the result */
  onSubmitOperation?(nodeId: string, request: OperationRequest): Promise<void>
  /** Generation operations declared by configured providers, per media kind; the toolbar shows entries from this */
  generationOperations?: Partial<Record<MediaKind, readonly GenerationOperation[]>>
  /** Import local files and add them as reference inputs of nodeId (the input panel "Upload") */
  onUploadReference?(nodeId: string, files: File[]): Promise<void>
}

/** media.process params without requestId (the host generates it) */
export type MediaProcessRequest = Omit<MethodParams<'media.process'>, 'requestId'>

/** muted: the user cancelled and the server confirmed; this is not an error, so use a neutral color */
export type JobProblem = { jobId: string; message: string; muted?: boolean; recheckable?: boolean }

/** Generation status on a node, computed by the host from job events */
export type NodeDecoration = {
  scriptShot?: { shotId: string; seq: number }
  sceneProposals?: number
  writingEdits?: number
  /** Number of active jobs targeting this node (or placing new results beside it) */
  running: number
  activeJobs?: JobView[]
  /** Finished jobs with problems, retained until the user dismisses them */
  problems: JobProblem[]
  /** Sequence number of the latest delivery event for this node; highlight once when it changes */
  deliveredSeq?: number
  /** 0021: the latest local processing task on this node (queued, running, or an undismissed failure) */
  mediaTask?: MediaTaskView
  /** 0023: the owning session of a script node and whether it is working on it */
  scriptAgent?: ScriptAgentState
  scriptBatches?: readonly BatchView[]
  scriptBatchJobs?: readonly JobView[]
}

export type CanvasViewProps = CanvasActions & {
  /** A mounted editor owns keyboard input while the canvas remains visible underneath. */
  suspended?: boolean
  /** The canvas is mounted but not displayed, so it has no size to fit or center against. */
  hidden?: boolean
  histories?: ReadonlyMap<string, SlotVersionView[]>
  /** An already-published client snapshot avoids broadcasting each history response through React context. */
  historySource?: CanvasHistorySource
  nodes: NodeView[]
  focusRequest?: ({ nodeId: string } | { nodeIds: string[] }) & { seq: number } | undefined
  decorations?: ReadonlyMap<string, NodeDecoration>
  /** Dismiss the failure notice on a node */
  onDismissJobs?(jobIds: string[]): void
  onDismissMediaTask?(taskId: string): void
  /** Accessible asset URL determined by the host (web host or Electron custom protocol) */
  assetUrl(assetVersionId: string): string
  /** Cached video poster URL determined by the host; generated on first request. */
  posterUrl(assetVersionId: string): string
  /** Cached image thumbnail URL; hosts without a cache use the immutable asset URL. */
  thumbnailUrl?(assetVersionId: string): string
}

const MIN_SIZE = 80

type CanvasContext = {
  suspended: boolean
  nodeViews: ReadonlyMap<string, NodeView>
  titleNumbers: ReadonlyMap<string, number>
  decorations: ReadonlyMap<string, NodeDecoration> | undefined
  frameRunning: ReadonlyMap<string, boolean>
  selectNode(id: string): void
  selectedPanel: { nodeId: string; panelId: string } | null
  selectPanel(nodeId: string, panelId: string | null): void
  assetUrl(id: string): string
  posterUrl(id: string): string
  thumbnailUrl(id: string): string
  actions: CanvasActions
  scriptSessions: CanvasActions['scriptSessions']
  currentScriptSessionId: CanvasActions['currentScriptSessionId']
  generationOperations: CanvasActions['generationOperations']
  nodes: NodeView[]
  allNodes: NodeView[]
  selectedId: string | null
  pickingId: string | null
  setPickingId(id: string | null): void
  pickImage(scriptNodeId: string, onPick: (nodeId: string) => void): void
  extendingId: string | null
  extend(node: NodeView, kind: NodeKind): void
  onResize(nodeId: string, layout: Layout): void
  onDismissJobs: ((jobIds: string[]) => void) | undefined
  onDismissMediaTask: ((taskId: string) => void) | undefined
}
const Ctx = createContext<CanvasContext | null>(null)
type HistorySnapshot = { nodeViews: ReadonlyMap<string, NodeView>; histories: CanvasViewProps['histories']; source?: CanvasHistorySource | undefined }
const HistoriesCtx = createContext<HistorySnapshot | null>(null)
const noHistorySubscription = () => () => {}
function useHistorySelection(snapshot: HistorySnapshot, view: NodeView | undefined, slotId: string) {
  const source = slotId ? snapshot.source : undefined
  const fallback = snapshot.histories?.get(slotId)
  const getSnapshot = useMemo(() => historySelection(source, view, slotId, fallback), [source, view, slotId, fallback])
  return useSyncExternalStore(source?.subscribe ?? noHistorySubscription, getSnapshot, getSnapshot)
}
function useCanvasHistory(nodeId: string, slotId: string) {
  const snapshot = useContext(HistoriesCtx)!
  return useHistorySelection(snapshot, snapshot.nodeViews.get(nodeId), slotId)
}
export function useCanvasSelector<S>(select: (state: CanvasContext) => S, _dependencies: DependencyList): S {
  return select(useContext(Ctx)!)
}
const actionsSelector = (state: CanvasContext) => state.actions
const useCanvasActions = () => useCanvasSelector(actionsSelector, [])
const EMPTY_NODES: NodeView[] = []
const zoomSelector = (state: { transform: [number, number, number] }) => state.transform[2]
const textDetailSelector = (state: { transform: [number, number, number] }) => lowTextDetail(state.transform[2])
const PAN_BUTTONS = [0, 1]
const MODIFIER_KEYS = ['Meta', 'Control']
const PRO_OPTIONS = { hideAttribution: true }
const OPEN_FIT_OPTIONS = { maxZoom: 1 }
const minimapNodeColor = (node: VisNode) => node.data.view.kind === 'frame' ? FRAME_COLORS[node.data.view.frame?.color ?? 'gray'] : node.data.deco?.problems.some(p => !p.muted) ? 'var(--vis-danger)'
  : node.data.deco?.running ? 'var(--vis-warn)' : `var(--vis-minimap-${node.data.view.kind})`

export function useReferencePick() {
  const [pickingId, setTarget] = useState<string | null>(null)
  const imagePick = useRef<((nodeId: string) => void) | null>(null)
  const setPickingId = useCallback((id: string | null) => {
    imagePick.current = null
    setTarget(id)
  }, [])
  const pickImage = useCallback((scriptNodeId: string, onPick: (nodeId: string) => void) => {
    imagePick.current = onPick
    setTarget(scriptNodeId)
  }, [])
  return { pickingId, setPickingId, imagePick, pickImage }
}

export function CanvasView({ histories, historySource, ...props }: CanvasViewProps) {
  // Histories belong to the same render as node views, including responses without a node revision change.
  const nodeViews = useMemo(() => new Map(props.nodes.map(node => [node.nodeId, node])), [props.nodes])
  const historySnapshot = useMemo(() => ({ nodeViews, histories, source: historySource }), [nodeViews, histories, historySource])
  return (
    <HistoriesCtx.Provider value={historySnapshot}>
    <ReactFlowProvider>
      <Canvas {...props} nodeViews={nodeViews} />
    </ReactFlowProvider>
    </HistoriesCtx.Provider>
  )
}

const Canvas = memo(function Canvas({ nodes: allNodes, nodeViews, decorations, onDismissJobs, onDismissMediaTask, assetUrl, posterUrl, thumbnailUrl = assetUrl, focusRequest, hidden = false, suspended = false, scriptSessions, currentScriptSessionId, generationOperations, ...actionProps }: Omit<CanvasViewProps, 'histories' | 'historySource'> & { nodeViews: ReadonlyMap<string, NodeView> }) {
  const actions = useShallowValue(actionProps)
  const m = useMessages(messages)
  const sm = useMessages(scriptMessages)
  const tl = useMessages(timelineMessages)
  const pv = useMessages(previzMessages)
  const sc = useMessages(sceneMessages)
  const format = useFormat()
  const { locale } = useLocale()
  const [showWorking, setShowWorking] = useState(() => {
    try { return localStorage.getItem('vis.canvas.working') === 'shown' } catch { return false }
  })
  const [revealedWorkingId, setRevealedWorkingId] = useState<string | null>(null)
  const revealedSelection = useRef<string | null>(null)
  useEffect(() => {
    revealedSelection.current = null
    setRevealedWorkingId(focusRequest && 'nodeId' in focusRequest && allNodes.some(node => node.nodeId === focusRequest.nodeId && node.purpose === 'working') ? focusRequest.nodeId : null)
  }, [focusRequest])
  const nodes = useMemo(() => allNodes.filter(node => showWorking || node.purpose !== 'working' || node.nodeId === revealedWorkingId), [allNodes, showWorking, revealedWorkingId])
  const [help, setHelp] = useState(false)
  const [organizing, setOrganizing] = useState(false)
  const [removeEmptyFrames, setRemoveEmptyFrames] = useState(true)
  const [categoryIds, setCategoryIds] = useState<string[] | null>(null)
  const [category, setCategory] = useState('')
  const [operationError, setOperationError] = useState<{ error: unknown } | null>(null)
  const [operationBusy, setOperationBusy] = useState(false)
  const organizeDialog = useRef<HTMLDialogElement>(null)
  const categoryDialog = useRef<HTMLDialogElement>(null)
  const [deleteIds, setDeleteIds] = useState<string[] | null>(null)
  const deleteDialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    if (!deleteIds) return
    const previous = document.activeElement as HTMLElement | null
    deleteDialog.current?.showModal()
    return () => { deleteDialog.current?.close(); previous?.focus() }
  }, [deleteIds])
  const flow = useReactFlow()
  const navigationTarget = useRef<{ viewport: Viewport; expiresAt: number } | null>(null)
  const zoom = useStore(zoomSelector)
  const wrapper = useRef<HTMLDivElement>(null)
  const upload = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (suspended) return
    const keydown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLElement && event.target.closest('.vis-tl-editor')) return
      if (event.key !== '?' || !wrapper.current?.getClientRects().length || isEditing(event.target) || document.querySelector('dialog[open]')) return
      event.preventDefault()
      setHelp(true)
    }
    window.addEventListener('keydown', keydown)
    return () => window.removeEventListener('keydown', keydown)
  }, [suspended])
  useEffect(() => {
    const dialog = organizing ? organizeDialog.current : categoryIds ? categoryDialog.current : null
    if (!dialog) return
    dialog.showModal()
    return () => { dialog.close(); wrapper.current?.focus() }
  }, [organizing, categoryIds])
  const applyOperations = async (ops: CanvasOp[], description: string) => {
    if (!actions.onApply || !ops.length) return
    setOperationBusy(true)
    setOperationError(null)
    try { await actions.onApply(ops, description) }
    catch (error) { setOperationError({ error }); throw error }
    finally { setOperationBusy(false) }
  }
  const growth = useRef(new Set<string>())
  useEffect(() => {
    if (!actions.onApply || operationBusy) return
    // Batch events arrive one operation at a time; wait for layout to settle before expanding so intermediate organization positions do not enter undo history.
    const timer = setTimeout(() => {
      const ops = growFrames(allNodes)
      const signature = JSON.stringify([ops, allNodes.filter(node => node.frameId).map(({ nodeId, frameId, x, y, w, h }) => ({ nodeId, frameId, x, y, w, h }))])
      if (!ops.length || growth.current.has(signature)) return
      // Do not immediately write the same layout after undoing automatic expansion, or the user cannot continue undoing.
      growth.current.add(signature)
      void actions.onApply!(ops, m.growFrames).catch(error => { growth.current.delete(signature); setOperationError({ error }) })
    }, 150)
    return () => clearTimeout(timer)
  }, [allNodes, actions.onApply, operationBusy, m, locale])
  const [flowNodes, setFlowNodes] = useState<VisNode[]>([])
  const selected = flowNodes.filter(node => node.selected)
  const selectedIds = useShallowValue(selected.map(node => node.id).sort())
  const edgeSelection = useMemo(() => new Set(selectedIds), [selectedIds])
  const previousEdges = useRef<ReturnType<typeof inputEdges>>([])
  const edges = useMemo(() => {
    return inputEdges(nodes, edgeSelection, locale, previousEdges.current)
  }, [nodes, edgeSelection, locale])
  useLayoutEffect(() => { previousEdges.current = edges }, [edges])
  const arrangement = useMemo(() => {
    if (!organizing) return null
    try { return { plan: arrangeCanvas(allNodes, new Set(selected.map(node => node.id)), locale), error: '' } }
    catch (error) { return { plan: null, error: describeError(error, locale) } }
  }, [organizing, allNodes, selected.map(node => node.id).join(','), locale])
  const selectedId = selected.length === 1 ? selected[0]!.id : null
  const { pickingId, setPickingId, imagePick, pickImage } = useReferencePick()
  const [extendingId, setExtendingId] = useState<string | null>(null)
  const [showMinimap, setShowMinimap] = useState(() => {
    try { return localStorage.getItem('vis.canvas.minimap') !== 'hidden' } catch { return true }
  })
  const [previewId, setPreviewId] = useState<string | null>(null)
  const previewOrigin = useRef<DOMRect | undefined>(undefined)
  const selectPreview = (id: string) => {
    setFlowNodes(prev => selectFlowNodes(prev, new Set([id])))
    setPreviewId(id)
  }
  useEffect(() => {
    if (suspended) return
    const open = (event: Event) => {
      const id = (event as CustomEvent<string>).detail
      const node = nodes.find(n => n.nodeId === id)
      if (!node || !mediaSlot(node) || pickingId) return
      previewOrigin.current = wrapper.current?.querySelector(`[data-id="${CSS.escape(id)}"] .vis-version-body`)?.getBoundingClientRect()
      selectPreview(id)
    }
    const key = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLElement && event.target.closest('.vis-tl-editor')) return
      if (event.key !== ' ' || previewId || !selectedId || isEditing(event.target) || (event.target instanceof HTMLElement && event.target.closest('button, a'))) return
      const node = nodes.find(n => n.nodeId === selectedId)
      if (!node || node.kind === 'audio' || !mediaSlot(node)) return
      event.preventDefault()
      openPreview(selectedId)
    }
    window.addEventListener('vis:preview', open)
    window.addEventListener('keydown', key)
    return () => { window.removeEventListener('vis:preview', open); window.removeEventListener('keydown', key) }
  }, [nodes, selectedId, previewId, pickingId, suspended])
  const closePreview = () => {
    navigationTarget.current = null
    const node = flowNodes.find(n => n.id === previewId)
    if (node && wrapper.current) {
      const bounds = wrapper.current.getBoundingClientRect()
      const p = flow.flowToScreenPosition(node.position)
      const end = flow.flowToScreenPosition({ x: node.position.x + node.data.view.w, y: node.position.y + node.data.view.h })
      if (end.x < bounds.left || p.x > bounds.right || end.y < bounds.top || p.y > bounds.bottom) {
        void flow.setCenter(node.position.x + node.data.view.w / 2, node.position.y + node.data.view.h / 2, { zoom: flow.getZoom(), duration: 250 })
      }
    }
    setPreviewId(null)
    wrapper.current?.focus()
  }
  useEffect(() => {
    if (previewId && !nodes.some(n => n.nodeId === previewId && mediaSlot(n))) closePreview()
  }, [nodes, previewId])
  const pendingSelect = useRef<string | null>(null)
  const pendingClones = useRef<string[]>([])
  const [clipboard, setClipboard] = useState<NodeView[]>([])
  const [menu, setMenu] = useState<{ x: number; y: number; at: { x: number; y: number }; ids: string[] } | null>(null)
  const [submenu, setSubmenu] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuJobs = [...new Map((menu?.ids ?? []).flatMap(id => decorations?.get(id)?.activeJobs ?? []).map(job => [job.jobId, job])).values()]
  const menuNode = menu?.ids.length === 1 ? nodes.find(node => node.nodeId === menu.ids[0]) : undefined
  const menuMedia = menuNode && wrapper.current?.querySelector<HTMLImageElement | HTMLVideoElement>(`[data-id="${CSS.escape(menuNode.nodeId)}"] .vis-version-media img:not(.is-previous), [data-id="${CSS.escape(menuNode.nodeId)}"] .vis-version-media > div:not(.is-previous) video`)
  const mediaWidth = menuMedia && menuMedia instanceof HTMLImageElement ? menuMedia.naturalWidth : menuMedia?.videoWidth
  const mediaHeight = menuMedia && menuMedia instanceof HTMLImageElement ? menuMedia.naturalHeight : menuMedia?.videoHeight
  const fittedHeight = menuNode && mediaWidth && mediaHeight ? Math.max(1, Math.round(menuNode.w * mediaHeight / mediaWidth)) : null
  const menuRecheck = menuNode && decorations?.get(menuNode.nodeId)?.problems.find(problem => problem.recheckable)?.jobId
  const menuRetry = menuNode && (decorations?.get(menuNode.nodeId)?.problems[0]?.jobId ?? menuNode.slots.find(slot => slot.slotKey === 'main')?.source?.jobId)
  const mouse = useRef<{ x: number; y: number } | null>(null)
  const uploadAt = useRef<{ x: number; y: number } | null>(null)
  const pickingBusy = useRef(false)
  const pendingCreate = useRef<{ kind: NodeKind; x: number; y: number; existing: Set<string> } | null>(null)
  // Fit the view only if nodes exist on opening; do not suddenly zoom in when creating the first node on an empty canvas
  const [fitOnOpen] = useState(() => nodes.length > 0)
  const [openedHidden] = useState(hidden)
  const [fitWhenShown, setFitWhenShown] = useState(hidden && fitOnOpen)
  const [sized, setSized] = useState(!hidden)
  const nodesInitialized = useNodesInitialized()
  useEffect(() => {
    if (!wrapper.current) return
    // Runs after React Flow's own observer, so its dimensions are current when this state changes.
    const observer = new ResizeObserver(([entry]) => setSized(Boolean(entry?.contentRect.width)))
    observer.observe(wrapper.current)
    return () => observer.disconnect()
  }, [])
  // Submitted layouts awaiting server confirmation; prefer local values until confirmed so nodes do not jump back first
  const pendingLayout = useRef(new Map<string, Layout & { layoutRevision?: number }>())
  const actionsRef = useRef(actions)
  // React Flow selection callbacks run in passive effects; the other readers are event handlers.
  useLayoutEffect(() => { actionsRef.current = actions }, [actions])
  const focused = useRef<number | undefined>(undefined)

  useEffect(() => {
    const pending = pendingLayout.current
    for (const v of nodes) {
      const p = pending.get(v.nodeId)
      if (p && ((p.layoutRevision !== undefined && v.layoutRevision > p.layoutRevision) || (p.x === v.x && p.y === v.y && p.w === v.w && p.h === v.h))) pending.delete(v.nodeId)
    }
    const created = pendingCreate.current
    const newNode = created && nodes.find(node => !created.existing.has(node.nodeId) && node.kind === created.kind && node.x === created.x && node.y === created.y)
    if (newNode) {
      navigationTarget.current = null
      pendingSelect.current = newNode.nodeId
      pendingCreate.current = null
      void flow.setCenter(newNode.x + newNode.w / 2, newNode.y + newNode.h / 2, { zoom: flow.getZoom(), duration: 300 })
    }
    const nextSelected = pendingSelect.current
    if (nextSelected && nodes.some(node => node.nodeId === nextSelected)) pendingSelect.current = null
    setFlowNodes(prev => {
      const selected = pendingClones.current.length ? new Set(pendingClones.current) : nextSelected ? new Set([nextSelected]) : new Set(prev.filter(n => n.selected).map(n => n.id))
      if (pendingClones.current.every(id => nodes.some(n => n.nodeId === id))) pendingClones.current = []
      const previous = new Map(prev.map(node => [node.id, node]))
      const next = nodes.map(v => toFlowNode(v, pending.get(v.nodeId), selected.has(v.nodeId), decorations?.get(v.nodeId), previous.get(v.nodeId)))
      return next.length === prev.length && next.every((node, index) => node === prev[index]) ? prev : next
    })
  }, [nodes, decorations, flow])

  useEffect(() => {
    if (!sized || !focusRequest || focused.current === focusRequest.seq) return
    const ids = new Set('nodeIds' in focusRequest ? focusRequest.nodeIds : [focusRequest.nodeId])
    const targets = flowNodes.filter(node => ids.has(node.id))
    const node = targets[0]
    if (!node) return
    focused.current = focusRequest.seq
    navigationTarget.current = null
    setPickingId(null)
    setFlowNodes(prev => selectFlowNodes(prev, ids))
    actionsRef.current.onSelectionChange?.(targets.map(n => n.id))
    if ('nodeIds' in focusRequest) {
      void flow.fitView({ nodes: targets, minZoom: 0, maxZoom: 1, padding: .15, duration: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 300 })
      return
    }
    if (node.data.view.kind === 'frame') {
      void flow.fitBounds(getNodesBounds(targets), { padding: .15, duration: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 300 })
      return
    }
    void flow.setCenter(node.position.x + (node.width ?? node.data.view.w) / 2, node.position.y + (node.height ?? node.data.view.h) / 2, {
      zoom: flow.getZoom(), duration: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 300,
    })
  }, [focusRequest, flowNodes, flow, sized])

  useEffect(() => {
    if (!fitWhenShown || !sized || !nodesInitialized) return
    setFitWhenShown(false)
    if (!focusRequest || focused.current === focusRequest.seq) void flow.fitView(OPEN_FIT_OPTIONS)
  }, [fitWhenShown, sized, nodesInitialized, focusRequest, flow])

  useEffect(() => {
    if (pickingId && !nodes.some(node => node.nodeId === pickingId)) setPickingId(null)
  }, [nodes, pickingId])

  useEffect(() => {
    if (!pickingId || suspended) return
    const cancel = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || isEditing(event.target) || (event.target instanceof Element && event.target.closest('[role="menu"]'))) return
      event.preventDefault()
      event.stopPropagation()
      setPickingId(null)
    }
    window.addEventListener('keydown', cancel, true)
    return () => window.removeEventListener('keydown', cancel, true)
  }, [pickingId, suspended])

  const onNodesChange = useCallback((changes: NodeChange<VisNode>[]) => {
    setFlowNodes(prev => applyNodeChanges(pickingId ? changes.filter(change => change.type !== 'select') : changes, prev))
  }, [pickingId])

  const commitLayout = useCallback((nodeId: string, layout: Layout) => {
    const view = nodes.find(n => n.nodeId === nodeId)
    if (view && view.x === layout.x && view.y === layout.y && view.w === layout.w && view.h === layout.h) return
    pendingLayout.current.set(nodeId, layout)
    const prospective = allNodes.map(node => node.nodeId === nodeId ? { ...node, ...layout } : node)
    const growth = growFrames(prospective)
    const expanded = growth.find(op => op.nodeId === nodeId)
    const finalLayout = expanded ? { ...layout, x: expanded.x!, y: expanded.y!, w: expanded.w!, h: expanded.h! } : layout
    const submit = actionsRef.current.onApply
      ? actionsRef.current.onApply([...growth.filter(op => op.nodeId !== nodeId), { op: 'node.layout', nodeId, ...finalLayout }], m.resizeNode)
      : actionsRef.current.onLayout(nodeId, finalLayout)
    submit.catch(() => {
      pendingLayout.current.delete(nodeId)
      setFlowNodes(prev => prev.map(n => {
        const v = nodes.find(x => x.nodeId === n.id)
        return v ? toFlowNode(v, undefined, Boolean(n.selected), n.data.deco, n) : n
      }))
    })
  }, [nodes, allNodes, m])

  const dragStart = useRef<NodeView[]>([])
  const escapeDrag = useRef(false)
  const dragMoves = (dragged: VisNode[]) => constrainedMoves(dragStart.current, dragged.map(n => ({ nodeId: n.id, ...n.position })), escapeDrag.current)
  const dragBatch = (dragged: VisNode[]) => movedFrameBounds(dragStart.current, dragged.map(n => ({ nodeId: n.id, ...n.position })), escapeDrag.current)
  const onNodeDragStop = useStableCallback((_: unknown, _node: VisNode, dragged: VisNode[]) => {
    const batch = dragBatch(dragged).filter(l => {
      const old = dragStart.current.find(n => n.nodeId === l.nodeId)
      return old && (old.x !== l.x || old.y !== l.y)
    })
    if (!batch.length) return
    for (const l of batch) pendingLayout.current.set(l.nodeId, { ...l, layoutRevision: dragStart.current.find(n => n.nodeId === l.nodeId)!.layoutRevision })
    void (actions.onApply ? actions.onApply(memberMoveOps(dragStart.current, dragMoves(dragged)), m.moveNodes) : actions.onMove(frameMoveOps(dragStart.current, dragMoves(dragged)))).catch(() => {
      for (const l of batch) pendingLayout.current.delete(l.nodeId)
      setFlowNodes(prev => prev.map(n => toFlowNode(n.data.view, undefined, Boolean(n.selected), n.data.deco, n)))
    })
  })
  const requestDelete = (ids: string[]) => {
    if (nodes.some(node => node.kind === 'frame' && ids.includes(node.nodeId))) setDeleteIds(ids)
    else actions.onDelete(ids)
  }

  const extend = (node: NodeView, kind: Exclude<NodeKind, 'script' | 'timeline' | 'previz' | 'scene'>) => {
    if (extendingId) return
    const at = extensionPosition(node, kind, nodes)
    setExtendingId(node.nodeId)
    void actions.onExtend(node.nodeId, kind, at).then(id => {
      pendingSelect.current = id
      setFlowNodes(prev => {
        if (prev.some(n => n.id === id)) pendingSelect.current = null
        return selectFlowNodes(prev, new Set([id]))
      })
      const size = nodeSize(kind)
      navigationTarget.current = null
      void flow.setCenter(at.x + size.w / 2, at.y + size.h / 2, { zoom: flow.getZoom(), duration: 300 })
      setPickingId(null)
    }).catch(() => {}).finally(() => setExtendingId(null))
  }
  const selectNode = useCallback((id: string) => {
    navigationTarget.current = null
    pendingSelect.current = id
    setFlowNodes(prev => {
      if (prev.some(n => n.id === id)) pendingSelect.current = null
      return selectFlowNodes(prev, new Set([id]))
    })
  }, [])
  const [selectedPanel, setSelectedPanel] = useState<{ nodeId: string; panelId: string } | null>(null)
  const selectPanel = useCallback((nodeId: string, panelId: string | null) => {
    if (panelId) selectNode(nodeId)
    setSelectedPanel(panelId ? { nodeId, panelId } : null)
  }, [selectNode])
  useEffect(() => {
    if (selectedPanel && (selectedId !== selectedPanel.nodeId || suspended)) setSelectedPanel(null)
  }, [selectedId, suspended])
  const stableExtend = useStableCallback(extend)
  const onResize = useStableCallback(commitLayout)
  const titleNumbers = useMemo(() => nodeTitleNumbers(nodes), [nodes])
  const frameRunning = useMemo(() => frameRunningStates(nodes, decorations), [nodes, decorations])
  const ctx: CanvasContext = useShallowValue({ suspended, nodeViews, titleNumbers, decorations, frameRunning, selectNode, selectedPanel, selectPanel, assetUrl, posterUrl, thumbnailUrl, actions, scriptSessions, currentScriptSessionId, generationOperations, nodes, allNodes, selectedId: suspended || previewId ? null : selectedId, pickingId, setPickingId, pickImage, extendingId, extend: stableExtend, onResize, onDismissJobs, onDismissMediaTask })

  const viewportCenter = () => {
    const rect = wrapper.current!.getBoundingClientRect()
    return flow.screenToFlowPosition({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 })
  }
  const fitCanvas = () => {
    const targets = flow.getNodes().filter(node => !node.hidden)
    if (!targets.length || !wrapper.current) return
    const rect = wrapper.current.getBoundingClientRect()
    // fitView queues a node update; a following zoom can otherwise be overwritten when that queue drains.
    const viewport = getViewportForBounds(getNodesBounds(targets), rect.width, rect.height, 0.05, 1, 0.2)
    navigateViewport(viewport, 300)
  }
  const navigateViewport = (viewport: Viewport, duration: number) => {
    const ms = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : duration
    navigationTarget.current = { viewport, expiresAt: performance.now() + ms }
    void flow.setViewport(viewport, { duration: ms })
  }
  const zoomCanvas = (direction: 'in' | 'out' | 'reset') => {
    if (!wrapper.current) return
    const target = navigationTarget.current
    const current = target && target.expiresAt > performance.now() ? target.viewport : flow.getViewport()
    const zoom = Math.max(0.05, Math.min(4, direction === 'reset' ? 1 : current.zoom * (direction === 'in' ? 1.2 : 1 / 1.2)))
    const rect = wrapper.current.getBoundingClientRect()
    navigateViewport(zoomedViewport(current, rect.width, rect.height, zoom), 200)
  }
  const createAtCenter = (kind: NodeKind) => {
    const center = viewportCenter()
    const size = nodeSize(kind)
    const at = freePosition({ x: center.x - size.w / 2, y: center.y - size.h / 2 }, size, nodes, 'x')
    pendingCreate.current = { kind, ...at, existing: new Set(nodes.map(node => node.nodeId)) }
    setPickingId(null)
    if (kind === 'text') actions.onCreateText(at)
    else if (kind === 'script') void actions.onCreateScript?.(at).catch(error => setOperationError({ error }))
    else if (kind === 'previz') void actions.onCreatePreviz?.(at).catch(error => setOperationError({ error }))
    else if (kind === 'scene') void actions.onCreateScene?.(at).catch(error => setOperationError({ error }))
    else if (kind === 'timeline') void actions.onCreateTimeline?.(at).catch(error => setOperationError({ error }))
    else actions.onCreateGenNode(kind, at)
  }

  const selectCreated = (ids: string[]) => {
    pendingClones.current = ids
    setFlowNodes(prev => selectFlowNodes(prev, new Set(ids)))
  }
  const createTimelineFrom = (ids: string[]) => {
    const selectedNodes = nodes.filter(node => ids.includes(node.nodeId))
    if (!canCreateTimeline(selectedNodes) || !actions.onCreateTimelineFrom) return
    void actions.onCreateTimelineFrom(timelineReadingOrder(selectedNodes).map(node => node.nodeId)).then(id => selectCreated([id])).catch(error => setOperationError({ error }))
  }
  const copy = (ids: string[]) => {
    const copied = structuredClone(nodes.filter(node => node.kind !== 'frame' && ids.includes(node.nodeId)))
    setClipboard(copied)
    const text = copied.flatMap(node => node.kind === 'text' ? node.slots.filter(s => s.content.type === 'text').map(s => s.content.type === 'text' ? s.content.body : '') : []).join('\n')
    if (text) void navigator.clipboard?.writeText(text).catch(() => {})
  }
  const paste = (source: NodeView[], at: { x: number; y: number }) => {
    if (source.length) void actions.onClone(source, at).then(selectCreated).catch(() => {})
  }
  const duplicate = (ids: string[]) => {
    const source = nodes.filter(node => node.kind !== 'frame' && ids.includes(node.nodeId))
    if (source.length) paste(source, { x: Math.min(...source.map(n => n.x)) + 40, y: Math.min(...source.map(n => n.y)) + 40 })
  }
  useEffect(() => {
    if (suspended) return
    const keydown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLElement && event.target.closest('.vis-tl-editor')) return
      if (event.key === 'Escape') { setMenu(null); return }
      if (deleteIds) return
      if ((event.target as HTMLElement).closest('input, textarea') || (event.target as HTMLElement).isContentEditable) return
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return
      const ids = selected.map(n => n.id)
      switch (event.key.toLowerCase()) {
        // Selected text, such as in the conversation, outranks the selected nodes.
        case 'c': if (!ids.length || window.getSelection()?.toString()) return; copy(ids); break
        case 'v': if (!clipboard.length) return; paste(clipboard, mouse.current ?? viewportCenter()); break
        case 'd': if (!ids.length) return; duplicate(ids); break
        default: return
      }
      event.preventDefault()
      setMenu(null)
    }
    window.addEventListener('keydown', keydown)
    return () => window.removeEventListener('keydown', keydown)
  })
  // Menu items vary with node state; fit actual menu dimensions inside the viewport on opening, since overflow scrolls into view and any scrolling closes the menu
  useLayoutEffect(() => {
    const el = menuRef.current
    if (!menu || !el) return
    const rect = el.getBoundingClientRect()
    const x = Math.max(4, Math.min(menu.x, window.innerWidth - rect.width - 4))
    const y = Math.max(4, Math.min(menu.y, window.innerHeight - rect.height - 4))
    if (x !== menu.x || y !== menu.y) setMenu({ ...menu, x, y })
  }, [menu, submenu])
  useEffect(() => {
    if (!menu) return
    const outside = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as globalThis.Node)) setMenu(null)
    }
    const close = (event: Event) => {
      if (event.target instanceof globalThis.Node && menuRef.current?.contains(event.target)) return
      setMenu(null)
    }
    window.addEventListener('pointerdown', outside, true)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', close, true)
    menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    return () => {
      window.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [menu])
  const openMenu = (event: MouseEvent | globalThis.MouseEvent, nodeId?: string) => {
    event.preventDefault()
    const ids = nodeId ? selected.some(n => n.id === nodeId) ? selected.map(n => n.id) : [nodeId] : []
    if (nodeId) setFlowNodes(prev => selectFlowNodes(prev, new Set(ids)))
    setPickingId(null)
    setSubmenu(false)
    const p = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY })
    const at = { x: Math.round(p.x), y: Math.round(p.y) }
    mouse.current = at
    setMenu({ x: Math.max(4, Math.min(event.clientX, window.innerWidth - 248)), y: Math.max(4, Math.min(event.clientY, window.innerHeight - 360)), at, ids })
  }
  const menuAction = (action: () => void) => { action(); setMenu(null) }
  const referenceGenerate = (kind: 'image' | 'video' | 'audio') => {
    if (!menu) return
    const source = nodes.filter(n => menu.ids.includes(n.nodeId))
    if (!source.length) return
    const at = freePosition({ x: Math.max(...source.map(n => n.x + n.w)) + 80, y: Math.min(...source.map(n => n.y)) }, nodeSize(kind), nodes, 'y')
    void actions.onExtendReferences(menu.ids, kind, at).then(id => selectCreated([id])).catch(() => {})
  }
  const onPaneContextMenu = useStableCallback((event: MouseEvent | globalThis.MouseEvent) => openMenu(event))
  const onNodeContextMenu: NodeMouseHandler<VisNode> = useStableCallback((event, node) => openMenu(event, node.id))
  const onSelectionContextMenu = useStableCallback((event: MouseEvent) => openMenu(event, selected[0]?.id))
  const onMoveStart = useCallback((event: unknown) => {
    if (!event) return
    navigationTarget.current = null
    setMenu(null)
  }, [])
  const onNodeDragStart: OnNodeDrag<VisNode> = useStableCallback(event => {
    escapeDrag.current = event.metaKey || event.ctrlKey
    dragStart.current = allNodes.map(node => ({ ...node, ...pendingLayout.current.get(node.nodeId) }))
  })
  const onNodeDrag: OnNodeDrag<VisNode> = useStableCallback((event, _node, dragged) => {
    escapeDrag.current = event.metaKey || event.ctrlKey
    const batch = new Map(dragBatch(dragged).map(layout => [layout.nodeId, layout]))
    setFlowNodes(previous => moveFlowNodes(previous, batch))
  })
  const onNodeClick: NodeMouseHandler<VisNode> = useStableCallback((event, node) => {
    if (node.data.view.kind === 'frame') return
    if (!pickingId || pickingBusy.current || node.id === pickingId) return
    event.stopPropagation()
    if (imagePick.current) {
      if (node.data.view.kind !== 'image') return
      const onPick = imagePick.current
      imagePick.current = null
      setPickingId(null)
      onPick(node.id)
      return
    }
    const target = nodes.find(candidate => candidate.nodeId === pickingId)
    if (!target) return
    pickingBusy.current = true
    void actions.onSetInputs(target.nodeId, [...new Set([...(target.inputs ?? []), node.id])])
      .then(() => setPickingId(null)).catch(() => {}).finally(() => { pickingBusy.current = false })
  })
  const onSelectionChange = useCallback(({ nodes: selected }: { nodes: VisNode[] }) => {
    setRevealedWorkingId(current => {
      if (current && selected.some(node => node.id === current)) revealedSelection.current = current
      // React Flow first deselects the previous target while the newly revealed node mounts.
      return current && !selected.some(node => node.id === current) && revealedSelection.current === current ? null : current
    })
    actionsRef.current.onSelectionChange?.(selected.map(node => node.id))
  }, [])
  const onBeforeDelete = useStableCallback(async ({ nodes: removed }: { nodes: VisNode[] }) => {
    if (removed.length) requestDelete(removed.map(node => node.id))
    return false as const
  })

  const onDragOver = useCallback((e: DragEvent) => {
    // Nested editors own their drag gestures, including move-only shot reordering.
    if (e.defaultPrevented) return
    const types = e.dataTransfer.types
    if (types.includes('Files') || (actionsRef.current.onDropData && actionsRef.current.dropDataTypes?.some(type => types.includes(type)))) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    }
  }, [])
  const onDrop = useCallback((e: DragEvent) => {
    if (e.defaultPrevented) return
    const files = [...e.dataTransfer.files]
    const p = flow.screenToFlowPosition({ x: e.clientX, y: e.clientY })
    const at = { x: Math.round(p.x), y: Math.round(p.y) }
    if (actionsRef.current.onDropData?.(e.dataTransfer, at)) { e.preventDefault(); return }
    if (!files.length) return
    e.preventDefault()
    actionsRef.current.onDropFiles(files, at)
  }, [flow])

  return (
    <Ctx.Provider value={ctx}>
      <div ref={wrapper} tabIndex={-1} className={`vis-canvas-wrap${pickingId ? ' is-picking-reference' : ''}${lowTextDetail(zoom) ? ' is-low-detail' : ''}`} style={lowTextDetail(zoom) ? { '--vis-zoom': Math.max(zoom, 0.2) } as CSSProperties : undefined} onKeyDownCapture={event => {
        if (suspended) { event.stopPropagation(); return }
        const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key]
        if (!direction || isEditing(event.target) || !(event.target instanceof Element) || !event.target.matches('.react-flow__node')) return
        event.preventDefault()
        event.stopPropagation()
        const focusedId = event.target.getAttribute('data-id')
        const moving = flowNodes.filter(node => node.selected || node.id === focusedId)
        if (!moving.length) return
        dragStart.current = allNodes.map(node => ({ ...node, ...pendingLayout.current.get(node.nodeId) }))
        escapeDrag.current = event.metaKey || event.ctrlKey
        const step = event.shiftKey ? 20 : 5
        // Start from actual layout (including unconfirmed writes): after dragging, flowNodes may temporarily retain the pointer position without frame constraints
        const layout = new Map(dragStart.current.map(node => [node.nodeId, node]))
        const dragged = moving.map(node => {
          const at = layout.get(node.id) ?? node.position
          return { ...node, position: { x: at.x + direction[0]! * step, y: at.y + direction[1]! * step } }
        })
        const batch = new Map(dragBatch(dragged).map(layout => [layout.nodeId, layout]))
        setFlowNodes(previous => moveFlowNodes(previous, batch))
        onNodeDragStop(event, dragged[0]!, dragged)
      }} onDragOver={onDragOver} onDrop={onDrop} onWheelCapture={event => { if (!menuRef.current?.contains(event.target as globalThis.Node)) setMenu(null) }} onMouseMove={event => {
        mouse.current = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY })
      }}>
        <ReactFlow
          className="vis-canvas"
          nodes={flowNodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          onPaneContextMenu={onPaneContextMenu}
          onNodeContextMenu={onNodeContextMenu}
          onSelectionContextMenu={onSelectionContextMenu}
          // Close the menu only on user pan or zoom; programmatic fit/focus moves have no event object, and their animations may start after the menu opens
          onMoveStart={onMoveStart}
          onNodesChange={onNodesChange}
          onNodeDragStart={onNodeDragStart}
          onNodeDrag={onNodeDrag}
          onNodeDragStop={onNodeDragStop}
          elevateNodesOnSelect={false}
          onNodeClick={onNodeClick}
          onSelectionChange={onSelectionChange}
          // Delegate deletion to the server; nodes disappear only after receiving deletion events
          onBeforeDelete={onBeforeDelete}
          nodesConnectable={false}
          elementsSelectable={!pickingId}
          zoomOnDoubleClick={false}
          // Trackpad: two-finger pan and pinch zoom; mouse: Cmd/Ctrl + wheel to zoom; right-click only opens the menu and never pans
          panOnScroll
          zoomOnScroll={false}
          panOnDrag={PAN_BUTTONS}
          proOptions={PRO_OPTIONS}
          colorMode="dark"
          minZoom={0.05}
          maxZoom={4}
          fitView={fitOnOpen && !openedHidden}
          fitViewOptions={OPEN_FIT_OPTIONS}
          deleteKeyCode={suspended || deleteIds ? null : ['Backspace', 'Delete']}
          selectionKeyCode={suspended ? null : 'Shift'}
          multiSelectionKeyCode={suspended ? null : MODIFIER_KEYS}
          panActivationKeyCode={suspended ? null : 'Space'}
          zoomActivationKeyCode={suspended ? null : MODIFIER_KEYS}
          disableKeyboardA11y={suspended}
        >
          {!allNodes.length ? <EmptyShortcuts /> : null}
          <Panel position="bottom-center" className="vis-canvas-toolbar" data-canvas-obstacle="bottom">
            <button aria-label={m.importWriting} title={m.importWriting} disabled={!actions.onImportWriting} onClick={() => actions.onImportWriting?.(flow.screenToFlowPosition({ x: (wrapper.current?.getBoundingClientRect().left ?? 0) + (wrapper.current?.clientWidth ?? 0) / 2, y: (wrapper.current?.getBoundingClientRect().top ?? 0) + (wrapper.current?.clientHeight ?? 0) / 2 }))}><Icon kind="text" /></button>
            <button aria-label={m.text} title={m.text} onClick={() => createAtCenter('text')}><Icon kind="text" /></button>
            <button aria-label={sm.createScript} title={sm.createScript} disabled={!actions.onCreateScript} onClick={() => createAtCenter('script')}><Icon kind="script" /></button>
            <button aria-label={pv.create} title={pv.create} disabled={!actions.onCreatePreviz} onClick={() => createAtCenter('previz')}><Icon kind="previz" /></button>
            <button aria-label={sc.create} title={sc.create} disabled={!actions.onCreateScene} onClick={() => createAtCenter('scene')}><Icon kind="scene" /></button>
            <button aria-label={tl.timeline} title={tl.timeline} disabled={!actions.onCreateTimeline} onClick={() => createAtCenter('timeline')}><Icon kind="timeline" /></button>
            <button aria-label={m.generateImage} title={m.generateImage} onClick={() => createAtCenter('image')}><Icon kind="image" /></button>
            <button aria-label={m.generateAudio} title={m.generateAudio} onClick={() => createAtCenter('audio')}><Icon kind="audio" /></button>
            <button aria-label={m.generateVideo} title={m.generateVideo} onClick={() => createAtCenter('video')}><Icon kind="video" /></button>
            <button title={m.organize} aria-label={m.organize} disabled={!nodes.length || !actions.onApply} onClick={() => { setOperationError(null); setRemoveEmptyFrames(true); setOrganizing(true) }}><Icon kind="organize" /></button>
            <button className="vis-working-toggle" aria-label={m.showWorking} title={m.showWorking} aria-pressed={showWorking} onClick={() => {
              setShowWorking(!showWorking)
              try { localStorage.setItem('vis.canvas.working', !showWorking ? 'shown' : 'hidden') } catch {}
            }}><Icon kind="document" /></button>
            <span className="vis-toolbar-divider" />
            <button aria-label={m.upload} title={m.uploadMedia} onClick={() => { uploadAt.current = null; upload.current?.click() }}><Icon kind="upload" /></button>
          </Panel>
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="var(--vis-canvas-dot)" />
          {showMinimap ? <MiniMap<VisNode>
              position="bottom-right" className="vis-minimap" pannable zoomable
              bgColor="var(--vis-panel)" maskColor="var(--vis-minimap-mask)"
              nodeColor={minimapNodeColor}
            /> : null}
          <Panel position="bottom-right" className="vis-canvas-navigation">
            <button aria-label={m.shortcuts} title={m.shortcutsHint} onClick={() => setHelp(true)}>?</button>
            <button aria-label={showMinimap ? m.hideMinimap : m.showMinimap} title={showMinimap ? m.hideMinimap : m.showMinimap} onClick={() => {
              setShowMinimap(!showMinimap)
              try { localStorage.setItem('vis.canvas.minimap', showMinimap ? 'hidden' : 'shown') } catch {}
            }}><Icon kind="map" /></button>
            <button aria-label={m.zoomOutCanvas} title={m.zoomOut} onClick={() => zoomCanvas('out')}>−</button>
            <button className="vis-zoom-value" aria-label={m.resetZoom} title={m.resetZoomHint} onClick={() => zoomCanvas('reset')}>{format.number(Math.round(zoom * 100))}%</button>
            <button aria-label={m.zoomInCanvas} title={m.zoomIn} onClick={() => zoomCanvas('in')}>{m.plus}</button>
            <button aria-label={m.fitCanvas} title={m.fitCanvas} onClick={fitCanvas}><Icon kind="fit" /></button>
          </Panel>
          {pickingId ? <Panel position="top-center" className="vis-reference-hint" role="status">{m.pickReference}</Panel> : null}
        </ReactFlow>
        {operationError && !organizing && !categoryIds ? <div role="alert" className="vis-organization-error">{describeError(operationError.error, locale)}<button onClick={() => setOperationError(null)}>{m.close}</button></div> : null}
        {help ? <ShortcutDialog onClose={() => setHelp(false)} onRestoreFocus={() => wrapper.current?.focus()} /> : null}
        <dialog ref={organizeDialog} className="vis-dialog vis-frame-delete vis-organize-dialog" aria-label={m.organizeCanvas} onCancel={() => setOrganizing(false)} onClick={event => { if (event.target === event.currentTarget) setOrganizing(false) }}>
          <header className="vis-dialog-header"><h2>{m.organizeCanvas}</h2><IconButton label={m.close} onClick={() => setOrganizing(false)}><CloseIcon /></IconButton></header>
          <div className="vis-dialog-body">
            <p>{m.organizeHint(Boolean(selected.length))}</p>
            {arrangement?.plan ? <><OrganizationPreview {...arrangement.plan} nodes={allNodes} />
              {arrangement.plan.removedFrames.length ? <label className="vis-organize-removals"><input type="checkbox" checked={removeEmptyFrames} onChange={event => setRemoveEmptyFrames(event.target.checked)} />{m.removeEmptyFrames}<ul>{arrangement.plan.removedFrames.map(frame => <li key={frame.nodeId}>{frame.title}</li>)}</ul></label> : null}</> : null}
            {arrangement?.error || operationError ? <p role="alert">{arrangement?.error || (operationError && describeError(operationError.error, locale))}</p> : null}
          </div>
          <footer className="vis-dialog-footer"><button onClick={() => setOrganizing(false)}>{m.cancel}</button><button className="is-primary" disabled={operationBusy || !arrangement?.plan?.ops.some(op => removeEmptyFrames || op.op !== 'node.delete')} onClick={() => {
            if (arrangement?.plan) void applyOperations(arrangement.plan.ops.filter(op => removeEmptyFrames || op.op !== 'node.delete'), m.organizeByCategory).then(() => setOrganizing(false)).catch(() => {})
          }}>{m.confirmOrganize}</button></footer>
        </dialog>
        <dialog ref={categoryDialog} className="vis-dialog vis-frame-delete" aria-label={m.setCategory} onCancel={() => setCategoryIds(null)} onClick={event => { if (event.target === event.currentTarget && category === (nodes.find(node => node.nodeId === categoryIds?.[0])?.category ?? '')) setCategoryIds(null) }}>
          <header className="vis-dialog-header"><h2>{m.setCategory}</h2><IconButton label={m.close} onClick={() => setCategoryIds(null)}><CloseIcon /></IconButton></header>
          <div className="vis-dialog-body">
            <label>{m.category}<input aria-label={m.category} maxLength={20} list="vis-categories" value={category} onChange={event => setCategory(event.target.value)} /></label>
            <datalist id="vis-categories">{[m.characters, m.scenes, m.props, m.shots, m.storyboards, m.copywriting, m.other].map(value => <option key={value} value={value} />)}</datalist>
            <p>{m.categoryHint}</p>
            {operationError ? <p role="alert">{describeError(operationError.error, locale)}</p> : null}
          </div>
          <footer className="vis-dialog-footer"><button onClick={() => setCategoryIds(null)}>{m.cancel}</button><button className="is-primary" disabled={operationBusy} onClick={() => {
            if (categoryIds) void applyOperations(categoryIds.map(nodeId => ({ op: 'node.setMeta', nodeId, category: category.trim() || null })), m.setCategory).then(() => setCategoryIds(null)).catch(() => {})
          }}>{m.save}</button></footer>
        </dialog>
        <dialog ref={deleteDialog} className="vis-dialog vis-frame-delete" aria-labelledby="vis-frame-delete-title" onCancel={() => setDeleteIds(null)} onClick={event => { if (event.target === event.currentTarget) setDeleteIds(null) }}>
          <header className="vis-dialog-header"><h2 id="vis-frame-delete-title">{m.deleteFrame}</h2><IconButton label={m.close} onClick={() => setDeleteIds(null)}><CloseIcon /></IconButton></header>
          <div className="vis-dialog-body">
            {nodes.filter(n => n.kind === 'frame' && deleteIds?.includes(n.nodeId)).map(n => <p key={n.nodeId}>{m.deleteFrameHint(n.frame?.title ?? m.frame)}</p>)}
            {deleteIds?.some(id => nodes.some(n => n.nodeId === id && n.kind !== 'frame')) ? <p>{m.deleteContents(format.number(nodes.filter(n => n.kind !== 'frame' && deleteIds.includes(n.nodeId)).length))}</p> : null}
          </div>
          <footer className="vis-dialog-footer"><button autoFocus onClick={() => setDeleteIds(null)}>{m.cancel}</button><button onClick={() => { if (deleteIds) actions.onDelete(deleteIds); setDeleteIds(null) }}>{m.deleteFrame}</button></footer>
        </dialog>
        {!suspended && previewId && nodes.find(n => n.nodeId === previewId && mediaSlot(n)) ? <NodePreview key={previewId} running={Boolean(decorations?.get(previewId)?.running)} view={nodes.find(n => n.nodeId === previewId)!} origin={previewOrigin.current} onSelect={selectPreview} onClose={closePreview} /> : null}
        {menu ? <div ref={menuRef} role="menu" aria-label={m.contextMenu} className="vis-context-menu" style={{ left: menu.x, top: menu.y }} onContextMenu={e => e.preventDefault()} onKeyDown={event => {
          if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
          event.preventDefault()
          const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
          const index = items.indexOf(document.activeElement as HTMLButtonElement)
          items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus()
        }}>
          {menu.ids.length ? <>
            {actions.onApply ? <>
              <button role="menuitem" onClick={() => { setCategoryIds(menu.ids); setCategory(menuNode?.category ?? ''); setOperationError(null); setMenu(null) }}>{m.setCategoryMenu}</button>
              <button role="menuitem" onClick={() => menuAction(() => { void applyOperations(menu.ids.map(nodeId => ({ op: 'node.setMeta', nodeId, purpose: menuNode?.purpose === 'working' ? 'artifact' : 'working' })), m.setPurpose).catch(() => {}) })}>{menuNode?.purpose === 'working' ? m.markArtifact : m.markWorking}</button>
              {menuNode?.frameId ? <button role="menuitem" onClick={() => menuAction(() => { void applyOperations(leaveFrameOps(menuNode, allNodes), m.leaveFrame).catch(() => {}) })}>{m.leaveFrame}</button> : null}
              {menuNode && (menuNode.kind === 'image' || menuNode.kind === 'video') ? <button role="menuitem" disabled={!fittedHeight || fittedHeight === menuNode.h} onClick={() => menuAction(() => {
                if (fittedHeight) {
                  const growth = growFrames(allNodes.map(node => node.nodeId === menuNode.nodeId ? { ...node, h: fittedHeight } : node))
                  void applyOperations([...growth, { op: 'node.layout', nodeId: menuNode.nodeId, h: fittedHeight }], m.fitMedia).catch(() => {})
                }
              })}>{m.fitMedia}</button> : null}
              <hr />
            </> : null}
            {menuJobs.length && actions.onCancelGeneration ? <button role="menuitem" disabled={menuJobs.every(job => job.cancelRequestedAt !== undefined)} onClick={() => menuAction(() => { for (const job of menuJobs) void actions.onCancelGeneration!(job.jobId).catch(() => {}) })}>{m.cancelGeneration}</button> : null}
            {menuRecheck && !menuJobs.length && actions.onRecheck ? <button role="menuitem" onClick={() => menuAction(() => { void actions.onRecheck!(menuRecheck).catch(() => {}) })}>{m.recheck}</button> : null}
            {menuRetry && !menuJobs.length && actions.onRegenerate ? <button role="menuitem" onClick={() => menuAction(() => { void actions.onRegenerate!(menuRetry).catch(() => {}) })}>{decorations?.get(menuNode!.nodeId)?.problems.length ? m.regenerate : m.anotherVersion}</button> : null}
            {actions.onCreateTimelineFrom && canCreateTimeline(nodes.filter(node => menu.ids.includes(node.nodeId))) ? <button role="menuitem" onClick={() => menuAction(() => createTimelineFrom(menu.ids))}>{tl.create}</button> : null}
            <button role="menuitem" onClick={() => menuAction(() => copy(menu.ids))}>{m.copy}<kbd>{MOD}C</kbd></button>
            <button role="menuitem" disabled={!clipboard.length} onClick={() => menuAction(() => paste(clipboard, menu.at))}>{m.paste}<kbd>{MOD}V</kbd></button>
            <button role="menuitem" onClick={() => menuAction(() => duplicate(menu.ids))}>{m.duplicate}<kbd>{MOD}D</kbd></button>
            <button role="menuitem" onClick={() => menuAction(() => requestDelete(menu.ids))}>{m.delete}<kbd>Delete</kbd></button>
            <hr />
            <button role="menuitem" onClick={() => menuAction(() => actions.onReference?.(menu.ids))}>{m.sendReference}</button>
            <button role="menuitem" aria-haspopup="menu" aria-expanded={submenu} onClick={() => setSubmenu(!submenu)}>{m.generateReferenceMenu}<ChevronRightIcon /></button>
            {submenu ? <div role="menu" aria-label={m.generateReference} className="vis-context-submenu">
              <button role="menuitem" onClick={() => menuAction(() => referenceGenerate('image'))}>{m.generateImage}</button>
              <button role="menuitem" onClick={() => menuAction(() => referenceGenerate('audio'))}>{m.generateAudio}</button>
              <button role="menuitem" onClick={() => menuAction(() => referenceGenerate('video'))}>{m.generateVideo}</button>
            </div> : null}
            <button role="menuitem" onClick={() => menuAction(() => actions.onDownload(nodes.filter(n => menu.ids.includes(n.nodeId))))}>{m.download}</button>
          </> : <>
            <button role="menuitem" disabled={!actions.onImportWriting} onClick={() => menuAction(() => actions.onImportWriting?.(menu.at))}>{m.importWriting}</button>
            <button role="menuitem" onClick={() => menuAction(() => actions.onCreateText(menu.at))}>{m.newText}</button>
            <button role="menuitem" disabled={!actions.onCreateScript} onClick={() => menuAction(() => { void actions.onCreateScript?.(menu.at).then(id => selectCreated([id])).catch(error => setOperationError({ error })) })}>{sm.createScript}</button>
            <button role="menuitem" disabled={!actions.onCreatePreviz} onClick={() => menuAction(() => { void actions.onCreatePreviz?.(menu.at).then(id => selectCreated([id])).catch(error => setOperationError({ error })) })}>{pv.create}</button>
            <button role="menuitem" disabled={!actions.onCreateScene} onClick={() => menuAction(() => { void actions.onCreateScene?.(menu.at).then(id => selectCreated([id])).catch(error => setOperationError({ error })) })}>{sc.create}</button>
            <button role="menuitem" disabled={!actions.onCreateTimeline} onClick={() => menuAction(() => { void actions.onCreateTimeline?.(menu.at).then(id => selectCreated([id])).catch(error => setOperationError({ error })) })}>{tl.timeline}</button>
            <button role="menuitem" onClick={() => menuAction(() => actions.onCreateGenNode('image', menu.at))}>{m.generateImage}</button>
            <button role="menuitem" onClick={() => menuAction(() => actions.onCreateGenNode('audio', menu.at))}>{m.generateAudio}</button>
            <button role="menuitem" onClick={() => menuAction(() => actions.onCreateGenNode('video', menu.at))}>{m.generateVideo}</button>
            <button role="menuitem" onClick={() => menuAction(() => { uploadAt.current = menu.at; upload.current?.click() })}>{m.uploadMenu}</button>
            <hr />
            <button role="menuitem" disabled={!clipboard.length} onClick={() => menuAction(() => paste(clipboard, menu.at))}>{m.paste}<kbd>{MOD}V</kbd></button>
          </>}
        </div> : null}
        <input ref={upload} className="vis-upload-input" type="file" accept="image/*,video/*,audio/*" multiple aria-label={m.uploadMedia} onChange={event => {
          const files = [...(event.target.files ?? [])]
          if (files.length) {
            const center = uploadAt.current ?? viewportCenter()
            uploadAt.current = null
            actions.onDropFiles(files, { x: Math.round(center.x), y: Math.round(center.y) })
          }
          event.target.value = ''
        }} />
      </div>
    </Ctx.Provider>
  )
})

const SIDES = [Position.Top, Position.Right, Position.Bottom, Position.Left]

const NodeFrame = memo(function NodeFrame({ id, data, selected, children, versionBadge, reviewing }: { id: string; data: VisNodeData; selected: boolean; children: ReactNode; versionBadge?: ReactNode; reviewing?: boolean }) {
  const m = useMessages(messages)
  const tm = useMessages(toolbarMessages)
  const format = useFormat()
  const { locale } = useLocale()
  const actions = useCanvasActions()
  const { onResize, onDismissJobs, onDismissMediaTask, singleSelected, extend, extending, ordinal, assetUrl } = useCanvasSelector(state => ({
    onResize: state.onResize, onDismissJobs: state.onDismissJobs, onDismissMediaTask: state.onDismissMediaTask,
    singleSelected: state.selectedId === id, extend: state.extend, extending: state.selectedId === id && Boolean(state.extendingId),
    ordinal: state.titleNumbers.get(id) ?? 1, assetUrl: state.assetUrl,
  }), [id])
  const { view, deco } = data
  const hasPrompt = view.slots.some(s => s.slotKey === 'prompt')
  const problems = deco?.problems ?? []
  const activeJobs = deco?.activeJobs ?? []
  const [jobBusy, setJobBusy] = useState(false)
  const runJob = (work: () => Promise<unknown>) => {
    setJobBusy(true)
    void work().catch(() => {}).finally(() => setJobBusy(false))
  }
  const queued = activeJobs.length > 0 && activeJobs.every(job => job.status === 'queued')
  const concurrencyLimited = queued && activeJobs.some(job => job.queueReason === 'concurrency_limit')
  const cancelling = activeJobs.length > 0 && activeJobs.every(job => job.cancelRequestedAt !== undefined)
  const mainAsset = assetOf(view.slots.find(slot => slot.slotKey === 'main'))
  const mediaTask = deco?.mediaTask
  const processing = mediaTask?.status === 'queued' || mediaTask?.status === 'running'
  const [showExtend, setShowExtend] = useState(false)
  useEffect(() => { if (!singleSelected) setShowExtend(false) }, [singleSelected])
  return (
    <>
      {SIDES.map(side => (
        <Fragment key={side}>
          <Handle id={`out-${side}`} className="vis-source-handle" type="source" position={side} isConnectable={false} />
          <Handle id={`in-${side}`} className="vis-source-handle" type="target" position={side} isConnectable={false} />
        </Fragment>
      ))}
      <NodeResizer
        isVisible={selected}
        minWidth={MIN_SIZE}
        minHeight={view.slots.some(s => s.slotKey === 'prompt') ? 120 : MIN_SIZE}
        color="var(--vis-accent)"
        onResizeEnd={(_, p) => onResize(id, { x: Math.round(p.x), y: Math.round(p.y), w: Math.round(p.width), h: Math.round(p.height) })}
      />
      <div className="vis-node-label">
        <NodeTitle view={view} ordinal={ordinal} src={mainAsset ? assetUrl(mainAsset.assetVersionId) : undefined} onApply={actions.onApply} />
        <span className="vis-node-label-end">
          {deco?.running ? <span className="vis-node-badge is-running" title={concurrencyLimited ? m.concurrencyHint : undefined}>{cancelling ? m.cancelling : concurrencyLimited ? m.concurrencyQueued : queued ? m.queued : m.generating}{deco.running > 1 ? m.generationCount(format.number(deco.running)) : ''}</span> : null}
          {versionBadge}
        </span>
      </div>
      <div className={`vis-node vis-node-${view.kind}${selected ? ' is-selected' : ''}${reviewing ? ' is-viewing-version' : ''}${deco?.running ? ' is-generating' : ''}${problems.length ? problems.every(p => p.muted) ? ' has-notice' : ' has-problem' : ''}`}>
        {activeJobs.length && actions.onCancelGeneration ? <button
          className="vis-node-cancel nodrag nopan" aria-label={m.cancelGeneration} title={m.cancelGeneration}
          disabled={jobBusy || cancelling}
          onPointerDown={event => event.stopPropagation()}
          onKeyDown={event => event.stopPropagation()}
          onClick={() => runJob(() => Promise.all(activeJobs.map(job => actions.onCancelGeneration!(job.jobId))))}
        ><Icon kind="close" size={16} /></button> : null}
        <div className={`vis-node-body${view.format === 'code' ? ' vis-code-body' : ''}`}>{children}</div>
        {processing ? <div className="vis-node-media-progress" role="status">
          <span>{mediaTask.status === 'queued' ? tm.queued : tm.processing}</span>
          <progress aria-label={tm.processing} max={1} value={mediaTask.progress} />
          {mediaTask.progress !== undefined ? <span>{format.number(Math.round(mediaTask.progress * 100))}%</span> : null}
        </div> : null}
        {mediaTask?.status === 'failed' ? <div className="vis-node-media-failure nodrag nopan" role="alert" onPointerDown={event => event.stopPropagation()}>
          <span>{describeError(mediaTask.error ?? { message: tm.processFailed }, locale)}</span>
          {onDismissMediaTask ? <button aria-label={tm.dismiss} onClick={() => onDismissMediaTask(mediaTask.taskId)}><Icon kind="close" size={14} /></button> : null}
        </div> : null}
        {problems.length
          ? (
            <div className="vis-node-problem nodrag" title={problems.map(p => describeError(p, locale)).join('\n')}>
              <span>{describeError(problems[0]!, locale)}{problems.length > 1 ? m.moreProblems(format.number(problems.length - 1)) : ''}</span>
              {problems[0]!.recheckable && actions.onRecheck ? <button disabled={jobBusy || Boolean(deco?.running)} title={m.recheckHint} onClick={() => runJob(() => actions.onRecheck!(problems[0]!.jobId))}>{m.recheck}</button> : null}
              {actions.onRegenerate ? <button disabled={jobBusy || Boolean(deco?.running)} onClick={() => runJob(() => actions.onRegenerate!(problems[0]!.jobId))}>{m.regenerate}</button> : null}
              {onDismissJobs ? <button onClick={() => onDismissJobs(problems.map(p => p.jobId))}>{m.close}</button> : null}
            </div>
          )
          : null}
        {/* A new key remounts it so the animation plays once */}
        {deco?.deliveredSeq !== undefined ? <div key={deco.deliveredSeq} className="vis-node-flash" /> : null}
      </div>
      {singleSelected ? <>
        {hasPrompt ? <button
          className="vis-node-extend vis-node-extend-left nodrag nopan"
          aria-label={m.addTextInput} title={m.addTextInput}
          disabled={extending}
          onPointerDown={event => event.stopPropagation()}
          onKeyDown={event => event.stopPropagation()}
          onClick={() => extend(view, 'text')}
        ><Icon kind="plus" /></button> : null}
        <div className="vis-node-extension nodrag nopan" onPointerDown={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
          <button className="vis-node-extend" aria-label={m.extendNode} title={m.extendNode} aria-expanded={showExtend} disabled={extending} onClick={() => setShowExtend(!showExtend)}><Icon kind="plus" /></button>
          {showExtend ? <div className="vis-node-extend-menu">
            <button aria-label={m.extendImage} onClick={() => { setShowExtend(false); extend(view, 'image') }}><Icon kind="image" />{m.generateImage}</button>
            <button aria-label={m.extendAudio} onClick={() => { setShowExtend(false); extend(view, 'audio') }}><Icon kind="audio" />{m.generateAudio}</button>
            <button aria-label={m.extendVideo} onClick={() => { setShowExtend(false); extend(view, 'video') }}><Icon kind="video" />{m.generateVideo}</button>
          </div> : null}
        </div>
      </> : null}
    </>
  )
})


function Empty({ kind }: { kind: 'image' | 'video' | 'audio' }) {
  return <div className="vis-node-empty"><Icon kind={kind} /><span className="vis-empty-plus">+</span></div>
}

function assetOf(slot: SlotView | undefined) {
  return slot?.content.type === 'asset' ? slot.content : null
}

function useTextDraft(slot: SlotView | undefined, missingPromptNodeId?: string) {
  const actions = useCanvasActions()
  const body = slot?.content.type === 'text' ? slot.content.body : ''
  // Capture the revision when editing starts; blur and the generate button share the same submission
  const [draft, setDraft] = useState<{ text: string; baseRevision: number } | null>(null)
  const committing = useRef<Promise<boolean> | null>(null)
  // A saved draft stays on screen until the slot event with the new revision arrives; the RPC can answer first,
  // and clearing the draft then would briefly show the old body
  const saved = useRef<{ text: string; baseRevision: number } | null>(null)
  const [saving, setSaving] = useState(false)
  const revision = slot?.revision
  const latest = useRef({ revision, body })
  // Only the asynchronous commit result reads this; discarded renders must not replace it.
  useLayoutEffect(() => { latest.current = { revision, body } }, [revision, body])
  useEffect(() => {
    const done = saved.current
    if (!done || revision === undefined || (revision <= done.baseRevision && body !== done.text)) return
    saved.current = null
    // Typing that continued from the saved text builds on the user's own write, so it moves to the new revision
    setDraft(current => current === done ? null : current && current.baseRevision === done.baseRevision ? { ...current, baseRevision: revision } : current)
  }, [revision, body])

  const commit = (): Promise<boolean> => {
    if (committing.current) return committing.current
    if (!draft || (!slot && (!missingPromptNodeId || !actions.onApply))) return Promise.resolve(true)
    if (draft.text === body && draft.baseRevision === (slot?.revision ?? 0)) {
      setDraft(null)
      return Promise.resolve(true)
    }
    setSaving(true)
    const write = slot ? actions.onTextCommit(slot.slotId, draft.text, draft.baseRevision)
      : actions.onApply!([{ op: 'node.setPrompt', nodeId: missingPromptNodeId!, body: draft.text, expectedRevision: draft.baseRevision }]).then(() => 'ok' as const)
    committing.current = write
      .then(result => {
        if (result === 'ok' && (latest.current.revision ?? 0) <= draft.baseRevision && latest.current.body !== draft.text) saved.current = draft
        else setDraft(current => current === draft ? null : current)
        return result === 'ok'
      })
      .catch(() => false)
      .finally(() => {
        committing.current = null
        setSaving(false)
      })
    return committing.current
  }

  return { body, draft, setDraft, commit, saving }
}

const TextNode = memo(function TextNode({ id, data, selected }: NodeProps<VisNode>) {
  const m = useMessages(messages)
  const slot = data.view.slots.find(s => s.slotKey === 'main')
  const { body, draft, setDraft, commit, saving } = useTextDraft(slot)
  const actions = useCanvasActions()
  const code = data.view.format === 'code'
  const f = useFormat()
  const long = !code && body.length >= WRITING_LIMITS.longText
  const words = useMemo(() => code ? 0 : writingWordCount(body), [body, code])
  const opening = useMemo(() => markdownOpening(body), [body])

  return (
    <NodeFrame id={id} data={data} selected={selected}>
      <div className="vis-text-card-content">
        {/* The bar is where people grab the card, so only its button opts out of dragging. */}
        {!code && actions.onOpenWriting ? <div className="vis-writing-card-bar"><span>{m.writingWords(f.number(words))}{data.deco?.writingEdits ? ` · ${m.writingReviewCount(f.number(data.deco.writingEdits))}` : ''}</span><button className="nodrag nopan" onClick={() => actions.onOpenWriting?.(id)}>{m.openWriting}</button></div> : null}
        {code ? <CodeRender nodeId={id} revision={slot?.revision ?? 0} edited={Boolean(draft && draft.text !== body)} actions={actions} commit={commit} /> : null}
        {draft
          ? (
            <textarea
              aria-label={m.textContent}
              className={`vis-node-text-edit nodrag nowheel nopan${code ? ' vis-code-text' : ''}`}
              autoFocus
              readOnly={saving}
              value={draft.text}
              onChange={e => setDraft({ ...draft, text: e.target.value })}
              onBlur={() => void commit()}
              onKeyDown={e => {
                e.stopPropagation()
                if (e.key === 'Escape') setDraft(null)
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault()
                  void commit()
                }
              }}
            />
          )
          : (
            <div
              className={`vis-node-text-body${code ? ' vis-code-text' : ' vis-node-markdown'}`}
              onWheelCapture={event => nodeWheel(event, selected)}
              onDoubleClick={e => {
                if (!slot) return
                e.stopPropagation()
                if (long && actions.onOpenWriting) actions.onOpenWriting(id)
                else setDraft({ text: body, baseRevision: slot.revision })
              }}
            >
              {body ? code ? body : <TextDisplay body={long ? opening : body} title={data.view.title} /> : <span className="vis-node-placeholder">{m.editHint}</span>}
            </div>
          )}
      </div>
    </NodeFrame>
  )
})

const TextDisplay = memo(function TextDisplay({ body, title }: { body: string; title?: string | null | undefined }) {
  const low = useStore(textDetailSelector)
  const overview = useMemo(() => low ? textOverview(body, title) : null, [body, title, low])
  return overview
    ? <span className="vis-node-text-summary">{overview.title ? <span className="vis-node-text-overview-title">{overview.title}</span> : null}{overview.summary ? <span>{overview.summary}</span> : null}</span>
    : <MarkdownBody body={body} />
})

function PromptEditor({ view, slot, source, operation }: { view: NodeView; slot: SlotView | undefined; source: SlotVersionView['source']; operation?: { operation: GenerationOperation; onClose(): void } | undefined }) {
  const { actions, nodes, assetUrl, posterUrl, visible, picking, setPickingId } = useCanvasSelector(state => ({
    actions: state.actions, nodes: state.selectedId === view.nodeId ? state.allNodes : EMPTY_NODES, assetUrl: state.assetUrl, posterUrl: state.posterUrl,
    visible: state.selectedId === view.nodeId, picking: state.pickingId === view.nodeId, setPickingId: state.setPickingId,
  }), [view.nodeId])
  const { nodeId } = view
  const generation = useGenerationChoice(view, actions.onSetGeneration)
  const { body, draft, setDraft, commit, saving } = useTextDraft(slot, isOperationSource(source) ? nodeId : undefined)
  useEffect(() => {
    // Deselecting can unmount the overlay without a browser blur event.
    if (!visible) void commit()
  }, [visible])
  // Hidden React Flow toolbars still subscribe to every viewport update and scan the node list.
  if (!visible) return null
  return <NodeToolbar nodeId={nodeId} isVisible={visible} position={Position.Bottom} offset={16}>
    <PromptPanel view={view} nodes={nodes} text={draft?.text ?? body} saving={saving} generation={generation} actions={actions} assetUrl={assetUrl} posterUrl={posterUrl} source={source} operation={operation} editingDraft={draft !== null} expectedPromptRevision={draft?.baseRevision ?? slot?.revision ?? 0}
      picking={picking} onPick={() => setPickingId(picking ? null : nodeId)}
      onChange={text => setDraft({ text, baseRevision: draft?.baseRevision ?? slot?.revision ?? 0 })}
      onCommit={commit} onReset={() => setDraft(null)} />
  </NodeToolbar>
}

const PrevizNode = memo(function PrevizNode({ id, data, selected }: NodeProps<VisNode>) {
  const { actions, thumbnailUrl, assetUrl, posterUrl, nodes, allNodes, selectedPanel, selectPanel } = useCanvasSelector(state => ({ actions: state.actions, allNodes: state.allNodes, thumbnailUrl: state.thumbnailUrl, assetUrl: state.assetUrl, posterUrl: state.posterUrl,
    nodes: state.nodes, selectedPanel: state.selectedPanel?.nodeId === id ? state.selectedPanel.panelId : null, selectPanel: state.selectPanel }), [id])
  const content = data.view.slots.find(slot => slot.slotKey === 'main')?.content
  return <NodeFrame id={id} data={data} selected={selected}>
    {content?.type === 'previz' ? <PrevizNodeContent node={data.view} doc={content.doc} actions={actions} thumbnailUrl={thumbnailUrl} assetUrl={assetUrl} posterUrl={posterUrl} nodes={nodes} references={allNodes} selected={selected} panelId={selectedPanel} onSelect={panelId => selectPanel(id, panelId)} /> : <Icon kind="previz" />}
  </NodeFrame>
})

const TimelineNode = memo(function TimelineNode({ id, data, selected }: NodeProps<VisNode>) {
  const slot = data.view.slots.find(slot => slot.slotKey === 'main')
  const history = useCanvasHistory(id, slot?.slotId ?? '')
  const { allNodes, nodes, actions, assetUrl, posterUrl, singleSelected } = useCanvasSelector(state => ({
    allNodes: state.allNodes, nodes: state.nodes, actions: state.actions,
    assetUrl: state.assetUrl, posterUrl: state.posterUrl, singleSelected: state.selectedId === id,
  }), [id])
  const task = data.deco?.mediaTask
  return <NodeFrame id={id} data={data} selected={selected}>
    {slot?.content.type === 'timeline' ? <TimelineNodeContent view={data.view} slot={slot} doc={slot.content.doc} nodes={allNodes} layoutNodes={nodes} actions={actions} assetUrl={assetUrl} posterUrl={posterUrl} selected={singleSelected} playerSelected={selected} processing={task?.status === 'queued' || task?.status === 'running'} history={history} /> : <Icon kind="timeline" />}
  </NodeFrame>
})

const ScriptNode = memo(function ScriptNode({ id, data, selected }: NodeProps<VisNode>) {
  const { nodes, actions, assetUrl, posterUrl, singleSelected, pickingId, suspended, selectNode, selectPanel } = useCanvasSelector(state => ({
    nodes: state.allNodes, actions: state.actions, assetUrl: state.assetUrl, posterUrl: state.posterUrl, singleSelected: state.selectedId === id,
    pickingId: state.pickingId, suspended: state.suspended, selectNode: state.selectNode, selectPanel: state.selectPanel,
  }), [id])
  const flow = useReactFlow()
  const slot = data.view.slots.find(slot => slot.slotKey === 'main')
  const prompt = data.view.slots.find(slot => slot.slotKey === 'prompt')
  if (slot?.content.type !== 'script') return <NodeFrame id={id} data={data} selected={selected}><Icon kind="script" /></NodeFrame>
  return <NodeFrame id={id} data={data} selected={selected}>
    <ScriptNodeContent view={data.view} slot={slot} doc={slot.content.doc} deco={data.deco} nodes={nodes} actions={actions}
      selected={singleSelected} suspended={suspended || Boolean(pickingId)} onPanelFocus={(nodeId, panelId) => selectPanel(nodeId, panelId)} assetUrl={assetUrl} posterUrl={posterUrl} onFocus={nodeId => {
        selectNode(nodeId)
        const target = nodes.find(node => node.nodeId === nodeId)
        if (target) void flow.setCenter(target.x + target.w / 2, target.y + target.h / 2, { zoom: flow.getZoom(), duration: 0 })
        requestAnimationFrame(() => document.querySelectorAll<HTMLElement>('.react-flow__node').forEach(node => { if (node.getAttribute('data-id') === nodeId) node.focus() }))
      }}>
      {(parts, expanded) => prompt ? <ScriptPromptEditor view={data.view} slot={prompt} parts={parts} expanded={expanded} /> : null}
    </ScriptNodeContent>
  </NodeFrame>
})

function ScriptPromptEditor({ view, slot, parts, expanded }: { view: NodeView; slot: SlotView; parts: ScriptPartProps; expanded: boolean }) {
  const m = useMessages(scriptMessages)
  const { actions, nodes, assetUrl, posterUrl, visible, picking, setPickingId } = useCanvasSelector(state => ({
    actions: state.actions, nodes: state.selectedId === view.nodeId ? state.allNodes : EMPTY_NODES, assetUrl: state.assetUrl, posterUrl: state.posterUrl,
    visible: state.selectedId === view.nodeId, picking: state.pickingId === view.nodeId, setPickingId: state.setPickingId,
  }), [view.nodeId])
  const { body, draft, setDraft, commit, saving } = useTextDraft(slot)
  const input = useRef<PromptRefInputHandle>(null)
  const upload = useRef<HTMLInputElement>(null)
  const replay = useRef(false)
  const [uploading, setUploading] = useState(false)
  const references = useMemo(() => numberedReferences(view.inputs ?? [], nodes), [view.inputs, nodes])
  const shown = visible && !expanded
  useEffect(() => { if (!shown) void commit() }, [shown])
  if (!shown) return null
  return <NodeToolbar nodeId={view.nodeId} isVisible={visible} position={Position.Bottom} offset={16}>
    <section className="vis-script-input-panel vis-prompt-panel nodrag nopan nowheel" aria-label={m.promptInput} style={{ width: Math.max(420, view.w) }}
      onPointerDown={event => event.stopPropagation()} onKeyDown={event => {
        if (!((event.metaKey || event.ctrlKey) && ['z', 'y'].includes(event.key.toLowerCase()))) event.stopPropagation()
      }}>
      <div className="vis-prompt-sources">
        <button aria-label={m.addReference} aria-pressed={picking} onClick={() => setPickingId(picking ? null : view.nodeId)}><Icon kind="plus" size={14} />{m.addReference}</button>
        <button aria-label={m.uploadReference} disabled={!actions.onUploadReference || uploading} onClick={() => upload.current?.click()}><Icon kind="upload" size={14} />{m.uploadReference}</button>
        <input ref={upload} type="file" accept="image/*,video/*,audio/*" multiple hidden onChange={event => {
          const files = Array.from(event.currentTarget.files ?? [])
          event.currentTarget.value = ''
          if (!files.length || !actions.onUploadReference) return
          setUploading(true)
          void actions.onUploadReference(view.nodeId, files).catch(() => {}).finally(() => setUploading(false))
        }} />
      </div>
      {references.length ? <ReferenceStrip references={references} assetUrl={assetUrl} posterUrl={posterUrl} onInsert={id => input.current?.insert(id)}
        onRemove={id => void actions.onSetInputs(view.nodeId, (view.inputs ?? []).filter(input => input !== id)).catch(() => {})} /> : null}
      <PromptRefInput ref={input} value={draft?.text ?? body} references={references} canvas={{ nodeId: view.nodeId, nodes, allKinds: true, attach: nodeId => actions.onSetInputs(view.nodeId, [...new Set([...(view.inputs ?? []), nodeId])]) }} assetUrl={assetUrl} posterUrl={posterUrl} placeholder={m.promptInput} readOnly={saving}
        onChange={text => setDraft({ text, baseRevision: draft?.baseRevision ?? slot.revision })} onCommit={() => void commit()} onReset={() => setDraft(null)} onComposing={() => {}} />
      <div onClickCapture={event => {
        const target = event.target instanceof Element ? event.target.closest('button') : null
        if (!target || !draft || replay.current) return
        // Agent requests read the prompt slot: commit the focused draft before replaying the user's button click.
        event.preventDefault()
        event.stopPropagation()
        void commit().then(ok => {
          if (!ok || !target.isConnected) return
          replay.current = true
          target.click()
          replay.current = false
        })
      }}><ScriptAgentBar {...parts} {...{ requestText: draft?.text ?? body }} tasks={['breakdown', 'custom']} /></div>
    </section>
  </NodeToolbar>
}

const MediaNode = memo(function MediaNode({ id, data, selected }: NodeProps<VisNode>) {
  const { locale } = useLocale()
  const versions = useCanvasHistory(id, data.view.slots.find(slot => slot.slotKey === 'main')!.slotId)
  const { assetUrl, posterUrl, actions, singleSelected, nodes, selectNode, generationOperations, suspended } = useCanvasSelector(state => ({
    assetUrl: state.assetUrl, posterUrl: state.posterUrl, suspended: state.suspended,
    actions: state.actions, singleSelected: state.selectedId === id, nodes: state.selectedId === id ? state.nodes : EMPTY_NODES, selectNode: state.selectNode,
    generationOperations: state.selectedId === id ? state.generationOperations : undefined,
  }), [id])
  const history = useNodeVersions({ view: data.view, history: versions, actions, selected: singleSelected, nodes, selectNode, assetUrl, posterUrl, running: Boolean(data.deco?.running) })
  const asset = history.content.type === 'asset' ? history.content : null
  const main = data.view.slots.find(s => s.slotKey === 'main')
  const prompt = data.view.slots.find(s => s.slotKey === 'prompt')
  // Provenance identifies whether an unseeded node needs legacy Restore or can start a fresh generate draft.
  const versionSource = versions?.find(version => version.source?.jobId === history.source?.jobId && version.content.type === 'asset' && asset?.assetVersionId === version.content.assetVersionId)?.source
  const [exporting, setExporting] = useState(false)
  const [active, setActive] = useState<(ToolbarEntry & { operation: LocalOperation }) | null>(null)
  const [operation, setOperation] = useState<GenerationOperation | null>(null)
  const closeOperation = useCallback(() => setOperation(null), [])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const task = data.deco?.mediaTask
  const processing = task?.status === 'queued' || task?.status === 'running'
  const kind = data.view.kind === 'audio' ? 'audio' : data.view.kind === 'video' ? 'video' : 'image'
  const Panel = active ? OPERATION_PANELS[active.operation] : undefined
  useEffect(() => { setActive(null); setError(null) }, [singleSelected, main?.revision])
  useEffect(() => { if (!singleSelected) closeOperation() }, [singleSelected, closeOperation])
  useEffect(() => {
    if (!active || busy || suspended) return
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopImmediatePropagation()
      setActive(null)
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [active, busy, suspended])
  const submit = async (operation: LocalOperation, params: Record<string, unknown>) => {
    if (!main || !actions.onMediaProcess) return
    setBusy(true)
    setError(null)
    try {
      const result = await actions.onMediaProcess({ operation, nodeId: id, slotId: main.slotId, expectedRevision: main.revision, params })
      if (result.status === 'failed') throw result.error
      if (result.status === 'succeeded') setActive(null)
    } finally { setBusy(false) }
  }
  const run = (entry: ToolbarEntry) => {
    setError(null)
    const local = LocalOperation.safeParse(entry.operation)
    if (!local.success) { setActive(null); setOperation(entry.operation as GenerationOperation); return }
    closeOperation()
    if (OPERATION_PANELS[local.data]) { setActive({ ...entry, operation: local.data }); return }
    setBusy(true)
    void submit(local.data, {}).catch(setError).finally(() => setBusy(false))
  }
  return (
    <>
      {singleSelected ? <NodeOperationsToolbar nodeId={id} nodes={nodes} kind={kind} generation={generationOperations?.[kind]}
        disabled={!asset || busy || processing || history.previewing} onOperation={run}
        sourceJobId={versionSource?.jobId} running={Boolean(data.deco?.running)}
        regenerateDisabled={!asset || busy || processing}
        onRegenerate={actions.onRegenerateNode ? jobId => actions.onRegenerateNode!(id, jobId).catch(setError) : undefined}
        {...(actions.onCreateTimelineFrom && canCreateTimeline([data.view]) ? { onCreateTimeline: () => { void actions.onCreateTimelineFrom!([id]).then(selectNode).catch(setError) } } : {})}
        onDownload={() => actions.onDownload([data.view])} onExportMov={kind === 'video' && actions.onMediaProcess && actions.onResolveAsset && actions.onMediaCancel && actions.onMediaDismiss && actions.onMediaDownload ? () => setExporting(true) : undefined} onFullscreen={() => openPreview(id)} /> : null}
      {exporting && asset && main ? <MovExportDialog key={asset.assetVersionId} node={data.view} slot={main} assetVersionId={asset.assetVersionId} actions={actions} task={task} onClose={() => setExporting(false)} /> : null}
      <NodeFrame id={id} data={data} selected={selected} versionBadge={history.badge} reviewing={history.reviewing}>
        <div ref={history.ref} className="vis-version-body" onDoubleClick={event => { if (asset) { event.stopPropagation(); openPreview(id) } }}>
          {Panel && active && asset && main ? <Panel key={`${active.operation}:${active.variant ?? ''}:${asset.assetVersionId}`} view={data.view} slot={main} assetVersionId={asset.assetVersionId} src={assetUrl(asset.assetVersionId)} onPreview={actions.onPreview}
            {...(active.variant ? { variant: active.variant } : {})} onSubmit={params => submit(active.operation, params)} onCancel={() => setActive(null)}
            {...(actions.onMediaAnalyze ? { onAnalyze: () => actions.onMediaAnalyze!(id, main.slotId) } : {})} />
            : asset && data.view.kind === 'audio' ? <AudioPlayer key={asset.assetVersionId} assetId={asset.assetVersionId} src={assetUrl(asset.assetVersionId)} selected={singleSelected} onPreview={actions.onPreview} /> : asset ? <VersionMedia hasAlpha={asset.hasAlpha} assetId={asset.assetVersionId} kind={data.view.kind === 'video' ? 'video' : 'image'} selected={selected} assetUrl={assetUrl} posterUrl={posterUrl} previewing={history.previewing} source={history.source} /> : <Empty kind={data.view.kind === 'audio' ? 'audio' : data.view.kind === 'video' ? 'video' : 'image'} />}
          {!active ? history.bar : null}
          {error ? <div className="vis-node-media-failure" role="alert">{describeError(error, locale)}</div> : null}
        </div>
      </NodeFrame>
      {!active ? history.toolbar : null}
      {prompt || versionSource || operation ? <PromptEditor view={data.view} slot={prompt} source={versionSource}
        operation={operation ? { operation, onClose: closeOperation } : undefined} /> : null}
    </>
  )
})

const FrameNode = memo(function FrameNode({ id, data, selected }: NodeProps<VisNode>) {
  const m = useMessages(messages)
  const { running, onResize } = useCanvasSelector(state => ({
    running: state.frameRunning.get(id) ?? false, onResize: state.onResize,
  }), [id])
  const zoom = useStore(zoomSelector)
  return <div className={`vis-frame${selected ? ' is-selected' : ''}${running ? ' is-generating' : ''}`} style={{ '--frame-color': FRAME_COLORS[data.view.frame?.color ?? 'gray'] } as CSSProperties}>
    <NodeResizer isVisible={selected} minWidth={FRAME_MIN_SIZE.w} minHeight={FRAME_MIN_SIZE.h} color="var(--vis-accent)"
      onResizeEnd={(_, p) => onResize(id, { x: Math.round(p.x), y: Math.round(p.y), w: Math.round(p.width), h: Math.round(p.height) })} />
    {/* Grow the enlarged title upward, out of the frame: member cards render above frames and would hide its lower part. */}
    <div className="vis-frame-header" style={zoom < 0.35 ? { transform: `scale(${1 / zoom})`, transformOrigin: 'bottom left', width: 'max-content', maxWidth: data.view.w * zoom, background: 'var(--vis-panel)' } : undefined}>
      <strong>{data.view.frame?.title ?? m.frame}</strong>
    </div>
  </div>
})

const SceneNode = memo(function SceneNode({ id, data, selected }: NodeProps<VisNode>) {
  const m = useMessages(sceneMessages)
  const f = useFormat()
  const { actions, thumbnailUrl } = useCanvasSelector(state => ({ actions: state.actions, thumbnailUrl: state.thumbnailUrl }), [])
  const content = data.view.slots.find(slot => slot.slotKey === 'main')?.content
  const views = content?.type === 'scene' ? content.doc.views : []
  const first = views[0]
  const name = data.view.title ?? m.scene
  return <NodeFrame id={id} data={data} selected={selected}>
    <section className="vis-scene-card" aria-label={m.label(name, f.number(views.length))} onDoubleClick={event => { event.stopPropagation(); actions.onOpenScene?.(id) }}>
      <div className="vis-scene-picture">{first?.still ? <img src={thumbnailUrl(first.still)} alt={first.name} draggable={false} loading="lazy" /> : <div className="vis-scene-empty"><Icon kind="scene" size={36} /><p>{views.length ? m.noStill : m.empty}</p></div>}</div>
      <footer><div><strong>{name}</strong>{data.deco?.sceneProposals ? <span>{m.proposals(f.number(data.deco.sceneProposals))}</span> : null}<span>{m.views(f.number(views.length))}{content?.type === 'scene' && content.doc.durationS !== undefined ? <span className="vis-scene-duration">{m.duration(f.number(content.doc.durationS))}</span> : null}</span></div><button className="nodrag nopan" disabled={!actions.onOpenScene} onPointerDown={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()} onClick={() => actions.onOpenScene?.(id)}>{m.open}</button></footer>
    </section>
  </NodeFrame>
})
const NODE_CONTENTS = { frame: FrameNode, text: TextNode, script: ScriptNode, timeline: TimelineNode, previz: PrevizNode, scene: SceneNode, image: MediaNode, video: MediaNode, audio: MediaNode }
const EMPTY_NODE_VIEWS: ReadonlyMap<string, NodeView> = new Map()
export function selectCanvasNode(state: CanvasContext, history: SlotVersionView[] | undefined, id: string) {
  const view = state.nodeViews.get(id)
  if (!view) return null
  const kind = view.kind
  const selected = state.selectedId === id
  return {
    view, decoration: state.decorations?.get(id), suspended: state.suspended,
    history,
    ordinal: state.titleNumbers.get(id), running: state.frameRunning.get(id) ?? false,
    selectNode: state.selectNode, selectedPanel: selected ? state.selectedPanel : null, selectPanel: state.selectPanel, assetUrl: state.assetUrl, posterUrl: state.posterUrl, thumbnailUrl: state.thumbnailUrl, actions: state.actions,
    setPickingId: state.setPickingId, pickImage: state.pickImage, extend: state.extend, onResize: state.onResize,
    onDismissJobs: state.onDismissJobs, onDismissMediaTask: state.onDismissMediaTask,
    nodes: selected || kind === 'script' || kind === 'timeline' || kind === 'previz' ? state.nodes : EMPTY_NODES,
    // Attached references remain valid when their source nodes are hidden.
    allNodes: selected || kind === 'timeline' || kind === 'script' || kind === 'previz' ? state.allNodes : EMPTY_NODES,
    selectedId: selected ? id : null,
    pickingId: kind === 'script' || state.pickingId === id ? state.pickingId : null,
    extendingId: selected ? state.extendingId : null,
    scriptSessions: kind === 'script' ? state.scriptSessions : undefined,
    currentScriptSessionId: kind === 'script' ? state.currentScriptSessionId : undefined,
    generationOperations: selected ? state.generationOperations : undefined,
  }
}
type NodeSnapshot = NonNullable<ReturnType<typeof selectCanvasNode>>

const CanvasNode = memo(function CanvasNode(props: NodeProps<VisNode> & { snapshot: NodeSnapshot }) {
  const { view, decoration, history, ordinal, running, ...state } = props.snapshot
  const { id } = props
  const data = useMemo(() => ({ view, deco: decoration }), [view, decoration])
  const slotId = data.view.slots.find(slot => slot.slotKey === 'main')?.slotId ?? ''
  const historyViews = useMemo(() => new Map([[id, data.view]]), [id, data.view])
  const histories = useMemo(() => new Map(history ? [[slotId, history]] : []), [slotId, history])
  const historySnapshot = useMemo(() => ({ nodeViews: historyViews, histories }), [historyViews, histories])
  const kind = data.view.kind
  const titleNumbers = useMemo(() => new Map(ordinal === undefined ? [] : [[id, ordinal]]), [id, ordinal])
  const decorations = useMemo(() => decoration ? new Map([[id, decoration]]) : undefined, [id, decoration])
  const frameRunning = useMemo(() => new Map([[id, running]]), [id, running])
  const scoped = useShallowValue({
    ...state, nodeViews: EMPTY_NODE_VIEWS, titleNumbers, decorations, frameRunning,
  })
  const Content = NODE_CONTENTS[kind]
  return <Ctx.Provider value={scoped}>
    <HistoriesCtx.Provider value={historySnapshot}>
    <Content {...props} data={data} />
    </HistoriesCtx.Provider>
  </Ctx.Provider>
}, (previous, next) => {
  // React Flow reconciles data later; the immutable snapshot already supplies the current view and decoration.
  const { snapshot: previousSnapshot, data: _previousData, ...previousProps } = previous
  const { snapshot: nextSnapshot, data: _nextData, ...nextProps } = next
  return shallowEqual(previousSnapshot, nextSnapshot) && shallowEqual(previousProps, nextProps)
})

const CanvasNodeSelection = memo(function CanvasNodeSelection(props: NodeProps<VisNode>) {
  // Context wakes this small gate; only a changed node slice reaches the memoized renderer and allocates Maps.
  const state = useContext(Ctx)!
  const view = state.nodeViews.get(props.id)
  const slotId = view && view.kind !== 'text' && view.kind !== 'frame' && view.kind !== 'script'
    ? view.slots.find(slot => slot.slotKey === 'main')?.slotId ?? '' : ''
  const history = useHistorySelection(useContext(HistoriesCtx)!, view, slotId)
  const snapshot = useShallowValue(selectCanvasNode(state, history, props.id))
  return useMemo(() => snapshot ? <CanvasNode {...props} snapshot={snapshot} /> : null, [props, snapshot])
})
const NODE_TYPES = { frame: CanvasNodeSelection, text: CanvasNodeSelection, script: CanvasNodeSelection, timeline: CanvasNodeSelection, previz: CanvasNodeSelection, scene: CanvasNodeSelection, image: CanvasNodeSelection, video: CanvasNodeSelection, audio: CanvasNodeSelection }

function NodePreview({ view, origin, onSelect, onClose, running }: { running: boolean; view: NodeView; origin: DOMRect | undefined; onSelect(id: string): void; onClose(): void }) {
  const { nodes, actions, selectNode, assetUrl, posterUrl } = useCanvasSelector(state => ({
    nodes: state.nodes, actions: state.actions, selectNode: state.selectNode, assetUrl: state.assetUrl, posterUrl: state.posterUrl,
  }), [])
  const versions = useCanvasHistory(view.nodeId, view.slots.find(slot => slot.slotKey === 'main')!.slotId)
  const history = useNodeVersions({ view, history: versions, actions, selected: true, nodes, selectNode, assetUrl, posterUrl, running, preview: true })
  const displayed = nodes.map(node => node.nodeId === view.nodeId ? { ...node, slots: node.slots.map(slot => slot.slotKey === 'main' ? { ...slot, content: history.content, source: history.source } : slot) } : node)
  return <Lightbox nodes={displayed} nodeId={view.nodeId} assetUrl={assetUrl} origin={origin} onSelect={onSelect} onClose={onClose} onPreview={actions.onPreview} footer={history.toolbar ? <>{history.toolbar}{history.bar}</> : null} />
}
