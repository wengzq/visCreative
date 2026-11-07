import { z } from 'zod'
import { Id, RequestId, Revision } from './common'
import { Episode, SeriesTarget } from './series'

export const WRITING_LIMITS = { uploadBytes: 10 * 1024 ** 2, expandedBytes: 20 * 1024 ** 2, characters: 2_000_000, longText: 1000, autosaveMs: 5000, maxWaitMs: 30_000 } as const

/** Creation defaults only: later text edits never change an existing card's layout. */
export function writingCardSize(body: string, manuscript = false): { w: number; h: number } {
  if (!manuscript && body.length < WRITING_LIMITS.longText) return { w: 320, h: 200 }
  const w = body.length > 5000 ? 640 : 560
  const opening = body.slice(0, 5000)
  const lines = opening.split('\n').reduce((total, line) => total + Math.max(1, Math.ceil(line.length / 48)), 0)
  return { w, h: Math.max(420, Math.min(720, 100 + lines * 24)) }
}

export const WritingChapter = z.object({ title: z.string(), level: z.int().min(1).max(6), from: z.int().nonnegative(), to: z.int().nonnegative() })
export type WritingChapter = z.infer<typeof WritingChapter>
export const WritingImportPreview = z.object({
  name: z.string(),
  encoding: z.enum(['utf-8', 'gb18030', 'docx']),
  body: z.string().max(WRITING_LIMITS.characters),
  chapters: z.array(WritingChapter),
  words: z.int().nonnegative(),
})
export type WritingImportPreview = z.infer<typeof WritingImportPreview>
export const WritingSplitChapter = z.object({ from: z.int().nonnegative(), to: z.int().positive(), name: z.string().trim().min(1).max(200), episode: Episode })
export type WritingSplitChapter = z.infer<typeof WritingSplitChapter>
export const WritingSplitResult = z.object({
  chapters: z.array(z.object({ from: z.int(), name: z.string(), episode: Episode, status: z.enum(['succeeded', 'failed']), skipped: z.boolean(), spaceId: Id.optional(), nodeId: Id.optional(), error: z.object({ code: z.string(), reason: z.string().optional() }).optional() })),
})
export type WritingSplitResult = z.infer<typeof WritingSplitResult>
export const writing = {
  split: {
    params: z.object({ requestId: RequestId, nodeId: Id, expectedRevision: Revision, series: SeriesTarget.optional(), chapters: z.array(WritingSplitChapter).min(1) })
      .refine(p => new Set(p.chapters.map(c => c.from)).size === p.chapters.length, 'Chapter ranges must be unique')
      .refine(p => new Set(p.chapters.map(c => c.episode)).size === p.chapters.length, 'Episode numbers must be unique'),
    result: WritingSplitResult,
  },
  importPreview: {
    params: z.object({ path: z.string().min(1) }),
    result: WritingImportPreview,
  },
} as const

