import { ASSET_REF_PATTERN, assetRef, Shot, TIMELINE_LIMITS, type TimelineFromItem, type NodeView, type ScriptAsset, type ScriptDoc, type ScriptOp, type ShotFields } from '@vis/protocol'

export type AssetPart = { type: 'text'; text: string } | { type: 'asset'; id: string; asset: ScriptAsset | undefined }

export function assetParts(text: string, assets: readonly ScriptAsset[]): AssetPart[] {
  const byId = new Map(assets.map(asset => [asset.id, asset]))
  const parts: AssetPart[] = []
  let offset = 0
  for (const match of text.matchAll(ASSET_REF_PATTERN)) {
    if (match.index > offset) parts.push({ type: 'text', text: text.slice(offset, match.index) })
    parts.push({ type: 'asset', id: match[1]!, asset: byId.get(match[1]!) })
    offset = match.index + match[0].length
  }
  if (offset < text.length) parts.push({ type: 'text', text: text.slice(offset) })
  return parts
}

export function assetText(parts: readonly AssetPart[]): string {
  return parts.map(part => part.type === 'text' ? part.text : assetRef(part.id)).join('')
}

export function assetSummary(text: string, assets: readonly ScriptAsset[], missing: string): string {
  return assetParts(text, assets).map(part => part.type === 'text' ? part.text : part.asset?.name ?? missing).join('')
}

export function updateShot(shot: Shot, fields: ShotFields): ScriptOp[] {
  const changed = Object.fromEntries(Object.entries(fields).filter(([key, value]) => JSON.stringify(shot[key as keyof Shot] ?? null) !== JSON.stringify(value ?? null)))
  return Object.keys(changed).length ? [{ kind: 'shot.update', shotId: shot.id, rev: shot.rev, fields: changed }] : []
}

export function insertShot(shots: readonly Shot[], index: number, tempId: string): ScriptOp[] {
  return [{ kind: 'shot.insert', tempId, afterShotId: shots[index - 1]?.id ?? null, shot: { description: '', transition: 'cut' } }]
}

function firstCut(shots: readonly Shot[]): ScriptOp[] {
  return shots[0]?.transition === 'continuous' ? updateShot(shots[0], { transition: 'cut' }) : []
}

export function deleteShot(shots: readonly Shot[], shotId: string): ScriptOp[] {
  const shot = shots.find(shot => shot.id === shotId)
  if (!shot) return []
  const remaining = shots.filter(shot => shot.id !== shotId)
  return [...firstCut(remaining), { kind: 'shot.delete', shotId, rev: shot.rev }]
}

/** targetIndex is the position in the final order, after removing the dragged row. */
export function moveShot(shots: readonly Shot[], shotId: string, targetIndex: number): ScriptOp[] {
  const from = shots.findIndex(shot => shot.id === shotId)
  if (from < 0) return []
  const index = Math.max(0, Math.min(shots.length - 1, targetIndex))
  if (from === index) return []
  const reordered = shots.filter(shot => shot.id !== shotId)
  reordered.splice(index, 0, shots[from]!)
  return [...firstCut(reordered), { kind: 'shot.move', shotId, afterShotId: reordered[index - 1]?.id ?? null }]
}

export function bulkShots(shots: readonly Shot[], ids: ReadonlySet<string>, fields: ShotFields): ScriptOp[] {
  return shots.filter(shot => ids.has(shot.id)).flatMap(shot => updateShot(shot, fields))
}

export function continuousChains(shots: readonly Shot[]): string[][] {
  const chains: string[][] = []
  for (const shot of shots) {
    if (shot.transition === 'continuous' && chains.length) chains.at(-1)!.push(shot.id)
    else chains.push([shot.id])
  }
  return chains.filter(chain => chain.length > 1)
}

export const EXPORT_FIELDS = ['number', 'durationSec', 'transition', 'description', 'endState', 'shotSize', 'camera', 'characterIds', 'sceneId', 'propIds', 'dialogue', 'sound', 'color', 'framePrompt', 'endFramePrompt', 'videoPrompt'] as const
export type ExportField = typeof EXPORT_FIELDS[number]

export function exportRows(doc: ScriptDoc, missing: string): string[][] {
  const names = (ids: readonly string[]) => ids.map(id => doc.assets.find(asset => asset.id === id)?.name ?? missing).join(', ')
  return doc.shots.map((shot, index) => EXPORT_FIELDS.map(field => {
    if (field === 'number') return String(index + 1)
    if (field === 'characterIds' || field === 'propIds') return names(shot[field])
    if (field === 'sceneId') return shot.sceneId ? names([shot.sceneId]) : ''
    return assetSummary(String(shot[field] ?? ''), doc.assets, missing)
  }))
}

