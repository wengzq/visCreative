import { describeError, useLocale, useMessages } from '@vis/ui-kit'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { MediaTab } from './media/MediaTab'
import { libraryMediaFiles } from './media/state'
import { libraryShellMessages } from './messages'
import { SettingsTab } from './settings/SettingsTab'
import type { LibraryHost, LibraryTab } from './types'
import { LibraryRunControls } from './LibraryRunControls'
import { useSeriesSettings } from './settings/series-data'
import { seriesUpdateCount } from './settings/series-model'
import { seriesMessages } from './settings/series-messages'
import { useFormat } from '@vis/ui-kit'

// The right-hand library panel (RFC 0027). The host owns open state and the selected tab so both persist per project.
export function LibraryPanel({ host, tab, onTabChange, settingsHeader, renderGroupIntoSetting }: {
  host: LibraryHost; tab: LibraryTab; onTabChange(tab: LibraryTab): void; settingsHeader?: ReactNode
  renderGroupIntoSetting?(assetIds: string[], close: () => void): ReactNode
}) {
  const m = useMessages(libraryShellMessages)
  const seriesCopy = useMessages(seriesMessages)
  const series = useSeriesSettings(host)
  const format = useFormat()
  const newer = seriesUpdateCount(series.entities)
  const { locale } = useLocale()
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [error, setError] = useState('')
  const upload = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search), 220)
    return () => clearTimeout(timer)
  }, [search])
  const importFiles = async (files: File[]) => {
    const media = libraryMediaFiles(files)
    try {
      setError(media.length < files.length ? m.mediaOnly : '')
      if (media.length) await host.importFiles(media)
    }
    catch (error) { setError(describeError(error, locale)) }
  }
  return (
    <aside className="library-panel" aria-label={m.library} onDragOver={event => {
      if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'copy' }
    }} onDrop={event => {
      if (!event.dataTransfer.files.length) return
      event.preventDefault()
      event.stopPropagation()
      void importFiles([...event.dataTransfer.files])
    }}>
      <header className="library-panel-header">
        <div role="tablist" aria-label={m.library}>
          {(['media', 'settings'] as const).map(value => (
            <button key={value} id={`library-tab-${value}`} aria-controls="library-tab-content" type="button" role="tab" tabIndex={tab === value ? 0 : -1} aria-selected={tab === value} onClick={() => onTabChange(value)} onKeyDown={event => {
              if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
              event.preventDefault()
              const next = event.key === 'Home' ? 'media' : event.key === 'End' ? 'settings' : tab === 'media' ? 'settings' : 'media'
              onTabChange(next)
              document.getElementById(`library-tab-${next}`)?.focus()
            }}>{value === 'settings' && newer ? seriesCopy.tabCount(format.number(newer)) : m[value]}</button>
          ))}
        </div>
        <button type="button" className="library-panel-close" aria-label={m.close} onClick={host.onClose}>×</button>
      </header>
      <div className="library-panel-tools">
        <div className="library-search-row"><input type="search" aria-label={tab === 'media' ? m.search : m.searchSettings} placeholder={tab === 'media' ? m.search : m.searchSettings} value={search} onChange={event => setSearch(event.target.value)} />{tab === 'media' ? <button onClick={() => upload.current?.click()}>{m.import}</button> : null}</div>
        {/* Labeling acts on media; the settings tab brings its own merge-run controls. */}
        {tab === 'media' ? <LibraryRunControls host={host} kind="label" /> : settingsHeader}
        {error ? <p role="alert">{error}</p> : null}
      </div>
      <input ref={upload} hidden type="file" aria-label={m.import} multiple accept="image/*,video/*,audio/*" onChange={event => { void importFiles([...(event.currentTarget.files ?? [])]); event.currentTarget.value = '' }} />
      <div className="library-panel-body" id="library-tab-content" role="tabpanel" aria-labelledby={`library-tab-${tab}`}>
        {tab === 'media' ? <MediaTab host={host} query={query} {...(renderGroupIntoSetting ? { renderGroupIntoSetting } : {})} /> : <SettingsTab host={host} {...{ query }} />}
      </div>
    </aside>
  )
}
