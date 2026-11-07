import { ulid, VisError } from '@vis/domain'
import type { LibraryRunView, MethodParams, MethodResult } from '@vis/protocol'
import { desc, eq, spaceSchema as s, sql, type SpaceTx } from '@vis/storage'
import { emitAssetUpdated, LABEL_FIELDS, readAsset, readLabelSnapshot, writeTags } from './assets'
import { proposalEvent } from './proposals'
import { emitLibraryChanged, usableLibrarySession } from './state'

export function readLibraryRun(tx: SpaceTx, runId: string): LibraryRunView {
  const row = tx.select().from(s.libraryRuns).where(eq(s.libraryRuns.id, runId)).get()
  if (!row) throw VisError.of('not_found', 'library.run_not_found', { runId }, 'Library run does not exist')
  const changeCount = row.kind === 'merge'
    ? tx.select({ count: sql<number>`count(*)` }).from(s.entityProposals).where(eq(s.entityProposals.runId, runId)).get()!.count
    : tx.select({ count: sql<number>`count(*)` }).from(s.libraryRunChanges).where(eq(s.libraryRunChanges.runId, runId)).get()!.count
  return { runId, kind: row.kind, sessionId: row.sessionId, startedAt: row.startedAt, changeCount,
    ...(row.revertedAt !== null ? { revertedAt: row.revertedAt } : {}) }
}

export function startLibraryRun(tx: SpaceTx, params: MethodParams<'library.runStart'>, now: number): LibraryRunView {
  const sessionId = usableLibrarySession(tx)
  if (!sessionId) throw VisError.of('invalid_params', 'library.session_required', {}, 'Choose a library session before starting an organize run')
  const runId = `lrun_${ulid(now)}`
  tx.insert(s.libraryRuns).values({ id: runId, kind: params.kind, sessionId, startedAt: now }).run()
  emitLibraryChanged(tx, now)
  return readLibraryRun(tx, runId)
}

export function listLibraryRuns(tx: SpaceTx, params: MethodParams<'library.runList'>): MethodResult<'library.runList'> {
  return { runs: tx.select({ id: s.libraryRuns.id }).from(s.libraryRuns).where(params.kind ? eq(s.libraryRuns.kind, params.kind) : undefined).orderBy(desc(s.libraryRuns.startedAt), desc(s.libraryRuns.id))
    .limit(params.limit).all().map(row => readLibraryRun(tx, row.id)) }
}

// A merge run only proposed; reverting withdraws what is still pending. Accepted proposals were the user's decision
// and are undone per setting with entity.unmerge, so they are reported as skipped.
function revertMergeRun(tx: SpaceTx, run: LibraryRunView, now: number): MethodResult<'library.runRevert'> {
  const reverted: string[] = []
  const skipped: string[] = []
  for (const proposal of tx.select().from(s.entityProposals).where(eq(s.entityProposals.runId, run.runId)).orderBy(s.entityProposals.createdAt, s.entityProposals.id).all()) {
    if (proposal.status === 'accepted') skipped.push(proposal.id)
    if (proposal.status !== 'pending') continue
    tx.update(s.entityProposals).set({ status: 'rejected', resolvedAt: now }).where(eq(s.entityProposals.id, proposal.id)).run()
    proposalEvent(tx, proposal.id, 'rejected', now)
    reverted.push(proposal.id)
  }
  tx.update(s.libraryRuns).set({ revertedAt: now }).where(eq(s.libraryRuns.id, run.runId)).run()
  emitLibraryChanged(tx, now)
  return { run: readLibraryRun(tx, run.runId), reverted, skipped }
}

function snapshotKey(snapshot: s.LibraryLabelSnapshot) {
  return JSON.stringify({ ...snapshot, tags: [...snapshot.tags].sort(), userFields: [...snapshot.userFields].sort() })
}

export function revertLibraryRun(tx: SpaceTx, params: MethodParams<'library.runRevert'>, now: number): MethodResult<'library.runRevert'> {
  const run = readLibraryRun(tx, params.runId)
  if (run.revertedAt !== undefined) throw VisError.of('invalid_transition', 'library.run_reverted', {}, 'Library run has already been reverted')
  if (run.kind === 'merge') return revertMergeRun(tx, run, now)
  const reverted: string[] = []
  const skipped: string[] = []
  for (const change of tx.select().from(s.libraryRunChanges).where(eq(s.libraryRunChanges.runId, run.runId)).all()) {
    const asset = readAsset(tx, change.assetId)
    const current = readLabelSnapshot(tx, asset.id)
    // Confirming labels protects them even if their text happens to be identical to the run's output.
    // A later batch must not absorb an intervening user edit into the run's revertable output.
    const userChanged = LABEL_FIELDS.some(field => current.userFields.includes(field)
      && (!change.before.userFields.includes(field) || JSON.stringify(current[field]) !== JSON.stringify(change.before[field])))
    if (userChanged || snapshotKey(current) !== snapshotKey(change.after)) {
      skipped.push(asset.id)
      continue
    }
    const { tags, ...fields } = change.before
    tx.update(s.assets).set({ ...fields, revision: asset.revision + 1 }).where(eq(s.assets.id, asset.id)).run()
    writeTags(tx, asset.id, tags)
    emitAssetUpdated(tx, asset.id, asset.revision + 1, now)
    reverted.push(asset.id)
  }
  tx.update(s.libraryRuns).set({ revertedAt: now }).where(eq(s.libraryRuns.id, run.runId)).run()
  emitLibraryChanged(tx, now)
  return { run: readLibraryRun(tx, run.runId), reverted, skipped }
}
