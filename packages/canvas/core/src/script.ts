import { ulid, VisError } from '@vis/domain'
import { ASSET_REF_PATTERN, assetRefs, EMPTY_SCRIPT, PROMPT_FIELDS, PROMPT_REF_PATTERN, PROMPT_SOURCE_FIELDS, SCRIPT_LIMITS, ScriptDocInput, ScriptOp, ShotFields,
  type ScriptAsset, type ScriptDoc, type Shot } from '@vis/protocol'
import type { Actor } from './apply'

function invalid(reason: string, message: string): never {
  throw VisError.of('invalid_params', `script.${reason}`, {}, `${message}. See guide "script".`)
}

const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const hasPrompts = (shot: Shot) => PROMPT_FIELDS.some(key => Boolean(shot[key]))
const usesAsset = (shot: Shot, id: string) => shot.sceneId === id || shot.characterIds.includes(id) || shot.propIds.includes(id)
  || Object.values(shot).some(value => typeof value === 'string' && assetRefs(value).includes(id))

function stale(shot: Shot) {
  if (shot.promptState === 'agent' || shot.promptState === 'edited') shot.promptState = 'stale'
}

function promptState(shot: Shot, previous: Shot | undefined, fields: Record<string, unknown>, actor: Actor) {
  if (!hasPrompts(shot)) {
    shot.promptState = null
  } else if (PROMPT_FIELDS.some(key => Object.hasOwn(fields, key))) {
    shot.promptState = actor.kind === 'agent' ? 'agent' : 'edited'
  } else if (previous && PROMPT_SOURCE_FIELDS.some(key => !equal(previous[key], shot[key]))) {
    stale(shot)
  }
}

function validate(doc: ScriptDoc) {
  if (doc.shots.length > SCRIPT_LIMITS.shots || doc.assets.length > SCRIPT_LIMITS.assets) invalid('limit', 'The script exceeds the shot or asset limit')
  const names = new Set<string>()
  for (const asset of doc.assets) {
    const name = `${asset.kind}:${asset.name.trim().toLowerCase()}`
    if (names.has(name)) invalid('duplicate_asset_name', 'Asset names must be unique within each kind')
    names.add(name)
  }
  const assets = new Map(doc.assets.map(asset => [asset.id, asset.kind]))
  for (const shot of doc.shots) {
    if (!ShotFields.safeParse(Object.fromEntries(Object.entries(shot).filter(([key]) => key !== 'id' && key !== 'rev' && key !== 'promptState'))).success) {
      invalid('limit', 'A script cell or shot field exceeds its limits')
    }
    if ((shot.sceneId && assets.get(shot.sceneId) !== 'scene')
      || shot.characterIds.some(id => assets.get(id) !== 'character')
      || shot.propIds.some(id => assets.get(id) !== 'prop')) invalid('asset_reference', 'Shot references must name existing assets of the matching kind')
  }
}

function resolveFields<T extends object>(fields: T, ids: Record<string, string>): T {
  const resolve = (value: unknown): unknown => typeof value === 'string'
    ? value.replace(ASSET_REF_PATTERN, (match, id: string) => ids[id] ? `{{asset:${ids[id]}}}` : match)
      .replace(PROMPT_REF_PATTERN, (match, id: string) => ids[id] ? `{{ref:${ids[id]}}}` : match)
    : value
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key,
    (key === 'sceneId' || key === 'imageNodeId') && typeof value === 'string' ? ids[value] ?? value
      : key === 'characterIds' || key === 'propIds' ? (value as string[]).map(id => ids[id] ?? id)
        : key === 'source' && value && typeof value === 'object' && 'nodeId' in value ? { ...value, nodeId: ids[String(value.nodeId)] ?? value.nodeId }
          : resolve(value),
  ])) as T
}

function allocate(doc: ScriptDoc, ids: Record<string, string>, tempId: string, prefix: string) {
  if (Object.hasOwn(ids, tempId) || doc.shots.some(row => row.id === tempId) || doc.assets.some(row => row.id === tempId)) invalid('duplicate_temp_id', 'Script tempIds must be unique within the batch')
  const id = `${prefix}_${ulid()}`
  ids[tempId] = id
  return id
}

function firstCut(doc: ScriptDoc, revisedId?: string) {
  const first = doc.shots[0]
  if (first && first.transition !== 'cut') {
    first.transition = 'cut'
    if (first.id !== revisedId) first.rev++
    stale(first)
  }
}

