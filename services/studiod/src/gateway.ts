import { refreshTextDeletionApprovals } from './text-deletion'
import { assertAgentTextWrites, childTextOps } from './writing-permissions'
import type { MediaTools } from '@vis/assets'
import { appendNotice, getGuide } from '@vis/workbench-core'
import { VisError } from '@vis/domain'
import { readActiveJobViews } from '@vis/generation'
import { readNodes } from '@vis/canvas-core'
import { requireAgentSession, requireAgentWriteSession } from '@vis/library-core'
import {
  type Caller, type Credential, describeCapability, isMethodName, listCapabilities, METHODS, type MethodName, type MethodParams, type MethodResult,
  PROTOCOL_VERSION, RPC_APPLICATION_ERROR, type RpcFailure, runtime as runtimeSpec, type TransientEvent, type MediaTaskProgress,
} from '@vis/protocol'
import { appSchema, type AppDb, appendEvent, currentSeq, eq, inArray, readEventsAfter, spaceSchema as s, workspaceMigrationBoundary } from '@vis/storage'
import { findAgentInstance, findInstanceTurn, sameSecret, spaceIdOfToken } from './auth'
import { assetView, extractFrames, importAgentFile, importAsset, listModels } from './media'
import { listProjectSkills, pickDirectory, reveal, validateDirectory } from './filesystem'
import { join } from 'node:path'
import { statSync } from 'node:fs'
import type { ProviderManager } from './providers'
import type { SpaceHost, SpaceRegistry } from './space-host'
import { readActiveMediaTasks } from './media-tasks'
import { databaseVersion } from './database-version'
import { listFonts } from './fonts'
import { previewWritingFile } from './writing'
import { splitWriting } from './writing-split'
import { assertAgentPrevizWrites } from './previz-permissions'
import { assertAgentSceneWrites, stampUserSceneWrites } from './scene-permissions'
import { extractBlockout } from './previz-blockout'

// JSON-RPC 2.0 reserved error codes
const PARSE_ERROR = -32700
const INVALID_REQUEST = -32600
const METHOD_NOT_FOUND = -32601
const INTERNAL_ERROR = -32603

/** Peer on a connection: the transport handles framing; this layer only sends and receives message objects. */
export type Peer = { send(message: object): void; close(): void }
export type Connection = { receive(line: string): void; closed(): void }

export type ShutdownReason = MethodParams<'runtime.shutdown'>['reason'] | 'idle'

export type GatewayDeps = {
  appDb: AppDb
  spaces: SpaceRegistry
  providers?: ProviderManager
  usage?: () => MethodResult<'generation.usage'>
  uiToken: string
  studiodVersion: string
  runtimeEpoch: string
  onShutdown(reason: ShutdownReason): void
  /** Local media tools for import and frame extraction */
  media: MediaTools
  /** Fallback event polling interval; events are also pushed immediately after each request. */
  eventPollMs?: number
  now?: () => number
}

export interface Gateway {
  accept(peer: Peer): Connection
  /** Active turns and generation jobs, used for exit confirmation and idle exit */
  activity(): MethodResult<'runtime.activity'>
  uiConnections(): number
  /** Transient events such as streamed text: pushed only to UI clients subscribed to the space, never persisted. */
  publishTransient(spaceId: string, event: TransientEvent | MediaTaskProgress): void
  close(): void
}

type AgentIdentity = { spaceId: string; instanceId: string; sessionId: string }

type ConnState = {
  peer: Peer
  phase: 'hello' | 'ready' | 'closed'
  caller?: Caller
  /** UI connections with a mismatched protocol version can only call runtime.shutdown (RFC 0004 "Version compatibility"). */
  shutdownOnly?: boolean
  skillsSeq?: number
  agent?: AgentIdentity
  /** The space currently open in the UI, determined by events.subscribe */
  subscription?: { spaceId: string; cursor: number }
}

type Ctx = { conn: ConnState; caller: Caller; host: SpaceHost }
type Handler<M extends MethodName> = (params: MethodParams<M>, ctx: Ctx) => MethodResult<M> | Promise<MethodResult<M>>

const ACTIVE_TURN = ['running', 'waiting_user'] as const
const ACTIVE_JOB = ['queued', 'running', 'finalizing'] as const

