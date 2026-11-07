import type { LibraryCoreHost } from './host'
import type { MediaHost } from './media/host'
import type { SettingsHost } from './settings/host'

export type LibraryHost = LibraryCoreHost & MediaHost & SettingsHost
export type LibraryTab = 'settings' | 'media'
