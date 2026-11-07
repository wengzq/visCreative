import { messagesFor, type Locale } from '@vis/ui-kit'
import { attachmentMessages } from './messages'
import type { AssetVersionView } from '@vis/protocol'

export type AttachmentDraft = { id: string; name: string } & (
  | { status: 'pending' }
  | { status: 'ready'; asset: AssetVersionView }
  | { status: 'error'; error: unknown; validationFile?: Pick<File, 'name' | 'type' | 'size'> }
)

export type AttachmentDrafts = Record<string, AttachmentDraft[]>

// Match asset.import extensions and the web host upload limit; the backend still validates content.
export const ATTACHMENT_ACCEPT = '.svg,.png,.jpg,.jpeg,.webp,.gif,.mp4,.m4v,.mov,.webm,.mkv,.mp3,.wav,.m4a,.aac,.ogg,.flac'
export const MAX_ATTACHMENT_BYTES = 2 * 1024 ** 3

export function attachmentError(file: Pick<File, 'name' | 'type' | 'size'>, locale: Locale = 'zh-CN'): string | null {
  const m = messagesFor(attachmentMessages, locale)
  const extension = /\.[^.]+$/.exec(file.name)?.[0].toLowerCase()
  if (!extension || !ATTACHMENT_ACCEPT.split(',').includes(extension)) return m.unsupportedFile
  if (file.type && !/^(image|video|audio)\//i.test(file.type) && !['application/octet-stream', 'application/ogg'].includes(file.type.toLowerCase())) return m.unsupportedFile
  if (file.size > MAX_ATTACHMENT_BYTES) return m.fileTooLarge
  return null
}

export function updateAttachment(drafts: AttachmentDrafts, sessionId: string, attachment: AttachmentDraft): AttachmentDrafts {
  const current = drafts[sessionId]
  // Late import results must not restore removed or sent attachments.
  if (!current?.some(item => item.id === attachment.id)) return drafts
  return { ...drafts, [sessionId]: current.map(item => item.id === attachment.id ? attachment : item) }
}

export function removeAttachments(drafts: AttachmentDrafts, sessionId: string, ids: readonly string[]): AttachmentDrafts {
  const current = drafts[sessionId]
  if (!current?.some(item => ids.includes(item.id))) return drafts
  return { ...drafts, [sessionId]: current.filter(item => !ids.includes(item.id)) }
}

export function attachmentRefs(attachments: readonly AttachmentDraft[]): { assetVersionId: string }[] {
  return [...new Set(attachments.flatMap(item => item.status === 'ready' ? [item.asset.assetVersionId] : []))].map(assetVersionId => ({ assetVersionId }))
}
