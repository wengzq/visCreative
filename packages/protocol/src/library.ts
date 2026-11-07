import { z } from 'zod'
import { Id, RequestId } from './common'

// 0027: the project's library session and organize runs. A run groups one organize task so the user can revert it
// as a whole; it is not part of the canvas undo stack.

export const LibraryRunKind = z.enum(['label', 'merge'])
export type LibraryRunKind = z.infer<typeof LibraryRunKind>

export const LibraryRunView = z.object({
  runId: Id,
  kind: LibraryRunKind,
  sessionId: Id,
  startedAt: z.int(),
  // Assets whose labels this run changed (label runs) or proposals it made (merge runs)
  changeCount: z.int().nonnegative(),
  revertedAt: z.int().optional(),
})
export type LibraryRunView = z.infer<typeof LibraryRunView>

export const LibraryStateView = z.object({
  sessionId: Id.nullable(),
  // Counts for the organize confirmation; images and video that have no node context need looking at
  unlabeled: z.object({ total: z.int().nonnegative(), needsViewing: z.int().nonnegative() }),
  pendingProposals: z.int().nonnegative(),
})
export type LibraryStateView = z.infer<typeof LibraryStateView>

export const library = {
  state: {
    params: z.object({}),
    result: LibraryStateView,
  },
  setSession: {
    params: z.object({ sessionId: Id.nullable() }),
    result: LibraryStateView,
  },
  runStart: {
    params: z.object({ requestId: RequestId, kind: LibraryRunKind }),
    result: LibraryRunView,
  },
  runList: {
    params: z.object({ limit: z.int().min(1).max(50).default(10), kind: LibraryRunKind.optional() }),
    result: z.object({ runs: z.array(LibraryRunView) }),
  },
  runRevert: {
    params: z.object({ requestId: RequestId, runId: Id }),
    // Label runs: asset ids; assets whose label fields no longer hold what the run wrote are skipped.
    // Merge runs: proposal ids; pending proposals are withdrawn, accepted ones are skipped (undo them with entity.unmerge).
    result: z.object({ run: LibraryRunView, reverted: z.array(Id), skipped: z.array(Id) }),
  },
} as const
