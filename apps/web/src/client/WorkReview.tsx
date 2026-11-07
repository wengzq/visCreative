import type { MethodResult, NodeView, SlotContent, SlotVersionView, WorkChange, WorkItemView, WorkMessageView } from '@vis/protocol'
import { type RefPreview, type ReviewChangePreview, type WorkCardThumbnail, ReviewDrawer } from '@vis/workbench-ui'
import { useEffect, useRef, useState } from 'react'
import { describeError, formatter, messagesFor, useLocale, useMessages, type Locale } from '@vis/ui-kit'
import type { RpcClient } from './rpc'
import { type SpaceConnection, useSpaceView } from './space'
import { workMessages } from './messages'
import { latestTimelineExport, timelineSummary } from '@vis/canvas-ui'
import { timelineMessages, previzMessages } from '@vis/canvas-ui'

/** This activation changes sort by latest event; prompts and outputs belong to the same node. */
export function changedThumbnails(changes: readonly WorkChange[], nodes: ReadonlyMap<string, NodeView>, assetUrl: (id: string) => string): WorkCardThumbnail[] {
  const seen = new Set<string>()
  return [...changes].sort((a, b) => b.lastSeq - a.lastSeq).flatMap(change => {
    if (seen.has(change.nodeId)) return []
    seen.add(change.nodeId)
    const node = nodes.get(change.nodeId)
    if (change.change === 'deleted' || !node || (node.kind !== 'image' && node.kind !== 'video')) return []
    const content = node.slots.find(slot => slot.slotKey === 'main')?.content
    return content?.type === 'asset' ? [{ src: assetUrl(content.assetVersionId), kind: node.kind }] : []
  }).slice(0, 2)
}

export interface WorkReviewProps {
  conn: SpaceConnection
  item: WorkItemView
  onClose(): void
  onLocateNode(input: { spaceId: string; nodeId: string }): void
  onApprove(): Promise<void>
  onReject(feedback?: string): Promise<void>
}

type ReviewData = { key: string; locale: Locale; revision: number; messages: WorkMessageView[]; hasMore: boolean; changes: ReviewChangePreview[] }

export function mergeReviewMessages(previous: readonly WorkMessageView[], incoming: readonly WorkMessageView[]): WorkMessageView[] {
  return [...new Map([...previous, ...incoming].map(message => [message.messageId, message])).values()]
    .sort((a, b) => a.createdAt - b.createdAt || a.messageId.localeCompare(b.messageId))
}

export function reviewCompletionReport(item: WorkItemView, messages: readonly WorkMessageView[]): WorkMessageView | null {
  return item.status === 'in_review' && item.reviewReportId
    ? messages.find(message => message.messageId === item.reviewReportId && message.kind === 'done' && message.workItemId === item.workItemId) ?? null
    : null
}

export async function loadReviewMessages(rpc: RpcClient, params: { spaceId: string; workItemId: string }, current: () => boolean, locale: Locale = 'zh-CN'): Promise<MethodResult<'work.get'> | null> {
  const t = messagesFor(workMessages, locale)
  if (!current()) return null
  const result = await rpc.call<MethodResult<'work.get'>>('work.get', { ...params, limit: 100 })
  if (!current()) return null
  result.messages = mergeReviewMessages([], result.messages)
  while (result.hasMore && result.item.reviewReportId && !reviewCompletionReport(result.item, result.messages)) {
    const beforeCreatedAt = result.messages[0]?.createdAt
    if (beforeCreatedAt === undefined) throw new Error(t.workMessagePageStalled)
    const older = await rpc.call<MethodResult<'work.get'>>('work.get', { ...params, limit: 100, beforeCreatedAt })
    if (!current()) return null
    if (older.hasMore && (!older.messages.length || Math.min(...older.messages.map(message => message.createdAt)) >= beforeCreatedAt)) throw new Error(t.workMessagePageStalled)
    result.messages = mergeReviewMessages(result.messages, older.messages)
    result.hasMore = older.hasMore
  }
  if (result.item.reviewReportId && !reviewCompletionReport(result.item, result.messages)) throw new Error(t.workReportMissing)
  return result
}

