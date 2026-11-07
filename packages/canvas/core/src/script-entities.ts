import { newId, VisError } from '@vis/domain'
import { currentScripts, entityRow, findEntityByName, projectScriptEntities, shotUsesEntity, usableEntityImage, writeEntity } from '@vis/library-core'
import type { EntityRef, ScriptAsset, ScriptDoc } from '@vis/protocol'
import { and, currentSeq, eq, isNull, spaceSchema as s, sql, type SpaceDb, type SpaceTx } from '@vis/storage'
import type { ScriptEntityAliases } from './script'
import { writeSlotRevision } from './write'

export function imageNodeRef(tx: SpaceTx, nodeId: string): EntityRef | undefined {
  const node = tx.select().from(s.nodes).where(and(eq(s.nodes.id, nodeId), isNull(s.nodes.deletedAt))).get()
  if (node?.kind !== 'image') return undefined
  const row = tx.select({ assetVersionId: s.slotRevisions.assetVersionId }).from(s.slots)
    .innerJoin(s.slotRevisions, and(eq(s.slotRevisions.slotId, s.slots.id), eq(s.slotRevisions.revision, s.slots.currentRevision)))
    .where(and(eq(s.slots.nodeId, nodeId), eq(s.slots.slotKey, 'main'), isNull(s.slots.deletedAt))).get()
  return row?.assetVersionId ? { assetVersionId: row.assetVersionId, sourceNodeId: nodeId } : undefined
}

/** The port is called within the entity transaction so invalidation and settings cannot diverge. */
export function markScriptEntitiesChanged(tx: SpaceTx, entityIds: string[], now = Date.now(), exceptSlotId?: string) {
  const changes = entityIds.map(id => entityRow(tx, id, true))
  let operationId: string | undefined
  for (const script of currentScripts(tx)) {
    if (!script.doc || script.slot.id === exceptSlotId) continue
    const source = script.doc
    const relevant = changes.filter(row => source.styleId === row.id || (source.castIds ?? source.assets.map(asset => asset.id)).includes(row.id))
    if (!relevant.length) continue
    const doc = structuredClone(source)
    const deleted = new Set(relevant.filter(row => row.deletedAt !== null).map(row => row.id))
    for (const shot of doc.shots) {
      if (!relevant.some(row => source.styleId === row.id || shotUsesEntity(shot, row.id))) continue
      if (shot.promptState === 'agent' || shot.promptState === 'edited') shot.promptState = 'stale'
      if (shot.sceneId && deleted.has(shot.sceneId)) shot.sceneId = null
      shot.characterIds = shot.characterIds.filter(id => !deleted.has(id))
      shot.propIds = shot.propIds.filter(id => !deleted.has(id))
      shot.rev++
    }
    doc.castIds = (source.castIds ?? source.assets.map(asset => asset.id)).filter(id => !deleted.has(id))
    if (doc.styleId && deleted.has(doc.styleId)) { doc.styleId = null; doc.rev++ }
    if (!operationId) {
      operationId = newId('operation', now)
      tx.insert(s.operations).values({ id: operationId, actorKind: 'system', description: 'Refresh script settings', createdAt: now }).run()
    }
    writeSlotRevision(tx, script.slot.id, script.slot.currentRevision, { script: projectScriptEntities(tx, doc) }, operationId, now)
  }
}

