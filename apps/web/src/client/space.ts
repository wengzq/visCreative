import { describeError, messagesFor, type Locale } from '@vis/ui-kit'
import { shellMessages } from './messages'
import type { ProviderCatalog } from '@vis/canvas-ui'
import type { JobView, MediaTaskProgress, MediaTaskView, NodeView, SessionSummary, SlotVersionView, SpaceEvent, SpaceSeries, TranscriptItem, TransientEvent, WorkInboxCounts, WorkItemView, WorkSlotsView } from '@vis/protocol'
import { transcriptGenerationJobIds } from '@vis/workbench-ui'
import { useSyncExternalStore } from 'react'
import { type ConnectionStatus, connectRpc, type RpcClient } from './rpc'
import { applyEvent, applyMediaProgress, dismissJobs, dismissMediaTask, recordMediaTask, emptyState, fromSnapshot, normalizeSession, type SpaceState } from './store'
import { appendDelta, emptyTranscripts, mergePage, setMessageState, type TranscriptState, upsertItem } from './transcripts'
import { migrateGenerationSettings } from './generationSettings'
import { applyWorkEvent, emptyWork, fromWorkSnapshot, removeWorkItems, setWorkInboxCounts, setWorkSlots, upsertWorkItem, type WorkState } from './work'

export type SpaceError = { kind: 'empty' } | { kind: 'history' | 'request'; error: unknown }

export function describeSpaceError(error: SpaceError, locale: Locale): string {
  const m = messagesFor(shellMessages, locale)
  if (error.kind === 'empty') return m.noProjects
  const detail = describeError(error.error, locale)
  return error.kind === 'history' ? m.historyFailed(detail) : detail
}

export type SpaceView = {
  agents?: import('@vis/protocol').AgentView[]
  projects: ProjectSummary[]
  projectsDir: string
  providers: ProviderCatalog | null
  status: ConnectionStatus
  space: ProjectSummary | null
  /** True after receiving the first snapshot */
  ready: boolean
  error: SpaceError | null
  state: SpaceState
  talk: TranscriptState
  work: WorkState
}

export type ProjectSummary = { spaceId: string; name: string; rootPath: string; series?: SpaceSeries }

export type SpaceConnection = {
  rpc: RpcClient
  token: string
  getView(): SpaceView
  subscribe(listener: () => void): () => void
  /** Persistent project events, after sequence deduplication. */
  onEvent?(listener: (event: SpaceEvent) => void): () => void
  onSeriesChanged?(listener: () => void): () => void
  refreshProjects(): Promise<void>
  selectProject(spaceId: string): Promise<void>
  mergeWorkItems(items: readonly WorkItemView[]): void
  removeWorkItems(workItemIds: readonly string[]): void
  refreshWork(scope?: 'space' | 'all'): Promise<void>
  /** Adds archived sessions absent from the snapshot on demand, for opening historical work-item agents. */
  loadSession(sessionId: string): Promise<void>
  /** Reads session records: the latest page initially, an earlier page with older */
  loadTranscript(sessionId: string, older?: boolean): Promise<void>
  closeTranscript(sessionId: string): void
  loadTranscriptJobs(items: TranscriptItem[], knownJobs: ReadonlyMap<string, JobView>): Promise<void>
  /** Reads full slot history on demand; refresh forces a reread after revision conflicts */
  loadHistory(slotId: string, refresh?: boolean): Promise<void>
  refreshNodes(nodeIds: string[]): Promise<void>
  /** Dismisses terminal-job notices (on this page only) */
  dismissJobs(jobIds: string[]): void
  recordMediaTask(task: MediaTaskView): void
  dismissMediaTask(taskId: string): void
}

const PAGE = 100
const TERMINAL_JOBS = new Set(['succeeded', 'failed', 'unknown', 'cancelled'])