export function reviewChangePreview(change: WorkChange, node: NodeView | undefined, versions: readonly SlotVersionView[], assetUrl: (id: string) => string, error?: string, locale: Locale = 'zh-CN', nodes: readonly NodeView[] = []): ReviewChangePreview {
  const t = messagesFor(workMessages, locale)
  const format = formatter(locale)
  // Image and video generation prompts and outputs use separate slots; titles identify which changed
  const slotLabels: Record<string, string> = { main: t.workOutputSlot, prompt: t.workPromptSlot }
  const beforeContent = change.fromRevision === null ? undefined : versions.find(version => version.revision === change.fromRevision)?.content
  const afterContent = change.toRevision === null ? undefined : versions.find(version => version.revision === change.toRevision)?.content
  const content = (node?.slots.find(slot => slot.slotKey === 'main') ?? node?.slots[0])?.content ?? afterContent ?? beforeContent
  const nodeKind = change.nodeKind
  const title = nodeKind === 'frame' ? node?.frame?.title ?? t.workFrame
    : nodeKind === 'timeline' ? node?.title ?? messagesFor(timelineMessages, locale).timeline
    : nodeKind === 'previz' ? node?.title ?? messagesFor(previzMessages, locale).create
    : nodeKind === 'script' ? node?.title ?? t.workScript
    : nodeKind === 'text' ? node?.title ?? ((content?.type === 'text' ? content.body.split(/\r?\n/)[0]?.trim() : '') || (node ? t.workEmptyText : t.workDeletedNode))
    : `${nodeKind === 'image' ? t.workImage : t.workVideo}${slotLabels[node?.slots.find(slot => slot.slotId === change.slotId)?.slotKey ?? ''] ?? ''}`
  const preview = (value: SlotContent | undefined, revision: number | null): RefPreview | null => {
    if (revision === null) return null
    if (error) return { kind: 'missing', label: t.workPreviewFailed(error) }
    if (!value) return { kind: 'missing', label: change.slotId ? t.workRevisionMissing(format.number(revision)) : t.workLayoutPreviewMissing }
    if (value.type === 'text') return { kind: 'text', text: value.body, label: title }
    if (value.type === 'script') return { kind: 'script', shots: value.doc.shots.length, assets: value.doc.assets.length, label: title }
    if (value.type === 'previz') {
      const image = value.doc.panels.find(panel => panel.image)?.image
      return image ? { kind: 'image', src: assetUrl(image), label: title } : { kind: 'text', text: messagesFor(previzMessages, locale).summary(format.number(value.doc.panels.length)), label: title }
    }
    if (value.type === 'timeline') {
      const summary = timelineSummary(value.doc, locale)
      const exported = latestTimelineExport(change.nodeId, nodes)
      const asset = exported?.slots.find(slot => slot.slotKey === 'main')?.content
      return asset?.type === 'asset' && exported?.exportOf?.timelineRevision === revision ? { kind: exported.kind === 'audio' ? 'audio' : 'video', src: assetUrl(asset.assetVersionId), label: `${title} · ${summary}` } : { kind: 'text', text: summary, label: title }
    }
    if (value.type === 'asset') return { kind: value.mime.startsWith('audio/') ? 'audio' : value.mime.startsWith('video/') ? 'video' : 'image', src: assetUrl(value.assetVersionId), label: title }
    return nodeKind === 'frame' ? { kind: 'missing', label: t.workFramePreviewMissing } : { kind: 'empty', nodeKind: nodeKind === 'timeline' || nodeKind === 'previz' || nodeKind === 'scene' ? 'video' : nodeKind, label: title }
  }
  return { ...change, nodeKind, title, before: preview(beforeContent, change.fromRevision), after: preview(afterContent, change.toRevision) }
}

/** Reads only revisions needed for comparison; page switching stops further RPC calls. */
export async function loadReviewHistory(rpc: RpcClient, change: WorkChange, current: () => boolean, locale: Locale = 'zh-CN'): Promise<SlotVersionView[]> {
  const t = messagesFor(workMessages, locale)
  if (!change.slotId) return []
  const wanted = [change.fromRevision, change.toRevision].filter((revision): revision is number => revision !== null)
  const versions: SlotVersionView[] = []
  let beforeRevision: number | undefined
  while (current() && wanted.some(revision => !versions.some(version => version.revision === revision))) {
    const page = await rpc.call<MethodResult<'slot.history'>>('slot.history', { slotId: change.slotId, limit: 200, ...(change.change === 'deleted' ? { includeDeleted: true } : {}), ...(beforeRevision === undefined ? {} : { beforeRevision }) })
    if (!current()) return []
    versions.push(...page.versions)
    if (!page.hasMore) break
    const oldest = Math.min(...page.versions.map(version => version.revision))
    if (!Number.isFinite(oldest) || (beforeRevision !== undefined && oldest >= beforeRevision)) throw new Error(t.workHistoryPageStalled)
    beforeRevision = oldest
  }
  return versions
}

