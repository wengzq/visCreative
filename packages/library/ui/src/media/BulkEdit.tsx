import { useEffect, useRef, useState } from 'react'
import type { LibraryAsset } from '@vis/protocol'
import { describeError, useFormat, useLocale, useMessages } from '@vis/ui-kit'
import type { LibraryHost } from '../types'
import { mediaMessages } from './messages'
import { parseTags } from './MediaDetail'
import { updateAsset } from './state'

export function BulkEdit({ host, assets, onClose }: { host: LibraryHost; assets: LibraryAsset[]; onClose(): void }) {
  const m = useMessages(mediaMessages)
  const { locale } = useLocale()
  const format = useFormat()
  const modal = useRef<HTMLDialogElement>(null)
  const [category, setCategory] = useState('')
  const [tags, setTags] = useState('')
  const [useCategory, setUseCategory] = useState(false)
  const [useTags, setUseTags] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState('')
  const [failures, setFailures] = useState<string[]>([])
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const element = modal.current
    element?.showModal()
    return () => { element?.close(); previous?.focus() }
  }, [])
  const save = async () => {
    setBusy(true)
    const failures: string[] = []
    let saved = 0
    for (const asset of assets.slice(0, 50)) {
      try {
        await updateAsset(host, asset, { ...(useCategory ? { category: category.trim() || null } : {}), ...(useTags ? { tags: parseTags(tags) } : {}) })
        saved++
      } catch (error) { failures.push(`${asset.displayName ?? m[asset.kind]}: ${describeError(error, locale)}`) }
    }
    setResult(m.bulkResult(format.number(saved), format.number(failures.length)))
    setFailures(failures)
    setBusy(false)
  }
  return <dialog ref={modal} className="vis-dialog library-dialog" aria-label={m.bulkTitle} onCancel={event => { if (busy) event.preventDefault(); else onClose() }}>
    <h2>{m.bulkTitle}</h2><p className="library-muted">{m.bulkHint}</p>
    <label className="library-check"><input type="checkbox" checked={useCategory} disabled={busy} onChange={event => setUseCategory(event.target.checked)} />{m.applyCategory}</label>
    <label>{m.category}<input aria-label={m.category} value={category} maxLength={20} disabled={busy || !useCategory} onChange={event => setCategory(event.target.value)} /></label>
    <label className="library-check"><input type="checkbox" checked={useTags} disabled={busy} onChange={event => setUseTags(event.target.checked)} />{m.applyTags}</label>
    <label>{m.tags}<input aria-label={m.tags} value={tags} disabled={busy || !useTags} onChange={event => setTags(event.target.value)} /></label>
    {result ? <p role="status">{result}</p> : null}
    {failures.length ? <ul role="alert">{failures.map((failure, index) => <li key={index}>{failure}</li>)}</ul> : null}
    <footer><button disabled={busy} onClick={onClose}>{result ? m.done : m.cancel}</button><button disabled={busy || !useCategory && !useTags || !!result} className="library-primary" onClick={() => void save()}>{m.save}</button></footer>
  </dialog>
}
