import { useWritingProposals } from './writing-proposals'
import { describeError, useLocale, useMessages, useFormat, type Locale } from '@vis/ui-kit'
import { mySkillsMessages, messages } from './messages'
import { RpcError } from './rpc'
import { localizedProvider } from './providerLabels'
import { CanvasView, GenerationSettingsContext, latestTimelineExport, previzMessages, timelineSummary } from '@vis/canvas-ui'
import type { AgentKind, ApprovalDecision, MethodResult, NodeView, TranscriptItem } from '@vis/protocol'
import { AgentsContext, EMPTY_AGENTS, agentLabel, type MentionNode, type RefChip, type RefPreview, type SkillOption, type WorkspaceInput, SessionPanel, ProjectSwitcher, SkillManager, type SkillManagerActions, useAttachments } from '@vis/workbench-ui'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { type Notice } from './actions'
import { useCanvasCallbacks } from './canvas-callbacks'
import { generationOperations } from './operations'
import { describeSpaceError, type SpaceConnection, useSpaceView } from './space'
import { ProviderSettings } from './ProviderSettings'
import { GenerationUsage, type GenerationUsageData } from './GenerationUsage'
import { nodeDecorations, sortedNodes } from './store'
import { useWorkUI } from './WorkUI'
import { ProjectDeleteDialog } from './ProjectDelete'
import { withScriptDecorations, type ScriptRequestRecord } from './script-actions'
import { WritingEditorMount, CanvasWritingImport } from './writing-editor'
import '@vis/writing-ui/writing.css'
import { PrevizEditorMount } from './previz-editor'
import { SceneEditorMount, type ScenePanelTarget } from './scene-editor'
import '@vis/previz-ui/previz.css'
import { TimelineEditor } from '@vis/timeline-ui'
import '@vis/timeline-ui/timeline.css'
import { timelineEditorHost, useTimelineEditorNodes } from './timeline-editor'
// RFC 0027: library shell, media and settings hosts, and per-project panel preferences.
import { GroupIntoSettingDialog, LIBRARY_ASSET_MIME, LibraryPanel, LibraryRunControls, SettingPicker, SettingsHeader, libraryShellMessages, readLibraryPreference, writeLibraryPreference, type LibraryHost, type LibraryTab } from '@vis/library-ui'
import '@vis/library-ui/library.css'
import { libraryCanvasDrop, libraryHost } from './library-host'
import { createScriptSettingsHost, createSettingsHost } from './library-settings-host'
import { createSeriesProjectHost } from './series-project-host'
import type { ProjectSeriesInput } from '@vis/workbench-ui'

const libraryDropTypes = [LIBRARY_ASSET_MIME]
const statusLabels = (m: typeof messages['en']) => ({ connecting: m.connecting, open: m.connected, closed: m.reconnecting } as const)
const kindLabels = (m: typeof messages['en']): Record<NodeView['kind'], string> => ({ text: m.text, image: m.image, video: m.video, audio: m.audio, frame: m.frame, script: m.script, timeline: m.timeline, previz: m.previz, scene: m.scene })
let noticeId = 0
const rid = () => `web-${crypto.randomUUID()}`

function refLabel(node: NodeView | undefined, m: typeof messages['en']): string {
  if (!node) return m.deletedNode
  if (node.title) return node.title
  const c = (node.slots.find(slot => slot.slotKey === 'main') ?? node.slots[0])?.content
  if (c?.type === 'text') {
    const line = c.body.replace(/\s+/g, ' ').trim()
    return line ? m.textRef(line.length > 14 ? `${line.slice(0, 14)}…` : line) : m.emptyText
  }
  return kindLabels(m)[node.kind]
}

export function nodeRefPreview(node: NodeView | undefined, assetUrl: (id: string) => string, m: typeof messages['en'], nodes: readonly NodeView[] = [], locale: Locale = 'en'): RefPreview {
  const label = refLabel(node, m)
  if (!node || node.kind === 'frame') return { kind: 'missing', label }
  const content = (node.slots.find(slot => slot.slotKey === 'main') ?? node.slots[0])?.content
  if (content?.type === 'script') return { kind: 'script', shots: content.doc.shots.length, assets: content.doc.assets.length, label: node.title ?? label }
  if (content?.type === 'previz') {
    const image = content.doc.panels.find(panel => panel.image)?.image
    return image ? { kind: 'image', src: assetUrl(image), label: node.title ?? m.previz } : { kind: 'text', text: m.previz, label: node.title ?? m.previz }
  }
  if (content?.type === 'scene') {
    const still = content.doc.views[0]?.still
    return still ? { kind: 'image', src: assetUrl(still), label } : { kind: 'text', text: m.scene, label }
  }
  if (content?.type === 'timeline') {
    const summary = timelineSummary(content.doc, locale)
    const exported = latestTimelineExport(node.nodeId, nodes)
    const asset = exported?.slots.find(slot => slot.slotKey === 'main')?.content
    return asset?.type === 'asset' ? { kind: exported?.kind === 'audio' ? 'audio' : 'video', src: assetUrl(asset.assetVersionId), label: `${node.title ?? label} · ${summary}` } : { kind: 'text', text: summary, label: node.title ?? label }
  }
  if (content?.type === 'text') return { kind: 'text', text: content.body, label }
  if (content?.type === 'asset' && node.kind !== 'text' && node.kind !== 'script' && node.kind !== 'timeline' && node.kind !== 'previz' && node.kind !== 'scene') return { kind: node.kind, src: assetUrl(content.assetVersionId), label }
  return { kind: 'empty', nodeKind: node.kind === 'timeline' || node.kind === 'previz' || node.kind === 'scene' ? 'video' : node.kind, label }
}

/** An @ list item: show category, containing frame, and opening text alongside thumbnails to distinguish similar-looking nodes */
function mentionNode(node: NodeView, nodes: Map<string, NodeView>, selected: boolean, m: typeof messages['en']): MentionNode {
  const c = (node.slots.find(slot => slot.slotKey === 'main') ?? node.slots[0])?.content
  const line = c?.type === 'text' ? c.body.replace(/\s+/g, ' ').trim() : ''
  const category = node.category?.trim()
  const label = c?.type === 'text' ? (line ? (line.length > 18 ? `${line.slice(0, 18)}…` : line) : m.emptyText) : `${category ?? ''}${kindLabels(m)[node.kind]}`
  const frame = node.frameId ? nodes.get(node.frameId)?.frame?.title : undefined
  const detail = [c?.type === 'text' ? [category, kindLabels(m)[node.kind]].filter(Boolean).join('') : '', frame ? m.inFrame(frame) : ''].filter(Boolean).join(' · ')
  return { nodeId: node.nodeId, label, detail, selected }
}