export function WorkReview(p: WorkReviewProps) {
  const { locale } = useLocale()
  const t = useMessages(workMessages)
  const view = useSpaceView(p.conn)
  const live = view.work.items.get(p.item.workItemId)
  const item = live && live.spaceId === p.item.spaceId && live.revision >= p.item.revision ? live : p.item
  const key = `${item.spaceId}/${item.workItemId}`
  const [data, setData] = useState<ReviewData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [warning, setWarning] = useState('')
  const epoch = useRef(0)
  const olderLoading = useRef(false)
  const dataRef = useRef(data)
  dataRef.current = data
  const messageVersion = view.work.messageVersions.get(item.workItemId) ?? 0

  useEffect(() => {
    const request = ++epoch.current
    olderLoading.current = false
    const current = () => epoch.current === request && p.conn.getView().ready && p.conn.getView().space?.spaceId === item.spaceId
    setLoading(true)
    setError('')
    setWarning('')
    if (!view.ready || view.space?.spaceId !== item.spaceId) return () => { epoch.current++ }
    const params = { spaceId: item.spaceId, workItemId: item.workItemId }
    void (async () => {
      const [page, changed] = await Promise.all([
        loadReviewMessages(p.conn.rpc, params, current, locale),
        p.conn.rpc.call<MethodResult<'work.changes'>>('work.changes', params),
      ])
      if (!current() || !page) return
      const errors: string[] = []
      let nodes: NodeView[] = []
      if (changed.changes.length) {
        // Timeline exports are found by their exportOf link, so only timeline changes need the whole canvas
        const nodeIds = changed.changes.some(change => change.nodeKind === 'timeline') ? undefined : [...new Set(changed.changes.map(change => change.nodeId))]
        try { nodes = (await p.conn.rpc.call<MethodResult<'canvas.get'>>('canvas.get', nodeIds ? { nodeIds } : {})).nodes }
        catch (error) { errors.push(describeError(error, locale)) }
      }
      if (!current()) return
      const nodeMap = new Map(nodes.map(node => [node.nodeId, node]))
      const assetUrl = (id: string) => `/assets/${encodeURIComponent(item.spaceId)}/${encodeURIComponent(id)}?t=${encodeURIComponent(p.conn.token)}`
      const changes = await Promise.all(changed.changes.map(async change => {
        try { return reviewChangePreview(change, nodeMap.get(change.nodeId), await loadReviewHistory(p.conn.rpc, change, current, locale), assetUrl, undefined, locale, nodes) }
        catch (error) {
          errors.push(describeError(error, locale))
          return reviewChangePreview(change, nodeMap.get(change.nodeId), [], assetUrl, describeError(error, locale), locale, nodes)
        }
      }))
      if (!current()) return
      const previous = dataRef.current?.key === key ? dataRef.current : null
      const olderWasLoaded = previous?.messages[0] && (!page.messages[0] || previous.messages[0].createdAt < page.messages[0].createdAt)
      setData({ key, locale, revision: page.item.revision, messages: mergeReviewMessages(previous?.messages ?? [], page.messages), hasMore: olderWasLoaded ? previous.hasMore : page.hasMore, changes })
      setWarning(errors.length ? t.workPreviewWarnings([...new Set(errors)]) : '')
      p.conn.mergeWorkItems([page.item])
    })().catch(error => { if (current()) setError(t.workReviewFailed(describeError(error, locale))) })
      .finally(() => { if (current()) setLoading(false) })
    return () => { epoch.current++ }
  }, [p.conn, item.spaceId, item.workItemId, item.revision, key, messageVersion, view.ready, view.space?.spaceId, locale])

  const loaded = data?.key === key && data.locale === locale ? data : null
  const loadMore = async () => {
    if (!loaded?.hasMore || loading || olderLoading.current) return
    const beforeCreatedAt = loaded.messages[0]?.createdAt
    if (beforeCreatedAt === undefined) throw new Error(t.workMessagePageStalled)
    const request = epoch.current
    const current = () => epoch.current === request && p.conn.getView().ready && p.conn.getView().space?.spaceId === item.spaceId
    olderLoading.current = true
    try {
      const page = await p.conn.rpc.call<MethodResult<'work.get'>>('work.get', { spaceId: item.spaceId, workItemId: item.workItemId, beforeCreatedAt, limit: 100 })
      if (!current()) return
      if (page.hasMore && (!page.messages.length || Math.min(...page.messages.map(message => message.createdAt)) >= beforeCreatedAt)) throw new Error(t.workMessagePageStalled)
      setData(previous => previous?.key === key ? { ...previous, messages: mergeReviewMessages(previous.messages, page.messages), hasMore: page.hasMore } : previous)
      p.conn.mergeWorkItems([page.item])
    } catch (error) { if (current()) throw error }
    finally { if (current()) olderLoading.current = false }
  }
  const incomplete = item.childIds.flatMap(id => {
    const child = view.work.items.get(id)
    return child && child.status !== 'done' ? [child] : []
  })
  return <ReviewDrawer key={key} item={item} spaceName={view.projects.find(project => project.spaceId === item.spaceId)?.name ?? item.spaceName ?? item.spaceId}
    messages={loaded?.messages ?? []} completionReport={reviewCompletionReport(item, loaded?.messages ?? [])}
    changes={loaded?.changes ?? []} hasMore={loaded?.hasMore ?? false} loading={loading || (!error && loaded?.revision !== item.revision)} error={error} warning={warning}
    incompleteChildren={incomplete} onLoadMore={loadMore} onLocateNode={p.onLocateNode} onApprove={p.onApprove} onReject={p.onReject}
    onClose={() => { epoch.current++; p.onClose() }} />
}
