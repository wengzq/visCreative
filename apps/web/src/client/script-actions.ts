import type { AgentKind, CanvasOp, MethodResult, NodeView, ScriptDoc, SessionSummary, TranscriptItem } from '@vis/protocol'
import type { NodeDecoration, ScriptActions, ScriptAgentRequest, ScriptAgentState, ScriptAgentTask } from '@vis/canvas-ui'
import { formatter, messagesFor, type Locale } from '@vis/ui-kit'
import { scriptMessages } from './script-messages'
import type { SpaceConnection } from './space'
import { RpcError } from './rpc'
import { reuseNodeDecorations } from './store'

export type ScriptRequestRecord = { nodeId: string; sessionId: string; messageId: string; task: ScriptAgentTask; turnId?: string }
const rid = () => `web-${crypto.randomUUID()}`

export async function createScriptSession(conn: SpaceConnection, agentKind: AgentKind) {
  const spaceId = conn.getView().space?.spaceId
  const session = await conn.rpc.call<MethodResult<'session.create'>>('session.create', {
    requestId: rid(), agentKind,
  })
  if (conn.getView().space?.spaceId !== spaceId || !conn.getView().ready) throw new RpcError('not_found', 'The script project is no longer open', { reason: 'session.not_found', params: { sessionId: session.sessionId } })
  return { sessionId: session.sessionId }
}

export function scriptDoc(node: NodeView): ScriptDoc | undefined {
  const content = node.slots.find(slot => slot.slotKey === 'main')?.content
  return content?.type === 'script' ? content.doc : undefined
}

export function scriptMessage(node: NodeView, request: ScriptAgentRequest, locale: Locale) {
  const m = messagesFor(scriptMessages, locale)
  return {
    text: [m[request.task], request.shotIds?.length ? m.selectedShots(request.shotIds.join(', ')) : '', request.text].filter(Boolean).join('\n\n'),
    refs: [...new Set([node.nodeId, ...(node.inputs ?? [])])].map(nodeId => ({ nodeId, versionPolicy: 'latest-at-execution' as const })),
  }
}

export function shotNodeOps(node: NodeView, nodes: readonly NodeView[], shotId: string, role: 'first' | 'video', locale: Locale): CanvasOp[] {
  const doc = scriptDoc(node)
  const index = doc?.shots.findIndex(shot => shot.id === shotId) ?? -1
  if (!doc || index < 0) throw new RpcError('not_found', 'The script shot no longer exists', { reason: 'canvas.node_not_found', params: { nodeId: node.nodeId } })
  const shot = doc.shots[index]!
  const assetIds = [shot.sceneId, ...shot.characterIds, ...shot.propIds]
  const inputNodeIds = [...new Set(assetIds.flatMap(id => {
    const imageId = doc.assets.find(asset => asset.id === id)?.imageNodeId
    return imageId && nodes.some(node => node.nodeId === imageId && node.kind === 'image') ? [imageId] : []
  }))]
  const m = messagesFor(scriptMessages, locale)
  const number = formatter(locale).number(index + 1)
  return [{
    op: 'node.create', tempId: 'n', kind: role === 'video' ? 'video' : 'image',
    x: node.x + node.w + 64, y: node.y + index * 380, w: 320, h: role === 'video' ? 180 : 320,
    category: scriptMessages['zh-CN'].shot, title: role === 'video' ? m.videoTitle(number) : m.shotTitle(number),
    shot: { scriptNodeId: node.nodeId, shotId, role }, inputNodeIds,
    prompt: (role === 'video' ? shot.videoPrompt : shot.framePrompt) ?? '',
  }]
}

export function scriptAgentDecoration(node: NodeView, sessions: ReadonlyMap<string, SessionSummary>, requests: readonly ScriptRequestRecord[], items: readonly TranscriptItem[] = []): ScriptAgentState | undefined {
  const sessionId = scriptDoc(node)?.sessionId
  const owner = sessionId ? sessions.get(sessionId) : undefined
  if (!owner) return
  const activeTurnId = owner.activeTurnId
  const request = [...requests].reverse().find(request => request.nodeId === node.nodeId && request.sessionId === owner.sessionId &&
    activeTurnId && (request.turnId === activeTurnId || items.some(item => item.kind === 'user' && item.turnId === activeTurnId && (item.payload as { messageId?: string })?.messageId === request.messageId)))
  return { sessionId: owner.sessionId, title: owner.title, task: request?.task ?? null, running: !!activeTurnId }
}

export function withScriptDecorations(nodes: readonly NodeView[], sessions: ReadonlyMap<string, SessionSummary>, base: ReadonlyMap<string, NodeDecoration>, requests: readonly ScriptRequestRecord[], transcripts: ReadonlyMap<string, { items: TranscriptItem[] }>, previous?: ReadonlyMap<string, NodeDecoration>) {
  const decorations = new Map(base)
  for (const node of nodes) {
    if (node.kind !== 'script') continue
    const owner = scriptDoc(node)?.sessionId
    const scriptAgent = scriptAgentDecoration(node, sessions, requests, owner ? transcripts.get(owner)?.items : [])
    if (scriptAgent) decorations.set(node.nodeId, { ...(base.get(node.nodeId) ?? { running: 0, problems: [] }), scriptAgent })
  }
  return reuseNodeDecorations(decorations, previous)
}