export function createGateway(deps: GatewayDeps): Gateway {
  const now = deps.now ?? Date.now
  const conns = new Set<ConnState>()
  const workCards = new Map<string, { cursor: number; cards: Map<string, { serialized: string; revision: number }> }>()
  const doingEmittedAt = new Map<string, number>()
  let closed = false
  let lastInbox: string | undefined
  let lastSlots: string | undefined
  let connectionRevision = 0
  let nextWorkCardAt = Infinity
  let forcePending = false
  let retryAt = 0
  let retryDelay = 0
  let lastFailure: string | undefined
  let lastPoll: { connections: number; app: string | undefined; day: string; hosts: Map<SpaceHost, string | undefined> } | undefined

  function pollChanged() {
    const app = databaseVersion(deps.appDb)
    const day = new Date(now()).toDateString()
    const hosts = new Map(deps.spaces.opened().map(host => [host, databaseVersion(host.db)]))
    const changed = app === undefined || !lastPoll || lastPoll.connections !== connectionRevision || lastPoll.app !== app || lastPoll.day !== day
      || lastPoll.hosts.size !== hosts.size || [...hosts].some(([host, version]) => version === undefined || lastPoll!.hosts.get(host) !== version)
      || now() >= nextWorkCardAt
    return { changed, snapshot: { connections: connectionRevision, app, day, hosts } }
  }

  /** Check the turn and work item on every call; once a stop request is accepted, old token permissions cannot be restored. */
  function agentTurn(ctx: Ctx) {
    const turn = findInstanceTurn(ctx.host.db, ctx.conn.agent!.instanceId)
    if (!turn || ctx.host.sessions.isTurnStopping(turn.turnId)) throw VisError.of('forbidden', 'runtime.turn_inactive', {}, 'The runtime instance has exited, the turn has stopped, or no turn is active')
    requireAgentSession(ctx.host.db, ctx.conn.agent!.sessionId)
    return turn
  }

  function recordAgentActivity(conn: ConnState) {
    if (conn.caller !== 'agent') return
    const host = hostFor(conn)
    const turn = findInstanceTurn(host.db, conn.agent!.instanceId)
    if (turn) host.sessions.recordActivity(conn.agent!.sessionId, turn.turnId)
  }

  function agentSession(conn: ConnState) {
    const session = hostFor(conn).db.select({ workItemId: s.sessions.workItemId, archivedAt: s.sessions.archivedAt }).from(s.sessions).where(eq(s.sessions.id, conn.agent!.sessionId)).get()
    if (!session || session.archivedAt !== null) throw VisError.of('forbidden', 'runtime.session_inactive', {}, 'The token session does not exist or is archived')
    return session
  }

  function workActor(ctx: Ctx) {
    if (ctx.caller !== 'agent') return undefined
    agentTurn(ctx)
    const session = requireAgentWriteSession(ctx.host.db, ctx.conn.agent!.sessionId)
    return { sessionId: ctx.conn.agent!.sessionId, workItemId: session.workItemId }
  }

  const handlers: { [M in Exclude<MethodName, 'agents.list' | 'series.list' | 'series.create' | 'series.rename' | 'series.delete' | 'series.mediaGet' | 'providers.list' | 'providers.update' | 'providers.setKey' | 'providers.clearKey' | 'events.subscribe' | `space.${string}` | 'generation.usage' | 'fs.pickDirectory' | 'fs.validateDirectory' | 'fs.listSkills' | 'fs.reveal' | `skill.${string}` | `preferences.${string}` | 'runtime.activity' | 'runtime.shutdown' | 'work.inbox' | 'work.slots' | 'work.setSlotLimit'>]: Handler<M> } = {
    'text.requestDelete': (p, ctx) => {
      const turn = agentTurn(ctx)
      return ctx.host.textDeletion.request(p, ctx.conn.agent!.sessionId, turn.turnId)
    },
    'text.propose': (p, ctx) => {
      agentTurn(ctx)
      return ctx.host.textProposals.propose(p, ctx.conn.agent!.sessionId)
    },
    'text.proposal.list': (p, ctx) => {
      if (ctx.caller === 'agent') agentTurn(ctx)
      return ctx.host.textProposals.list(p)
    },
    'text.proposal.resolve': (p, { host }) => host.db.transaction(tx => { const result = host.textProposals.resolve(p); refreshTextDeletionApprovals(tx, now()); return result }, { behavior: 'immediate' }),
    'series.textList': (_p, ctx) => {
      agentTurn(ctx)
      const membership = deps.spaces.series.membership(ctx.host.spaceId)
      if (!membership) return { episodes: [] }
      return { episodes: deps.spaces.list().filter(space => space.spaceId !== ctx.host.spaceId && space.series?.seriesId === membership.seriesId)
        .sort((a, b) => a.series!.episode - b.series!.episode).map(space => ({ spaceId: space.spaceId, name: space.name, episode: space.series!.episode,
          nodes: deps.spaces.readTexts(space.spaceId).map(({ body: _body, format: _format, ...node }) => node) })) }
    },
    'series.textRead': (p, ctx) => {
      agentTurn(ctx)
      const membership = deps.spaces.series.membership(ctx.host.spaceId)
      const target = deps.spaces.list().find(space => space.spaceId === p.spaceId)
      if (!membership || p.spaceId === ctx.host.spaceId || target?.series?.seriesId !== membership.seriesId) throw VisError.of('forbidden', 'writing.same_series_required', {}, 'Only manuscripts of other projects in this series can be read')
      const node = deps.spaces.readTexts(p.spaceId).find(node => node.nodeId === p.nodeId)
      if (!node) throw VisError.of('not_found', 'writing.manuscript_not_found', {}, 'The manuscript is unavailable or excluded from series reading')
      return node
    },
    // Series writes follow the same rule as entity.create: an active turn, no work item needed (the library session has none).
    'series.entityList': (p, ctx) => {
      if (ctx.caller === 'agent') agentTurn(ctx)
      return ctx.host.seriesEntities.list(p)
    },
    'entity.link': (p, ctx) => {
      if (ctx.caller === 'agent') {
        if (p.replaceEntityId !== undefined) throw VisError.of('forbidden', 'entity.replace_ui_only', {}, 'Only the user can replace an existing setting with a series setting')
        agentTurn(ctx)
      }
      return ctx.host.seriesEntities.link(p)
    },
    'entity.seriesDiff': (p, { host }) => host.seriesEntities.diff(p),
    'entity.updateFromSeries': (p, { host }) => host.seriesEntities.updateFromSeries(p),
    'entity.resetToSeries': (p, { host }) => host.seriesEntities.resetToSeries(p),
    'entity.publish': (p, { host }) => {
      try { return host.seriesEntities.publish(p) }
      finally { seriesChanged(deps.spaces.series.membership(host.spaceId)?.seriesId) }
    },
    'session.create': (p, { host }) => host.sessions.create(p),
    'session.list': (p, { host }) => host.sessions.list(p),
    'session.agentOptions': (p, { host }) => host.sessions.agentOptions(p),
    'session.setAgentConfig': (p, { host }) => host.sessions.setAgentConfig(p),
    'session.rename': (p, { host }) => host.sessions.rename(p),
    'session.resetTitle': (p, { host }) => host.sessions.resetTitle(p),
    'session.setTitle': (p, ctx) => {
      agentTurn(ctx)
      return ctx.host.sessions.setTitle(ctx.conn.agent!.sessionId, p)
    },
    'session.sendMessage': (p, { host }) => host.sessions.sendMessage(p),
    'session.stop': (p, { host }) => host.sessions.stop(p),
    'session.sendNow': (p, { host }) => host.sessions.sendNow(p),
    'session.respondApproval': (p, { host }) => host.workDeletion.respond(p) ?? host.textDeletion.respond(p) ?? host.sessions.respondApproval(p),
    'session.resumeQueue': (p, { host }) => host.sessions.resumeQueue(p),
    'session.clearQueue': (p, { host }) => host.sessions.clearQueue(p),
    'session.setApprovalMode': (p, { host }) => host.sessions.setApprovalMode(p),
    'session.retryMessage': (p, { host }) => host.sessions.retryMessage(p),
    'session.getTranscript': (p, { host }) => { host.textDeletion.expire(); host.workDeletion.expire(); return host.sessions.getTranscript(p) },
    'generation.submit': async (p, ctx) => {
      if (ctx.caller === 'ui') return ctx.host.generation.submit({ sessionId: null, turnId: null, inputSnapshotId: null }, p)
      const turn = agentTurn(ctx)
      try {
        return ctx.host.generation.submit({ sessionId: ctx.conn.agent!.sessionId, turnId: turn.turnId, inputSnapshotId: turn.inputSnapshotId }, p)
      } catch (error) {
        if (error instanceof VisError && error.code === 'quota_exceeded') {
          ctx.host.db.transaction(tx => appendNotice(tx, ctx.conn.agent!.sessionId, turn.turnId, error.code, error.message, Date.now(),
            typeof error.details?.reason === 'string' ? { reason: error.details.reason, params: error.details.params as Record<string, string | number> ?? {} } : undefined))
        }
        throw error
      }
    },
    'generation.cancel': (p, ctx) => {
      const turn = ctx.caller === 'agent' ? agentTurn(ctx) : undefined
      return ctx.host.generation.cancel({ sessionId: ctx.caller === 'agent' ? ctx.conn.agent!.sessionId : null, turnId: turn?.turnId ?? null, inputSnapshotId: turn?.inputSnapshotId ?? null }, p)
    },
    'generation.recheck': (p, ctx) => {
      const turn = ctx.caller === 'agent' ? agentTurn(ctx) : undefined
      return ctx.host.generation.recheck({ sessionId: ctx.caller === 'agent' ? ctx.conn.agent!.sessionId : null, turnId: turn?.turnId ?? null, inputSnapshotId: turn?.inputSnapshotId ?? null }, p)
    },
    'generation.regenerate': (p, ctx) => ctx.host.generation.regenerate({ sessionId: null, turnId: null, inputSnapshotId: null }, p),
    'generation.get': (p, ctx) => {
      if (ctx.caller === 'agent') agentTurn(ctx)
      return ctx.host.generation.get(p)
    },
    'canvas.apply': (p, ctx) => {
      if (ctx.caller === 'ui') {
        if (!p.ops.some(op => op.op === 'scene.set')) return ctx.host.canvas.apply({ kind: 'user' }, p)
        return ctx.host.db.transaction(tx => ctx.host.canvas.apply({ kind: 'user' }, { ...p, ops: stampUserSceneWrites(readNodes(tx), p.ops) }), { behavior: 'immediate' })
      }
      agentTurn(ctx)
      if (p.ops.some(op => op.op === 'scene.set' || (op.op === 'node.create' && op.kind === 'scene') || op.op === 'node.delete')) assertAgentSceneWrites(readNodes(ctx.host.db), p.ops)
      if (p.ops.some(op => op.op === 'previz.set' || op.op === 'node.delete')) assertAgentPrevizWrites(readNodes(ctx.host.db), p.ops)
      return ctx.host.db.transaction(tx => {
        assertAgentTextWrites(tx, p.ops)
        return ctx.host.canvas.apply({ kind: 'agent', sessionId: ctx.conn.agent!.sessionId }, { ...p, ops: childTextOps(tx, ctx.conn.agent!.sessionId, p.ops) })
      }, { behavior: 'immediate' })
    },
    'canvas.undo': (p, { host }) => host.canvas.undo(p),
    // Settings use the same active-session write gate as canvas operations.
    'entity.list': (p, ctx) => {
      if (ctx.caller === 'agent') agentTurn(ctx)
      return ctx.host.entities.list(p)
    },
    'entity.get': (p, ctx) => {
      if (ctx.caller === 'agent') agentTurn(ctx)
      return ctx.host.entities.get(p)
    },
    'entity.create': (p, ctx) => {
      if (ctx.caller === 'agent') {
        agentTurn(ctx)
        if (p.members !== undefined) throw VisError.of('forbidden', 'entity.members_ui_only', {}, 'Agents must propose member changes for user review')
      }
      return ctx.host.entities.create(p)
    },
    'entity.update': (p, ctx) => {
      if (ctx.caller === 'agent') {
        agentTurn(ctx)
        if (p.members !== undefined) throw VisError.of('forbidden', 'entity.members_ui_only', {}, 'Agents must propose member changes for user review')
      }
      return ctx.host.entities.update(p)
    },
    'entity.delete': (p, { host }) => host.entities.delete(p),
    'entity.propose': (p, ctx) => {
      agentTurn(ctx)
      return ctx.host.entities.propose(ctx.conn.agent!.sessionId, p)
    },
    'entity.proposalList': (p, ctx) => {
      if (ctx.caller === 'agent') agentTurn(ctx)
      return ctx.host.entities.proposalList(p)
    },
    'entity.proposalResolve': (p, { host }) => host.entities.proposalResolve(p),
    'entity.unmerge': (p, { host }) => host.entities.unmerge(p),
    'canvas.redo': (p, { host }) => host.canvas.redo(p),
    'canvas.get': (p, ctx) => {
      if (ctx.caller === 'ui') return ctx.host.canvas.get(p)
      return ctx.host.canvas.get(p, { inputSnapshotId: agentTurn(ctx).inputSnapshotId })
    },
    'slot.history': (p, ctx) => {
      if (ctx.caller === 'agent') {
        agentTurn(ctx)
        if (p.includeDeleted) throw VisError.of('forbidden', 'canvas.deleted_history_ui_only', {}, 'Only the UI can view deleted node history')
      }
      return ctx.host.canvas.history(p)
    },
    'work.list': (p, ctx) => ctx.host.work.list(p, workActor(ctx)),
    'work.get': (p, ctx) => ctx.host.work.get(p, workActor(ctx)),
    'work.create': (p, { host }) => host.work.create(p),
    'work.dispatch': (p, ctx) => ctx.host.work.dispatch(p, workActor(ctx)),
    'work.activate': (p, ctx) => ctx.host.work.activate(p, workActor(ctx)),
    'work.deletePlan': (p, { host }) => host.work.deletePlan(p),
    'work.requestDelete': (p, ctx) => {
      const turn = agentTurn(ctx)
      const actor = workActor(ctx)!
      return ctx.host.workDeletion.request(p, actor, turn.turnId)
    },
    'work.delete': async (p, { host }) => {
      const result = await host.work.delete(p)
      lastInbox = ''
      lastSlots = ''
      return result
    },
    'work.recall': (p, ctx) => ctx.host.work.recall(p, workActor(ctx)),
    'work.move': (p, { host }) => host.work.move(p),
    'work.reparent': (p, { host }) => host.work.reparent(p),
    'work.reopen': (p, { host }) => host.work.reopen(p),
    'work.submitReview': (p, { host }) => host.work.submitReview(p),
    'work.report': (p, ctx) => ctx.host.work.report(p, workActor(ctx)),
    'work.reply': (p, ctx) => ctx.host.work.reply(p, workActor(ctx)),
    'work.review': (p, ctx) => ctx.host.work.review(p, workActor(ctx)),
    'work.update': (p, { host }) => host.work.update(p),
    'work.markRead': (p, { host }) => host.work.markRead(p),
    'work.changes': (p, { host }) => host.work.changes(p),
    // RFC 0027 step a: metadata writes share the canvas session and work-item checks.
    'asset.list': (p, ctx) => {
      if (ctx.caller === 'agent') agentTurn(ctx)
      return ctx.host.library.list(p, ctx.caller)
    },
    'asset.versions': (p, { host }) => host.library.versions(p),
    'asset.update': (p, { host }) => host.library.update(p),
    'asset.label': (p, ctx) => {
      const actor = workActor(ctx)!
      return ctx.host.library.label(p, actor.sessionId)
    },
    'library.state': (_p, ctx) => {
      if (ctx.caller === 'agent') agentTurn(ctx)
      return ctx.host.library.state()
    },
    'library.setSession': (p, { host }) => host.library.setSession(p),
    'library.runStart': (p, { host }) => host.library.runStart(p),
    'library.runList': (p, { host }) => host.library.runList(p),
    'library.runRevert': (p, { host }) => host.library.runRevert(p),
    'asset.get': (p, ctx) => {
      if (ctx.caller === 'agent') agentTurn(ctx)
      return assetView(ctx.host, ctx.host.db, p.assetVersionId)
    },
    'font.list': (_p, ctx) => {
      if (ctx.caller === 'agent') agentTurn(ctx)
      return listFonts(ctx.host.db)
    },
    'model.list': (_p, { host }) => listModels(host),
    'writing.split': (p, { host }) => {
      try { return splitWriting(deps.appDb, deps.spaces, host, p) }
      finally { spacesChanged(); seriesChanged(deps.spaces.series.membership(host.spaceId)?.seriesId) }
    },
    'writing.importPreview': p => previewWritingFile(p.path),
    'asset.import': (p, { host }) => importAsset(host, deps.media, p),
    'asset.importFile': (p, ctx) => {
      agentTurn(ctx)
      return importAgentFile(ctx.host, deps.media, ctx.conn.agent!.sessionId, p)
    },
    'asset.extractFrames': (p, ctx) => {
      if (ctx.caller === 'agent') agentTurn(ctx)
      return extractFrames(ctx.host, deps.media, p)
    },
    'previz.extractBlockout': (p, ctx) => extractBlockout(ctx.host, deps.media, p),
    'media.process': (p, ctx) => {
      if (ctx.caller === 'agent' && p.operation === 'video.exportMov') throw VisError.of('forbidden', 'media.export_user_only', {}, 'Only the user can export MOV delivery files')
      if (ctx.caller === 'agent') agentTurn(ctx)
      return ctx.host.mediaTasks.process(ctx.caller === 'agent' ? { kind: 'agent', sessionId: ctx.conn.agent!.sessionId } : { kind: 'user' }, p)
    },
    'media.cancel': (p, { host }) => host.mediaTasks.cancel(p.taskId),
    'media.dismiss': (p, { host }) => host.mediaTasks.dismiss(p.taskId),
    'media.exportDownload': (p, { host }) => host.mediaTasks.exportDownload(p.taskId),
    'media.get': (p, ctx) => {
      if (ctx.caller === 'agent') agentTurn(ctx)
      return ctx.host.mediaTasks.get(p)
    },
    'script.batch.plan': (p, ctx) => {
      if (ctx.caller === 'agent') agentTurn(ctx)
      return ctx.host.scriptBatches.plan(p)
    },
    'script.batch.start': (p, ctx) => {
      const turn = ctx.caller === 'agent' ? agentTurn(ctx) : undefined
      return ctx.host.scriptBatches.start(p, turn ? { sessionId: ctx.conn.agent!.sessionId, turnId: turn.turnId } : undefined)
    },
    'script.batch.get': (p, ctx) => {
      if (ctx.caller === 'agent') agentTurn(ctx)
      return ctx.host.scriptBatches.get(p)
    },
    'script.batch.list': (p, ctx) => {
      if (ctx.caller === 'agent') agentTurn(ctx)
      return ctx.host.scriptBatches.list(p)
    },
    'script.batch.approve': (p, { host }) => host.scriptBatches.approve(p),
    'script.batch.reject': (p, { host }) => host.scriptBatches.reject(p),
    'script.batch.cancel': (p, ctx) => {
      if (ctx.caller === 'agent') agentTurn(ctx)
      return ctx.host.scriptBatches.cancel(p, ctx.caller === 'agent' ? ctx.conn.agent!.sessionId : undefined)
    },
    'script.batch.resume': (p, { host }) => host.scriptBatches.resume(p),
    'media.analyze': (p, ctx) => {
      if (ctx.caller === 'agent') agentTurn(ctx)
      return ctx.host.mediaTasks.analyze(p)
    },
    'media.preview': (p, { host }) => host.mediaPreviews.get(p),
    'guide.get': (p, ctx) => {
      agentTurn(ctx)
      return getGuide(p.topic)
    },
    'capabilities.list': (_, { caller }) => ({ capabilities: listCapabilities(caller) }),
    'capabilities.describe': (p, { caller }) => {
      const found = describeCapability(p.method, caller)
      if (!found) throw VisError.of('not_found', 'runtime.capability_not_found', { method: p.method }, `Capability ${p.method} is unavailable`)
      return found
    },
  }

  function respond(conn: ConnState, id: string | number | null, outcome: { result: unknown } | { error: RpcFailure['error'] }) {
    if (conn.phase === 'closed') return
    conn.peer.send({ jsonrpc: '2.0', id, ...outcome })
  }

  function errorOf(error: unknown): RpcFailure['error'] {
    if (error instanceof VisError) {
      return { code: RPC_APPLICATION_ERROR, message: error.message, data: { code: error.code, ...(error.conflicts ? { conflicts: error.conflicts } : {}), ...error.quota, ...error.details } }
    }
    console.error('[gateway] Unexpected error', error)
    return { code: INTERNAL_ERROR, message: error instanceof Error ? error.message : String(error) }
  }

  function close(conn: ConnState) {
    if (conn.phase === 'closed') return
    conn.phase = 'closed'
    conns.delete(conn)
    connectionRevision++
    conn.peer.close()
  }

  function hello(conn: ConnState, params: unknown): { protocolVersion: number; studiodVersion: string; runtimeEpoch: string } {
    const parsed = runtimeSpec.hello.params.safeParse(params)
    if (!parsed.success) {
      const message = describeIssues(parsed.error.issues)
      throw VisError.of('invalid_params', 'runtime.invalid_params', { detail: message }, message)
    }
    const { protocolVersion, credential } = parsed.data
    const identity = authenticate(credential)
    if (protocolVersion !== PROTOCOL_VERSION) {
      if (identity.caller === 'agent') throw VisError.of('unavailable', 'runtime.agent_protocol_incompatible', { clientVersion: protocolVersion, serverVersion: PROTOCOL_VERSION }, `Incompatible protocol version: client ${protocolVersion}, studiod ${PROTOCOL_VERSION}`)
      conn.shutdownOnly = true
    }
    conn.caller = identity.caller
    if (identity.agent) conn.agent = identity.agent
    conn.phase = 'ready'
    recordAgentActivity(conn)
    connectionRevision++
    return { protocolVersion: PROTOCOL_VERSION, studiodVersion: deps.studiodVersion, runtimeEpoch: deps.runtimeEpoch }
  }

  function authenticate(credential: Credential): { caller: Caller; agent?: AgentIdentity } {
    if (credential.kind === 'ui') {
      if (!sameSecret(credential.token, deps.uiToken)) throw VisError.of('forbidden', 'runtime.invalid_ui_credentials', {}, 'Invalid UI credentials')
      return { caller: 'ui' }
    }
    const spaceId = spaceIdOfToken(credential.token)
    const host = spaceId ? deps.spaces.get(spaceId) : undefined
    const instance = host ? findAgentInstance(host.db, credential.token) : undefined
    if (!spaceId || !instance) throw VisError.of('forbidden', 'runtime.invalid_agent_credentials', {}, 'Invalid runtime token or runtime instance has exited')
    return { caller: 'agent', agent: { spaceId, instanceId: instance.id, sessionId: instance.sessionId } }
  }

  function hostFor(conn: ConnState, requestedSpaceId?: string): SpaceHost {
    const spaceId = conn.caller === 'agent' ? conn.agent!.spaceId : requestedSpaceId ?? conn.subscription?.spaceId
    if (!spaceId) throw VisError.of('busy', 'runtime.no_space', {}, 'No space is open: call events.subscribe first')
    const host = deps.spaces.get(spaceId)
    if (!host) throw VisError.of('not_found', 'space.missing_id', { spaceId }, `Space ${spaceId} does not exist`)
    return host
  }

  function subscribe(conn: ConnState, params: MethodParams<'events.subscribe'>): MethodResult<'events.subscribe'> {
    const host = deps.spaces.get(params.spaceId)
    if (!host) throw VisError.of('not_found', 'space.missing_id', { spaceId: params.spaceId }, `Space ${params.spaceId} does not exist`)
    deps.spaces.markOpened(params.spaceId)
    seedWorkCards(host)
    connectionRevision++
    // Read the snapshot and cursor in the same read transaction, then push only later events (0003 events.subscribe).
    return host.db.transaction(tx => {
      const seq = currentSeq(tx)
      // Preserve pre-upgrade events verbatim; old cursors fetch the current snapshot to avoid replaying the old contract to new clients.
      const boundary = workspaceMigrationBoundary(tx)?.eventSeq ?? 0
      if (params.afterSeq !== undefined && (boundary === 0 || params.afterSeq > boundary) && params.afterSeq <= seq) {
        conn.subscription = { spaceId: params.spaceId, cursor: params.afterSeq }
        return { reset: false as const }
      }
      conn.subscription = { spaceId: params.spaceId, cursor: seq }
      const snapshot = { nodes: readNodes(tx), sessions: host.sessions.list({}).sessions, activeJobs: readActiveJobViews(tx), activeMediaTasks: readActiveMediaTasks(tx), activeScriptBatches: host.scriptBatches.list({ activeOnly: true }).batches, workItems: host.work.list({}).items }
      return { reset: true as const, snapshot, seq }
    })
  }

  function activity(): MethodResult<'runtime.activity'> {
    let activeTurns = 0
    let activeJobs = 0
    for (const host of deps.spaces.opened()) {
      activeTurns += host.db.select({ id: s.turns.id }).from(s.turns).where(inArray(s.turns.status, [...ACTIVE_TURN])).all().length
      activeJobs += host.db.select({ id: s.generationJobs.id }).from(s.generationJobs).where(inArray(s.generationJobs.status, [...ACTIVE_JOB])).all().length
    }
    return { activeTurns, activeJobs }
  }

  function inbox(): MethodResult<'work.inbox'> {
    const groups: MethodResult<'work.inbox'>['groups'] = []
    const counts: MethodResult<'work.inbox'>['counts'] = { unread: 0, unresolved: 0, bySpace: [] }
    for (const space of deps.spaces.list()) {
      const result = deps.spaces.get(space.spaceId)!.work.inbox(space.name)
      groups.push(...result.groups)
      counts.unread += result.counts.unread
      counts.unresolved += result.counts.unresolved
      counts.bySpace.push(...result.counts.bySpace)
    }
    counts.bySpace.sort((a, b) => a.spaceId.localeCompare(b.spaceId))
    return { groups, counts }
  }

  function seedWorkCards(host: SpaceHost) {
    if (!workCards.has(host.spaceId)) workCards.set(host.spaceId, {
      cursor: currentSeq(host.db),
      cards: new Map(host.work.list({}).items.map(item => [item.workItemId, { serialized: JSON.stringify(item), revision: item.revision }])),
    })
  }

  // Cards also include session activity and this activation's change count; these changes bypass WorkService state transitions.
  function flushWorkCards(host: SpaceHost) {
    seedWorkCards(host)
    const previous = workCards.get(host.spaceId)!
    const emitted = new Map<string, string>()
    let cursor = previous.cursor
    for (;;) {
      const batch = readEventsAfter(host.db, cursor)
      if (!batch.length) break
      for (const event of batch) {
        if (event.type === 'work.itemChanged') emitted.set(event.entityId, JSON.stringify(event.payload))
        cursor = event.seq
      }
    }
    const cards = new Map<string, { serialized: string; revision: number }>()
    for (const item of host.work.list({}).items) {
      let serialized = JSON.stringify(item)
      const before = previous.cards.get(item.workItemId)
      const changed = before?.serialized !== serialized
      const old = before ? JSON.parse(before.serialized) as typeof item : undefined
      const activitySessions = old ? item.sessions.filter(session => {
        const previous = old.sessions.find(candidate => candidate.sessionId === session.sessionId)
        return previous && (previous.doing !== session.doing || previous.lastActivityAt !== session.lastActivityAt)
      }) : []
      const stableFields = (card: typeof item) => ({ ...card, sessions: card.sessions.map(({ doing: _doing, lastActivityAt: _lastActivityAt, ...session }) => session) })
      const doingOnly = old && changed && JSON.stringify(stableFields(old)) === JSON.stringify(stableFields(item))
      const at = now()
      if (doingOnly && activitySessions.some(session => at - (doingEmittedAt.get(session.sessionId) ?? 0) < 1000)) {
        // Retain the last pushed cards; polling delivers the final activity change during throttling.
        nextWorkCardAt = Math.min(nextWorkCardAt, Math.max(...activitySessions.map(session => (doingEmittedAt.get(session.sessionId) ?? 0) + 1000)))
        cards.set(item.workItemId, before!)
        continue
      }
      const bumpRevision = changed && before?.revision === item.revision
      if (bumpRevision || (changed && emitted.get(item.workItemId) !== serialized)) {
        host.db.transaction(tx => {
          if (bumpRevision) {
            item.revision++
            tx.update(s.workItems).set({ revision: item.revision }).where(eq(s.workItems.id, item.workItemId)).run()
          }
          appendEvent(tx, { type: 'work.itemChanged', entityType: 'work', entityId: item.workItemId, payload: item })
        })
        serialized = JSON.stringify(item)
        for (const session of activitySessions) doingEmittedAt.set(session.sessionId, at)
      }
      cards.set(item.workItemId, { serialized, revision: item.revision })
    }
    workCards.set(host.spaceId, { cursor: currentSeq(host.db), cards })
  }

  /** Push persistent events after the subscription cursor to each UI connection. */
  function flushEvents(force = true) {
    if (closed) return
    forcePending ||= force
    const at = performance.now()
    // Interval ticks can land a fraction of a millisecond before the deadline; do not slip a whole poll period
    if (at + 1 < retryAt) return
    const previousDeadline = nextWorkCardAt
    try {
      flush(forcePending)
      forcePending = false
      retryAt = 0
      retryDelay = 0
      lastFailure = undefined
    } catch (error) {
      nextWorkCardAt = Math.min(nextWorkCardAt, previousDeadline)
      retryDelay = Math.min(retryDelay ? retryDelay * 2 : 100, 1000)
      retryAt = at + retryDelay
      let failure = 'Unreadable flush error'
      try {
        failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      } catch {
        // Error objects can have throwing property getters or string conversions.
      }
      if (lastFailure !== failure) {
        lastFailure = failure
        try {
          console.error('[gateway] Event flush failed', error)
        } catch {
          // A failing logger must not escape the timer or RPC completion.
        }
      }
    }
  }

  function flush(force: boolean) {
    const skillsSeq = deps.spaces.skillLibrary.sequence()
    for (const conn of conns) {
      if (conn.phase !== 'ready' || conn.caller !== 'ui' || conn.skillsSeq === skillsSeq) continue
      if (skillsSeq) conn.peer.send({ jsonrpc: '2.0', method: 'events.skillsChanged', params: { seq: skillsSeq } })
      conn.skillsSeq = skillsSeq
    }
    const { changed, snapshot } = pollChanged()
    // A failed forced flush also needs retrying when its inputs have not changed.
    if (!force && !changed && !retryDelay) return
    nextWorkCardAt = Infinity
    deps.spaces.workSlots.drain()
    const counts = inbox().counts
    const slots = deps.spaces.workSlots.view()
    slots.bySpace.sort((a, b) => a.spaceId.localeCompare(b.spaceId))
    const serializedInbox = JSON.stringify(counts)
    const serializedSlots = JSON.stringify(slots)
    for (const conn of conns) {
      if (conn.phase !== 'ready' || conn.caller !== 'ui') continue
      if (lastInbox !== undefined && lastInbox !== serializedInbox) conn.peer.send({ jsonrpc: '2.0', method: 'events.workInboxChanged', params: counts })
      if (lastSlots !== undefined && lastSlots !== serializedSlots) conn.peer.send({ jsonrpc: '2.0', method: 'events.workSlotsChanged', params: slots })
    }
    lastInbox = serializedInbox
    lastSlots = serializedSlots
    for (const host of deps.spaces.opened()) { host.workDeletion.expire(); flushWorkCards(host) }
    for (const conn of conns) {
      const sub = conn.subscription
      if (!sub || conn.phase !== 'ready') continue
      if (!deps.spaces.list().some(space => space.spaceId === sub.spaceId)) continue
      const host = deps.spaces.get(sub.spaceId)
      if (!host) continue
      for (;;) {
        const batch = readEventsAfter(host.db, sub.cursor)
        if (batch.length === 0) break
        for (const e of batch) {
          conn.peer.send({ jsonrpc: '2.0', method: 'events.event', params: { seq: e.seq, type: e.type, entityType: e.entityType, entityId: e.entityId, payload: e.payload } })
          sub.cursor = e.seq
        }
      }
    }
    // Commit only after success, retaining the pre-flush versions so derived writes trigger another tick.
    lastPoll = snapshot
  }

  function spacesChanged() {
    for (const conn of conns) {
      if (conn.phase === 'ready' && conn.caller === 'ui') conn.peer.send({ jsonrpc: '2.0', method: 'events.spacesChanged', params: {} })
    }
  }
  function seriesChanged(...seriesIds: (string | undefined)[]) {
    for (const seriesId of new Set(seriesIds.filter((id): id is string => !!id))) {
      for (const conn of conns) {
        if (conn.phase === 'ready' && conn.caller === 'ui') conn.peer.send({ jsonrpc: '2.0', method: 'events.seriesChanged', params: { seriesId } })
      }
    }
  }
  // Episodes of the series a project belongs to refresh on its changes; a deleted series has nobody left to tell.
  function seriesOf(spaceId: string) {
    try { return deps.spaces.series.membership(spaceId)?.seriesId } catch { return undefined }
  }

  async function dispatch(conn: ConnState, method: string, params: unknown): Promise<unknown> {
    if (conn.phase === 'hello') {
      if (method !== 'runtime.hello') throw VisError.of('forbidden', 'runtime.handshake_required', {}, 'The first request must be runtime.hello')
      return hello(conn, params)
    }
    recordAgentActivity(conn)
    if (method === 'runtime.hello') throw VisError.of('busy', 'runtime.handshake_completed', {}, 'Handshake already completed')
    if (!isMethodName(method)) throw Object.assign(new Error(`Unknown method ${method}`), { rpcCode: METHOD_NOT_FOUND })
    const caller = conn.caller!
    const spec = METHODS[method]
    if (!(spec.callers as readonly Caller[]).includes(caller)) throw VisError.of('forbidden', 'runtime.caller_forbidden', { method, caller }, `${method} cannot be called by ${caller}`)
    if (conn.shutdownOnly && method !== 'runtime.shutdown') throw VisError.of('unavailable', 'runtime.protocol_incompatible', {}, 'Incompatible protocol version; only shutting down the current studiod is allowed')
    if (caller === 'agent') {
      if ((method.startsWith('work.') || method.startsWith('canvas.') || method.startsWith('media.') || method.startsWith('entity.')) && params && typeof params === 'object' && 'spaceId' in params) {
        throw VisError.of('forbidden', 'runtime.agent_project_forbidden', {}, 'Agents cannot specify other projects')
      }
      if (method === 'work.list' && params && typeof params === 'object' && 'scope' in params && params.scope === 'all') {
        throw VisError.of('forbidden', 'runtime.agent_all_projects_forbidden', {}, 'Agents cannot read all projects')
      }
      agentSession(conn)
    }

    const parsed = spec.params.safeParse(params ?? {})
    if (!parsed.success) {
      const detail = method === 'providers.setKey' || method === 'providers.clearKey' ? 'Invalid key parameters' : describeIssues(parsed.error.issues)
      const ops = method === 'canvas.apply' && params && typeof params === 'object' && 'ops' in params && Array.isArray(params.ops) ? params.ops : []
      const topics = new Set<'script' | 'timeline'>()
      for (const issue of parsed.error.issues) {
        if (issue.path[0] !== 'ops' || typeof issue.path[1] !== 'number') continue
        const op = ops[issue.path[1]]
        if (!op || typeof op !== 'object' || !('op' in op)) continue
        if (op.op === 'script.replace' || op.op === 'script.patch') topics.add('script')
        if (op.op === 'timeline.set') topics.add('timeline')
      }
      const message = topics.size ? `${detail}. ${[...topics].map(topic => `See guide "${topic}".`).join(' ')}` : detail
      throw VisError.of('invalid_params', 'runtime.invalid_params', { detail }, message)
    }
    const p = parsed.data as never
    if (method === 'agents.list') return { agents: deps.spaces.agents?.() ?? [] }
    const agentParams = parsed.data as { agentKind?: string; chat?: { agentKind: string } }
    const requestedKind = agentParams.agentKind ?? agentParams.chat?.agentKind
    if (requestedKind && method !== 'work.move') deps.spaces.assertAgent?.(requestedKind)
    const requestedSpaceId = (parsed.data as { spaceId?: string }).spaceId
    if (requestedSpaceId && !method.startsWith('space.')) {
      if (!deps.spaces.get(requestedSpaceId)) throw VisError.of('not_found', 'space.not_found', {}, 'Project does not exist')
    }

    if (method === 'providers.list' || method === 'providers.update' || method === 'providers.setKey' || method === 'providers.clearKey') {
      if (!deps.providers) throw VisError.of('unavailable', 'provider.config_unavailable', {}, 'Generation provider configuration is unavailable')
      if (method === 'providers.list') return deps.providers.list()
      let result: unknown
      if (method === 'providers.update') result = await deps.providers.update((p as MethodParams<'providers.update'>).config)
      else {
        // Key writes bypass the database; even underlying exceptions must not reach general error logs.
        try {
          const key = p as MethodParams<'providers.setKey'>
          result = method === 'providers.setKey'
            ? await deps.providers.setKey(key.providerId, key.apiKey)
            : await deps.providers.clearKey(key.providerId)
        } catch {
          throw VisError.of('unavailable', 'provider.key_operation_failed', {}, 'Key operation failed: check provider configuration and the system keychain (macOS only)')
        }
      }
      for (const peer of conns) {
        if (peer.phase === 'ready' && peer.caller === 'ui') peer.peer.send({ jsonrpc: '2.0', method: 'events.providersChanged', params: {} })
      }
      return result
    }

    switch (method) {
      case 'events.subscribe': return subscribe(conn, p)
      case 'space.list': return { spaces: deps.spaces.list(), projectsDir: deps.spaces.projectsDir }
      case 'space.create': {
        const result = deps.spaces.create(p)
        spacesChanged()
        if (result.series) seriesChanged(result.series.seriesId)
        return result
      }
      case 'series.list': return deps.spaces.series.list()
      case 'series.create': {
        const result = deps.spaces.series.create(p)
        seriesChanged(result.seriesId)
        return result
      }
      case 'series.rename': {
        const result = deps.spaces.series.rename(p)
        seriesChanged(result.seriesId)
        spacesChanged()
        return result
      }
      case 'series.delete': {
        try { return deps.spaces.series.delete(p) }
        finally { seriesChanged((p as MethodParams<'series.delete'>).seriesId); spacesChanged() }
      }
      case 'series.mediaGet': {
        const params = p as MethodParams<'series.mediaGet'>
        deps.spaces.series.require(params.seriesId)
        return deps.spaces.series.libraries.mediaGet(params.seriesId, params.refId)
      }
      case 'space.setSeries': {
        const spaceId = (p as MethodParams<'space.setSeries'>).spaceId
        const before = seriesOf(spaceId)
        try { return deps.spaces.series.setSeries(p) }
        finally { seriesChanged(before, seriesOf(spaceId)); spacesChanged() }
      }
      case 'space.deletePlan': return deps.spaces.deletePlan(p)
      case 'space.listDeleted': return deps.spaces.listDeleted(p)
      case 'space.diskUsage': return deps.spaces.diskUsage(p)
      case 'space.delete':
      case 'space.restore':
      case 'space.purge': {
        const spaceId = (p as { spaceId: string }).spaceId
        const before = seriesOf(spaceId)
        try {
          if (method === 'space.delete') return await deps.spaces.delete(p)
          if (method === 'space.restore') return await deps.spaces.restore(p)
          return await deps.spaces.purge(p)
        }
        finally { spacesChanged(); seriesChanged(before, seriesOf(spaceId)) }
      }
      case 'fs.pickDirectory': return pickDirectory(p)
      case 'fs.validateDirectory': return validateDirectory((p as MethodParams<'fs.validateDirectory'>).path)
      case 'fs.listSkills': {
        const params = p as MethodParams<'fs.listSkills'>
        const host = params.spaceId ? deps.spaces.get(params.spaceId) : hostFor(conn)
        if (!host) throw VisError.of('not_found', 'space.not_found', {}, 'Project does not exist')
        return { skills: listProjectSkills(host.rootPath) }
      }
      case 'fs.reveal': {
        const params = p as MethodParams<'fs.reveal'>
        const host = params.spaceId ? deps.spaces.get(params.spaceId) : hostFor(conn)
        if (!host) throw VisError.of('not_found', 'space.not_found', {}, 'Project does not exist')
        const path = params.workItemId ? host.work.get({ workItemId: params.workItemId }).item.workDir : params.sessionId ? host.workDir(params.sessionId) : join(host.rootPath, params.skills ? 'skills' : 'assets')
        if (params.workItemId && !statSync(path, { throwIfNoEntry: false })?.isDirectory()) throw VisError.of('not_found', 'work.directory_not_found', {}, 'Working directory does not exist')
        return reveal(path)
      }
      case 'generation.usage': return deps.usage?.() ?? hostFor(conn).generation.usage()
      case 'runtime.activity': return activity()
      case 'work.inbox': return inbox()
      case 'work.slots': return deps.spaces.workSlots.view()
      case 'work.setSlotLimit': return deps.spaces.workSlots.setLimit(p)
      case 'runtime.shutdown':
        // Send the response before shutting down.
        setImmediate(() => deps.onShutdown((p as MethodParams<'runtime.shutdown'>).reason))
        return { accepted: true }
      case 'skill.proposeDraft': {
        const host = hostFor(conn)
        workActor({ conn, caller, host })
        return deps.spaces.skillLibrary.propose(p, host.spaceId, conn.agent!.sessionId)
      }
      case 'skill.draftState': return deps.spaces.skillLibrary.draftState((p as MethodParams<'skill.draftState'>).draftId)
      case 'skill.setAutoAdd': return deps.spaces.skillLibrary.setAutoAdd(p)
      case 'skill.libraryDelete': return deps.spaces.skillLibrary.delete(p)
      case 'skill.export': return deps.spaces.skillLibrary.export((p as MethodParams<'skill.export'>).skillId)
      case 'skill.importDrafts': return deps.spaces.skillLibrary.importDrafts(p)
      case 'skill.copyUpdate': case 'skill.copyReset': case 'skill.copyPublish': {
        const params = p as MethodParams<'skill.copyPublish'>
        const rootPath = hostFor(conn, params.spaceId).rootPath
        if (method === 'skill.copyUpdate') return deps.spaces.skillLibrary.update(params, rootPath)
        if (method === 'skill.copyReset') return deps.spaces.skillLibrary.reset(params, rootPath)
        return deps.spaces.skillLibrary.publish(params, rootPath)
      }
      case 'skill.libraryList': return deps.spaces.skillLibrary.list()
      case 'skill.libraryGet': return deps.spaces.skillLibrary.get((p as MethodParams<'skill.libraryGet'>).skillId)
      case 'skill.librarySave': return deps.spaces.skillLibrary.save(p)
      case 'skill.discardDraft': return deps.spaces.skillLibrary.discard(p)
      case 'skill.use': {
        const params = p as MethodParams<'skill.use'>
        return deps.spaces.skillLibrary.use(params, hostFor(conn, params.spaceId).rootPath)
      }
      case 'skill.discard': {
        const { stagingId } = p as MethodParams<'skill.discard'>
        for (const host of deps.spaces.opened()) host.skills.discard(stagingId)
        return { ok: true }
      }
      case 'skill.list': case 'skill.stage': case 'skill.import': case 'skill.remove': {
        const host = hostFor(conn, (p as { spaceId?: string }).spaceId)
        if (method === 'skill.list') return deps.spaces.skillLibrary.listProject(host.rootPath)
        if (method === 'skill.import') return host.skills.import(p as MethodParams<'skill.import'>)
        if (method === 'skill.remove') return host.skills.remove((p as MethodParams<'skill.remove'>).name)
        const params = p as MethodParams<'skill.stage'>
        const source = params.fromSpaceId ? deps.spaces.get(params.fromSpaceId) : undefined
        if (params.fromSpaceId && !source) throw VisError.of('not_found', 'space.source_not_found', {}, 'Source project does not exist')
        return host.skills.stage(params, source?.rootPath)
      }
      case 'preferences.get': {
        const value = deps.appDb.select().from(appSchema.settings).where(eq(appSchema.settings.key, 'ui.locale')).get()?.value
        return { locale: value === 'zh-CN' || value === 'en' ? value : null }
      }
      case 'preferences.set': {
        const { locale } = p as MethodParams<'preferences.set'>
        deps.appDb.transaction(tx => {
          if (locale === null) tx.delete(appSchema.settings).where(eq(appSchema.settings.key, 'ui.locale')).run()
          else tx.insert(appSchema.settings).values({ key: 'ui.locale', value: locale })
            .onConflictDoUpdate({ target: appSchema.settings.key, set: { value: locale } }).run()
        }, { behavior: 'immediate' })
        return { locale }
      }
      default: {
        if (method === 'work.list' && (p as MethodParams<'work.list'>).scope === 'all') {
          return { items: deps.spaces.list().flatMap(space => deps.spaces.get(space.spaceId)!.work.list(p).items.map(item => ({ ...item, spaceName: space.name }))) }
        }
        const host = hostFor(conn, caller === 'ui' && (method.startsWith('work.') || method === 'entity.list') ? (p as { spaceId?: string }).spaceId : undefined)
        seedWorkCards(host)
        return (handlers[method] as Handler<typeof method>)(p, { conn, caller, host })
      }
    }
  }

  function receive(conn: ConnState, line: string) {
    if (conn.phase === 'closed' || line.trim() === '') return
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      respond(conn, null, { error: { code: PARSE_ERROR, message: 'Cannot parse JSON' } })
      return
    }
    const m = message as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown }
    const id = typeof m.id === 'string' || typeof m.id === 'number' ? m.id : null
    if (typeof m !== 'object' || m === null || m.jsonrpc !== '2.0' || typeof m.method !== 'string') {
      respond(conn, id, { error: { code: INVALID_REQUEST, message: 'Invalid JSON-RPC 2.0 request' } })
      return
    }
    // No client notifications require handling.
    if (id === null) return

    // Check at actual dispatch: requests following the handshake in the same chunk must not be treated as handshakes.
    let wasHello = false
    Promise.resolve()
      .then(() => {
        wasHello = conn.phase === 'hello'
        return dispatch(conn, m.method as string, m.params)
      })
      .then(
        result => respond(conn, id, { result }),
        error => {
          const rpcCode = (error as { rpcCode?: number }).rpcCode
          respond(conn, id, { error: rpcCode ? { code: rpcCode, message: (error as Error).message } : errorOf(error) })
          // Disconnect on handshake failure.
          if (wasHello) close(conn)
        },
      )
      .finally(flushEvents)
      // respond() can throw on a torn-down peer; never let the completion chain become an unhandled rejection
      .catch(error => console.error('[gateway] request completion failed', error))
  }

  const timer = setInterval(() => flushEvents(false), deps.eventPollMs ?? 100)
  timer.unref()

  return {
    accept(peer) {
      const conn: ConnState = { peer, phase: 'hello' }
      conns.add(conn)
      connectionRevision++
      return { receive: line => receive(conn, line), closed: () => close(conn) }
    },
    activity,
    uiConnections: () => [...conns].filter(c => c.phase === 'ready' && c.caller === 'ui').length,
    publishTransient(spaceId, event) {
      for (const conn of conns) {
        if (conn.subscription?.spaceId === spaceId) conn.peer.send({ jsonrpc: '2.0', method: 'taskId' in event ? 'events.mediaProgress' : 'events.transient', params: event })
      }
    },
    close() {
      closed = true
      clearInterval(timer)
      for (const conn of [...conns]) close(conn)
    },
  }
}

function describeIssues(issues: readonly { path: readonly PropertyKey[]; message: string }[]): string {
  return issues.map(i => `${i.path.length ? i.path.map(String).join('.') : '(parameters)'}: ${i.message}`).join('; ')
}