export function App({ conn, localePreference, onLocaleChange }: { conn: SpaceConnection; localePreference: Locale | null; onLocaleChange(locale: Locale | null): Promise<void> }) {
  const { locale } = useLocale()
  const pm = useMessages(previzMessages)
  const m = useMessages(messages)
  const sm = useMessages(mySkillsMessages)
  const libraryMessages = useMessages(libraryShellMessages)
  const currentLocale = useRef(locale)
  currentLocale.current = locale
  const currentMessages = useRef(m)
  currentMessages.current = m
  const format = useFormat()
  const view = useSpaceView(conn)
  const viewError = view.error ? describeSpaceError(view.error, locale) : null
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsSection, setSettingsSection] = useState<'guardrails' | 'mySkills'>()
  const [settingsDraft, setSettingsDraft] = useState<string>()
  const skillDraftHost = useMemo(() => ({
    state: (draftId: string) => conn.rpc.call<MethodResult<'skill.draftState'>>('skill.draftState', { draftId }),
    discard: (draftId: string, expectedRevision: number) => conn.rpc.call('skill.discardDraft', { draftId, expectedRevision }),
    subscribe: (listener: () => void) => conn.rpc.onSkillsChanged?.(listener) ?? (() => {}),
    review: (draftId: string) => { setSettingsDraft(draftId); setSettingsSection('mySkills'); setSettingsOpen(true) },
  }), [conn])
  const [usageOpen, setUsageOpen] = useState(false)
  const [usage, setUsage] = useState<GenerationUsageData | null>(null)
  const [usageError, setUsageError] = useState('')
  const [previzPanelId, setPrevizPanelId] = useState<string | undefined>()
  const [composerDraft, setComposerDraft] = useState<{ sessionId: string; text: string; seq: number }>()
  const [writingQuote, setWritingQuote] = useState<string>()
  const [scriptShot, setScriptShot] = useState<{ nodeId: string; shotId: string; seq: number }>()
  const [writingId, setWritingId] = useState<string | null>(null)
  const [writingImportAt, setWritingImportAt] = useState<{ x: number; y: number } | null>(null)
  const [previzId, setPrevizId] = useState<string | null>(null)
  const [sceneRequest, setSceneRequest] = useState<{ nodeId: string; viewId?: string; target?: ScenePanelTarget } | null>(null)
  const [timelineId, setTimelineId] = useState<string | null>(null)
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === ',') { event.preventDefault(); setSettingsOpen(true) }
    }
    window.addEventListener('keydown', shortcut)
    return () => window.removeEventListener('keydown', shortcut)
  }, [])
  const providers = useMemo(() => view.providers ? { ...view.providers, providers: view.providers.providers.map(provider => localizedProvider(provider, locale)) } : null, [view.providers, locale])
  const nodes = useMemo(() => sortedNodes(view.state), [view.state.nodes])
  const previousDecorations = useRef<ReturnType<typeof nodeDecorations>['byNode'] | undefined>(undefined)
  const deco = useMemo(() => {
    return nodeDecorations(view.state, locale, previousDecorations.current)
  }, [view.state.nodes, view.state.jobs, view.state.mediaTasks, view.state.scriptBatches, view.state.delivered, locale])
  useLayoutEffect(() => { previousDecorations.current = deco.byNode }, [deco.byNode])
  const running = [...view.state.jobs.values()].filter(j => !['succeeded', 'failed', 'unknown', 'cancelled'].includes(j.status)).length
  const sessions = useMemo(() => [...view.state.sessions.values()].filter(session => !session.workItemId || !view.work.deletedIds.has(session.workItemId)).sort((a, b) => a.createdAt - b.createdAt), [view.state.sessions, view.work.deletedIds])
  const spaceId = view.space?.spaceId
  const generationSettings = useMemo(() => ({ catalog: providers, spaceId: spaceId ?? '', onManage: () => setSettingsOpen(true) }), [providers, spaceId])
  useEffect(() => {
    if (!view.ready) { setUsage(null); return }
    let current = true
    const refresh = () => conn.rpc.call<GenerationUsageData>('generation.usage', {}).then(result => {
      if (current) { setUsage(result); setUsageError('') }
    }, error => { if (current) setUsageError(m.usageFailed(describeError(error, locale))) })
    void refresh()
    const timer = setInterval(() => void refresh(), 60_000)
    return () => { current = false; clearInterval(timer) }
  }, [conn, view.ready, view.state.jobs, view.providers, view.projects, spaceId, usageOpen, locale, m])
  const assetUrl = useCallback(
    (assetVersionId: string) => `/assets/${encodeURIComponent(spaceId ?? '')}/${encodeURIComponent(assetVersionId)}?t=${encodeURIComponent(conn.token)}`,
    [spaceId, conn.token],
  )

  const posterUrl = useCallback(
    (assetVersionId: string) => `/previews/${encodeURIComponent(spaceId ?? '')}/${encodeURIComponent(assetVersionId)}/poster?t=${encodeURIComponent(conn.token)}`,
    [spaceId, conn.token],
  )
  const thumbnailUrl = useCallback((id: string) => posterUrl(id).replace('/poster?', '/thumbnail?'), [posterUrl])
  const scriptSettingsHost = useMemo(() => createScriptSettingsHost(conn, assetUrl), [conn, assetUrl])
  const seriesProjectHost = useMemo(() => createSeriesProjectHost(conn), [conn])

  const [notices, setNotices] = useState<Notice[]>([])
  const dismiss = useCallback((id: number) => setNotices(list => list.filter(n => n.id !== id)), [])
  const notify = useCallback((n: Omit<Notice, 'id'>) => {
    const id = ++noticeId
    setNotices(list => [...list.slice(-3), { ...n, id }])
    // Keep notices containing drafts until the user closes them
    if (!n.copy) setTimeout(() => dismiss(id), 6000)
  }, [dismiss])
  const fail = useCallback((what: () => string) => (error: unknown) => notify({ kind: 'error', text: currentMessages.current.failed(what(), describeError(error, currentLocale.current)) }), [notify])
  const [deletingProject, setDeletingProject] = useState<{ spaceId: string; name: string; requestId: string; plan: MethodResult<'space.deletePlan'> | null; loading: boolean; busy: boolean; error: string } | null>(null)
  const planProjectDelete = async (spaceId: string) => {
    const project = conn.getView().projects.find(project => project.spaceId === spaceId)
    if (!project) return
    const requestId = rid()
    setDeletingProject({ spaceId, name: project.name, requestId, plan: null, loading: true, busy: false, error: '' })
    try {
      const plan = await conn.rpc.call<MethodResult<'space.deletePlan'>>('space.deletePlan', { spaceId })
      setDeletingProject(previous => previous?.requestId === requestId ? { ...previous, plan, loading: false } : previous)
    } catch (error) { setDeletingProject(previous => previous?.requestId === requestId ? { ...previous, loading: false, error: m.deletePlanFailed(describeError(error, locale)) } : previous) }
  }
  const deleteProject = async () => {
    if (!deletingProject?.plan || deletingProject.busy || deletingProject.loading) return
    const project = deletingProject
    setDeletingProject({ ...project, busy: true, error: '' })
    try {
      const result = await conn.rpc.call<MethodResult<'space.delete'>>('space.delete', { requestId: project.requestId, spaceId: project.spaceId })
      setDeletingProject(null)
      notify({ kind: 'info', text: m.projectDeleted(project.name) })
      const billed = result.cancelledJobs.filter(job => !job.providerCancelled).length
      if (billed) notify({ kind: 'info', text: m.billedJobs(format.number(billed)) })
      await conn.refreshProjects().catch(fail(() => currentMessages.current.refreshProjects))
    } catch (error) { setDeletingProject(previous => previous?.requestId === project.requestId ? { ...previous, busy: false, error: m.deleteFailed(describeError(error, locale)) } : previous) }
  }
  useEffect(() => {
    if (!view.ready || timelineId || previzId || sceneRequest || writingId || writingImportAt) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.altKey) return
      const target = event.target
      if (target instanceof HTMLElement && target.closest('.vis-tl-editor, .library-panel, .library-dialog')) return
      if (target instanceof HTMLElement && (target.isContentEditable || target.matches('input, textarea'))) return
      const key = event.key.toLowerCase()
      const method = (event.metaKey || event.ctrlKey) && key === 'z'
        ? event.shiftKey ? 'canvas.redo' : 'canvas.undo'
        : event.ctrlKey && key === 'y' && !event.shiftKey ? 'canvas.redo' : null
      if (!method) return
      event.preventDefault()
      conn.rpc.call<{ operationId: string; description: string } | { nothing: true }>(method, { requestId: rid() })
        .then(result => {
          if ('nothing' in result) notify({ kind: 'info', text: currentMessages.current.nothingTo(method === 'canvas.undo' ? currentMessages.current.undo : currentMessages.current.redo) })
        }, fail(() => method === 'canvas.undo' ? currentMessages.current.undo : currentMessages.current.redo))
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [conn, view.ready, notify, fail, m, timelineId, previzId, sceneRequest, writingId, writingImportAt])

  // -- Sessions --
  const [openSessionId, setOpenSessionId] = useState<string | null>(null)
  const [scriptRequests, setScriptRequests] = useState<ScriptRequestRecord[]>([])
  const previousScriptDecorations = useRef<ReturnType<typeof withScriptDecorations> | undefined>(undefined)
  const scriptDecorations = useMemo(() => {
    return withScriptDecorations(nodes, view.state.sessions, deco.byNode, scriptRequests, view.talk.transcripts, previousScriptDecorations.current)
  }, [nodes, view.state.sessions, deco.byNode, scriptRequests, view.talk.transcripts])
  useLayoutEffect(() => { previousScriptDecorations.current = scriptDecorations }, [scriptDecorations])
  const [panelCollapsed, setPanelCollapsed] = useState(() => { try { return localStorage.getItem('vis.session.collapsed') === 'true' } catch { return false } })
  const selectSession = (sessionId: string | null) => { setOpenSessionId(sessionId); if (sessionId) setPanelCollapsed(false) }
  const [selected, setSelected] = useState<string[]>([])
  const [focusRequest, setFocusRequest] = useState<{ nodeId: string; seq: number } | { nodeIds: string[]; seq: number }>()
  const timelineUpload = useRef<HTMLInputElement>(null)
  const timelineReturnFocus = useRef<string | null>(null)
  const closeWriting = useCallback(() => { setWritingId(null); requestAnimationFrame(() => { document.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(timelineReturnFocus.current ?? '')}"]`)?.focus({ preventScroll: true }) }) }, [])
  const closeWritingImport = useCallback(() => setWritingImportAt(null), [])
  const closePreviz = useCallback(() => {
    setPrevizId(null)
    requestAnimationFrame(() => {
      const target = [...document.querySelectorAll<HTMLElement>('.react-flow__node')].find(element => element.getAttribute('data-id') === timelineReturnFocus.current)
      target?.focus({ preventScroll: true })
    })
  }, [])
  const closeScene = useCallback(() => {
    setSceneRequest(null)
    if (sceneRequest?.target && conn.getView().state.nodes.has(sceneRequest.target.nodeId)) {
      setPrevizPanelId(sceneRequest.target.panelId)
      setPrevizId(sceneRequest.target.nodeId)
      return
    }
    requestAnimationFrame(() => {
      const target = [...document.querySelectorAll<HTMLElement>('.react-flow__node')].find(element => element.getAttribute('data-id') === timelineReturnFocus.current)
      target?.focus({ preventScroll: true })
    })
  }, [conn, sceneRequest])
  const closeTimeline = useCallback(() => {
    setTimelineId(null)
    requestAnimationFrame(() => {
      const target = [...document.querySelectorAll<HTMLElement>('.react-flow__node')].find(element => element.getAttribute('data-id') === timelineReturnFocus.current)
      target?.focus({ preventScroll: true })
    })
  }, [])
  useEffect(() => { setTimelineId(null); setPrevizId(null); setSceneRequest(null); setWritingId(null); setWritingImportAt(null) }, [spaceId])
  const writing = useWritingProposals(conn, view.space?.spaceId, view.ready)
  const writingNode = writingId ? view.state.nodes.get(writingId) : undefined
  const previzNode = previzId ? view.state.nodes.get(previzId) : undefined
  const sceneNode = sceneRequest ? view.state.nodes.get(sceneRequest.nodeId) : undefined
  useEffect(() => { if (sceneRequest && view.ready && !sceneNode) closeScene() }, [sceneRequest, view.ready, sceneNode, closeScene])
  const timelineNode = timelineId ? view.state.nodes.get(timelineId) : undefined
  const [sessionRefs, setSessionRefs] = useState<Record<string, string[]>>({})
  const attachments = useAttachments(openSessionId, async file => {
    if (!spaceId) throw new Error(m.selectProject)
    const res = await fetch(`/upload?t=${encodeURIComponent(conn.token)}&space=${encodeURIComponent(spaceId)}&name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file })
    const json = await res.json()
    if (!res.ok) throw new RpcError(json.error?.code ?? 'unavailable', json.error?.message ?? `HTTP ${res.status}`, json.error?.data ?? json.error)
    return json as MethodResult<'asset.import'>
  })
  const refs = openSessionId ? sessionRefs[openSessionId] ?? [] : []
  const setRefs = (update: string[] | ((value: string[]) => string[])) => { if (openSessionId) setSessionRefs(current => ({ ...current, [openSessionId]: typeof update === 'function' ? update(current[openSessionId] ?? []) : update })) }
  const [skills, setSkills] = useState<SkillOption[]>([])
  const [skillManager, setSkillManager] = useState<{ spaceId: string; importOpen: boolean } | null>(null)
  const refreshSkills = useCallback(async () => {
    if (!spaceId) return
    const result = await conn.rpc.call<MethodResult<'fs.listSkills'>>('fs.listSkills', { spaceId })
    if (conn.getView().space?.spaceId === spaceId) setSkills(result.skills ?? [])
  }, [conn, spaceId])
  const onRefreshSkills = useCallback(() => { void refreshSkills().catch(fail(() => currentMessages.current.readSkills)) }, [refreshSkills, fail])
  useEffect(() => conn.rpc.onSkillsChanged?.(onRefreshSkills), [conn, onRefreshSkills])
  const skillActions = useMemo<SkillManagerActions>(() => {
    const target = skillManager?.spaceId
    const normalizeStage = (result: MethodResult<'skill.stage'>): MethodResult<'skill.stage'> => {
      if (!result.stagingId) throw new Error(m.missingStaging)
      return { ...result, source: result.source ?? '', candidates: (result.candidates ?? []).map(candidate => ({ ...candidate, description: candidate.description ?? '', fileCount: candidate.fileCount ?? 0, bytes: candidate.bytes ?? 0, executables: candidate.executables ?? [], exists: candidate.exists ?? false })), skipped: result.skipped ?? [] }
    }
    return {
      list: async (id = target) => {
        const result = await conn.rpc.call<MethodResult<'skill.list'>>('skill.list', { spaceId: id })
        return { skillsPath: result.skillsPath ?? '', skills: result.skills ?? [], problems: result.problems ?? [] }
      },
      projects: async () => (await conn.rpc.call<MethodResult<'space.list'>>('space.list', {})).spaces ?? [],
      folder: async () => {
        const result = await conn.rpc.call<MethodResult<'fs.pickDirectory'>>('fs.pickDirectory', {})
        if (result.unsupported) throw new Error(m.unsupportedFolder)
        if (!result.path) return
        return normalizeStage(await conn.rpc.call<MethodResult<'skill.stage'>>('skill.stage', { spaceId: target, path: result.path }))
      },
      upload: async file => {
        const res = await fetch(`/upload?t=${encodeURIComponent(conn.token)}&space=${encodeURIComponent(target ?? '')}&name=${encodeURIComponent(file.name)}&kind=skill`, { method: 'POST', body: file })
        const json = await res.json()
        if (!res.ok) throw new RpcError(json.error?.code ?? 'unavailable', json.error?.message ?? `HTTP ${res.status}`, json.error?.data ?? json.error)
        return normalizeStage(json)
      },
      stage: async input => normalizeStage(await conn.rpc.call<MethodResult<'skill.stage'>>('skill.stage', { ...input, spaceId: target })),
      import: async input => {
        const result = await conn.rpc.call<MethodResult<'skill.import'>>('skill.import', { ...input, spaceId: target })
        return { imported: result.imported ?? [], replaced: result.replaced ?? [] }
      },
      discard: async stagingId => { await conn.rpc.call('skill.discard', { stagingId }) },
      remove: name => conn.rpc.call<MethodResult<'skill.remove'>>('skill.remove', { spaceId: target, name }),
      reveal: async () => {
        const result = await conn.rpc.call<MethodResult<'fs.reveal'>>('fs.reveal', { spaceId: target, skills: true })
        if (!result.revealed) notify({ kind: 'info', text: m.skillPath(result.path ?? '') })
      },
      subscribe: listener => conn.rpc.onSkillsChanged?.(listener) ?? (() => {}),
      changed: refreshSkills,
      notice: text => notify({ kind: 'info', text }),
    }
  }, [conn, skillManager?.spaceId, refreshSkills, notify, m])
  const [sessionSkills, setSessionSkills] = useState<Record<string, SkillOption[]>>({})
  const selectedSkills = openSessionId ? sessionSkills[openSessionId] ?? [] : []
  const setSelectedSkills = (update: SkillOption[] | ((value: SkillOption[]) => SkillOption[])) => { if (openSessionId) setSessionSkills(current => ({ ...current, [openSessionId]: typeof update === 'function' ? update(current[openSessionId] ?? []) : update })) }
  useEffect(() => { setOpenSessionId(null); setSelected([]); setSessionRefs({}); setSessionSkills({}); setSkills([]); setFocusRequest(undefined) }, [spaceId])
  useEffect(() => {
    if (!openSessionId) return
    conn.loadTranscript(openSessionId).catch(fail(() => currentMessages.current.readTranscript))
    return () => conn.closeTranscript(openSessionId)
  }, [openSessionId, conn, fail])
  useEffect(() => {
    let current = true
    setSkills([])
    if (spaceId && view.ready) conn.rpc.call<{ skills: SkillOption[] }>('fs.listSkills', { spaceId }).then(result => { if (current) setSkills(result.skills ?? []) }, fail(() => currentMessages.current.readSkills))
    return () => { current = false }
  }, [spaceId, conn, view.ready, fail])

  const work = useWorkUI({ conn, view, notify, activeSessionId: openSessionId,
    openSession: selectSession,
    closeSession: () => setOpenSessionId(null),
    focusNode: nodeId => { setFocusRequest(request => ({ nodeId, seq: (request?.seq ?? 0) + 1 })) },
    locateChanges,
    openSettings: () => { setSettingsSection('guardrails'); setSettingsOpen(true) },
  })
  const locateRequest = useRef(0)
  async function locateChanges(workItemId: string) {
    const item = conn.getView().work.items.get(workItemId)
    if (!item) return
    const request = ++locateRequest.current
    work.showCanvas()
    await conn.selectProject(item.spaceId)
    const changed = await conn.rpc.call<MethodResult<'work.changes'>>('work.changes', { spaceId: item.spaceId, workItemId })
    if (request !== locateRequest.current || !conn.getView().ready || conn.getView().space?.spaceId !== item.spaceId) return
    const nodeIds = [...new Set(changed.changes.map(change => change.nodeId))].filter(id => conn.getView().state.nodes.has(id))
    if (nodeIds.length) setFocusRequest(previous => ({ nodeIds, seq: (previous?.seq ?? 0) + 1 }))
    else notify({ kind: 'info', text: m.nodesGone })
  }
  const scriptSessions = useMemo(() => sessions.map(session => ({
    sessionId: session.sessionId, title: session.title, agentKind: session.agentKind,
    archived: !!session.workItemId && (!view.work.items.has(session.workItemId) || !!view.work.items.get(session.workItemId)?.archivedAt),
  })), [sessions, view.work.items])
  const operations = useMemo(() => generationOperations(view.providers), [view.providers])
  const historySource = useMemo(() => ({ subscribe: conn.subscribe, getSnapshot: () => conn.getView().state }), [conn])
  const actions = useCanvasCallbacks(conn, notify, spaceId, {
    agents: view.agents,
    locale,
    openSession: selectSession,
    focus: nodeId => setFocusRequest(previous => ({ nodeId, seq: (previous?.seq ?? 0) + 1 })),
    openPreviz: (nodeId, panelId) => { timelineReturnFocus.current = nodeId; setPrevizPanelId(panelId); setPrevizId(nodeId) },
    openScene: nodeId => { timelineReturnFocus.current = nodeId; setSceneRequest({ nodeId }) },
    previzDraft: (nodeId, text) => {
      if (!openSessionId) { notify({ kind: 'info', text: m.openSession }); return }
      setRefs(previous => [...new Set([...previous, nodeId])])
      setComposerDraft(previous => ({ sessionId: openSessionId, text, seq: (previous?.seq ?? 0) + 1 }))
      setPanelCollapsed(false)
    },
    openWriting: (nodeId, quote) => { timelineReturnFocus.current = nodeId; setWritingQuote(quote); setWritingId(nodeId) },
    importWriting: at => setWritingImportAt(at),
    openTimeline: nodeId => {
      timelineReturnFocus.current = nodeId
      setTimelineId(nodeId)
    },
    record: record => setScriptRequests(previous => [...previous.slice(-199), record]),
    selection: ids => setSelected(previous => previous.length === ids.length && previous.every((id, index) => id === ids[index]) ? previous : ids),
    reference: ids => {
      if (openSessionId) { setRefs(r => [...new Set([...r, ...ids])]); setPanelCollapsed(false) }
      else notify({ kind: 'info', text: m.openSession })
    },
  })
  const timelineTask = useMemo(() => [...view.state.mediaTasks.values()]
    .filter(task => task.nodeId === timelineId && task.operation === 'timeline.export')
    .sort((a, b) => b.createdAt - a.createdAt)[0], [view.state.mediaTasks, timelineId])
  const timelineNodes = useTimelineEditorNodes(timelineNode, nodes)
  const timelineWriter = timelineNode?.slots.find(slot => slot.slotKey === 'main')?.writer
  const writingDecorations = useMemo(() => {
    const result = new Map(scriptDecorations)
    for (const proposal of writing.proposals) {
      const previous = result.get(proposal.nodeId) ?? { running: 0, problems: [] }
      result.set(proposal.nodeId, { ...previous, writingEdits: (previous.writingEdits ?? 0) + proposal.edits.filter(edit => edit.status === 'pending' || edit.status === 'stale').length })
    }
    if (scriptShot) result.set(scriptShot.nodeId, { ...(result.get(scriptShot.nodeId) ?? { running: 0, problems: [] }), scriptShot })
    return result
  }, [scriptDecorations, writing.proposals, scriptShot])
  const timelineWriterTitle = timelineWriter?.actor === 'agent' && timelineWriter.sessionId ? view.state.sessions.get(timelineWriter.sessionId)?.title : undefined
  const timelineHost = useMemo(() => timelineNode && view.ready ? timelineEditorHost({
    conn, node: timelineNode, nodes: timelineNodes, actions, locale,
    close: closeTimeline,
    focus: nodeId => { timelineReturnFocus.current = nodeId; setFocusRequest(previous => ({ nodeId, seq: (previous?.seq ?? 0) + 1 })) },
    upload: () => timelineUpload.current?.click(),
  }) : null, [conn, timelineNode, timelineNodes, actions, locale, closeTimeline, view.ready, spaceId, timelineTask, timelineWriterTitle])
  // A2: keep library host identity stable across unrelated canvas and session renders.
  const [libraryPreference, setLibraryPreference] = useState({ projectId: '', open: false, tab: 'media' as LibraryTab })
  const [libraryEntityId, setLibraryEntityId] = useState<string>()
  useEffect(() => {
    setLibraryPreference({ projectId: spaceId ?? '', ...readLibraryPreference(spaceId ?? '') })
    setLibraryEntityId(undefined)
  }, [spaceId])
  const changeLibrary = useCallback((patch: Partial<{ open: boolean; tab: LibraryTab }> | ((current: { open: boolean; tab: LibraryTab }) => Partial<{ open: boolean; tab: LibraryTab }>)) => {
    if (!spaceId) return
    setLibraryPreference(previous => {
      const current = previous.projectId === spaceId ? previous : readLibraryPreference(spaceId)
      const next = { ...current, projectId: spaceId, ...(typeof patch === 'function' ? patch(current) : patch) }
      writeLibraryPreference(spaceId, next)
      return next
    })
  }, [spaceId])
  const closeLibrary = useCallback(() => changeLibrary({ open: false }), [changeLibrary])
  const showLibraryMedia = useCallback((entityId?: string) => {
    setLibraryEntityId(entityId)
    changeLibrary({ open: true, tab: 'media' })
  }, [changeLibrary])
  const focusLibraryNode = useCallback((nodeId: string) => {
    setSelected([nodeId])
    setFocusRequest(previous => ({ nodeId, seq: (previous?.seq ?? 0) + 1 }))
  }, [])
  const openLibrarySession = useCallback((sessionId: string) => { setOpenSessionId(sessionId); setPanelCollapsed(false) }, [])
  const assetLibraryHost = useMemo((): LibraryHost | null => view.ready && spaceId ? {
    ...libraryHost({ conn, close: closeLibrary, focus: focusLibraryNode, openSession: openLibrarySession, showMedia: showLibraryMedia, entityId: libraryEntityId }),
    ...createSettingsHost({ conn, assetUrl, showMembers: showLibraryMedia }),
  } : null, [conn, view.ready, spaceId, assetUrl, closeLibrary, focusLibraryNode, openLibrarySession, showLibraryMedia, libraryEntityId])
  const dropLibraryMedia = useCallback((data: DataTransfer, at: { x: number; y: number }) => libraryCanvasDrop(conn, data, at, ops => actions.onApply!(ops), fail(() => libraryMessages.import)), [conn, actions, fail, libraryMessages.import])
  const transcript = openSessionId ? view.talk.transcripts.get(openSessionId) : undefined
  useEffect(() => {
    if (!view.ready || !transcript) return
    const known = new Map([...(usage?.jobs ?? []).map(job => [job.jobId, job] as const), ...view.state.jobs])
    // Historical tools may refer to jobs that are no longer available; omit their result cards.
    void conn.loadTranscriptJobs(transcript.items, known).catch(() => {})
  }, [conn, transcript?.items, spaceId, view.ready, view.state.jobs, usage?.jobs, fail])
  const refChips: RefChip[] = refs.map(nodeId => ({ nodeId }))
  // @ reference candidates: selected canvas nodes first, then canvas order; frames are organizational containers and cannot be references
  const mentionNodes: MentionNode[] = [...view.state.nodes.values()].filter(node => node.kind !== 'frame')
    .map(node => mentionNode(node, view.state.nodes, selected.includes(node.nodeId), m))
    .sort((a, b) => Number(b.selected) - Number(a.selected))
  const resolveRef = (nodeId: string): RefPreview => {
    const node = view.state.nodes.get(nodeId)
    const preview = nodeRefPreview(node, assetUrl, m, nodes, locale)
    const content = node?.slots.find(slot => slot.slotKey === 'main')?.content
    return preview.kind === 'video' && content?.type === 'asset' ? { ...preview, posterSrc: posterUrl(content.assetVersionId) } : preview
  }

  const onCreate = async ({ spaceId: projectId, ...input }: WorkspaceInput) => {
    await conn.selectProject(projectId)
    if (!conn.getView().ready || conn.getView().space?.spaceId !== projectId) throw new Error(m.projectNotReady)
    const explicitTitle = input.title?.trim()
    const previous = explicitTitle ? [] : (await conn.rpc.call('session.list', { includeArchived: true })).sessions as typeof sessions
    const title = explicitTitle || `${agentLabel(view.agents ?? EMPTY_AGENTS, input.agentKind)} ${previous.filter(session => session.agentKind === input.agentKind).length + 1}`
    if (!conn.getView().ready || conn.getView().space?.spaceId !== projectId) throw new Error(m.projectChanged)
    const result = await conn.rpc.call('work.create', { requestId: rid(), spaceId: projectId, title, workDir: input.workDir, chat: { agentKind: input.agentKind } })
    conn.mergeWorkItems([result.item])
    if (!explicitTitle && result.item.sessions[0]) {
      // Work-item titles are required; ordinary sessions still let the agent name them when the title is empty.
      await conn.rpc.call('session.resetTitle', { requestId: rid(), sessionId: result.item.sessions[0].sessionId }).catch(fail(() => currentMessages.current.agentTitle))
    }
    if (conn.getView().space?.spaceId !== projectId) return
    if (result.item.sessions[0]) { selectSession(result.item.sessions[0].sessionId) }
    if (result.queued) notify({ kind: 'info', text: m.queued })
  }
  const onCreateProject = async (name: string, rootPath: string | undefined, agentKind: AgentKind | null, series?: ProjectSeriesInput) => {
    const project = await conn.rpc.call('space.create', { requestId: rid(), name, ...(rootPath ? { rootPath } : {}), ...series })
    if (project.skippedSkills?.length) notify({ kind: 'info', text: sm.skipped(project.skippedSkills.join(', ')) })
    await conn.refreshProjects()
    await conn.selectProject(project.spaceId)
    // The project already exists; do not roll it back if the first workspace fails, as users can retry in the session area
    if (agentKind) await onCreate({ spaceId: project.spaceId, agentKind }).catch(fail(() => currentMessages.current.firstWorkspace))
  }
  const onPickDirectory = useCallback(async (defaultPath?: string) => {
    const result = await conn.rpc.call<{ path?: string; cancelled: boolean; unsupported: boolean }>('fs.pickDirectory', { ...(defaultPath ? { defaultPath } : {}) })
    if (result.unsupported) notify({ kind: 'info', text: m.enterFolder })
    return result.path
  }, [conn, notify, m])
  const onValidateDirectory = useCallback((path: string) => conn.rpc.call<{ valid: boolean; error?: string }>('fs.validateDirectory', { path }), [conn])
  const onListSkills = useCallback(async (input: { spaceId: string }) => (await conn.rpc.call<{ skills: SkillOption[] }>('fs.listSkills', input)).skills ?? [], [conn])
  const revealDirectory = async (target: { sessionId: string } | { spaceId: string }) => {
    try {
      const result = await conn.rpc.call<{ path: string; revealed: boolean }>('fs.reveal', target)
      if (!result.revealed) { await navigator.clipboard.writeText(result.path); notify({ kind: 'info', text: m.pathCopied(result.path) }) }
    } catch (error) { fail(() => currentMessages.current.openFolder)(error) }
  }
  const onSend = async (text: string) => {
    if (!openSessionId) return
    const sentAttachmentIds = attachments.attachments.map(item => item.id)
    const sent = refs.filter(id => view.state.nodes.has(id))
    try {
      await conn.rpc.call('session.sendMessage', { requestId: rid(), sessionId: openSessionId, text, refs: [...sent.map(nodeId => ({ nodeId, versionPolicy: 'latest-at-execution' as const })), ...attachments.refs], skills: selectedSkills.map(skill => skill.name) })
      attachments.clear(sentAttachmentIds)
      if (conn.getView().space?.spaceId === spaceId) { setRefs(current => current.filter(id => !sent.includes(id))); setSelectedSkills(current => current.filter(skill => !selectedSkills.some(sentSkill => sentSkill.path === skill.path))) }
    } catch (error) {
      fail(() => currentMessages.current.send)(error)
      throw error
    }
  }
  const onStop = (sessionId: string) => {
    const s = view.state.sessions.get(sessionId)
    if (s?.activeTurnId) conn.rpc.call('session.stop', { requestId: rid(), sessionId: s.sessionId, turnId: s.activeTurnId }).catch(fail(() => currentMessages.current.stop))
  }
  const onRespondApproval = async (approvalId: string, decision: ApprovalDecision) => {
    try { await conn.rpc.call('session.respondApproval', { requestId: rid(), approvalId, decision }) }
    catch (error) { fail(() => currentMessages.current.approve)(error); throw error }
  }

  return (
    <AgentsContext.Provider value={view.agents}><div className="app">
      <header className="app-header">
        <ProjectSwitcher
          projects={view.projects}
          projectsDir={view.projectsDir}
          projectId={spaceId ?? null}
          seriesHost={seriesProjectHost}
          projectAttention={new Set(view.work.inboxCounts?.bySpace.filter(project => project.unresolved > 0).map(project => project.spaceId))}
          onSelectProject={conn.selectProject}
          onCreateProject={onCreateProject}
          onDeleteProject={id => { void planProjectDelete(id) }}
          onPickDirectory={onPickDirectory}
          onRevealProject={() => { if (spaceId) void revealDirectory({ spaceId }) }}
        />
        <span role="status" className={`app-status is-${view.status}`} aria-label={statusLabels(m)[view.status]} title={[statusLabels(m)[view.status], view.ready ? m.nodeCounts(format.number(nodes.length), format.number(running)) : ''].filter(Boolean).join(' · ')}>{view.status !== 'open' ? statusLabels(m)[view.status] : null}</span>
        {work.runningButton}
        {view.ready ? <div className="app-usage"><button className="app-toolbar-button" aria-label={m.usageLabel} title={m.todayUsage(usage ? format.number(usage.image) : '…', usage ? format.number(usage.video) : '…', usage ? format.number(usage.audio) : '…')} aria-expanded={usageOpen} onClick={() => setUsageOpen(!usageOpen)}><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M4 4v16h16M8 16v-4m5 4V8m5 8V5" /></svg></button>{usageOpen ? <GenerationUsage usage={usage} error={usageError} spaceId={spaceId} onClose={() => setUsageOpen(false)} onCancel={actions.onCancelGeneration!} onRegenerate={actions.onRegenerate!} onRecheck={actions.onRecheck!} onSelectProject={id => { void conn.selectProject(id).catch(fail(() => currentMessages.current.switchProject)) }} /> : null}</div> : null}
        {work.inboxButton}
        {view.ready ? <button aria-label={libraryMessages.library} aria-expanded={libraryPreference.projectId === spaceId && libraryPreference.open} onClick={() => changeLibrary(current => ({ open: !current.open }))}>{libraryMessages.library}</button> : null}
        {deco.unanchored.problems.length
          ? (
            <span className="app-error">
              {deco.unanchored.problems[0]!.message}
              {deco.unanchored.problems[0]!.recheckable ? <button title={m.recheckHint} onClick={() => void actions.onRecheck!(deco.unanchored.problems[0]!.jobId).catch(() => {})}>{m.recheck}</button> : null}
              <button onClick={() => void actions.onRegenerate!(deco.unanchored.problems[0]!.jobId).catch(() => {})}>{m.regenerate}</button>
              <button onClick={() => conn.dismissJobs(deco.unanchored.problems.map(p => p.jobId))}>{m.close}</button>
            </span>
          )
          : null}
        {viewError ? <span className="app-error">{viewError}</span> : null}
        <button className="app-toolbar-button" aria-label={m.settings} title={m.settingsShortcut} onClick={() => setSettingsOpen(true)}><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9.5 3-.5 3-2 1-2.8-1-2.5 4.3L4 12l-2.3 1.7L4.2 18 7 17l2 1 .5 3h5l.5-3 2-1 2.8 1 2.5-4.3L20 12l2.3-1.7L19.8 6 17 7l-2-1-.5-3Z" /><circle cx="12" cy="12" r="3" /></svg></button>
      </header>
      <main className="app-main">
        <div className="app-workspace" data-canvas-surface>
        {work.statusDropBar}
        <div className="app-view-switch" data-canvas-obstacle="top">{work.tabs}</div>
        {view.ready
          ? (
            <>
              <div className="app-canvas" style={{ display: work.mainView === 'canvas' ? 'flex' : 'none', flex: 1, minWidth: 0 }}>
              <GenerationSettingsContext.Provider value={generationSettings}>
              <CanvasView key={spaceId} hidden={work.mainView !== 'canvas'} suspended={!!timelineHost || !!previzNode || !!sceneNode || !!writingNode || !!writingImportAt} nodes={nodes} historySource={historySource} decorations={writingDecorations} onDismissJobs={conn.dismissJobs} onDismissMediaTask={conn.dismissMediaTask} assetUrl={assetUrl} posterUrl={posterUrl} thumbnailUrl={thumbnailUrl} focusRequest={focusRequest} {...actions} onDropData={dropLibraryMedia} dropDataTypes={libraryDropTypes} scriptSessions={scriptSessions} {...(openSessionId ? { currentScriptSessionId: openSessionId } : {})} generationOperations={operations}
                renderScriptSettingPicker={props => <SettingPicker host={scriptSettingsHost} {...props} />} />
              </GenerationSettingsContext.Provider>
              </div>
              {work.mainView === 'board' ? work.board : null}
            </>
          )
          : <div className="app-loading">{viewError ?? m.loading}</div>}
        </div>
        {assetLibraryHost && libraryPreference.projectId === spaceId && libraryPreference.open ? <LibraryPanel key={spaceId} host={assetLibraryHost} tab={libraryPreference.tab} onTabChange={tab => changeLibrary({ tab })}
          settingsHeader={<SettingsHeader host={assetLibraryHost} runControls={<LibraryRunControls host={assetLibraryHost} kind="merge" />} />}
          renderGroupIntoSetting={(assetIds, close) => <GroupIntoSettingDialog host={assetLibraryHost} assetIds={assetIds} onClose={close} onGrouped={close} />} /> : null}
        <SessionPanel skillDraftHost={skillDraftHost}
          showProjectSwitcher={false}
          workTree={work.tree}
          projectAttention={new Set(view.work.inboxCounts?.bySpace.filter(project => project.unresolved > 0).map(project => project.spaceId))}
          projects={view.projects}
          projectsDir={view.projectsDir}
          projectId={spaceId ?? null}
          onSelectProject={conn.selectProject}
          onCreateProject={onCreateProject}
          onDeleteProject={id => { void planProjectDelete(id) }}
          onPickDirectory={onPickDirectory}
          onValidateDirectory={onValidateDirectory}
          onListSkills={onListSkills}
          onRevealProject={() => { if (spaceId) void revealDirectory({ spaceId }) }}
          sessions={sessions}
          openSessionId={openSessionId}
          collapsed={panelCollapsed}
          onCollapsedChange={setPanelCollapsed}
          onLocate={workItemId => { void locateChanges(workItemId).catch(error => notify({ kind: 'error', text: m.locateFailed(describeError(error, locale)) })) }}
          onSelect={selectSession}
          onCreate={onCreate}
          transcript={transcript?.items ?? null}
          generationJobs={new Map([...(usage?.jobs ?? []).map(job => [job.jobId, job] as const), ...view.talk.jobs, ...view.state.jobs])}
          hasMore={transcript?.hasMore ?? false}
          onLoadMore={async () => { if (openSessionId) await conn.loadTranscript(openSessionId, true) }}
          onSetApprovalMode={async (sessionId, approvalMode) => { await conn.rpc.call('session.setApprovalMode', { requestId: rid(), sessionId, mode: approvalMode }) }}
          onReopenQueue={work.reopenQueue}
          onClearQueue={async sessionId => { await conn.rpc.call('session.clearQueue', { requestId: rid(), sessionId }) }}
          onResumeQueue={async sessionId => { await conn.rpc.call('session.resumeQueue', { requestId: rid(), sessionId }) }}
          composerDraft={composerDraft}
          drafts={(openSessionId && view.talk.drafts.get(openSessionId)) || EMPTY}
          messageStates={view.talk.messageStates}
          refs={refChips}
          attachments={attachments.attachments}
          onImportFiles={attachments.add}
          onRemoveAttachment={attachments.remove}
          resolveAsset={async assetVersionId => conn.rpc.call('asset.get', { assetVersionId })}
          assetUrl={assetUrl}
          posterUrl={posterUrl}
          onAddAssetRef={attachments.addAsset}
          resolveRef={resolveRef}
          onLocateRef={work.locateRef}
          mentionNodes={mentionNodes}
          onAddRef={nodeId => setRefs(r => r.includes(nodeId) ? r : [...r, nodeId])}
          onRemoveRef={nodeId => setRefs(r => r.filter(id => id !== nodeId))}
          onRefreshSkills={onRefreshSkills}
          onManageSkills={importOpen => { if (spaceId) setSkillManager({ spaceId, importOpen }) }}
          skills={skills}
          selectedSkills={selectedSkills}
          onAddSkill={skill => setSelectedSkills(list => list.some(item => item.path === skill.path) ? list : [...list, skill])}
          onRemoveSkill={path => setSelectedSkills(list => list.filter(skill => skill.path !== path))}
          onAgentOptions={async sessionId => (await conn.rpc.call('session.agentOptions', { sessionId })).models}
          onSetAgentConfig={async (sessionId, config) => { await conn.rpc.call('session.setAgentConfig', { requestId: rid(), sessionId, ...config }) }}
          onSend={onSend}
          onStop={onStop}
          onSendNow={async (sessionId, messageId) => { await conn.rpc.call('session.sendNow', { requestId: rid(), sessionId, messageId }) }}
          stopCancelsWork={new Set([
            ...[...view.state.mediaTasks.values()].flatMap(task => task.sessionId && ['queued', 'running'].includes(task.status) ? [task.sessionId] : []),
            ...[...view.state.scriptBatches.values()].flatMap(batch => batch.origin === 'agent' && batch.sessionId && ['pending_approval', 'running', 'paused'].includes(batch.status) ? [batch.sessionId] : []),
          ])}
          onRespondApproval={onRespondApproval}
          scriptBatches={view.state.scriptBatches}
          onGetBatch={batchId => conn.rpc.call<MethodResult<'script.batch.get'>>('script.batch.get', { batchId })}
          onRespondBatch={(batchId, decision, requestId) => conn.rpc.call<MethodResult<'script.batch.approve'>>(`script.batch.${decision}`, { batchId, requestId })}
          resolveBatchShots={nodeId => {
            const content = view.state.nodes.get(nodeId)?.slots.find(slot => slot.slotKey === 'main')?.content
            return content?.type === 'script' ? content.doc.shots : []
          }}
        />
      </main>
      {previzNode && view.ready ? <GenerationSettingsContext.Provider value={generationSettings}><PrevizEditorMount key={previzNode.nodeId} conn={conn} node={previzNode} initialPanelId={previzPanelId} nodes={nodes} close={closePreviz} openScene={(nodeId, viewId, panelId) => { setPrevizId(null); setSceneRequest({ nodeId, viewId, target: { nodeId: previzNode.nodeId, panelId } }) }} render={() => { setPrevizId(null); actions.onPrevizDraft?.(previzNode.nodeId, pm.renderDraft) }} /></GenerationSettingsContext.Provider> : null}
      {sceneNode && view.ready ? <SceneEditorMount key={sceneNode.nodeId} conn={conn} node={sceneNode} nodes={nodes} initialViewId={sceneRequest?.viewId} initialTarget={sceneRequest?.target} close={closeScene} /> : null}
      {writingNode && writingNode.format !== 'code' && view.ready ? <WritingEditorMount key={writingNode.nodeId} conn={conn} node={writingNode} nodes={nodes} sourceQuote={writingQuote} openShot={async shot => { setWritingId(null); setScriptShot(previous => ({ nodeId: shot.scriptNodeId, shotId: shot.shotId, seq: (previous?.seq ?? 0) + 1 })); setFocusRequest(previous => ({ nodeId: shot.scriptNodeId, seq: (previous?.seq ?? 0) + 1 })) }} close={closeWriting} proposals={writing.proposals.filter(proposal => proposal.nodeId === writingNode.nodeId)} {...(openSessionId && view.state.sessions.get(openSessionId) ? { session: view.state.sessions.get(openSessionId)! } : {})} update={writing.update} /> : null}
      {writingImportAt && view.ready ? <CanvasWritingImport key={spaceId} conn={conn} at={writingImportAt} close={closeWritingImport} created={nodeId => { setWritingImportAt(null); setWritingQuote(undefined); setWritingId(nodeId); timelineReturnFocus.current = nodeId; setFocusRequest(previous => ({ nodeId, seq: (previous?.seq ?? 0) + 1 })) }} /> : null}
      {timelineHost ? <TimelineEditor key={timelineHost.node.nodeId} host={timelineHost} /> : null}
      <input ref={timelineUpload} type="file" accept="image/*,video/*,audio/*" multiple hidden onChange={event => {
        const files = [...(event.currentTarget.files ?? [])]
        if (files.length) actions.onDropFiles(files, { x: 40, y: 40 })
        event.currentTarget.value = ''
      }} />
      {skillManager ? <SkillManager key={skillManager.spaceId} spaceId={skillManager.spaceId} importOpen={skillManager.importOpen} actions={skillActions} onClose={() => setSkillManager(null)} /> : null}
      {work.overlays}
      {settingsOpen && view.providers ? <ProviderSettings draftId={settingsDraft} {...(spaceId ? { spaceId } : {})} onSkillsUsed={onRefreshSkills} localePreference={localePreference} onLocaleChange={onLocaleChange} {...(view.work.slots ? { slots: view.work.slots } : {})} projects={view.projects} {...(settingsSection ? { initialSection: settingsSection } : {})} catalog={view.providers} rpc={conn.rpc} onClose={() => setSettingsOpen(false)} onUpdated={() => {}} onProjectsChanged={conn.refreshProjects} onProjectNotice={text => notify({ kind: 'info', text })} /> : null}
      {deletingProject ? <ProjectDeleteDialog name={deletingProject.name} plan={deletingProject.plan} loading={deletingProject.loading} busy={deletingProject.busy} error={deletingProject.error} onClose={() => { if (!deletingProject.busy) setDeletingProject(null) }} onDelete={() => { void deleteProject() }} /> : null}

      <div className="app-notices" aria-live="polite">
        {notices.map(n => (
          <div key={n.id} className={`app-notice is-${n.kind}`}>
            <span>{n.text}</span>
            {n.copy ? <button onClick={() => void navigator.clipboard.writeText(n.copy!)}>{m.copyDraft}</button> : null}
            <button onClick={() => dismiss(n.id)}>{m.close}</button>
          </div>
        ))}
      </div>
    </div></AgentsContext.Provider>
  )
}

const EMPTY: ReadonlyMap<string, TranscriptItem> = new Map()
