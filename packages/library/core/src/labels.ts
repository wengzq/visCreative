import { VisError } from '@vis/domain'
import { assetLibrary, type MethodParams, type MethodResult } from '@vis/protocol'
import { eq, spaceSchema as s, type SpaceTx } from '@vis/storage'
import { emitAssetUpdated, LABEL_FIELDS, readAsset, readLabelSnapshot, writeTags } from './assets'
import { requireActiveLibraryRun } from './state'

export function labelAssets(tx: SpaceTx, params: MethodParams<'asset.label'>, sessionId: string, now: number): MethodResult<'asset.label'> {
  const p = assetLibrary.label.params.parse(params)
  if (p.runId !== undefined) requireActiveLibraryRun(tx, p.runId, 'label', sessionId)
  const labeled = new Set<string>()
  const skipped = new Map<string, Set<typeof LABEL_FIELDS[number]>>()
  const assets = new Map<string, ReturnType<typeof readAsset>>()
  for (const item of p.items) {
    const asset = assets.get(item.assetId) ?? readAsset(tx, item.assetId)
    assets.set(asset.id, asset)
    const before = readLabelSnapshot(tx, asset.id, asset)
    const fields = LABEL_FIELDS.filter(field => item[field] !== undefined)
    const skippedFields = fields.filter(field => asset.userFields.includes(field))
    if (skippedFields.length) {
      if (!skipped.has(asset.id)) skipped.set(asset.id, new Set())
      for (const field of skippedFields) skipped.get(asset.id)!.add(field)
    }
    const writable = fields.filter(field => !asset.userFields.includes(field))
    if (!writable.length) continue
    const fieldsAfter = {
      ...(writable.includes('displayName') ? { displayName: item.displayName! } : {}),
      ...(writable.includes('category') ? { category: item.category! } : {}),
      labeledBy: 'agent' as const,
      revision: asset.revision + 1,
    }
    if (writable.includes('tags')) writeTags(tx, asset.id, item.tags!)
    tx.update(s.assets).set(fieldsAfter).where(eq(s.assets.id, asset.id)).run()
    assets.set(asset.id, { ...asset, ...fieldsAfter })
    if (p.runId) {
      const after = readLabelSnapshot(tx, asset.id, { ...asset, ...fieldsAfter })
      tx.insert(s.libraryRunChanges).values({ runId: p.runId, assetId: asset.id, before, after })
        .onConflictDoUpdate({ target: [s.libraryRunChanges.runId, s.libraryRunChanges.assetId], set: { after } }).run()
    }
    emitAssetUpdated(tx, asset.id, asset.revision + 1, now)
    labeled.add(asset.id)
  }
  return { labeled: [...labeled], skippedFields: [...skipped].map(([assetId, fields]) => ({ assetId, fields: [...fields] })) }
}
