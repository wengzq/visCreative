import { useState, type ReactNode } from 'react'
import type { EntityView } from '@vis/protocol'
import { describeError, useLocale, useMessages } from '@vis/ui-kit'
import type { SettingsLibraryHost } from './host'
import { SettingEditor } from './SettingEditor'
import { settingsMessages } from './messages'

export function SettingsHeader({ host, runControls }: { host: SettingsLibraryHost; runControls?: ReactNode }) {
  const m = useMessages(settingsMessages)
  const { locale } = useLocale()
  const [editing, setEditing] = useState<EntityView | 'new' | null>(null)
  const [error, setError] = useState<unknown>(null)
  return <div className="library-settings-header">
    <div className="library-settings-tools">{runControls}<button title={m.create} onClick={() => setEditing('new')}>{m.create}</button></div>
    {error ? <p role="alert">{describeError(error, locale)}</p> : null}
    {editing ? <SettingEditor key={editing === 'new' ? 'new' : editing.id} host={host} {...(editing === 'new' ? {} : { entity: editing })}
      onClose={() => setEditing(null)} onSaved={() => {}}
      onOpenExisting={id => { void host.call('entity.get', { entityId: id }).then(setEditing, setError) }} /> : null}
  </div>
}
