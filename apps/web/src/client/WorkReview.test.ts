import { EMPTY_SCRIPT, type NodeView, type ScriptDoc, type SlotVersionView, type WorkChange, type WorkItemView, type WorkMessageView } from '@vis/protocol'
import { LocaleProvider } from '@vis/ui-kit'
import { AgentsContext, AgentChoiceDialog, WorkCard, getQuickActions, ReviewDrawer, type ReviewDrawerProps } from '@vis/workbench-ui'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from './rpc'
import { changedThumbnails, loadReviewHistory, loadReviewMessages, mergeReviewMessages, reviewChangePreview, reviewCompletionReport } from './WorkReview'
import { nodeRefPreview } from './App'
import { messages } from './messages'

const message = (messageId: string, createdAt: number, patch: Partial<WorkMessageView> = {}): WorkMessageView => ({
  messageId, createdAt, workItemId: 'work', kind: 'done', body: messageId, from: { kind: 'session', sessionId: 'worker' }, to: 'user', refs: {},
  replyTo: null, deliveryId: null, resolvedBy: null, redelivered: false, deliveredAt: null, ackedAt: null, readAt: null, ...patch,
})
const item = (patch: Partial<WorkItemView> = {}): WorkItemView => ({
  workItemId: 'work', spaceId: 'space', title: '工作项', brief: '', status: 'in_review', reviewReportId: 'current', revision: 3,
  parentId: null, childIds: [], pinned: false, reviewBy: 'user', workDir: '/work', createdBy: { kind: 'user' },
  activationSeq: 10, waitingSlotSince: null, pendingFeedback: false, activity: 'idle', sessions: [], unreadCount: 0, unresolvedCount: 0,
  waitingOn: null, todayGenerations: 0, changeCount: 0, lastChangeSeq: null, statusChangedAt: 50, createdAt: 1, archivedAt: null, ...patch,
})
const change: WorkChange = { lastSeq: 12, nodeId: 'node', nodeKind: 'text', slotId: 'slot', change: 'updated', fromRevision: 1, toRevision: 3, sessionId: 'worker' }
const version = (revision: number, text: string): SlotVersionView => ({ revision, content: { type: 'text', body: text }, createdAt: revision, actor: 'agent', isCurrent: false })
const assetUrl = (id: string) => `/assets/space/${id}`