export function scriptCsv(doc: ScriptDoc, headers: readonly string[], missing: string): string {
  const quote = (text: string) => `"${text.replaceAll('"', '""')}"`
  return [headers, ...exportRows(doc, missing)].map(row => row.map(quote).join(',')).join('\r\n') + '\r\n'
}

export function scriptMarkdown(doc: ScriptDoc, headers: readonly string[], missing: string): string {
  const row = (cells: readonly string[]) => `| ${cells.map(text => text.replaceAll('\\', '\\\\').replaceAll('|', '\\|').replace(/\r?\n/g, '<br>')).join(' | ')} |`
  return [row(headers), row(headers.map(() => '---')), ...exportRows(doc, missing).map(row)].join('\n') + '\n'
}

/** Node ULIDs carry creation time (0002); snapshot stacking order is only a tie-breaker, since z can change. */
export function shotOutputs(nodes: readonly NodeView[], scriptNodeId: string): ReadonlyMap<string, readonly NodeView[]> {
  const grouped = new Map<string, NodeView[]>()
  const created = (id: string) => /^node_[0-9A-HJKMNP-TV-Z]{26}$/.test(id) ? id.slice(5, 15) : null
  const linked = [...nodes].reverse().filter(node => node.shot?.scriptNodeId === scriptNodeId).sort((a, b) => {
    const aTime = created(a.nodeId)
    const bTime = created(b.nodeId)
    return aTime && bTime ? bTime.localeCompare(aTime) : 0
  })
  for (const node of linked) {
    if (!node.shot) continue
    const outputs = grouped.get(node.shot.shotId) ?? []
    outputs.push(node)
    grouped.set(node.shot.shotId, outputs)
  }
  return grouped
}

export function assembleScriptTimeline(scriptNodeId: string, doc: ScriptDoc, nodes: readonly NodeView[], durationsByAsset?: ReadonlyMap<string, number | undefined>) {
  const outputs = shotOutputs(nodes, scriptNodeId)
  const items: TimelineFromItem[] = []
  const skipped: { shotId: string; reason: 'missing' | 'limit' }[] = []
  let duration = 0
  let limited = false
  for (const shot of doc.shots) {
    if (limited) { skipped.push({ shotId: shot.id, reason: 'limit' }); continue }
    const usable = (role: 'video' | 'first', kind: 'video' | 'image') => outputs.get(shot.id)?.find(node =>
      node.shot?.role === role && node.kind === kind && node.slots.some(slot => slot.slotKey === 'main' && slot.content.type === 'asset'))
    const node = usable('video', 'video') ?? usable('first', 'image')
    if (!node) { skipped.push({ shotId: shot.id, reason: 'missing' }); continue }
    const content = node.slots.find(slot => slot.slotKey === 'main')!.content
    const imageMs = shot.durationSec == null ? undefined : Math.max(TIMELINE_LIMITS.imageMinMs, Math.min(TIMELINE_LIMITS.imageMaxMs, Math.round(shot.durationSec * 1000)))
    const length = node.kind === 'image' ? imageMs ?? 3000 : content.type === 'asset' ? durationsByAsset?.get(content.assetVersionId) ?? 0 : 0
    if (items.length >= TIMELINE_LIMITS.clipsPerTrack || duration + length > TIMELINE_LIMITS.maxDurationMs) {
      limited = true
      skipped.push({ shotId: shot.id, reason: 'limit' })
      continue
    }
    items.push(node.kind === 'image' && imageMs !== undefined ? { nodeId: node.nodeId, durationMs: imageMs } : node.nodeId)
    duration += length
  }
  return { items, skipped }
}

export function conflictRows(error: unknown): Shot[] | null {
  if (!error || typeof error !== 'object') return null
  const record = error as { code?: unknown; data?: { reason?: unknown; params?: { currentRows?: unknown } }; params?: { currentRows?: unknown } }
  if (record.code !== 'revision_conflict' && record.data?.reason !== 'revision_conflict') return null
  const rows = record.data?.params?.currentRows ?? record.params?.currentRows
  try {
    const parsed: unknown = typeof rows === 'string' ? JSON.parse(rows) : rows
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap(row => {
      const result = Shot.safeParse(row?.kind === 'shot' ? row.current : row)
      return result.success ? [result.data] : []
    })
  } catch { return [] }
}
