import { createContext, useContext, useMemo, type ReactNode } from 'react'

// UI language (0018). Matches the @vis/protocol Locale structure; declared separately because ui-kit does not depend on protocol
export type Locale = 'zh-CN' | 'en'
export const LOCALES: readonly Locale[] = ['zh-CN', 'en']

/** The first Chinese or English browser-preferred language determines UI language; defaults to English if neither appears */
export function detectLocale(languages: readonly string[] = typeof navigator === 'undefined' ? [] : navigator.languages): Locale {
  for (const language of languages) {
    const lower = language.toLowerCase()
    if (lower === 'zh' || lower.startsWith('zh-')) return 'zh-CN'
    if (lower === 'en' || lower.startsWith('en-')) return 'en'
  }
  return 'en'
}

// Dictionary values are strings or functions returning strings from parameters (functions handle plurals and interpolation without template syntax)
type Message = string | ((...args: never[]) => string)
export type Messages = { readonly [key: string]: Message }
// English dictionaries must exactly match Chinese keys and function signatures; missing entries fail typecheck
export type Translation<T extends Messages> = { readonly [K in keyof T]: T[K] extends (...args: infer A) => string ? (...args: A) => string : string }
export type Dictionary<T extends Messages> = { readonly 'zh-CN': T; readonly en: Translation<T> }

/** Each UI package defines its own messages.ts to avoid conflicts during parallel edits */
export function defineMessages<T extends Messages>(zh: T, en: Translation<T>): Dictionary<T> {
  return { 'zh-CN': zh, en }
}

/** For non-React code (helpers and notification copy): pass language explicitly */
export function messagesFor<T extends Messages>(dictionary: Dictionary<T>, locale: Locale): Translation<T> {
  return dictionary[locale] as Translation<T>
}

type LocaleState = { locale: Locale; setLocale(locale: Locale | null): void }
const LocaleContext = createContext<LocaleState>({ locale: 'zh-CN', setLocale() {} })

/** The app determines locale (preference or browser); setLocale(null) restores following the browser */
export function LocaleProvider({ locale, setLocale, children }: LocaleState & { children: ReactNode }) {
  const value = useMemo(() => ({ locale, setLocale }), [locale, setLocale])
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>
}

export function useLocale(): LocaleState {
  return useContext(LocaleContext)
}

export function useMessages<T extends Messages>(dictionary: Dictionary<T>): Translation<T> {
  return messagesFor(dictionary, useLocale().locale)
}

/** Format by language; do not hand-write "3 minutes ago" or "1,234 bytes" in components */
export function formatter(locale: Locale) {
  const number = new Intl.NumberFormat(locale)
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  const units: [Intl.RelativeTimeFormatUnit, number][] = [['year', 31_536_000], ['month', 2_592_000], ['day', 86_400], ['hour', 3_600], ['minute', 60], ['second', 1]]
  return {
    number: (value: number) => number.format(value),
    // Use fixed B/KB/MB/GB units: Intl unit style produces lowercase kB and English "0 byte", inconsistent with the existing UI
    bytes(value: number) {
      const [unit, size] = value >= 1024 ** 3 ? ['GB', 1024 ** 3] as const : value >= 1024 ** 2 ? ['MB', 1024 ** 2] as const : value >= 1024 ? ['KB', 1024] as const : ['B', 1] as const
      return `${new Intl.NumberFormat(locale, { maximumFractionDigits: size === 1 ? 0 : 1 }).format(value / size)} ${unit}`
    },
    dateTime: (at: number, options: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' }) => new Intl.DateTimeFormat(locale, options).format(at),
    time: (at: number) => new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hour12: false }).format(at),
    relativeTime(at: number, now = Date.now()) {
      const seconds = Math.round((at - now) / 1000)
      const [unit, size] = units.find(([, size]) => Math.abs(seconds) >= size) ?? ['second', 1]
      return relative.format(Math.round(seconds / size), unit)
    },
  }
}

export function useFormat() {
  const { locale } = useLocale()
  return useMemo(() => formatter(locale), [locale])
}
