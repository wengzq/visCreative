import type { AssetVersionView } from '@vis/protocol'
import { describe, expect, it } from 'vitest'
import { attachmentError, attachmentRefs, MAX_ATTACHMENT_BYTES, removeAttachments, updateAttachment, type AttachmentDraft, type AttachmentDrafts } from './attachmentState'

const asset: AssetVersionView = { assetVersionId: 'asset', assetId: 'source', version: 1, kind: 'image', mime: 'image/png', url: 'file:///image.png' }
const pending: AttachmentDraft = { id: 'first', name: 'image.png', status: 'pending' }
const ready: AttachmentDraft = { ...pending, status: 'ready', asset }

describe('Session attachments', () => {
  it('Validation copy follows the language while Chinese remains unchanged', () => {
    const file = { name: 'page.html', type: 'text/html', size: 1 }
    expect(attachmentError(file, 'zh-CN')).toBe('不支持的文件类型，请选择图片、视频或音频')
    expect(attachmentError(file, 'en')).toBe('Unsupported file type. Choose an image, video, or audio file')
    expect(attachmentError({ name: 'image.png', type: 'image/png', size: MAX_ATTACHMENT_BYTES + 1 }, 'en')).toBe('File too large. Each attachment must be 2 GiB or smaller')
  })

  it('Retain media extensions and the 2 GiB boundary, supporting files for which the browser supplies no MIME type', () => {
    for (const [name, type] of [['image.SVG', 'image/svg+xml'], ['clip.mkv', 'video/x-matroska'], ['music.flac', 'audio/flac'], ['music.ogg', 'application/ogg'], ['image.png', '']]) {
      expect(attachmentError({ name: name!, type: type!, size: MAX_ATTACHMENT_BYTES })).toBeNull()
    }
    expect(attachmentError({ name: 'image.png', type: 'image/png', size: MAX_ATTACHMENT_BYTES + 1 })).toContain('2 GiB')
    expect(attachmentError({ name: 'page.html', type: 'text/html', size: 1 })).toContain('不支持')
    expect(attachmentError({ name: 'image.png', type: 'text/html', size: 1 })).toContain('不支持')
    expect(attachmentError({ name: 'image.heic', type: 'image/heic', size: 1 })).toContain('不支持')
  })

  it('Asynchronous import updates only the original session; failures retain a removable error', () => {
    const drafts: AttachmentDrafts = { original: [pending], other: [{ ...pending, id: 'other' }] }
    const imported = updateAttachment(drafts, 'original', ready)
    expect(imported.original).toEqual([ready])
    expect(imported.other).toBe(drafts.other)
    const failed = { ...pending, status: 'error' as const, error: '上传中断' }
    expect(updateAttachment(drafts, 'original', failed).original).toEqual([failed])
  })

  it('Removal and send cleanup affect only captured attachments; late results do not restore them', () => {
    const later = { ...pending, id: 'later' }
    const drafts: AttachmentDrafts = { session: [pending, later] }
    const removed = removeAttachments(drafts, 'session', [pending.id])
    expect(removed.session).toEqual([later])
    expect(updateAttachment(removed, 'session', ready)).toBe(removed)
  })

  it('Send only completed asset references, deduplicating identical content without including local state', () => {
    expect(attachmentRefs([pending, ready, { ...ready, id: 'duplicate' }, { ...pending, id: 'error', status: 'error', error: '失败' }])).toEqual([{ assetVersionId: 'asset' }])
  })
})