export function scriptEntityAliases(tx: SpaceTx, slotId: string, now: number): ScriptEntityAliases {
  const changed = (tx: SpaceTx, ids: string[]) => markScriptEntitiesChanged(tx, ids, now, slotId)
  const assetProjection = (id: string): ScriptAsset => projectScriptEntities(tx, { version: 1, rev: 0, assets: [], shots: [], castIds: [id], styleId: null }).assets[0]!
  const styleAlias = (text: string) => {
    const old = tx.select().from(s.entities).where(and(eq(s.entities.kind, 'style'), isNull(s.entities.deletedAt))).all().find(row => row.description === text)
    if (old) return old.id
    const scripts = currentScripts(tx, true)
    const index = scripts.findIndex(script => script.slot.id === slotId)
    const base = `${scripts[index]?.title || `\u811a\u672c ${index + 1}`} \u98ce\u683c`
    let name = base
    let suffix = 2
    while (findEntityByName(tx, 'style', name)) name = `${base.slice(0, 54)} ${suffix++}`
    return writeEntity(tx, { kind: 'style', name, description: text }, { now, onEntitiesChanged: changed }).id
  }
  const refsFromAsset = (asset: { imageNodeId?: string | null | undefined }, previous: EntityRef[] = []) => {
    if (asset.imageNodeId === undefined) return undefined
    if (asset.imageNodeId === null) return previous.slice(1)
    const ref = imageNodeRef(tx, asset.imageNodeId)
    // Empty image nodes are valid preparation targets; the alias obtains a ref once an image exists.
    return ref ? [ref, ...previous.slice(1)] : previous
  }
  const pendingSource = (id: unknown) => {
    if (typeof id !== 'string' || imageNodeRef(tx, id)) return null
    return tx.select().from(s.nodes).where(and(eq(s.nodes.id, id), eq(s.nodes.kind, 'image'), isNull(s.nodes.deletedAt))).get()?.id ?? null
  }
  return {
    identify(asset) { return findEntityByName(tx, asset.kind, asset.name)?.id },
    insert(asset, fields) {
      const old = findEntityByName(tx, asset.kind, asset.name)
      if (old) {
        if (fields.description !== undefined || fields.imageNodeId !== undefined) {
          const refs = refsFromAsset(fields, old.refs)
          writeEntity(tx, { ...old, ...(fields.description !== undefined ? { description: fields.description } : {}),
            ...(refs ? { refs, pendingSourceNodeId: pendingSource(fields.imageNodeId) } : {}) },
          { id: old.id, expectedRevision: old.revision, now, onEntitiesChanged: changed })
        }
        return assetProjection(old.id)
      }
      const refs = refsFromAsset(asset) ?? []
      return assetProjection(writeEntity(tx, { ...asset, refs, pendingSourceNodeId: pendingSource(asset.imageNodeId) }, { now, createId: asset.id, onEntitiesChanged: changed }).id)
    },
    update(asset, fields) {
      const old = entityRow(tx, asset.id)
      const refs = refsFromAsset(fields as { imageNodeId?: string | null }, old.refs)
      writeEntity(tx, { ...old, ...fields, ...(refs ? { refs, pendingSourceNodeId: pendingSource(fields.imageNodeId) } : {}) }, { id: old.id, expectedRevision: asset.rev, now, onEntitiesChanged: changed })
      return assetProjection(asset.id)
    },
    delete() {},
    document(doc, fields) {
      if (fields.castIds !== undefined) {
        for (const id of fields.castIds) if (entityRow(tx, id).kind === 'style') throw VisError.of('invalid_params', 'script.cast_kind', {}, 'Styles must be selected with styleId')
        doc.castIds = [...new Set([...fields.castIds, ...('assets' in fields ? doc.assets.map(asset => asset.id) : [])])]
        doc.assets = projectScriptEntities(tx, doc).assets
      }
      if (fields.styleId !== undefined) {
        if (fields.styleId && entityRow(tx, fields.styleId).kind !== 'style') throw VisError.of('invalid_params', 'script.style_kind', {}, 'styleId must reference a style setting')
        doc.styleId = fields.styleId
      } else if (fields.style !== undefined) doc.styleId = fields.style?.trim() ? styleAlias(fields.style) : null
      doc.style = doc.styleId ? entityRow(tx, doc.styleId).description : null
    },
  }
}

