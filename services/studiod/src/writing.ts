import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { extname, basename } from 'node:path'
import { isUtf8 } from 'node:buffer'
import { VisError } from '@vis/domain'
import { WRITING_LIMITS, writingChapters, writingWordCount, type WritingImportPreview } from '@vis/protocol'
import { readZip } from './zip'

function invalid(message: string): never {
  throw VisError.of('invalid_params', 'writing.invalid_document', {}, message)
}

function entities(text: string): string {
  if (/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[\da-f]+;)/i.test(text)) invalid('Invalid XML entity')
  return text.replace(/&([^;]*);/g, (_, entity: string) => {
    const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
    if (named[entity]) return named[entity]!
    const value = /^#x[\da-f]+$/i.test(entity) ? parseInt(entity.slice(2), 16) : /^#\d+$/.test(entity) ? Number(entity.slice(1)) : NaN
    if (!Number.isInteger(value) || value < 32 && ![9, 10, 13].includes(value) || value > 0x10ffff || value >= 0xd800 && value <= 0xdfff) invalid('Invalid XML entity')
    return String.fromCodePoint(value)
  })
}

type WordXmlVisitor = {
  open?(name: string, attributes: Record<string, string>): void
  close?(name: string): void
  text?(value: string, parent: string): void
}

/** A bounded XML tokenizer, with no DTD, entity expansion, network or filesystem resolution. */
function walkWordXml(xml: string, root: string, visitor: WordXmlVisitor) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) invalid('Unsupported XML declaration or entity')
  const stack: Array<{ name: string; local: string; word: boolean; ns: Record<string, string> }> = []
  let rootSeen = false
  let position = 0
  const tokens = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?xml[^?]*\?>|<[^>]*>|[^<]+/g
  for (const token of xml.matchAll(tokens)) {
    if (token.index !== position) invalid('Malformed document XML')
    const value = token[0]
    position += value.length
    if (value.startsWith('<!--')) continue
    if (value.startsWith('<![CDATA[')) {
      if (stack.at(-1)?.word) visitor.text?.(value.slice(9, -3), stack.at(-1)!.local)
      continue
    }
    if (value.startsWith('<?xml')) { if (rootSeen) invalid('Misplaced XML declaration'); continue }
    if (!value.startsWith('<')) {
      if (!stack.length && value.trim()) invalid('Text outside XML root')
      const text = entities(value)
      if (stack.at(-1)?.word) visitor.text?.(text, stack.at(-1)!.local)
      continue
    }
    const closing = /^<\/([\w:.-]+)\s*>$/.exec(value)
    if (closing) {
      const item = stack.pop()
      if (!item || item.name !== closing[1]) invalid('Unbalanced document XML')
      if (item.word) visitor.close?.(item.local)
      continue
    }
    const tag = /^<([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*\s*)(\/?)>$/.exec(value)
    if (!tag || stack.length >= 128) invalid('Malformed or deeply nested document XML')
    if (!stack.length) { if (rootSeen) invalid('Multiple XML roots'); rootSeen = true }
    const attributes: Record<string, string> = Object.create(null)
    for (const attr of tag[2]!.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      if (attributes[attr[1]!] !== undefined) invalid('Duplicate XML attribute')
      attributes[attr[1]!] = entities(attr[2] ?? attr[3] ?? '')
    }
    const ns = { ...stack.at(-1)?.ns }
    for (const [key, val] of Object.entries(attributes)) if (key === 'xmlns' || key.startsWith('xmlns:')) ns[key === 'xmlns' ? '' : key.slice(6)] = val
    const name = tag[1]!
    const pieces = name.split(':')
    const local = pieces.at(-1)!
    const uri = ns[pieces.length > 1 ? pieces[0]! : '']
    const word = uri === 'http://schemas.openxmlformats.org/wordprocessingml/2006/main' || uri === 'http://purl.oclc.org/ooxml/wordprocessingml/main'
    if (!stack.length && (!word || local !== root)) invalid(`Expected a Word ${root} root`)
    if (word) visitor.open?.(local, Object.fromEntries(Object.entries(attributes).filter(([key]) => !key.startsWith('xmlns')).map(([key, val]) => [key.split(':').at(-1)!, val])))
    if (!tag[3]) stack.push({ name, local, word, ns })
    else if (word) visitor.close?.(local)
  }
  if (!rootSeen || position !== xml.length || stack.length) invalid('Incomplete document XML')
}

const headingLevel = (name: string) => Math.min(6, Number(/^(?:heading|标题)\s*([1-9])$/i.exec(name)?.[1] ?? 0))
const outlineLevel = (value: string): number | undefined => /^[0-9]$/.test(value) ? Number(value) === 9 ? 0 : Math.min(6, Number(value) + 1) : undefined

export function extractDocxStyles(xml: string): Map<string, number> {
  type Style = { id: string; type: string; name: string; outline: number | undefined; basedOn: string }
  const styles = new Map<string, Style>()
  let current: Style | null = null
  walkWordXml(xml, 'styles', {
    open(name, attributes) {
      if (name === 'style') {
        if (current) invalid('Nested document style')
        current = { id: attributes.styleId ?? '', type: attributes.type ?? 'paragraph', name: '', outline: undefined, basedOn: '' }
      } else if (current) {
        if (name === 'name') current.name = attributes.val ?? ''
        if (name === 'outlineLvl') current.outline = outlineLevel(attributes.val ?? '')
        if (name === 'basedOn') current.basedOn = attributes.val ?? ''
      }
    },
    close(name) {
      if (name !== 'style') return
      if (!current) invalid('Malformed document style')
      if (current.id && current.type === 'paragraph') {
        if (styles.has(current.id)) invalid('Duplicate document style')
        styles.set(current.id, current)
      }
      current = null
    },
  })
  const resolve = (id: string, seen = new Set<string>(), depth = 0): number => {
    if (seen.has(id) || depth >= 32) return 0
    const style = styles.get(id)
    if (!style) return headingLevel(id)
    if (style.outline !== undefined) return style.outline
    const named = headingLevel(style.name)
    if (named) return named
    seen.add(id)
    return style.basedOn ? resolve(style.basedOn, seen, depth + 1) : headingLevel(id)
  }
  return new Map([...styles.keys()].map(id => [id, resolve(id)]))
}

