import type { SlotContent, SlotVersionView } from '@vis/protocol'
import { formatter, messagesFor, type Locale } from '@vis/ui-kit'
import { mediaMessages } from './messages'

/** Restoring the same asset adds no version; numbering uses its earliest occurrence */
export function assetVersions(history: readonly SlotVersionView[]): SlotVersionView[] {
  const seen = new Set<string>()
  return [...history].sort((a, b) => a.revision - b.revision).filter(version => {
    if (version.content.type !== 'asset' || seen.has(version.content.assetVersionId)) return false
    seen.add(version.content.assetVersionId)
    return true
  })
}

export function versionIndex(versions: readonly SlotVersionView[], content: SlotContent): number {
  return content.type === 'asset'
    ? versions.findIndex(v => v.content.type === 'asset' && v.content.assetVersionId === content.assetVersionId)
    : -1
}

export function versionDescription(version: SlotVersionView, index: number, now = Date.now(), locale: Locale = 'zh-CN'): string {
  const m = messagesFor(mediaMessages, locale)
  const format = formatter(locale)
  const minutes = Math.max(0, Math.floor((now - version.createdAt) / 60000))
  const ago = locale === 'en' ? format.relativeTime(Math.min(version.createdAt, now), now) : minutes < 1 ? m.justNow : minutes < 60 ? m.minutesAgo(format.number(minutes)) : minutes < 1440 ? m.hoursAgo(format.number(Math.floor(minutes / 60))) : m.daysAgo(format.number(Math.floor(minutes / 1440)))
  const source = version.source
  return `v${index + 1} · ${ago} · ${source ? `${source.model} / ${source.provider}` : m.manualReplaceUpload}${source?.prompt ? `\n${source.prompt.slice(0, 60)}` : ''}`
}
