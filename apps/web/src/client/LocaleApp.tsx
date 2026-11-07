import { useCallback, useEffect, useRef, useState } from 'react'
import { detectLocale, describeError, LocaleProvider, messagesFor, type Locale } from '@vis/ui-kit'
import { App } from './App'
import { messages, shellMessages } from './messages'
import { openSpace, useSpaceView } from './space'
import { RpcError } from './rpc'

export function initialLocale(): Locale {
  try {
    const saved = localStorage.getItem('vis.locale')
    if (saved === 'zh-CN' || saved === 'en') return saved
  } catch { /* Follow the browser when preference storage is unavailable */ }
  return detectLocale()
}

export function LocaleApp({ token }: { token: string | null }) {
  const [locale, setEffectiveLocale] = useState(initialLocale)
  const localeRef = useRef(locale)
  localeRef.current = locale
  const [conn] = useState(() => token ? openSpace(token, () => localeRef.current) : null)
  const setLocale = useCallback((next: Locale | null) => setEffectiveLocale(next ?? detectLocale()), [])
  useEffect(() => {
    document.documentElement.lang = locale
    document.title = messagesFor(messages, locale).appTitle
    try { localStorage.setItem('vis.locale', locale) } catch { /* Preferences are still saved by the backend */ }
  }, [locale])
  return <LocaleProvider locale={locale} setLocale={setLocale}>
    {conn ? <ConnectedApp conn={conn} locale={locale} setLocale={setLocale} /> : <div className="app-loading">{messagesFor(shellMessages, locale).missingToken}</div>}
  </LocaleProvider>
}

function ConnectedApp({ conn, locale, setLocale }: { conn: ReturnType<typeof openSpace>; locale: Locale; setLocale(locale: Locale | null): void }) {
  const { status } = useSpaceView(conn)
  const [preference, setPreference] = useState<Locale | null>(null)
  const [error, setError] = useState<unknown>(null)
  const revision = useRef(0)
  useEffect(() => {
    if (status !== 'open') return
    let current = true
    const read = revision.current
    void conn.rpc.call<{ locale: Locale | null }>('preferences.get', {}).then(result => {
      if (!current || revision.current !== read) return
      setPreference(result.locale)
      setLocale(result.locale)
      setError(null)
    }, error => {
      if (!current || revision.current !== read) return
      if (error instanceof RpcError && error.code === 'unavailable') {
        setPreference(null)
        setLocale(null)
        setError(null)
      } else setError(error)
    })
    return () => { current = false }
  }, [conn, status, setLocale])
  const saveLocale = async (next: Locale | null) => {
    revision.current++
    const result = await conn.rpc.call<{ locale: Locale | null }>('preferences.set', { locale: next })
    setPreference(result.locale)
    setLocale(result.locale)
    setError(null)
  }
  return <>
    {error ? <div role="alert">{describeError(error, locale)}</div> : null}
    <App conn={conn} localePreference={preference} onLocaleChange={saveLocale} />
  </>
}
