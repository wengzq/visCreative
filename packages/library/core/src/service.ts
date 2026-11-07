import type { MethodParams, MethodResult } from '@vis/protocol'
import { runIdempotent, type SpaceDb } from '@vis/storage'
import { listAssetVersions, listLibraryAssets, updateLibraryAsset, type LibraryReadContext } from './assets'
import { labelAssets } from './labels'
import { listLibraryRuns, revertLibraryRun, startLibraryRun } from './runs'
import { readLibraryState, setLibrarySession } from './state'

export interface LibraryService {
  versions(params: MethodParams<'asset.versions'>): MethodResult<'asset.versions'>
  list(params: MethodParams<'asset.list'>, caller: LibraryReadContext['caller']): MethodResult<'asset.list'>
  update(params: MethodParams<'asset.update'>): MethodResult<'asset.update'>
  label(params: MethodParams<'asset.label'>, sessionId: string): MethodResult<'asset.label'>
  state(): MethodResult<'library.state'>
  setSession(params: MethodParams<'library.setSession'>): MethodResult<'library.setSession'>
  runStart(params: MethodParams<'library.runStart'>): MethodResult<'library.runStart'>
  runList(params: MethodParams<'library.runList'>): MethodResult<'library.runList'>
  runRevert(params: MethodParams<'library.runRevert'>): MethodResult<'library.runRevert'>
}

export function createLibraryService(deps: { db: SpaceDb; blobPath: (hash: string) => string; now?: () => number }): LibraryService {
  const { db, blobPath } = deps
  const now = deps.now ?? Date.now
  const ctx: LibraryReadContext = { caller: 'ui', blobPath }
  return {
    versions: p => db.transaction(tx => listAssetVersions(tx, p.assetId, ctx)),
    list: (p, caller) => db.transaction(tx => listLibraryAssets(tx, p, { ...ctx, caller })),
    update: p => db.transaction(tx => updateLibraryAsset(tx, p, ctx, now()), { behavior: 'immediate' }),
    label: (p, sessionId) => runIdempotent(db, { requestId: p.requestId, method: 'asset.label', params: { ...p, sessionId } }, tx => labelAssets(tx, p, sessionId, now()), now),
    state: () => db.transaction(tx => readLibraryState(tx, ctx)),
    setSession: p => db.transaction(tx => setLibrarySession(tx, p.sessionId, ctx, now()), { behavior: 'immediate' }),
    runStart: p => runIdempotent(db, { requestId: p.requestId, method: 'library.runStart', params: p }, tx => startLibraryRun(tx, p, now()), now),
    runList: p => db.transaction(tx => listLibraryRuns(tx, p)),
    runRevert: p => runIdempotent(db, { requestId: p.requestId, method: 'library.runRevert', params: p }, tx => revertLibraryRun(tx, p, now()), now),
  }
}