/** Han characters count individually; other letters and numbers form words. Markdown punctuation is not a word. */
export function writingWordCount(body: string): number {
  const han = body.match(/\p{Script=Han}/gu)?.length ?? 0
  const words = body.replace(/\p{Script=Han}/gu, ' ').match(/[\p{L}\p{N}]+(?:['’_-][\p{L}\p{N}]+)*/gu)?.length ?? 0
  return han + words
}

/** Offsets use UTF-16, as CodeMirror and the text slot do. Ignore heading-like lines inside fences. */
export function writingChapters(body: string): WritingChapter[] {
  const chapters: WritingChapter[] = []
  let from = 0
  let fence = ''
  let previous: { text: string; from: number } | null = null
  for (const line of body.split('\n')) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (marker) {
      previous = null
      if (!fence) fence = marker
      else if (marker[0] === fence[0] && marker.length >= fence.length && /^ {0,3}(?:`+|~+)\s*$/.test(line)) fence = ''
    } else if (!fence) {
      const heading = /^ {0,3}(#{1,6})[\t ]+(.+?)\s*$/.exec(line)
      const setext = /^ {0,3}(=+|-+)\s*$/.exec(line)
      if (heading) chapters.push({ title: heading[2]!.replace(/[\t ]+#+[\t ]*$/, ''), level: heading[1]!.length, from, to: body.length })
      else if (setext && previous) chapters.push({ title: previous.text.trim(), level: setext[1]![0] === '=' ? 1 : 2, from: previous.from, to: body.length })
      previous = !heading && !setext && line.trim() && !/^ {4}|^\t/.test(line) ? { text: line, from } : null
    }
    from += line.length + 1
  }
  const parents: WritingChapter[] = []
  for (const chapter of chapters) {
    while (parents.length && parents.at(-1)!.level >= chapter.level) parents.pop()!.to = chapter.from
    parents.push(chapter)
  }
  return chapters
}


export const TextEdit = z.object({
  find: z.string().min(1).max(WRITING_LIMITS.characters),
  before: z.string().max(WRITING_LIMITS.characters).optional(),
  after: z.string().max(WRITING_LIMITS.characters).optional(),
  replace: z.string().max(WRITING_LIMITS.characters),
})
export type TextEdit = z.infer<typeof TextEdit>
export const TextProposalEdit = TextEdit.extend({ editId: Id, status: z.enum(['pending', 'accepted', 'rejected', 'stale']) })
export type TextProposalEdit = z.infer<typeof TextProposalEdit>
export const TextProposal = z.object({
  proposalId: Id, slotId: Id, nodeId: Id, baseRevision: Revision, sessionId: Id,
  summary: z.string().max(2000), edits: z.array(TextProposalEdit).min(1).max(100),
  status: z.enum(['open', 'resolved']), createdAt: z.int(),
})
export type TextProposal = z.infer<typeof TextProposal>
export const TextEditRef = z.object({ proposalId: Id, editId: Id })
export type TextEditRef = z.infer<typeof TextEditRef>
const EditRefs = z.array(TextEditRef).min(1).max(1000).refine(refs => new Set(refs.map(ref => `${ref.proposalId}/${ref.editId}`)).size === refs.length, 'Edit references must be unique')
export const text = {
  requestDelete: {
    params: z.object({ requestId: RequestId, nodeId: Id, expectedRevision: Revision }),
    result: z.object({ approvalId: Id, status: z.enum(['pending', 'approved', 'denied', 'expired']) }),
  },
  propose: {
    params: z.object({ requestId: RequestId, slotId: Id, baseRevision: Revision, summary: z.string().trim().min(1).max(2000), edits: z.array(TextEdit).min(1).max(100) }),
    result: TextProposal,
  },
  proposalList: {
    params: z.object({ slotId: Id.optional(), status: z.enum(['open', 'resolved', 'all']).default('open') }),
    result: z.object({ proposals: z.array(TextProposal) }),
  },
  proposalResolve: {
    params: z.discriminatedUnion('action', [
      z.object({ requestId: RequestId, slotId: Id, action: z.literal('accept'), edits: EditRefs, expectedRevision: Revision, body: z.string().max(WRITING_LIMITS.characters) }),
      z.object({ requestId: RequestId, slotId: Id, action: z.literal('reject'), edits: EditRefs }),
    ]),
    result: z.object({ proposals: z.array(TextProposal), revision: Revision.optional() }),
  },
} as const

export const SeriesTextNode = z.object({ nodeId: Id, slotId: Id, title: z.string().nullable(), revision: Revision, words: z.int().nonnegative() })
export const seriesText = {
  list: {
    params: z.object({}),
    result: z.object({ episodes: z.array(z.object({ spaceId: Id, name: z.string(), episode: z.int().positive(), nodes: z.array(SeriesTextNode) })) }),
  },
  read: {
    params: z.object({ spaceId: Id, nodeId: Id }),
    result: SeriesTextNode.extend({ body: z.string(), format: z.enum(['plain', 'markdown']) }),
  },
} as const

/** Match quoted text with optional adjacent context, counting overlapping occurrences too. */
export function textEditAnchor(body: string, edit: Pick<TextEdit, 'find' | 'before' | 'after'> & { replace?: string }): { from: number; to: number } | null {
  if (!edit.find) return null
  let match: { from: number; to: number } | null = null
  for (let from = body.indexOf(edit.find); from !== -1; from = body.indexOf(edit.find, from + 1)) {
    const to = from + edit.find.length
    if (edit.before !== undefined && !body.slice(0, from).endsWith(edit.before)) continue
    if (edit.after !== undefined && !body.slice(to).startsWith(edit.after)) continue
    if (match) return null
    match = { from, to }
  }
  return match
}

/** Fail closed for ambiguous or overlapping edits, applying a valid batch from the end. */
export function applyTextEdits(body: string, edits: readonly TextEdit[]): string | null {
  const ranges = edits.map(edit => ({ edit, range: textEditAnchor(body, edit) }))
  if (ranges.some(item => !item.range)) return null
  ranges.sort((a, b) => a.range!.from - b.range!.from)
  if (ranges.some((item, index) => index > 0 && ranges[index - 1]!.range!.to > item.range!.from)) return null
  for (const { edit, range } of ranges.reverse()) body = body.slice(0, range!.from) + edit.replace + body.slice(range!.to)
  return body
}