function makeShot(fields: Parameters<typeof ShotFields.parse>[0], id: string, actor: Actor): Shot {
  const checked = ShotFields.safeParse(fields)
  if (!checked.success) invalid('invalid_fields', 'Resolved shot fields are invalid or exceed their limits')
  const parsed = checked.data
  const shot: Shot = { ...parsed, id, rev: 1, transition: parsed.transition ?? 'cut', description: parsed.description ?? '', characterIds: parsed.characterIds ?? [], propIds: parsed.propIds ?? [] }
  promptState(shot, undefined, parsed, actor)
  return shot
}

export type ScriptEntityAliases = {
  identify(asset: ScriptAsset): string | undefined
  insert(asset: ScriptAsset, fields: { description?: string | undefined; imageNodeId?: string | null | undefined }): ScriptAsset
  update(asset: ScriptAsset, fields: Record<string, unknown>): ScriptAsset
  delete(asset: ScriptAsset): void
  document(doc: ScriptDoc, fields: { castIds?: string[] | undefined; styleId?: string | null | undefined; style?: string | null | undefined }): void
}

/** Pure row editing; persistence and undo remain in the surrounding canvas transaction. */
export function patchScript(source: ScriptDoc, input: ScriptOp[], actor: Actor, slotId: string, revision: number, ids: Record<string, string>, aliases?: ScriptEntityAliases): ScriptDoc {
  if (input.length < 1 || input.length > SCRIPT_LIMITS.opsPerBatch) invalid('limit', 'A script patch must contain 1 to 200 operations')
  const parsed = ScriptOp.array().safeParse(input)
  if (!parsed.success) invalid('invalid_fields', 'Script operation fields are invalid or exceed their limits')
  const doc = structuredClone(source)
  const conflicts: { kind: 'shot' | 'asset' | 'doc'; id?: string; current: Shot | ScriptAsset | ScriptDoc }[] = []
  const resolve = (id: string) => ids[id] ?? id
  const shotIndex = (id: string) => {
    const index = doc.shots.findIndex(shot => shot.id === resolve(id))
    if (index < 0) invalid('shot_not_found', 'The shot does not exist')
    return index
  }
  const afterIndex = (id: string | null) => id === null ? -1 : shotIndex(id)
  for (const op of parsed.data) {
    switch (op.kind) {
      case 'shot.insert': {
        const index = afterIndex(op.afterShotId) + 1
        const fields = resolveFields(op.shot, ids)
        doc.shots.splice(index, 0, makeShot(index === 0 ? { ...fields, transition: 'cut' } : fields, allocate(doc, ids, op.tempId, 'shot'), actor))
        break
      }
      case 'shot.update':
      case 'shot.delete': {
        const index = shotIndex(op.shotId)
        const shot = doc.shots[index]!
        if (shot.rev !== op.rev) {
          conflicts.push({ kind: 'shot', id: shot.id, current: structuredClone(shot) })
          break
        }
        if (op.kind === 'shot.delete') doc.shots.splice(index, 1)
        else {
          const fields = resolveFields(op.fields, ids)
          if (index === 0 && fields.transition !== undefined) fields.transition = 'cut'
          const next: Shot = { ...shot, ...fields, rev: shot.rev + 1, transition: fields.transition ?? shot.transition,
            description: fields.description ?? shot.description, characterIds: fields.characterIds ?? shot.characterIds, propIds: fields.propIds ?? shot.propIds }
          promptState(next, shot, fields, actor)
          doc.shots[index] = next
        }
        break
      }
      case 'shot.move': {
        const index = shotIndex(op.shotId)
        if (op.afterShotId !== null) afterIndex(op.afterShotId)
        if (resolve(op.shotId) === (op.afterShotId === null ? null : resolve(op.afterShotId))) invalid('invalid_move', 'A shot cannot be placed after itself')
        const [shot] = doc.shots.splice(index, 1)
        shot!.rev++
        doc.shots.splice(afterIndex(op.afterShotId) + 1, 0, shot!)
        break
      }
      case 'asset.insert': {
        const id = allocate(doc, ids, op.tempId, 'sast')
        const fields = resolveFields(op.asset, ids)
        const asset = { ...fields, id, rev: 1, description: fields.description ?? '' }
        const row = aliases?.insert(asset, fields) ?? asset
        ids[op.tempId] = row.id
        const index = doc.assets.findIndex(asset => asset.id === row.id)
        if (index < 0) doc.assets.push(row)
        else {
          if (doc.assets[index]!.rev !== row.rev) for (const shot of doc.shots) if (usesAsset(shot, row.id)) { stale(shot); shot.rev++ }
          doc.assets[index] = row
        }
        break
      }
      case 'asset.update':
      case 'asset.delete': {
        const index = doc.assets.findIndex(asset => asset.id === resolve(op.assetId))
        if (index < 0) invalid('asset_not_found', 'The script asset does not exist')
        const asset = doc.assets[index]!
        if (asset.rev !== op.rev) {
          conflicts.push({ kind: 'asset', id: asset.id, current: structuredClone(asset) })
          break
        }
        const fields = op.kind === 'asset.update' ? resolveFields(op.fields, ids) : {}
        const changed = op.kind === 'asset.delete' || Object.entries(fields).some(([key, value]) => !equal(asset[key as keyof ScriptAsset], value))
        if (op.kind === 'asset.delete') {
          aliases?.delete(asset)
          doc.assets.splice(index, 1)
        } else doc.assets[index] = aliases?.update(asset, fields) ?? { ...asset, ...fields, rev: asset.rev + 1, name: fields.name ?? asset.name, description: fields.description ?? asset.description }
        if (changed) for (const shot of doc.shots) {
          if (!usesAsset(shot, asset.id)) continue
          if (op.kind === 'asset.delete') {
            if (shot.sceneId === asset.id) shot.sceneId = null
            shot.characterIds = shot.characterIds.filter(id => id !== asset.id)
            shot.propIds = shot.propIds.filter(id => id !== asset.id)
          }
          stale(shot)
          shot.rev++
        }
        break
      }
      case 'doc.set': {
        if (doc.rev !== op.rev) {
          conflicts.push({ kind: 'doc', current: structuredClone(doc) })
          break
        }
        const oldStyle = doc.styleId ?? doc.style
        Object.assign(doc, op.fields, { rev: doc.rev + 1 })
        aliases?.document(doc, op.fields)
        if (oldStyle !== (doc.styleId ?? doc.style)) for (const shot of doc.shots) { stale(shot); shot.rev++ }
        break
      }
    }
    firstCut(doc, op.kind === 'shot.move' || op.kind === 'shot.update' ? resolve(op.shotId) : undefined)
  }
  if (conflicts.length) throw VisError.of('revision_conflict', 'script.revision_conflict', { currentRows: JSON.stringify(conflicts) },
    'Script rows have changed; read the current rows and retry', [{ slotId, expectedRevision: revision, currentRevision: revision }])
  doc.castIds = doc.assets.map(asset => asset.id)
  validate(doc)
  return doc
}

