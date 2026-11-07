import { useEffect, useRef, useState } from 'react'
import { writing, writingChapters, type MethodParams, type SeriesView, type WritingSplitResult } from '@vis/protocol'
import { describeError, useFormat, useLocale, useMessages } from '@vis/ui-kit'
import { containDialogFocus } from './focus'
import { writingMessages } from './messages'
import type { WritingHost } from './types'

type Request = Omit<MethodParams<'writing.split'>, 'nodeId'>

export function SplitDialog({ host, body, revision, close }: { host: WritingHost; body: string; revision: number; close(): void }) {
  const m = useMessages(writingMessages)
  const f = useFormat()
  const { locale } = useLocale()
  const storageKey = `vis-writing-split:${host.node.nodeId}`
  const [request, setRequest] = useState<Request | null>(() => {
    try {
      const value = localStorage.getItem(storageKey)
      const parsed = value ? writing.split.params.safeParse({ ...JSON.parse(value), nodeId: host.node.nodeId }) : null
      if (!parsed?.success) return null
      const { nodeId: _nodeId, ...request } = parsed.data
      return request
    } catch { return null }
  })
  const [chapters, setChapters] = useState(() => writingChapters(body).map(chapter => ({ ...chapter, name: chapter.title.slice(0, 200), episode: 0, checked: false })))
  const [series, setSeries] = useState<SeriesView[]>([])
  const [seriesId, setSeriesId] = useState(host.series?.seriesId ?? '')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<unknown>(null)
  const [result, setResult] = useState<WritingSplitResult | null>(null)
  const dialog = useRef<HTMLElement>(null)
  useEffect(() => {
    let active = true
    void host.seriesList?.().then(items => {
      if (!active) return
      setSeries(items)
      const next = Math.max(0, ...(items.find(item => item.seriesId === host.series?.seriesId)?.episodes.map(episode => episode.episode) ?? [])) + (host.series ? 1 : 2)
      setChapters(rows => rows.map((chapter, index) => ({ ...chapter, episode: next + index, checked: chapter.level === Math.min(...rows.map(row => row.level)) })))
    }).catch(setError).finally(() => { if (active) setLoading(false) })
    dialog.current?.querySelector<HTMLElement>('button, input, select')?.focus()
    return () => { active = false }
  }, [])
  const rows = request ? request.chapters.map(chapter => ({ ...chapter, checked: true, title: chapter.name })) : chapters
  const run = async () => {
    if (busy || !host.split) return
    setBusy(true); setError(null)
    try {
      const current = request ?? { requestId: `writing-split-${crypto.randomUUID()}`, expectedRevision: revision, chapters: chapters.filter(chapter => chapter.checked).map(({ from, to, name, episode }) => ({ from, to, name, episode })),
        ...(host.series ? {} : { series: seriesId ? { seriesId } : { name: name.trim() } }) }
      // Retain the request across closing, reloads and lost responses so retry uses the same snapshot.
      localStorage.setItem(storageKey, JSON.stringify(current))
      setRequest(current)
      setResult(await host.split(current))
    } catch (cause) {
      setError(cause)
      if (['revision_conflict', 'invalid_params'].includes((cause as { code?: string })?.code ?? '')) { localStorage.removeItem(storageKey); setRequest(null) }
    }
    finally { setBusy(false) }
  }
  const done = () => {
    if (result?.chapters.every(chapter => chapter.status === 'succeeded')) localStorage.removeItem(storageKey)
    close()
  }
  return <div className="vis-writing-import-backdrop" onKeyDown={event => { event.stopPropagation(); containDialogFocus(event); if (event.key === 'Escape' && !busy) { event.preventDefault(); done() } }}>
    <section ref={dialog} role="dialog" aria-modal="true" aria-label={m.split} className="vis-writing-import vis-writing-split">
      <header><h2>{m.split}</h2><button disabled={busy} onClick={done}>{m.cancel}</button></header>
      <p>{m.splitHint}</p>
      {host.series ? <p>{m.series}: {host.series.name}</p> : !request && <div className="vis-writing-split-series">
        <label>{m.series}<select aria-label={m.series} value={seriesId} disabled={loading || busy} onChange={event => {
          const id = event.target.value
          setSeriesId(id)
          const next = Math.max(0, ...(series.find(item => item.seriesId === id)?.episodes.map(episode => episode.episode) ?? [])) + 2
          setChapters(rows => rows.map((row, index) => ({ ...row, episode: next + index })))
        }}><option value="">{m.newSeries}</option>{series.map(item => <option key={item.seriesId} value={item.seriesId}>{item.name}</option>)}</select></label>
        {!seriesId && <label>{m.seriesName}<input aria-label={m.seriesName} maxLength={60} value={name} disabled={busy} onChange={event => setName(event.target.value)} /></label>}
      </div>}
      <form onSubmit={event => { event.preventDefault(); void run() }}>
        <table><thead><tr><th>{m.outline}</th><th>{m.episode}</th><th>{m.episodeName}</th><th /></tr></thead><tbody>{rows.map((chapter, index) => {
          const status = result?.chapters.find(item => item.from === chapter.from)
          return <tr key={chapter.from}><td><label><input type="checkbox" aria-label={m.chooseChapter(chapter.title)} checked={chapter.checked} disabled={busy || !!request} onChange={event => setChapters(rows => rows.map((row, i) => i === index ? { ...row, checked: event.target.checked } : row))} />{chapter.title}</label></td>
            <td><input aria-label={`${m.episode} · ${chapter.title}`} type="number" min={1} max={9999} required={chapter.checked} value={chapter.episode} disabled={!chapter.checked || busy || !!request} onChange={event => setChapters(rows => rows.map((row, i) => i === index ? { ...row, episode: Number(event.target.value) } : row))} /></td>
            <td><input aria-label={`${m.episodeName} · ${chapter.title}`} maxLength={200} required={chapter.checked} value={chapter.name} disabled={!chapter.checked || busy || !!request} onChange={event => setChapters(rows => rows.map((row, i) => i === index ? { ...row, name: event.target.value } : row))} /></td>
            <td role="status">{status ? `${status.status === 'failed' ? m.splitFailed : status.skipped ? m.splitSkipped : m.splitSuccess}${status.error ? ` · ${describeError({ code: status.error.code, message: m.splitFailed, data: { reason: status.error.reason } }, locale)}` : ''}` : ''}</td></tr>
        })}</tbody></table>
        {error ? <p role="alert">{describeError(error, locale)}</p> : null}
        <footer><span role="status">{busy ? m.splitWorking : result ? f.number(result.chapters.filter(chapter => chapter.status === 'succeeded').length) : ''}</span>
          {result?.chapters.every(chapter => chapter.status === 'succeeded') ? <button type="button" onClick={done}>{m.splitDone}</button> : <button className="is-primary" disabled={busy || loading || (!request && (!chapters.some(chapter => chapter.checked) || (!host.series && !seriesId && !name.trim())))}>{request ? m.splitRetry : m.splitConfirm}</button>}
        </footer>
      </form>
    </section>
  </div>
}