export function extractDocxXml(xml: string, styles = new Map<string, number>()): string {
  const paragraphs: string[] = []
  let paragraph: { text: string; level: number; explicitOutline: boolean } | null = null
  walkWordXml(xml, 'document', {
    open(name, attributes) {
      if (name === 'p') { if (paragraph) invalid('Nested paragraph'); paragraph = { text: '', level: 0, explicitOutline: false } }
      if (!paragraph) return
      const val = attributes.val ?? ''
      if (name === 'pStyle' && !paragraph.explicitOutline) paragraph.level = styles.get(val) ?? headingLevel(val)
      if (name === 'outlineLvl') {
        const level = outlineLevel(val)
        if (level !== undefined) { paragraph.level = level; paragraph.explicitOutline = true }
      }
      if (name === 'tab') paragraph.text += '\t'
      if (name === 'br' || name === 'cr') paragraph.text += '\n'
    },
    text(value, parent) { if (paragraph && parent === 't') paragraph.text += value },
    close(name) {
      if (name !== 'p') return
      if (!paragraph) invalid('Malformed paragraph')
      paragraphs.push(`${paragraph.level ? '#'.repeat(paragraph.level) + ' ' : ''}${paragraph.text}`)
      paragraph = null
    },
  })
  if (paragraph) invalid('Incomplete paragraph')
  return paragraphs.join('\n\n')
}

export function detectChapterMarkers(body: string): string {
  let fence = ''
  return body.split('\n').map(line => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (marker) {
      if (!fence) fence = marker
      else if (marker[0] === fence[0] && marker.length >= fence.length && /^ {0,3}(?:`+|~+)\s*$/.test(line)) fence = ''
    }
    // Standalone chapter labels, not sentences mentioning a chapter.
    return !fence && /^\s*第[零〇一二三四五六七八九十百千万两\d]+[章节卷部回](?:[\s：:、　].{0,80})?\s*$/.test(line) ? `# ${line.trim()}` : line
  }).join('\n')
}

export function parseWritingFile(name: string, bytes: Buffer): WritingImportPreview {
  if (bytes.length > WRITING_LIMITS.uploadBytes) invalid('Document exceeds the 10 MiB upload limit')
  const extension = extname(name).toLowerCase()
  let body: string
  let encoding: WritingImportPreview['encoding'] = 'utf-8'
  if (extension === '.docx') {
    const files = (() => {
      try { return readZip(bytes, { maxBytes: WRITING_LIMITS.expandedBytes, maxFiles: 2000, reasonPrefix: 'writing.zip' }) }
      catch (error) { throw VisError.of('invalid_params', 'writing.invalid_archive', {}, error instanceof Error ? error.message : 'Invalid document archive') }
    })()
    const document = files.find(file => file.path === 'word/document.xml')
    if (!document || !isUtf8(document.data)) invalid('Missing UTF-8 word/document.xml')
    const styleFile = files.find(file => file.path === 'word/styles.xml')
    let styles = new Map<string, number>()
    if (styleFile && isUtf8(styleFile.data)) {
      // Styles are optional metadata; damaged style definitions must not prevent recovering the manuscript.
      try { styles = extractDocxStyles(styleFile.data.toString('utf8')) } catch {}
    }
    body = extractDocxXml(document.data.toString('utf8'), styles)
    encoding = 'docx'
  } else if (extension === '.txt' || extension === '.md') {
    try {
      if (extension === '.txt' && !isUtf8(bytes)) { encoding = 'gb18030'; body = new TextDecoder('gb18030', { fatal: true }).decode(bytes) }
      else body = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch { invalid('Unsupported or malformed text encoding') }
  } else invalid('Only .txt, .md and .docx documents are supported')
  if (body.includes('\0') || body.length > WRITING_LIMITS.characters) invalid('Document is binary or exceeds the character limit')
  body = detectChapterMarkers(body.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n'))
  if (body.length > WRITING_LIMITS.characters) invalid('Document exceeds the character limit')
  return { name: basename(name), encoding, body, chapters: writingChapters(body), words: writingWordCount(body) }
}

export async function previewWritingFile(path: string): Promise<WritingImportPreview> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > WRITING_LIMITS.uploadBytes) invalid('Document must be a regular file of at most 10 MiB')
    // Bound the read even if a local file grows after stat.
    const bytes = Buffer.alloc(Math.min(stat.size + 1, WRITING_LIMITS.uploadBytes + 1))
    let length = 0
    while (length < bytes.length) {
      const read = await file.read(bytes, length, bytes.length - length)
      if (!read.bytesRead) break
      length += read.bytesRead
    }
    if (length > stat.size) invalid('Document changed while reading')
    return parseWritingFile(path, bytes.subarray(0, length))
  } finally { await file.close() }
}
