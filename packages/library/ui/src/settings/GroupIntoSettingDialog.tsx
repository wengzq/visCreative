import { useEffect, useState } from 'react'
import { ENTITY_LIMITS, type EntityKind, type EntityMember, type EntityView } from '@vis/protocol'
import { describeError, useFormat, useLocale, useMessages } from '@vis/ui-kit'
import type { SettingsLibraryHost } from './host'
import { SettingsDialog } from './Dialog'
import { useSettingMedia } from './data'
import { duplicateSettingId, mergeMembers, revisionConflict, settingKinds } from './model'
import { settingsMessages } from './messages'

export function GroupIntoSettingDialog({ host, assetIds, onClose, onGrouped }: {
  host: SettingsLibraryHost; assetIds: readonly string[]; onClose(): void; onGrouped?(entity: EntityView): void
}) {
  const m = useMessages(settingsMessages)
  const format = useFormat()
  const { locale } = useLocale()
  const [items, setItems] = useState<EntityView[]>([])
  const [target, setTarget] = useState('')
  const [kind, setKind] = useState<EntityKind>('character')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [limitReached, setLimitReached] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [requestId] = useState(() => crypto.randomUUID())
  const { media, error: mediaError, loading } = useSettingMedia(host)
  useEffect(() => { void host.call('entity.list', { includeDeleted: false }).then(result => setItems(result.items), setError) }, [host])
  const members: EntityMember[] = [...new Set(assetIds)].map(assetId => {
    const kind = media.find(item => item.assetId === assetId)?.kind
    return { assetId, role: kind === 'audio' ? 'voice' : kind ?? 'other' }
  })
  const combinedMembers = mergeMembers(items.find(item => item.id === target)?.members ?? [], members)
  const overLimit = combinedMembers.length > ENTITY_LIMITS.members
  useEffect(() => { setLimitReached(false) }, [target, assetIds])
  const group = async () => {
    if (overLimit) return
    setBusy(true); setError(null)
    try {
      let saved: EntityView
      if (target) {
        const add = async () => {
          const current = await host.call('entity.get', { entityId: target })
          const combined = mergeMembers(current.members, members)
          if (combined.length > ENTITY_LIMITS.members) {
            setItems(items => items.map(item => item.id === target ? current : item))
            setLimitReached(true)
            return undefined
          }
          return host.call('entity.update', { entityId: target, expectedRevision: current.revision,
            members: combined })
        }
        let result
        try { result = await add() } catch (cause) { if (!revisionConflict(cause)) throw cause; result = await add() }
        if (!result) return
        saved = result
      } else {
        const cover = media.find(item => assetIds.includes(item.assetId) && item.kind === 'image')
        saved = await host.call('entity.create', { requestId, kind, name: name.trim(), members, ...(cover ? { refs: [{ assetVersionId: cover.latest.assetVersionId }] } : {}) })
      }
      onGrouped?.(saved); onClose()
    } catch (cause) { setError(cause) }
    finally { setBusy(false) }
  }
  const duplicate = duplicateSettingId(error)
  return <SettingsDialog title={m.group} onClose={onClose} footer={<><button disabled={busy} onClick={onClose}>{m.cancel}</button><button className="is-primary" disabled={busy || loading || !!mediaError || !assetIds.length || overLimit || limitReached || (!target && !name.trim())} onClick={() => void group()}>{m.save}</button></>}>
    {loading ? <p role="status">{m.loading}</p> : null}
    <div className="library-setting-fields">
      <label>{m.destination}<select aria-label={m.destination} value={target} disabled={busy} onChange={event => setTarget(event.target.value)}><option value="">{m.newSetting}</option>{items.map(item => <option key={item.id} value={item.id}>{item.name} · {m[item.kind]}</option>)}</select></label>
      {!target ? <><label>{m.kind}<select aria-label={m.kind} value={kind} disabled={busy} onChange={event => setKind(event.target.value as EntityKind)}>{settingKinds.map(value => <option key={value} value={value}>{m[value]}</option>)}</select></label>
        <label>{m.name}<input aria-label={m.name} autoFocus value={name} maxLength={60} disabled={busy} onChange={event => setName(event.target.value)} /></label></> : null}
    </div>
    {overLimit || limitReached ? <p role="alert">{m.memberLimit(format.number(ENTITY_LIMITS.members))}</p> : null}
    {error || mediaError ? <p role="alert">{duplicate ? m.duplicate : describeError(error ?? mediaError, locale)}{duplicate ? <button onClick={() => { setTarget(duplicate); setError(null) }}>{m.openExisting}</button> : null}</p> : null}
  </SettingsDialog>
}
