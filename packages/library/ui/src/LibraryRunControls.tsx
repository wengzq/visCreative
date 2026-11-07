import { useCallback, useEffect, useRef, useState } from 'react'
import type { LibraryRunKind, LibraryRunView, LibraryStateView } from '@vis/protocol'
import { describeError, useFormat, useLocale, useMessages } from '@vis/ui-kit'
import type { LibraryCoreHost, LibrarySession } from './host'
import { libraryShellMessages } from './messages'

const requestId = () => `library-${crypto.randomUUID()}`

export function LibraryRunControls({ host, kind, label }: { host: LibraryCoreHost; kind: LibraryRunKind; label?: string }) {
  const m = useMessages(libraryShellMessages)
  const format = useFormat()
  const { locale } = useLocale()
  const [state, setState] = useState<LibraryStateView>()
  const [sessions, setSessions] = useState<LibrarySession[]>([])
  const [runs, setRuns] = useState<LibraryRunView[]>([])
  const [dialog, setDialog] = useState<'session' | 'confirm' | null>(null)
  const [afterSession, setAfterSession] = useState(false)
  const [selection, setSelection] = useState('')
  const [relabel, setRelabel] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [result, setResult] = useState('')
  const [revertRun, setRevertRun] = useState<LibraryRunView>()
  const modal = useRef<HTMLDialogElement>(null)
  const revertModal = useRef<HTMLDialogElement>(null)
  const read = useRef(0)
  const refresh = useCallback(async () => {
    const epoch = ++read.current
    const [next, list, history] = await Promise.all([host.call('library.state', {}), host.sessions(), host.call('library.runList', { limit: 5, kind })])
    if (epoch === read.current) {
      setState(next)
      setSessions(list)
      setRuns(history.runs)
    }
    return next
  }, [host, kind])
  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = () => { void refresh().catch(error => { if (active) setError(error) }) }
    load()
    const off = host.onEvent(event => {
      if (['library.changed', 'asset.updated', 'asset.versionAdded', 'session.updated', 'turn.stateChanged'].includes(event.type) || event.type.startsWith('entity.')) {
        clearTimeout(timer)
        timer = setTimeout(load, 120)
      }
    })
    return () => { active = false; read.current++; clearTimeout(timer); off() }
  }, [host, refresh])
  useEffect(() => {
    if (!dialog) return
    const previous = document.activeElement as HTMLElement | null
    const element = modal.current
    element?.showModal()
    return () => { element?.close(); previous?.focus() }
  }, [dialog])
  useEffect(() => {
    if (!revertRun) return
    const previous = document.activeElement as HTMLElement | null
    const element = revertModal.current
    element?.showModal()
    return () => { element?.close(); previous?.focus() }
  }, [revertRun])
  const owner = sessions.find(session => session.sessionId === state?.sessionId)
  const choose = (run: boolean) => {
    setSelection(state?.sessionId ?? sessions[0]?.sessionId ?? '')
    setAfterSession(run)
    setError(null)
    setDialog('session')
  }
  const start = async () => {
    setBusy(true)
    setError(null)
    try {
      const next = await refresh()
      if (!next.sessionId) { choose(true); return }
      setRelabel(false)
      setDialog('confirm')
    } catch (error) { setError(error) }
    finally { setBusy(false) }
  }
  const confirm = async () => {
    setBusy(true)
    setError(null)
    try {
      if (dialog === 'session') {
        const next = await host.call('library.setSession', { sessionId: selection })
        setState(next)
        setDialog(afterSession ? 'confirm' : null)
      } else if (state?.sessionId) {
        const run = await host.call('library.runStart', { requestId: requestId(), kind })
        try {
          await host.sendLibraryTask({ sessionId: run.sessionId, runId: run.runId, kind, relabel })
        } catch (error) {
          // A failed send must not leave an empty run presented as an active organize task.
          await host.call('library.runRevert', { requestId: requestId(), runId: run.runId }).catch(() => {})
          throw error
        }
        setDialog(null)
        await refresh()
      }
    } catch (error) { setError(error) }
    finally { setBusy(false) }
  }
  const revert = async (runId: string) => {
    setBusy(true)
    setError(null)
    try {
      const response = await host.call('library.runRevert', { requestId: requestId(), runId })
      setResult(m.reverted(format.number(response.reverted.length), format.number(response.skipped.length)))
      await refresh()
      setRevertRun(undefined)
    } catch (error) { setError(error) }
    finally { setBusy(false) }
  }
  return <div className="library-run-controls">
    <div className="library-run-actions">
      <button className="library-primary" disabled={busy || !!owner?.running} onClick={() => void start()}>{label ?? (kind === 'label' ? m.organize : m.mergeConfirm)}</button>
      <button className="library-session-button" aria-label={m.chooseSession} title={owner?.title ?? m.chooseSession} disabled={busy} onClick={() => choose(false)}><span>{owner?.title ?? m.chooseSessionShort}</span><svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg></button>
      {owner ? <button aria-label={m.openSession} title={m.openSession} onClick={() => host.openSession(owner.sessionId)}>↗</button> : null}
    </div>
    {owner?.running ? <p role="status">{m.working}</p> : null}
    {runs.length ? <details className="library-run-history"><summary>{m.recentRuns}</summary>{runs.map(run => <div key={run.runId}>
      <time dateTime={new Date(run.startedAt).toISOString()}>{format.dateTime(run.startedAt)}</time><span>{m.changes(format.number(run.changeCount))}</span>
      {run.revertedAt ? <span>{m.undone}</span> : <button disabled={busy || !!owner?.running} onClick={() => { setError(null); setRevertRun(run) }}>{m.undo}</button>}
    </div>)}</details> : null}
    {result ? <p role="status">{result}</p> : null}
    {error && !dialog && !revertRun ? <p role="alert">{describeError(error, locale)}</p> : null}
    {revertRun ? <dialog ref={revertModal} className="vis-dialog library-dialog" aria-label={m.undo} onCancel={event => { if (busy) event.preventDefault(); else setRevertRun(undefined) }}>
      <h2>{m.undo}</h2><p>{kind === 'label' ? m.undoLabelNote(format.number(revertRun.changeCount)) : m.undoMergeNote(format.number(revertRun.changeCount))}</p>
      {error ? <p role="alert">{describeError(error, locale)}</p> : null}
      <footer><button disabled={busy} onClick={() => setRevertRun(undefined)}>{m.cancel}</button><button disabled={busy} onClick={() => void revert(revertRun.runId)}>{m.undo}</button></footer>
    </dialog> : null}
    {dialog ? <dialog ref={modal} className="vis-dialog library-dialog" aria-label={dialog === 'session' ? m.chooseSession : kind === 'label' ? m.organizeConfirm : m.mergeConfirm} onCancel={event => { if (busy) event.preventDefault(); else setDialog(null) }}>
      <h2>{dialog === 'session' ? m.chooseSession : kind === 'label' ? m.organizeConfirm : m.mergeConfirm}</h2>
      {dialog === 'session' ? <>
        <label>{m.session}<select aria-label={m.session} value={selection} onChange={event => setSelection(event.target.value)} disabled={busy}>
          <option value="">{m.noSession}</option>
          {sessions.map(session => <option key={session.sessionId} value={session.sessionId}>{session.title}</option>)}
        </select></label>
        {!sessions.length ? <p>{m.noSessions}</p> : null}
      </> : <>
        <p>{state?.unlabeled.total ? m.unlabeled(format.number(state.unlabeled.total), format.number(state.unlabeled.needsViewing)) : m.allLabeled}</p>
        <p className="library-muted">{m.tokenNote}</p>
        {kind === 'label' ? <label className="library-check"><input type="checkbox" checked={relabel} onChange={event => setRelabel(event.target.checked)} />{m.relabel}</label> : null}
      </>}
      {error ? <p role="alert">{describeError(error, locale)}</p> : null}
      <footer><button disabled={busy} onClick={() => setDialog(null)}>{m.cancel}</button><button className="library-primary" disabled={busy || dialog === 'session' && !selection} onClick={() => void confirm()}>{dialog === 'session' ? m.confirm : m.start}</button></footer>
    </dialog> : null}
  </div>
}
