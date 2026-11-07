import { ChapterOutline } from './ChapterOutline'
import { manuscriptMarkdown, markdownProtected } from './markdown'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Compartment, EditorState } from '@codemirror/state'
import { Decoration, EditorView, keymap } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { applyTextEdits, textEditAnchor, writingChapters, writingWordCount, type SlotVersionView } from '@vis/protocol'
import { CloseIcon, describeError, useFormat, useLocale, useMessages } from '@vis/ui-kit'
import { reviewDecorations, reviewEdits, type ReviewEdit } from './review'
import { containDialogFocus } from './focus'
import { blockInsert, useWritingDraft } from './draft'
import { SplitDialog } from './SplitDialog'
import { sourceDecorations, type PassageShot } from './sources'
import { SourceMarkers } from './SourceMarkers'
import { SelectionActions, type WritingAction } from './SelectionActions'
import type { SelectionRange } from './geometry'
import { WritingImportDialog } from './ImportDialog'
import { writingMessages } from './messages'
import type { WritingHost } from './types'

export function WritingEditor({ host }: { host: WritingHost }) {
  const m = useMessages(writingMessages)
  const f = useFormat()
  const { locale } = useLocale()
  const draft = useWritingDraft(host)
  const latest = useRef(draft)
  latest.current = draft
  const mount = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const [editorView, setEditorView] = useState<EditorView | null>(null)
  const editable = useMemo(() => new Compartment(), [])
  const sources = useMemo(() => new Compartment(), [])
  const [splitting, setSplitting] = useState(false)
  const review = useMemo(() => new Compartment(), [])
  const [selection, setSelection] = useState<SelectionRange | null>(null)
  const [scriptName, setScriptName] = useState('')
  const [actionRequest, setActionRequest] = useState<{ action: 'ask' | 'shots'; target: SelectionRange } | null>(null)
  const [instruction, setInstruction] = useState('')
  const [sending, setSending] = useState(false)
  const [reviewing, setReviewing] = useState(false)
  const [reviewPosition, setReviewPosition] = useState(-1)
  const edits = useMemo(() => reviewEdits(host.proposals ?? []), [host.proposals])
  const locked = draft.conflict || draft.pendingReview || reviewing
  const [position, setPosition] = useState(0)
  const [measured, setMeasured] = useState(draft.body)
  const [importing, setImporting] = useState(false)
  const importPosition = useRef({ from: 0, to: 0 })
  const [showHistory, setShowHistory] = useState(false)
  const [versions, setVersions] = useState<SlotVersionView[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [chosen, setChosen] = useState<SlotVersionView | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [copied, setCopied] = useState(false)
  // Statistics never scan the whole manuscript on the keystroke's critical path.
  useEffect(() => { const timer = setTimeout(() => setMeasured(draft.body), 250); return () => clearTimeout(timer) }, [draft.body])
  const chapters = useMemo(() => writingChapters(measured), [measured])
  const words = useMemo(() => writingWordCount(measured), [measured])
  const current = [...chapters].reverse().find(chapter => chapter.from <= position)
  const chapterWords = useMemo(() => writingWordCount(measured.slice(current?.from ?? 0, current?.to ?? chapters[0]?.from ?? measured.length)), [measured, current?.from, current?.to, chapters])
  useEffect(() => {
    if (!mount.current) return
    const editor = new EditorView({
      parent: mount.current,
      state: EditorState.create({ doc: latest.current.body, extensions: [
        sources.of(EditorView.decorations.of(Decoration.none)),
        review.of(EditorView.decorations.of(Decoration.none)),
        manuscriptMarkdown(m.editTable),
        history(), keymap.of([...defaultKeymap, ...historyKeymap]), EditorView.lineWrapping,
        EditorView.contentAttributes.of({ 'aria-label': m.manuscript, role: 'textbox', 'aria-multiline': 'true', spellcheck: 'true' }),
        editable.of(EditorView.editable.of(!latest.current.conflict)),
        EditorView.updateListener.of(update => {
          if (update.docChanged) latest.current.edit(update.state.doc.toString())
          if (update.docChanged || update.selectionSet) {
            const range = update.state.selection.main
            setPosition(range.head)
            setSelection(range.empty ? null : { from: range.from, to: range.to, text: update.state.sliceDoc(range.from, range.to) })
          }
        }),
      ] }),
    })
    view.current = editor
    setEditorView(editor)
    editor.focus()
    return () => { editor.destroy(); view.current = null }
    // Recreate state after loading their version, so undo cannot resurrect a discarded draft.
  }, [draft.generation, editable, review, sources, m.manuscript, m.editTable])
  useEffect(() => {
    const editor = view.current
    if (editor && editor.state.doc.toString() !== draft.body) editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: draft.body } })
  }, [draft.body])
  useEffect(() => { view.current?.dispatch({ effects: editable.reconfigure(EditorView.editable.of(!locked)) }) }, [locked, editable, draft.generation])
  useEffect(() => {
    const leave = (event: BeforeUnloadEvent) => { if (latest.current.state !== 'saved') { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', leave)
    return () => window.removeEventListener('beforeunload', leave)
  }, [])
  useEffect(() => {
    const editor = view.current
    if (!editor) return
    editor.dispatch({ effects: sources.reconfigure(EditorView.decorations.of(sourceDecorations(draft.body, host.shots ?? [], host.sourceQuote))) })
  }, [draft.body, draft.generation, host.shots, host.sourceQuote, sources])
  useEffect(() => {
    const editor = view.current
    if (!editor) return
    const protectedRanges = [...edits.map(item => textEditAnchor(draft.body, item.edit)),
      ...(host.shots ?? []).map(shot => textEditAnchor(draft.body, { find: shot.quote })),
      host.sourceQuote ? textEditAnchor(draft.body, { find: host.sourceQuote }) : null,
    ].filter((range): range is { from: number; to: number } => range !== null)
    editor.dispatch({ effects: markdownProtected.of(protectedRanges) })
  }, [draft.body, draft.generation, edits, host.shots, host.sourceQuote])
  useEffect(() => {
    const editor = view.current
    const range = host.sourceQuote ? textEditAnchor(latest.current.body, { find: host.sourceQuote }) : null
    if (editor && range) editor.dispatch({ selection: { anchor: range.from }, effects: EditorView.scrollIntoView(range.from, { y: 'center' }) })
  }, [host.sourceQuote, draft.generation])
  const resolve = async (action: 'accept' | 'reject', selected: ReviewEdit[]) => {
    if (reviewing || draft.pendingReview || draft.conflict) return
    setReviewing(true); setError(null)
    try {
      if (action === 'reject') await host.rejectEdits?.(selected)
      else {
        if (!await latest.current.flush()) return
        const body = latest.current.body
        const applicable = selected.filter(item => item.edit.status === 'pending' && textEditAnchor(body, item.edit))
        if (!applicable.length) return
        const next = applyTextEdits(body, applicable.map(item => item.edit))
        if (next === null) { setError(new Error(m.overlap)); return }
        // CodeMirror owns local undo; the draft controller owns serialized revision-checked saves.
        view.current?.dispatch({ changes: { from: 0, to: view.current.state.doc.length, insert: next } })
        await latest.current.accept(next, applicable)
      }
    } catch (cause) { setError(cause) }
    finally { setReviewing(false) }
  }
  const resolveRef = useRef(resolve)
  resolveRef.current = resolve
  useEffect(() => {
    const labels = { accept: m.accept, reject: m.reject, stale: m.stale,
      label: (number: number, summary: string) => m.editLabel(f.number(number), summary),
      acceptEdit: (number: number) => m.acceptEdit(f.number(number)), rejectEdit: (number: number) => m.rejectEdit(f.number(number)) }
    view.current?.dispatch({ effects: review.reconfigure(EditorView.decorations.of(reviewDecorations(draft.body, edits, locked, labels, (action, selected) => void resolveRef.current(action, selected)))) })
  }, [draft.body, edits, locked, m, f, review, draft.generation])
  const nextEdit = (direction: number) => {
    if (!edits.length) return
    const index = reviewPosition < 0 ? (direction > 0 ? 0 : edits.length - 1) : (reviewPosition + direction + edits.length) % edits.length
    setReviewPosition(index)
    const from = textEditAnchor(draft.body, edits[index]!.edit)?.from ?? draft.body.length
    view.current?.dispatch({ selection: { anchor: from }, effects: EditorView.scrollIntoView(from, { y: 'center' }) })
    view.current?.focus()
  }
  const send = async (action: WritingAction, target = selection) => {
    if (!target || !host.session || !host.sendSelection || locked) return
    setSending(true); setError(null)
    try {
      if (!await latest.current.flush()) return
      const chapter = [...writingChapters(latest.current.body)].reverse().find(chapter => chapter.from <= target.from)?.title ?? m.preamble
      await host.sendSelection(action, chapter, target.text, action === 'shots' ? scriptName.trim() : instruction)
      setActionRequest(null); setInstruction('')
    } catch (cause) { setError(cause) }
    finally { setSending(false) }
  }
  const chooseAction = (action: WritingAction, target: SelectionRange) => {
    if (action === 'ask' || action === 'shots') setActionRequest({ action, target })
    else void send(action, target)
  }
  const openSource = (shot: PassageShot) => {
    void latest.current.flush().then(saved => { if (saved) return host.openShot?.(shot) }).catch(setError)
  }
  const close = async () => {
    setBusy(true); setError(null)
    try { if (await draft.flush()) host.onClose() }
    catch (cause) { setError(cause) }
    finally { setBusy(false) }
  }
  const loadHistory = async (more = false) => {
    setBusy(true); setError(null)
    try {
      const result = await host.history(more ? versions.at(-1)?.revision : undefined)
      setVersions(previous => more ? [...previous, ...result.versions] : result.versions)
      setHasMore(result.hasMore)
    } catch (cause) { setError(cause) }
    finally { setBusy(false) }
  }
  return <section className="vis-writing-editor" role="dialog" aria-modal="true" aria-label={m.title} onKeyDown={event => {
    event.stopPropagation()
    containDialogFocus(event)
    if (event.key === 'Escape' && !importing && !showHistory && !splitting && !actionRequest) { event.preventDefault(); void close() }
  }}>
    <header className="vis-writing-header"><button aria-label={m.close} disabled={busy || locked} onClick={() => void close()}><CloseIcon /></button>
      <div><span className="vis-writing-eyebrow">{m.title}{edits.length ? ` · ${m.reviewCount(f.number(edits.length))}` : ''}</span><h1>{host.node.title ?? m.manuscript}</h1></div>
      <span className={`vis-writing-save is-${draft.state}`} role="status"><i aria-hidden="true" />{draft.state === 'saved' ? m.saved : draft.state === 'unsaved' ? m.unsaved : draft.state === 'conflict' ? '' : m.saving}</span>
      {draft.error ? <button onClick={() => void draft.flush().catch(setError)}>{m.retry}</button> : null}
      <button disabled={locked} onClick={() => { draft.beginEdit(); importPosition.current = view.current?.state.selection.main ?? { from: 0, to: 0 }; setImporting(true) }}>{m.import}</button>
      <button disabled={locked || !chapters.length || !host.split} onClick={() => { void draft.flush().then(saved => { if (saved) setSplitting(true) }).catch(setError) }}>{m.split}</button>
      <button aria-pressed={showHistory} onClick={() => { setShowHistory(!showHistory); setChosen(null); if (!showHistory) void loadHistory() }}>{m.history}</button>
    </header>
    {edits.length > 0 && <div className="vis-writing-review-bar"><span>{m.reviewCount(f.number(edits.length))}</span>
      <button className="is-primary" disabled={locked || !edits.some(item => item.edit.status === 'pending' && textEditAnchor(draft.body, item.edit))} onClick={() => void resolve('accept', edits)}>{m.acceptAll}</button>
      <button disabled={locked} onClick={() => void resolve('reject', edits)}>{m.rejectAll}</button>
      <button aria-label={m.previousEdit} onClick={() => nextEdit(-1)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="m15 5-7 7 7 7" /></svg></button>
      <button aria-label={m.nextEdit} onClick={() => nextEdit(1)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="m9 5 7 7-7 7" /></svg></button>
    </div>}
    {(host.session?.working || sending) && <div className="vis-writing-working" role="status">{m.working(host.session?.title ?? '')}</div>}
    {host.sourceQuote && !textEditAnchor(draft.body, { find: host.sourceQuote }) && <p className="vis-writing-working" role="status">{m.sourceStale}</p>}
    {draft.conflict && <div className="vis-writing-conflict" role="alert"><span>{host.lastWriter?.() ? m.conflict(host.lastWriter()!) : m.conflictUnknown}</span>
      <button onClick={() => { draft.loadTheirs(); setCopied(false) }}>{m.loadTheirs}</button>
      <button onClick={() => { void navigator.clipboard.writeText(draft.body).then(() => setCopied(true)).catch(setError) }}>{copied ? m.copied : m.copyDraft}</button></div>}
    {error || draft.error ? <p className="vis-writing-error" role="alert">{describeError(error ?? draft.error, locale)}</p> : null}
    <div className="vis-writing-layout"><ChapterOutline chapters={chapters} current={current?.from} label={m.outline} empty={m.noChapters} render={chapter => <div key={chapter.from} className="vis-writing-chapter"><button aria-current={current?.from === chapter.from ? 'location' : undefined} style={{ paddingInlineStart: 14 + (chapter.level - 1) * 12 }} onClick={() => {
        const editor = view.current
        if (!editor) return
        const from = Math.min(chapter.from, editor.state.doc.length)
        editor.dispatch({ selection: { anchor: from }, effects: EditorView.scrollIntoView(from, { y: 'start', yMargin: 28 }) }); editor.focus()
      }}>{chapter.title}</button><details><summary aria-label={m.chapterMenu(chapter.title)}>···</summary><div>{(['shots', 'extract'] as const).map(action => <button key={action} disabled={!host.session || locked || sending} onClick={event => { event.currentTarget.closest('details')?.removeAttribute('open'); chooseAction(action, { from: chapter.from, to: chapter.to, text: latest.current.body.slice(chapter.from, chapter.to) }) }}>{m[action]}</button>)}{!host.session && <span>{m.noSession}</span>}</div></details></div>} />
    <main className="vis-writing-main">
      {selection && !locked && <SelectionActions editor={editorView} selection={selection} hasSession={!!host.session} sending={sending} action={chooseAction} />}
      <SourceMarkers editor={editorView} body={draft.body} shots={host.shots ?? []} open={openSource} />
      <div ref={mount} className="vis-writing-codemirror" /></main>
      {showHistory && <aside className="vis-writing-history" aria-label={m.history}><header><h2>{m.history}</h2><button aria-label={m.cancel} onClick={() => setShowHistory(false)}><CloseIcon /></button></header>
        {!versions.length && <p>{busy ? m.loading : m.noHistory}</p>}
        {versions.map(version => <button key={version.revision} aria-pressed={chosen?.revision === version.revision} onClick={() => setChosen(version)}>
          <strong>{m.version(f.number(version.revision))}{version.isCurrent ? ` · ${m.current}` : ''}</strong><span>{f.dateTime(version.createdAt)}</span>
        </button>)}
        {hasMore && <button disabled={busy} onClick={() => void loadHistory(true)}>{m.more}</button>}
        {chosen?.content.type === 'text' && <><pre>{chosen.content.body}</pre><button disabled={busy || locked || chosen.isCurrent} onClick={() => {
          if (chosen.content.type !== 'text') return
          draft.edit(chosen.content.body); void draft.flush().then(() => { setChosen(null); return loadHistory() }).catch(setError)
        }}>{m.restore}</button></>}
      </aside>}
    </div>
    <footer className="vis-writing-footer"><span>{current?.title ?? m.preamble}</span><span>{m.chapterWords(f.number(chapterWords))}</span><span>{m.documentWords(f.number(words))}</span></footer>
    {actionRequest && <div className="vis-writing-import-backdrop" onKeyDown={event => { event.stopPropagation(); containDialogFocus(event); if (event.key === 'Escape' && !sending) { event.preventDefault(); setActionRequest(null); view.current?.focus() } }}>
      <section role="dialog" aria-modal="true" aria-label={m[actionRequest.action]} className="vis-writing-import vis-writing-action-dialog">
        <h2>{m[actionRequest.action]}</h2>
        <form onSubmit={event => { event.preventDefault(); void send(actionRequest.action, actionRequest.target) }}>
          {actionRequest.action === 'shots' ? <label>{m.targetScript}<input aria-label={m.targetScript} placeholder={m.newScript} list="vis-writing-script-names" maxLength={60} value={scriptName} onChange={event => setScriptName(event.target.value)} autoFocus /><datalist id="vis-writing-script-names">{host.scripts?.map(title => <option key={title} value={title} />)}</datalist></label> : <label>{m.instruction}<input aria-label={m.instruction} value={instruction} onChange={event => setInstruction(event.target.value)} autoFocus /></label>}
          <footer><button type="button" disabled={sending} onClick={() => { setActionRequest(null); view.current?.focus() }}>{m.cancel}</button><button className="is-primary" disabled={sending || (actionRequest.action === 'ask' && !instruction.trim())}>{m.send}</button></footer>
        </form>
      </section>
    </div>}
    {splitting && <SplitDialog host={host} body={draft.body} revision={draft.revision} close={() => { setSplitting(false); view.current?.focus() }} />}
    {importing && <WritingImportDialog blocked={draft.conflict} upload={host.upload} close={() => { setImporting(false); view.current?.focus() }} insert={async preview => {
      if (latest.current.conflict) return
      const editor = view.current
      if (!editor) return
      const { from, to } = importPosition.current
      const doc = editor.state.doc
      const insert = blockInsert(doc.sliceString(Math.max(0, from - 2), from), doc.sliceString(to, Math.min(doc.length, to + 2)), preview.body)
      editor.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length }, scrollIntoView: true })
    }} />}
  </section>
}