/** Restoring a script restores its rows and selections, while shared settings retain their latest state. */
export function restoreScriptCast(tx: SpaceTx, source: ScriptDoc, slotId: string, now: number) {
  const doc = structuredClone(source)
  if (!doc.castIds) doc.castIds = doc.assets.map(asset => asset.id)
  const live = new Set(tx.select({ id: s.entities.id }).from(s.entities).where(isNull(s.entities.deletedAt)).all().map(row => row.id))
  doc.castIds = doc.castIds.filter(id => live.has(id))
  if (doc.styleId === undefined) scriptEntityAliases(tx, slotId, now).document(doc, { style: doc.style ?? null })
  else if (doc.styleId && !live.has(doc.styleId)) doc.styleId = null
  const projected = projectScriptEntities(tx, doc)
  for (const shot of projected.shots) {
    const changed = source.styleId !== undefined && source.style !== projected.style
      || source.assets.some(asset => shotUsesEntity(shot, asset.id) && projected.assets.find(current => current.id === asset.id)?.rev !== asset.rev)
    if (changed) {
      if (shot.promptState === 'agent' || shot.promptState === 'edited') shot.promptState = 'stale'
      shot.rev++
    }
    if (shot.sceneId && !live.has(shot.sceneId)) shot.sceneId = null
    shot.characterIds = shot.characterIds.filter(id => live.has(id))
    shot.propIds = shot.propIds.filter(id => live.has(id))
  }
  return projected
}

/** Migrate current heads including deleted nodes, so undo can restore an editable script. */
export function migrateScriptEntities(db: SpaceDb, now = Date.now()) {
  return db.transaction(tx => {
    const result = { migrated: 0, skippedRefs: [] as { entityId: string; assetVersionId: string }[] }
    if (tx.select().from(s.contractMigrations).where(eq(s.contractMigrations.id, '0026-entities')).get()) return result
    const scripts = currentScripts(tx, true)
    for (const [index, script] of scripts.entries()) {
      if (!script.doc || script.doc.castIds) continue
      const doc = structuredClone(script.doc)
      const title = script.title || `\u811a\u672c ${index + 1}`
      for (const asset of doc.assets) {
        let name = asset.name
        if (findEntityByName(tx, asset.kind, name)) {
          const base = `${asset.name} \u00b7 ${title}`
          name = base
          let suffix = 2
          while (findEntityByName(tx, asset.kind, name)) name = `${base} ${suffix++}`
        }
        const ref = asset.imageNodeId ? imageNodeRef(tx, asset.imageNodeId) : undefined
        const media = ref ? usableEntityImage(tx, ref.assetVersionId) : undefined
        if (ref && !media) result.skippedRefs.push({ entityId: asset.id, assetVersionId: ref.assetVersionId })
        const pending = !ref && asset.imageNodeId ? tx.select({ id: s.nodes.id }).from(s.nodes)
          .where(and(eq(s.nodes.id, asset.imageNodeId), eq(s.nodes.kind, 'image'), isNull(s.nodes.deletedAt))).get()?.id : undefined
        writeEntity(tx, { kind: asset.kind, name, description: asset.description, refs: ref && media ? [ref] : [],
          members: media ? [{ assetId: media.assetId, role: 'image' }] : [], pendingSourceNodeId: pending ?? null },
          { now, createId: asset.id, initialRevision: asset.rev })
      }
      doc.castIds = doc.assets.map(asset => asset.id)
      doc.styleId = null
      scriptEntityAliases(tx, script.slot.id, now).document(doc, { style: doc.style ?? null })
      doc.rev++
      const operationId = newId('operation', now)
      tx.insert(s.operations).values({ id: operationId, actorKind: 'system', description: 'Migrate script settings', createdAt: now }).run()
      const revision = writeSlotRevision(tx, script.slot.id, script.slot.currentRevision, { script: projectScriptEntities(tx, doc) }, operationId, now)
      // Presence undo checks the head revision; the migration preserves the content's meaning.
      for (const entry of tx.select().from(s.undoEntries).all()) {
        const inverse = entry.inverse as { steps: { kind: string; nodeId: string }[]; slots: Record<string, number> }
        if (inverse.slots[script.slot.id] !== script.slot.currentRevision || !inverse.steps.some(step => step.kind === 'presence' && step.nodeId === script.nodeId)) continue
        inverse.slots[script.slot.id] = revision
        tx.update(s.undoEntries).set({ inverse }).where(eq(s.undoEntries.id, entry.id)).run()
      }
      result.migrated++
    }
    const row = tx.get<{ rowid: number }>(sql`SELECT coalesce(max(rowid), 0) AS rowid FROM idempotency_keys`)
    tx.insert(s.contractMigrations).values({ id: '0026-entities', eventSeq: currentSeq(tx), idempotencyRowid: row?.rowid ?? 0 }).run()
    return result
  }, { behavior: 'immediate' })
}
