import { useCallback, useEffect, useState } from 'react'
import type { TextProposal } from '@vis/protocol'
import type { SpaceConnection } from './space'

/** Project-scoped host cache, shared by the canvas count and the full-screen editor. */
export function useWritingProposals(conn: SpaceConnection, spaceId: string | undefined, ready: boolean) {
  const [proposals, setProposals] = useState<TextProposal[]>([])
  useEffect(() => {
    setProposals([])
    if (!ready || !spaceId) return
    let active = true
    let reading = false
    let dirty = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = async () => {
      if (reading) { dirty = true; return }
      reading = true
      try {
        do {
          dirty = false
          const result = await conn.rpc.call('text.proposal.list', {})
          if (active) setProposals(result.proposals)
        } while (active && dirty)
      } finally { reading = false }
    }
    const queue = () => { clearTimeout(timer); timer = setTimeout(() => { void refresh().catch(() => {}) }, 80) }
    void refresh().catch(() => {})
    const unsubscribe = conn.onEvent?.(event => { if (event.type === 'text.proposalChanged' || event.type === 'node.deleted') queue() })
    return () => { active = false; clearTimeout(timer); unsubscribe?.() }
  }, [conn, spaceId, ready])
  const update = useCallback((incoming: TextProposal[]) => setProposals(previous => {
    const changed = new Map(incoming.map(proposal => [proposal.proposalId, proposal]))
    return [...previous.filter(proposal => !changed.has(proposal.proposalId)), ...incoming].filter(proposal => proposal.status === 'open')
      .sort((a, b) => a.createdAt - b.createdAt || a.proposalId.localeCompare(b.proposalId))
  }), [])
  return { proposals, update }
}