export function scriptCanvasActions(conn: SpaceConnection, call: <T = any>(method: string, params?: unknown) => Promise<T>, apply: (ops: CanvasOp[], description?: string) => Promise<{ idMap: Record<string, string> }>, locale: () => Locale): ScriptActions {
  const read = async (nodeId: string) => {
    const result = await call<{ nodes: NodeView[] }>('canvas.get', { nodeIds: [nodeId] })
    const node = result.nodes.find(node => node.nodeId === nodeId)
    if (!node) throw new RpcError('not_found', 'The script node no longer exists', { reason: 'canvas.node_not_found', params: { nodeId } })
    return node
  }
  return {
    onPlanScriptBatch: params => call('script.batch.plan', params),
    onStartScriptBatch: params => call('script.batch.start', params),
    onCancelScriptBatch: params => call('script.batch.cancel', params),
    onResumeScriptBatch: params => call('script.batch.resume', params),
    async onCreateScript(at) {
      const { idMap } = await apply([{ op: 'node.create', tempId: 'n', kind: 'script', ...at, w: 420, h: 300 }], messagesFor(scriptMessages, locale()).create)
      return idMap.n!
    },
    async onCreateShotNode(scriptNodeId, shotId, role) {
      const node = await read(scriptNodeId)
      const { idMap } = await apply(shotNodeOps(node, [...conn.getView().state.nodes.values()], shotId, role, locale()), messagesFor(scriptMessages, locale()).create)
      return idMap.n!
    },
    async onScriptAssetImage(scriptNodeId, assetId, file) {
      const node = await read(scriptNodeId)
      const asset = scriptDoc(node)?.assets.find(asset => asset.id === assetId)
      if (!asset) throw new RpcError('not_found', 'The script asset no longer exists', { reason: 'canvas.node_not_found', params: { nodeId: scriptNodeId } })
      let imported: MethodResult<'asset.import'> | undefined
      if (file) {
        const projectId = conn.getView().space?.spaceId
        const response = await fetch(`/upload?t=${encodeURIComponent(conn.token)}&space=${encodeURIComponent(projectId ?? '')}&name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file })
        const result = await response.json()
        if (!response.ok) throw new RpcError(result.error?.data?.code ?? result.error?.code ?? 'unavailable', result.error?.message ?? `HTTP ${response.status}`, result.error?.data)
        imported = result
        if (imported?.kind !== 'image') throw new RpcError('invalid_params', 'Reference assets require an image', { reason: 'asset.kind_mismatch', params: { kind: imported?.kind ?? '', versionKind: 'image' } })
      }
      const { idMap } = await apply([{
        op: 'node.create', tempId: 'n', kind: 'image', title: asset.name.slice(0, 60),
        category: scriptMessages['zh-CN'][asset.kind], x: node.x - 384, y: node.y, w: 320, h: 320,
        ...(imported ? { content: { assetVersionId: imported.assetVersionId } } : { prompt: '' }),
      }], messagesFor(scriptMessages, locale()).reference)
      return idMap.n!
    },
  }
}

export async function sendScriptRequest(conn: SpaceConnection, request: ScriptAgentRequest, locale: Locale, record: (record: ScriptRequestRecord) => void): Promise<{ sessionId: string }> {
  const projectId = conn.getView().space?.spaceId
  const assertProject = () => {
    if (conn.getView().space?.spaceId !== projectId || !conn.getView().ready) throw new RpcError('not_found', 'The script project is no longer open', { reason: 'canvas.node_not_found', params: { nodeId: request.nodeId } })
  }
  const { nodes } = await conn.rpc.call<MethodResult<'canvas.get'>>('canvas.get', { nodeIds: [request.nodeId] })
  assertProject()
  const node = nodes.find(node => node.nodeId === request.nodeId)
  if (!node) throw new RpcError('not_found', 'The script node no longer exists', { reason: 'canvas.node_not_found', params: { nodeId: request.nodeId } })
  const doc = scriptDoc(node)
  let sessionId = request.session && 'sessionId' in request.session ? request.session.sessionId : doc?.sessionId
  if (request.session && 'new' in request.session) {
    const created = await createScriptSession(conn, request.session.agentKind)
    assertProject()
    sessionId = created.sessionId
  }
  if (!sessionId) throw new RpcError('not_found', 'Choose an owning session first', { reason: 'session.not_found', params: { sessionId: '' } })
  // A newly created owner is persisted before the first request so the UI can recover after a send failure.
  if (sessionId !== doc?.sessionId && doc) {
    const slot = node.slots.find(slot => slot.slotKey === 'main')!
    await conn.rpc.call('canvas.apply', { requestId: rid(), ops: [{ op: 'script.patch', slotId: slot.slotId, ops: [{ kind: 'doc.set', rev: doc.rev, fields: { sessionId } }] }] })
    assertProject()
  }
  const result = await conn.rpc.call<MethodResult<'session.sendMessage'>>('session.sendMessage', { requestId: rid(), sessionId, ...scriptMessage(node, request, locale) })
  assertProject()
  record({ nodeId: node.nodeId, sessionId, messageId: result.messageId, task: request.task })
  return { sessionId }
}
