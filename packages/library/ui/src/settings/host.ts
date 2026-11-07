import type { EntityRef } from '@vis/protocol'
import type { LibraryCoreHost } from '../host'

export type SettingsHost = {
  settingsAssetUrl?(assetVersionId: string): string
  seriesRefUrl?(seriesId: string, refId: string): string
  onSeriesChanged?(listener: () => void): () => void
  settingsCanvasImages?(): readonly { label: string; ref: EntityRef }[]
  showSettingMembers?(entityId: string): void
}

export type SettingsLibraryHost = Pick<LibraryCoreHost, 'call' | 'onEvent'> & SettingsHost