describe('Work-item review data', () => {
  it('preserves script titles, historical shot/asset counts and script icons in references and review', () => {
    const before: ScriptDoc = { ...EMPTY_SCRIPT, shots: [{ id: 'one', rev: 1, transition: 'cut', description: 'Opening', characterIds: [], propIds: [] }] }
    const after: ScriptDoc = { ...before, assets: [{ id: 'hero', rev: 1, kind: 'character', name: 'Hero', description: '' }] }
    const node: NodeView = { nodeId: 'script', kind: 'script', title: 'Storyboard', x: 0, y: 0, w: 480, h: 320, z: 1, layoutRevision: 1,
      slots: [{ slotId: 'slot', slotKey: 'main', contentType: 'script', revision: 8, content: { type: 'script', doc: EMPTY_SCRIPT } }] }
    expect(nodeRefPreview(node, assetUrl, messages.en)).toEqual({ kind: 'script', label: 'Storyboard', shots: 0, assets: 0 })
    const versions: SlotVersionView[] = [before, after].map((doc, index) => ({ ...version(index ? 3 : 1, ''), content: { type: 'script', doc } }))
    const preview = reviewChangePreview({ ...change, nodeId: 'script', nodeKind: 'script' }, node, versions, assetUrl, undefined, 'en')
    expect(preview.title).toBe('Storyboard')
    expect(preview.before).toEqual({ kind: 'script', label: 'Storyboard', shots: 1, assets: 0 })
    expect(preview.after).toEqual({ kind: 'script', label: 'Storyboard', shots: 1, assets: 1 })
    const props: ReviewDrawerProps = { item: item(), messages: [], completionReport: null, changes: [preview], hasMore: false, onClose() {}, onLoadMore() {}, onLocateNode() {}, async onApprove() {}, async onReject() {} }
    for (const locale of ['en', 'zh-CN'] as const) {
      const html = renderToStaticMarkup(createElement(LocaleProvider, { locale, setLocale() {}, children: createElement(ReviewDrawer, props) }))
      expect(html).toContain('Storyboard')
      expect(html).toContain(locale === 'en' ? '1 shots · 1 assets' : '1 个镜头 · 1 个资产')
      expect(html).toContain('M3 9h18M3 14h18M9 9v11')
    }
  })
  it('messages sort ascending by time and ID; overlapping pages preserve message state from newer reads', () => {
    const old = message('b', 2)
    const updated = { ...old, readAt: 5 }
    expect(mergeReviewMessages([old, message('later', 3)], [message('a', 2), updated, message('first', 1)]))
      .toEqual([message('first', 1), message('a', 2), updated, message('later', 3)])
  })

  it('shows only done explicitly linked to this activation; manual review, old reports, or other work items cannot substitute', () => {
    const previous = message('old', 1)
    const current = message('current', 2)
    expect(reviewCompletionReport(item(), [previous, current])).toBe(current)
    expect(reviewCompletionReport(item({ reviewReportId: null }), [previous, current])).toBeNull()
    expect(reviewCompletionReport(item(), [previous])).toBeNull()
    expect(reviewCompletionReport(item({ status: 'in_progress' }), [current])).toBeNull()
    expect(reviewCompletionReport(item(), [{ ...current, kind: 'reply' }])).toBeNull()
    expect(reviewCompletionReport(item(), [{ ...current, workItemId: 'other' }])).toBeNull()
  })

  it('loads more pages if the activation report is absent from the first page, stops when found, and preserves earlier-history pagination', async () => {
    const call = vi.fn().mockResolvedValueOnce({ item: item(), messages: [message('recent', 10, { kind: 'reply' })], hasMore: true })
      .mockResolvedValueOnce({ item: item(), messages: [message('current', 5), message('older', 4)], hasMore: true })
    const result = await loadReviewMessages({ call } as unknown as RpcClient, { spaceId: 'space', workItemId: 'work' }, () => true)
    expect(result?.messages.map(message => message.messageId)).toEqual(['older', 'current', 'recent'])
    expect(result?.hasMore).toBe(true)
    expect(call.mock.calls).toEqual([
      ['work.get', { spaceId: 'space', workItemId: 'work', limit: 100 }],
      ['work.get', { spaceId: 'space', workItemId: 'work', limit: 100, beforeCreatedAt: 10 }],
    ])
    call.mockReset().mockResolvedValue({ item: item({ reviewReportId: null }), messages: [message('old', 1)], hasMore: true })
    expect((await loadReviewMessages({ call } as unknown as RpcClient, { spaceId: 'space', workItemId: 'work' }, () => true))?.messages).toEqual([message('old', 1)])
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('project switching stops report pagination; missing report IDs and stalled cursors fail explicitly', async () => {
    let current = true
    const call = vi.fn().mockImplementation(async () => { current = false; return { item: item(), messages: [message('old', 1)], hasMore: true } })
    const params = { spaceId: 'space', workItemId: 'work' }
    expect(await loadReviewMessages({ call } as unknown as RpcClient, params, () => current)).toBeNull()
    expect(call).toHaveBeenCalledTimes(1)
    call.mockReset().mockResolvedValue({ item: item(), messages: [message('old', 1)], hasMore: false })
    await expect(loadReviewMessages({ call } as unknown as RpcClient, params, () => true)).rejects.toThrow('本轮完成报告不存在')
    call.mockReset().mockResolvedValue({ item: item(), messages: [message('old', 1)], hasMore: true })
    await expect(loadReviewMessages({ call } as unknown as RpcClient, params, () => true)).rejects.toThrow('消息历史分页没有前进')
  })

  it('compares exact revisions; titles use the first line of the text main slot without substituting current content for history', () => {
    const node: NodeView = { nodeId: 'node', kind: 'text', x: 0, y: 0, w: 100, h: 100, z: 1, layoutRevision: 8,
      slots: [{ slotId: 'slot', slotKey: 'main', contentType: 'text', revision: 8, content: { type: 'text', body: '当前标题\n正文' } }] }
    const preview = reviewChangePreview(change, node, [version(1, '之前'), version(3, '之后'), version(8, '最新')], assetUrl)
    expect(preview.title).toBe('当前标题')
    expect(preview.before).toEqual({ kind: 'text', text: '之前', label: '当前标题' })
    expect(preview.after).toEqual({ kind: 'text', text: '之后', label: '当前标题' })
    expect(reviewChangePreview(change, node, [version(8, '最新')], assetUrl).before).toEqual({ kind: 'missing', label: '修订 r1 没有可用预览' })
  })

  it('without node metadata, uses media types from changes; the added side is empty and read errors are visible', () => {
    const versions: SlotVersionView[] = [{ ...version(3, ''), content: { type: 'asset', assetVersionId: 'video', mime: 'video/mp4' } }]
    const preview = reviewChangePreview({ ...change, nodeKind: 'video', change: 'created', fromRevision: null }, undefined, versions, assetUrl)
    expect(preview.nodeKind).toBe('video')
    expect(preview.before).toBeNull()
    expect(preview.after).toEqual({ kind: 'video', src: '/assets/space/video', label: '视频' })
    expect(reviewChangePreview(change, undefined, [], assetUrl, '连接已断开').before).toEqual({ kind: 'missing', label: '读取预览失败：连接已断开' })
  })

  it('image-generation prompt and output slots are labeled separately', () => {
    const image = { nodeId: 'node', kind: 'image', x: 0, y: 0, w: 1, h: 1, z: 0, layoutRevision: 1, slots: [
      { slotId: 'p', slotKey: 'prompt', contentType: 'text', revision: 1, content: { type: 'text', body: '雨夜' } },
      { slotId: 'm', slotKey: 'main', contentType: 'image', revision: 1, content: { type: 'empty' } },
    ] } as NodeView
    const created = { ...change, nodeId: 'node', nodeKind: 'image' as const, change: 'created' as const, fromRevision: null }
    expect(reviewChangePreview({ ...created, slotId: 'p' }, image, [], assetUrl).title).toBe('图片 · 提示词')
    expect(reviewChangePreview({ ...created, slotId: 'm' }, image, [], assetUrl).title).toBe('图片 · 产物')
  })

  it('deleted-history queries include includeDeleted; missing previews retain deletion information with a nonblocking notice', async () => {
    const deleted: WorkChange = { ...change, nodeKind: 'image', change: 'deleted', toRevision: null }
    const call = vi.fn().mockRejectedValue(new Error('Slot does not exist or has been deleted'))
    await expect(loadReviewHistory({ call } as unknown as RpcClient, deleted, () => true)).rejects.toThrow('Slot does not exist or has been deleted')
    expect(call).toHaveBeenCalledWith('slot.history', { slotId: 'slot', limit: 200, includeDeleted: true })
    const preview = reviewChangePreview(deleted, undefined, [], assetUrl, 'Slot does not exist or has been deleted')
    expect(preview.nodeKind).toBe('image')
    expect(preview.before).toEqual({ kind: 'missing', label: '读取预览失败：Slot does not exist or has been deleted' })
    expect(preview.after).toBeNull()
    const props: ReviewDrawerProps = {
      item: item(), messages: [], completionReport: null, changes: [preview], hasMore: false, warning: '部分产物预览无法读取',
      onClose() {}, onLoadMore() {}, onLocateNode() {}, async onApprove() {}, async onReject() {},
    }
    const html = renderToStaticMarkup(createElement(ReviewDrawer, props))
    expect(html).toContain('部分产物预览无法读取')
    expect(html).toContain('删除前')
    expect(html).not.toContain('修改后')
    expect(html).not.toMatch(/class="is-primary" disabled/)
    expect(renderToStaticMarkup(createElement(ReviewDrawer, { ...props, error: '读取审阅内容失败' }))).toMatch(/class="is-primary" disabled/)
    expect(renderToStaticMarkup(createElement(ReviewDrawer, { ...props, loading: true }))).toMatch(/class="is-primary" disabled/)
  })

  it('slot history paginates on demand until both before and after revisions are available', async () => {
    const call = vi.fn().mockResolvedValueOnce({ versions: [version(4, 'four'), version(3, 'three')], hasMore: true })
      .mockResolvedValueOnce({ versions: [version(2, 'two'), version(1, 'one')], hasMore: false })
    const rpc = { call } as unknown as RpcClient
    expect((await loadReviewHistory(rpc, change, () => true)).map(value => value.revision)).toEqual([4, 3, 2, 1])
    expect(call.mock.calls).toEqual([
      ['slot.history', { slotId: 'slot', limit: 200 }],
      ['slot.history', { slotId: 'slot', limit: 200, beforeRevision: 3 }],
    ])
    call.mockClear()
    expect(await loadReviewHistory(rpc, { ...change, slotId: null }, () => true)).toEqual([])
    expect(call).not.toHaveBeenCalled()
  })

  it('late project reads send no further pages; empty or stalled pagination throws', async () => {
    let current = true
    const call = vi.fn().mockImplementation(async () => { current = false; return { versions: [version(3, 'three')], hasMore: true } })
    expect(await loadReviewHistory({ call } as unknown as RpcClient, change, () => current)).toEqual([])
    expect(call).toHaveBeenCalledTimes(1)
    call.mockResolvedValue({ versions: [], hasMore: true })
    await expect(loadReviewHistory({ call } as unknown as RpcClient, change, () => true)).rejects.toThrow('版本历史分页没有前进')
  })
})

describe('Board thumbnails for this activation', () => {
  it('sorts by recent changes and deduplicates nodes, includes prompt changes, and skips deleted nodes, empty outputs, and text', () => {
    const media = (nodeId: string, kind: 'image' | 'video', asset = true): NodeView => ({
      nodeId, kind, x: 0, y: 0, w: 100, h: 100, z: 0, layoutRevision: 1,
      slots: [{ slotId: `${nodeId}-main`, slotKey: 'main', contentType: kind, revision: 1,
        content: asset ? { type: 'asset', assetVersionId: nodeId, mime: `${kind}/test` } : { type: 'empty' } }],
    })
    const nodes = new Map(['old', 'prompt', 'deleted', 'empty', 'video'].map(id => [id, media(id, id === 'video' ? 'video' : 'image', id !== 'empty')]))
    const changes: WorkChange[] = [
      { ...change, nodeId: 'old', nodeKind: 'image', lastSeq: 1 },
      { ...change, nodeId: 'prompt', nodeKind: 'image', slotId: 'prompt-slot', lastSeq: 20 },
      { ...change, nodeId: 'prompt', nodeKind: 'image', slotId: 'main-slot', lastSeq: 19 },
      { ...change, nodeId: 'video', nodeKind: 'video', lastSeq: 10 },
      { ...change, nodeId: 'deleted', nodeKind: 'image', change: 'deleted', lastSeq: 40 },
      { ...change, nodeId: 'empty', nodeKind: 'image', lastSeq: 35 },
      { ...change, nodeId: 'text', lastSeq: 30 },
    ]
    expect(changedThumbnails(changes, nodes, assetUrl)).toEqual([
      { src: '/assets/space/prompt', kind: 'image' },
      { src: '/assets/space/video', kind: 'video' },
    ])
    expect(changedThumbnails([], nodes, assetUrl)).toEqual([])
  })
})

describe('Board history and role-free copy', () => {
  it('activation changes show bottom counts and location controls; zero changes hide both', () => {
    const render = (changeCount: number) => renderToStaticMarkup(createElement(WorkCard, { item: item({ status: 'in_review', changeCount }), variant: 'board', hasCompletionReport: false }))
    expect(render(2)).toContain('本轮改动 2 处')
    expect(render(2)).toContain('在画布中定位')
    expect(render(2)).toContain('没有完成报告')
    expect(render(0)).not.toContain('本轮改动')
    expect(render(0)).not.toContain('在画布中定位')
    expect(render(0)).not.toContain('框')
    expect(getQuickActions(item({ status: 'in_progress' }))).toEqual(['openSession', 'recall'])
  })

  it('activation hints explain parent-child hierarchy; cards show only the agent name', () => {
    for (const isRoot of [true, false]) {
      const html = renderToStaticMarkup(createElement(AgentChoiceDialog, { isRoot, onClose() {}, async onChoose() {} }))
      expect(html).toContain(isRoot ? '开始后可以自己完成，也可以拆分派发子工作项' : '开始后可以自己完成，完成后向上级报告')
      expect(html).not.toMatch(/协调者|执行者|普通对话/)
    }
    const html = renderToStaticMarkup(createElement(AgentsContext.Provider, { value: [{ kind: 'codex', label: 'Codex', icon: [] } as unknown as import('@vis/protocol').AgentView] }, createElement(WorkCard, { variant: 'board', item: item({ sessions: [{ sessionId: 's', agentKind: 'codex', title: '工作区原始标题', silentSince: null, activeTurnId: null, doing: null, lastActivityAt: null, archived: false }] }) })))
    expect(html).toContain('Codex')
    expect(html).not.toContain('工作区原始标题')
    expect(html).not.toMatch(/协调者|执行者|普通对话/)
  })
})
