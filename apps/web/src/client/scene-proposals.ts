import type { SceneChangeRef, SceneDoc, SceneProposal } from '@vis/protocol'
import { messagesFor, type Locale } from '@vis/ui-kit'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { RpcError } from './rpc'
import { actionMessages } from './messages'
import { sceneHostMessages } from './scene-messages'
import type { SpaceConnection } from './space'

type DraftHandle = { flush(): Promise<number | null>; adopt(doc: SceneDoc, revision: number, expectedRevision: number): void }
const drafts = new WeakMap<SpaceConnection, Map<string, DraftHandle>>()
export function registerSceneDraft(conn: SpaceConnection, slotId: string, handle: DraftHandle) {
  let entries = drafts.get(conn)
  if (!entries) { entries = new Map(); drafts.set(conn, entries) }
  entries.set(slotId, handle)
  return () => { if (entries.get(slotId) === handle) entries.delete(slotId) }
}

export async function resolveSceneProposal(conn: SpaceConnection, spaceId: string, locale: Locale, slotId: string, action: 'accept' | 'reject', changes: SceneChangeRef[]): Promise<SceneProposal[]> {
  const m = messagesFor(actionMessages, locale)
  const sm = messagesFor(sceneHostMessages, locale)
  const assertProject = () => { if (!conn.getView().ready || conn.getView().space?.spaceId !== spaceId) throw new Error(m.projectChanged) }
  assertProject()
  const nodeId = [...conn.getView().state.nodes.values()].find(node => node.slots.some(slot => slot.slotId === slotId))?.nodeId
  if (!nodeId) throw new Error(m.nodeDeleted)
  const handle = drafts.get(conn)?.get(slotId)
  let flushedRevision: number | undefined
  if (action === 'accept' && handle) {
    try {
      const revision = await handle.flush()
      if (revision === null) throw new Error(sm.saveBeforeAccept)
      flushedRevision = revision
    } catch (error) { throw new Error(sm.saveBeforeAccept, { cause: error }) }
  }
  assertProject()
  await conn.refreshNodes([nodeId])
  assertProject()
  const slot = conn.getView().state.nodes.get(nodeId)?.slots.find(slot => slot.slotId === slotId)
  if (!slot || slot.content.type !== 'scene') throw new Error(m.nodeDeleted)
  try {
    const result = await conn.rpc.call('scene.proposal.resolve', {
      requestId: `scene-review-${crypto.randomUUID()}`, slotId, action, changes,
      ...(action === 'accept' ? { expectedRevision: slot.revision } : {}),
    })
    assertProject()
    if (action === 'accept') {
      await conn.refreshNodes([nodeId])
      assertProject()
      const saved = conn.getView().state.nodes.get(nodeId)?.slots.find(slot => slot.slotId === slotId)
      if (saved?.content.type === 'scene' && flushedRevision !== undefined) handle?.adopt(saved.content.doc, saved.revision, flushedRevision)
    }
    return result.proposals
  } catch (error) {
    await conn.refreshNodes([nodeId])
    assertProject()
    if (error instanceof RpcError && error.code === 'revision_conflict' && flushedRevision !== undefined) {
      const saved = conn.getView().state.nodes.get(nodeId)?.slots.find(slot => slot.slotId === slotId)
      if (saved?.content.type === 'scene') handle?.adopt(saved.content.doc, saved.revision, flushedRevision)
    }
    throw error
  }
}

/** One project cache supplies inspector state and canvas counts without loading the scene editor. */
export function useSceneProposals(conn: SpaceConnection, spaceId: string | undefined, ready: boolean) {
  const [proposals, setProposals] = useState<SceneProposal[]>([])
  useEffect(() => {
    setProposals([])
    if (!ready || !spaceId) return
    let active = true
    let reading = false
    let dirty = false
    const refresh = async () => {
      if (reading) { dirty = true; return }
      reading = true
      try {
        do {
          dirty = false
          const result = await conn.rpc.call('scene.proposal.list', { status: 'all' })
          if (active) setProposals(result.proposals)
        } while (active && dirty)
      } finally { reading = false }
    }
    const queue = () => { void refresh().catch(() => {}) }
    const unsubscribe = conn.onEvent?.(event => { if (event.type === 'scene.proposalChanged' || event.type === 'node.deleted') queue() })
    queue()
    return () => { active = false; unsubscribe?.() }
  }, [conn, spaceId, ready])
  const update = useCallback((incoming: SceneProposal[]) => setProposals(previous => {
    const changed = new Map(incoming.map(proposal => [proposal.proposalId, proposal]))
    return [...previous.filter(proposal => !changed.has(proposal.proposalId)), ...incoming].sort((a, b) => a.createdAt - b.createdAt || a.proposalId.localeCompare(b.proposalId))
  }), [])
  const byId = useMemo(() => new Map(proposals.map(proposal => [proposal.proposalId, proposal])), [proposals])
  return { proposals, byId, update }
}

export function useSceneProposalsForNode(proposals: readonly SceneProposal[], nodeId: string | undefined) {
  return useMemo(() => proposals.filter(proposal => proposal.nodeId === nodeId), [proposals, nodeId])
}