/** Connects to the host and subscribes to a space (?space= in the URL, first by default); reconnects with afterSeq for replay */
export function openSpace(token: string, getLocale: () => Locale = () => 'zh-CN'): SpaceConnection {
  const m = () => messagesFor(shellMessages, getLocale())
  const listeners = new Set<() => void>()
  const eventListeners = new Set<(event: SpaceEvent) => void>()
  const seriesListeners = new Set<() => void>()
  const requestedHistories = new Set<string>()
  const historyLoads = new Map<string, Promise<void>>()
  const migratedProjects = new Set<string>()
  const migrationEpochs = new Map<string, number>()
  let transcriptSessionId: string | null = null
  const transcriptLoads = new Map<string, Promise<void>>()
  const transcriptJobLoads = new Map<string, Promise<void>>()
  let view: SpaceView = { projects: [], projectsDir: '', providers: null, status: 'connecting', space: null, ready: false, error: null, state: emptyState(), talk: emptyTranscripts(), work: emptyWork() }
  let projectEpoch = 0
  let projectsRead = 0
  // Global notifications have no seq; new notifications and connections invalidate in-flight reads.
  let workInboxRead = 0
  let workSlotsRead = 0
  let subscription = Promise.resolve()
  const set = (patch: Partial<SpaceView>) => {
    view = { ...view, ...patch }
    for (const l of listeners) l()
  }

  let providerRead = 0
  async function refreshProviders() {
    const read = ++providerRead
    try {
      const providers = await rpc.call<ProviderCatalog>('providers.list', {})
      if (read === providerRead) set({ providers })
    }
    catch (error) { set({ error: { kind: 'request', error } }) }
  }

  async function refreshProjects(reconcile = true) {
    const read = ++projectsRead
    let result: { spaces: ProjectSummary[]; projectsDir?: string }
    try { result = await rpc.call<typeof result>('space.list') }
    catch (error) { if (read === projectsRead) throw error; return }
    if (read !== projectsRead) return
    const { spaces, projectsDir = '' } = result
    const activeIds = new Set(spaces.map(space => space.spaceId))
    const items = new Map([...view.work.items].filter(([, item]) => activeIds.has(item.spaceId)))
    const current = spaces.find(space => space.spaceId === view.space?.spaceId)
    const membershipChanged = current && JSON.stringify(current.series) !== JSON.stringify(view.space?.series)
    set({ projects: spaces, projectsDir, ...(current ? { space: current } : {}), ...(items.size !== view.work.items.size ? { work: { ...view.work, items } } : {}) })
    if (membershipChanged) for (const listener of seriesListeners) listener()
    if (!reconcile) return
    if (view.space && activeIds.has(view.space.spaceId)) return
    if (spaces[0]) await selectProject(spaces[0].spaceId)
    else {
      projectEpoch++
      transcriptSessionId = null
      transcriptLoads.clear()
      requestedHistories.clear()
      historyLoads.clear()
      transcriptJobLoads.clear()
      set({ space: null, ready: false, state: emptyState(), talk: emptyTranscripts(), work: fromWorkSnapshot({ workItems: [] }, 0, view.work), error: { kind: 'empty' } })
      try {
        localStorage.setItem('vis.project', '')
        const url = new URL(location.href)
        url.searchParams.delete('space')
        history.replaceState(null, '', url)
      } catch { /* Non-browser environment or unavailable preference storage */ }
    }
  }

  function refreshWorkGlobals() {
    const inboxRead = ++workInboxRead
    const slotsRead = ++workSlotsRead
    void rpc.call<{ counts: WorkInboxCounts }>('work.inbox').then(({ counts }) => {
      if (inboxRead === workInboxRead) set({ work: setWorkInboxCounts(view.work, counts) })
    }).catch(error => {
      if (inboxRead === workInboxRead) set({ error: { kind: 'request', error } })
    })
    void rpc.call<WorkSlotsView>('work.slots').then(slots => {
      if (slotsRead === workSlotsRead) set({ work: setWorkSlots(view.work, slots) })
    }).catch(error => {
      if (slotsRead === workSlotsRead) set({ error: { kind: 'request', error } })
    })
  }

  function mergeWorkItems(items: readonly WorkItemView[]) {
    const work = items.reduce((state, item) => upsertWorkItem(state, item), view.work)
    if (work !== view.work) set({ work })
  }

  async function refreshWork(scope: 'space' | 'all' = 'space') {
    const epoch = projectEpoch
    const spaceId = view.space?.spaceId
    const previous = view.work.items
    if (scope === 'space' && !spaceId) return
    try {
      const { items } = await rpc.call<{ items: WorkItemView[] }>('work.list', { scope, ...(scope === 'space' ? { spaceId } : {}) })
      if (epoch !== projectEpoch) return
      const present = new Set(items.map(item => item.workItemId))
      // Missing items in complete lists mean deletion; events arriving during reads still take precedence.
      const missing = [...previous.values()].filter(item => (scope === 'all' || item.spaceId === spaceId) && !present.has(item.workItemId) && view.work.items.get(item.workItemId) === item).map(item => item.workItemId)
      const work = items.reduce((state, item) => upsertWorkItem(state, item), view.work)
      set({ work: missing.length ? removeWorkItems(work, missing) : work })
    } catch (error) {
      if (epoch === projectEpoch) throw error
    }
  }

  function subscribe() {
    const epoch = projectEpoch
    const next = subscription.then(() => epoch === projectEpoch ? performSubscribe(epoch) : undefined)
    subscription = next.catch(() => {})
    return next
  }

  async function performSubscribe(epoch: number) {
    void refreshProviders()
    void rpc.call<import('@vis/protocol').MethodResult<'agents.list'>>('agents.list', {}).then(result => { if (epoch === projectEpoch) set({ agents: result.agents }) }, error => set({ error: { kind: 'request', error } }))
    try {
      let space = view.space
      if (!space) {
        await refreshProjects(false)
        if (epoch !== projectEpoch) return
        const spaces = view.projects
        const wanted = new URLSearchParams(location.search).get('space')
        let saved: string | null = null
        try { saved = localStorage.getItem('vis.project') } catch { /* Select the first project when storage is unavailable */ }
        space = spaces.find(s => s.spaceId === (wanted ?? saved)) ?? spaces[0] ?? null
        if (!space) return set({ error: { kind: 'empty' } })
        set({ space })
      }
      const r = await rpc.call<{ reset: boolean; snapshot?: any; seq?: number }>('events.subscribe', { spaceId: space.spaceId, ...(view.ready ? { afterSeq: view.state.seq } : {}) })
      if (epoch !== projectEpoch) return
      try { localStorage.setItem('vis.project', space.spaceId) } catch { /* Ignore unavailable preference storage */ }
      if (r.reset) {
        // A fresh snapshot: open session records may have missed events, so reread them
        const opened = transcriptSessionId
        transcriptLoads.clear()
        historyLoads.clear()
        transcriptJobLoads.clear()
        set({ state: fromSnapshot(r.snapshot, r.seq!), talk: emptyTranscripts(), work: fromWorkSnapshot(r.snapshot, r.seq!, view.work), ready: true, error: null })
        if (!migratedProjects.has(space.spaceId) && migrationEpochs.get(space.spaceId) !== epoch) {
          const spaceId = space.spaceId
          migrationEpochs.set(spaceId, epoch)
          void migrateGenerationSettings(rpc, spaceId, [...view.state.nodes.values()], () => epoch === projectEpoch && view.ready).then(complete => {
            if (complete) migratedProjects.add(spaceId)
            else if (migrationEpochs.get(spaceId) === epoch) migrationEpochs.delete(spaceId)
          })
        }
        if (opened) void loadTranscript(opened).catch(error => set({ error: { kind: 'request', error } }))
        for (const id of requestedHistories) {
          if ([...view.state.nodes.values()].some(node => node.slots.some(slot => slot.slotId === id))) refreshHistory(id)
          else requestedHistories.delete(id)
        }
      } else {
        set({ ready: true, error: null })
      }
    } catch (error) {
      if (epoch === projectEpoch) set({ error: { kind: 'request', error } })
      throw error
    }
  }

  async function selectProject(spaceId: string) {
    if (view.space?.spaceId === spaceId && view.ready) return
    const space = view.projects.find(project => project.spaceId === spaceId)
    if (!space) throw new Error(m().missingProject)
    projectEpoch++
    transcriptSessionId = null
    transcriptLoads.clear()
    requestedHistories.clear()
    historyLoads.clear()
    transcriptJobLoads.clear()
    set({ space, ready: false, state: emptyState(), talk: emptyTranscripts(), work: fromWorkSnapshot({ workItems: [] }, 0, view.work), error: null })
    try {
      const url = new URL(location.href)
      url.searchParams.set('space', spaceId)
      history.replaceState(null, '', url)
    } catch { /* Non-browser environments have no address bar to update */ }
    await subscribe()
  }

  function onEvent(e: SpaceEvent) {
    if (!view.ready) return
    const state = applyEvent(view.state, e)
    if (state === view.state) return
    let talk = view.talk
    if (e.type === 'transcript.itemUpserted') talk = upsertItem(talk, e.entityId, e.payload as TranscriptItem)
    if (e.type === 'message.stateChanged') {
      const p = e.payload as { messageId: string; deliveryState: any }
      talk = setMessageState(talk, p.messageId, p.deliveryState)
    }
    set({ state, talk, work: applyWorkEvent(view.work, e) })
    for (const listener of eventListeners) listener(e)
    if (e.type === 'slot.revised') {
      const p = e.payload as { slotId?: string; slot?: { slotId: string } }
      const slotId = p.slotId ?? p.slot?.slotId
      if (slotId && requestedHistories.has(slotId)) refreshHistory(slotId)
    }
    if (e.type === 'node.deleted') {
      const liveSlots = new Set([...state.nodes.values()].flatMap(node => node.slots.map(slot => slot.slotId)))
      for (const id of requestedHistories) if (!liveSlots.has(id)) {
        requestedHistories.delete(id)
        historyLoads.delete(id)
      }
    }
  }

  function refreshHistory(slotId: string) {
    void loadHistory(slotId, true).catch(error => set({ error: { kind: 'history', error } }))
  }

  async function loadHistory(slotId: string, refresh = false): Promise<void> {
    requestedHistories.add(slotId)
    if (refresh) {
      historyLoads.delete(slotId)
      if (view.state.histories.has(slotId)) {
        const histories = new Map(view.state.histories)
        histories.delete(slotId)
        set({ state: { ...view.state, histories } })
      }
    }
    if (view.state.histories.has(slotId)) return
    const pending = historyLoads.get(slotId)
    if (pending) return pending
    const request: Promise<void> = Promise.resolve().then(async () => {
      const versions: SlotVersionView[] = []
      let beforeRevision: number | undefined
      while (true) {
        const page = await rpc.call<{ versions: SlotVersionView[]; hasMore: boolean }>('slot.history', { slotId, limit: 200, ...(beforeRevision !== undefined ? { beforeRevision } : {}) })
        if (historyLoads.get(slotId) !== request) return
        versions.push(...page.versions)
        if (!page.hasMore) break
        const last = page.versions.at(-1)?.revision
        if (last === undefined || (beforeRevision !== undefined && last >= beforeRevision)) throw new Error(m().historyStalled)
        beforeRevision = last
      }
      set({ state: { ...view.state, histories: new Map(view.state.histories).set(slotId, versions) } })
    }).catch(error => {
      if (historyLoads.get(slotId) === request) throw error
    }).finally(() => {
      if (historyLoads.get(slotId) === request) historyLoads.delete(slotId)
    })
    historyLoads.set(slotId, request)
    return request
  }

  async function loadSession(sessionId: string) {
    if (view.state.sessions.has(sessionId)) return
    const epoch = projectEpoch
    try {
      const { sessions } = await rpc.call<{ sessions: SessionSummary[] }>('session.list', { includeArchived: true })
      if (epoch !== projectEpoch || view.state.sessions.has(sessionId)) return
      const session = sessions.find(session => session.sessionId === sessionId)
      if (!session) throw new Error(m().missingSession)
      set({ state: { ...view.state, sessions: new Map(view.state.sessions).set(sessionId, normalizeSession(session)) } })
    } catch (error) {
      if (epoch === projectEpoch) throw error
    }
  }

  function closeTranscript(sessionId: string) {
    if (transcriptSessionId !== sessionId) return
    transcriptSessionId = null
    transcriptLoads.clear()
  }

  async function loadTranscript(sessionId: string, older = false) {
    if (transcriptSessionId !== sessionId) {
      transcriptSessionId = sessionId
      transcriptLoads.clear()
    }
    const epoch = projectEpoch
    const current = view.talk.transcripts.get(sessionId)
    if (current && (!older || !current.hasMore)) return
    const beforeSeq = older ? current?.items[0]?.createdSeq : undefined
    const key = String(beforeSeq ?? 'latest')
    const pending = transcriptLoads.get(key)
    if (pending) return pending
    const request = rpc.call<{ items: TranscriptItem[]; hasMore: boolean }>('session.getTranscript', { sessionId, limit: PAGE, ...(beforeSeq !== undefined ? { beforeSeq } : {}) }).then(page => {
      if (epoch !== projectEpoch || transcriptLoads.get(key) !== request) return
      set({ talk: mergePage(view.talk, sessionId, page, older) })
    }).catch(error => {
      if (epoch === projectEpoch && transcriptLoads.get(key) === request) throw error
    }).finally(() => {
      if (transcriptLoads.get(key) === request) transcriptLoads.delete(key)
    })
    transcriptLoads.set(key, request)
    return request
  }

  async function loadTranscriptJobs(items: TranscriptItem[], knownJobs: ReadonlyMap<string, JobView>) {
    if (!view.ready) return
    const epoch = projectEpoch
    const jobs = new Map(view.talk.jobs)
    const requests: Promise<void>[] = []
    let changed = false
    for (const jobId of transcriptGenerationJobIds(items)) {
      const live = view.state.jobs.get(jobId)
      const known = live ?? knownJobs.get(jobId)
      const cached = jobs.get(jobId)
      if (!live && cached && TERMINAL_JOBS.has(cached.status) && known && !TERMINAL_JOBS.has(known.status)) continue
      if (known) {
        if (jobs.get(jobId) !== known) { jobs.set(jobId, known); changed = true }
        continue
      }
      if (TERMINAL_JOBS.has(jobs.get(jobId)?.status ?? '')) continue
      const pending = transcriptJobLoads.get(jobId)
      if (pending) { requests.push(pending); continue }
      const cachedAtStart = view.talk.jobs.get(jobId)
      const request = rpc.call<JobView>('generation.get', { jobId }).then(job => {
        if (epoch !== projectEpoch || transcriptJobLoads.get(jobId) !== request) return
        if (view.talk.jobs.get(jobId) !== cachedAtStart) return
        set({ talk: { ...view.talk, jobs: new Map(view.talk.jobs).set(jobId, view.state.jobs.get(jobId) ?? job) } })
      }).catch(error => {
        if (epoch === projectEpoch && transcriptJobLoads.get(jobId) === request) throw error
      }).finally(() => {
        if (transcriptJobLoads.get(jobId) === request) transcriptJobLoads.delete(jobId)
      })
      transcriptJobLoads.set(jobId, request)
      requests.push(request)
    }
    if (changed) set({ talk: { ...view.talk, jobs } })
    await Promise.all(requests)
  }

  const rpc = connectRpc({
    getLocale,
    url: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?t=${encodeURIComponent(token)}`,
    onNotification(method, params) {
      if (method === 'events.providersChanged') void refreshProviders()
      else if (method === 'events.seriesChanged') {
        if ((params as { seriesId: string }).seriesId === view.space?.series?.seriesId) {
          for (const listener of seriesListeners) listener()
        }
      }
      else if (method === 'events.spacesChanged') {
        refreshWorkGlobals()
        void refreshProjects().catch(error => set({ error: { kind: 'request', error } }))
      }
      else if (method === 'events.workInboxChanged') {
        workInboxRead++
        set({ work: setWorkInboxCounts(view.work, params as WorkInboxCounts) })
      }
      else if (method === 'events.workSlotsChanged') {
        workSlotsRead++
        set({ work: setWorkSlots(view.work, params as WorkSlotsView) })
      }
      else if (method === 'events.event') onEvent(params as SpaceEvent)
      else if (method === 'events.mediaProgress' && view.ready) set({ state: applyMediaProgress(view.state, params as MediaTaskProgress) })
      else if (method === 'events.transient' && view.ready && view.state.sessions.has((params as TransientEvent).sessionId)) set({ talk: appendDelta(view.talk, params as TransientEvent) })
    },
    onStatus: status => set({ status }),
    onOpen: () => {
      refreshWorkGlobals()
      void refreshProjects(false).then(() => {
        if (view.space && !view.projects.some(project => project.spaceId === view.space!.spaceId)) return refreshProjects()
        return subscribe()
      }).catch(error => set({ error: { kind: 'request', error } }))
    },
  })

  return {
    rpc,
    token,
    getView: () => view,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    onEvent(listener) {
      eventListeners.add(listener)
      return () => eventListeners.delete(listener)
    },
    onSeriesChanged(listener) {
      seriesListeners.add(listener)
      return () => seriesListeners.delete(listener)
    },
    refreshProjects,
    selectProject,
    mergeWorkItems,
    removeWorkItems: ids => set({ work: removeWorkItems(view.work, ids) }),
    refreshWork,
    loadSession,
    loadTranscript,
    closeTranscript,
    loadTranscriptJobs,
    loadHistory,
    async refreshNodes(nodeIds) {
      if (!nodeIds.length) return
      const epoch = projectEpoch
      const result = await rpc.call<{ nodes: NodeView[] }>('canvas.get', { nodeIds })
      if (epoch !== projectEpoch) return
      const nodes = new Map(view.state.nodes)
      for (const fresh of result.nodes) {
        const current = nodes.get(fresh.nodeId)
        if (!current) continue
        nodes.set(fresh.nodeId, { ...current, slots: current.slots.map(slot => {
          const next = fresh.slots.find(next => next.slotId === slot.slotId)
          return next && next.revision >= slot.revision ? next : slot
        }) })
      }
      set({ state: { ...view.state, nodes } })
    },
    dismissJobs: jobIds => set({ state: dismissJobs(view.state, jobIds) }),
    recordMediaTask: task => set({ state: recordMediaTask(view.state, task) }),
    dismissMediaTask: taskId => set({ state: dismissMediaTask(view.state, taskId) }),
  }
}

export function useSpaceView(conn: SpaceConnection): SpaceView {
  return useSyncExternalStore(conn.subscribe, conn.getView)
}
