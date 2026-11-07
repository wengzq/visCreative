import { useRef, useState } from 'react'
import type { WritingImportPreview } from '@vis/protocol'
import { CloseIcon, describeError, useFormat, useLocale, useMessages } from '@vis/ui-kit'
import { containDialogFocus } from './focus'
import { writingMessages } from './messages'

export function WritingImportDialog({ upload, insert, close, blocked = false }: { blocked?: boolean; upload(file: File): Promise<WritingImportPreview>; insert(preview: WritingImportPreview): Promise<void>; close(): void }) {
  const m = useMessages(writingMessages)
  const f = useFormat()
  const { locale } = useLocale()
  const input = useRef<HTMLInputElement>(null)
  const [preview, setPreview] = useState<WritingImportPreview | null>(null)
  const [chapterLimit, setChapterLimit] = useState(200)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  return <div className="vis-writing-import-backdrop" onKeyDown={event => { event.stopPropagation(); containDialogFocus(event); if (event.key === 'Escape' && !busy) close() }}>
    <section className="vis-writing-import" role="dialog" aria-modal="true" aria-label={m.preview}>
      <header><h2>{m.preview}</h2><button aria-label={m.cancel} disabled={busy} onClick={close}><CloseIcon /></button></header>
      <p>{m.formats}</p>
      <input hidden ref={input} type="file" accept=".txt,.md,.docx" aria-label={m.importName} onChange={event => {
        const file = event.target.files?.[0]
        if (!file) return
        setBusy(true); setError(null); setPreview(null); setChapterLimit(200)
        void upload(file).then(setPreview).catch(setError).finally(() => setBusy(false))
        event.target.value = ''
      }} />
      <button autoFocus disabled={busy} onClick={() => input.current?.click()}>{busy ? m.loading : m.choose}</button>
      {blocked && <p role="alert">{m.conflictUnknown}</p>}
      {error ? <p role="alert">{describeError(error, locale)}</p> : null}
      {preview && <>
        <h3>{preview.name}</h3><p>{m.encoding(preview.encoding)} · {m.documentWords(f.number(preview.words))} · {m.chapters(f.number(preview.chapters.length))}</p>
        <div className="vis-writing-import-columns"><nav aria-label={m.outline}>{preview.chapters.slice(0, chapterLimit).map(chapter => <div key={chapter.from} style={{ paddingInlineStart: (chapter.level - 1) * 12 }}>{chapter.title}</div>)}{preview.chapters.length > chapterLimit && <button onClick={() => setChapterLimit(limit => limit + 200)}>{m.moreChapters}</button>}</nav>
          <pre aria-label={m.opening}>{preview.body.slice(0, 6000)}</pre></div><p>{m.previewHint}</p>
      </>}
      <footer><button disabled={busy} onClick={close}>{m.cancel}</button><button className="is-primary" disabled={!preview || busy || blocked} onClick={() => {
        if (!preview) return
        setBusy(true); setError(null)
        void insert(preview).then(close).catch(setError).finally(() => setBusy(false))
      }}>{m.insert}</button></footer>
    </section>
  </div>
}