export function replaceScript(source: ScriptDoc, input: ScriptDocInput, actor: Actor, ids: Record<string, string>, aliases?: ScriptEntityAliases): ScriptDoc {
  const parsed = ScriptDocInput.safeParse(input)
  if (!parsed.success) invalid('invalid_fields', 'Script document fields are invalid or exceed their limits')
  const doc: ScriptDoc = { ...structuredClone(EMPTY_SCRIPT), rev: source.rev + 1,
    style: parsed.data.style === undefined ? source.style : parsed.data.style,
    styleId: source.styleId ?? null,
    sessionId: parsed.data.sessionId === undefined ? source.sessionId : parsed.data.sessionId }
  const names = new Map<string, string>()
  const rows = parsed.data.assets.map(({ tempId, ...asset }) => {
    const row = { ...asset, id: allocate(doc, ids, tempId, 'sast'), rev: 1, description: asset.description ?? '' }
    const name = `${row.kind}:${row.name.trim().toLowerCase()}`
    row.id = aliases?.identify(row) ?? (aliases ? names.get(name) : undefined) ?? row.id
    names.set(name, row.id)
    ids[tempId] = row.id
    return row
  })
  for (const [index, row] of rows.entries()) {
    const asset = resolveFields(row, ids)
    const fields = resolveFields(parsed.data.assets[index]!, ids)
    const setting = aliases?.insert(asset, fields) ?? asset
    const existing = doc.assets.findIndex(asset => asset.id === setting.id)
    if (existing < 0) doc.assets.push(setting)
    else doc.assets[existing] = setting
  }
  aliases?.document(doc, parsed.data)
  doc.castIds = doc.assets.map(asset => asset.id)
  for (const [index, { tempId, ...fields }] of parsed.data.shots.entries()) {
    doc.shots.push(makeShot(resolveFields(index === 0 ? { ...fields, transition: 'cut' } : fields, ids), allocate(doc, ids, tempId, 'shot'), actor))
  }
  validate(doc)
  return doc
}
