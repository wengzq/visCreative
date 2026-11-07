import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { WRITING_LIMITS } from '@vis/protocol'
import { detectChapterMarkers, extractDocxXml, parseWritingFile, previewWritingFile } from './writing'
import { writingDocx, writingStyles, writingXml, writingZip } from './fixtures/writing'

it('detects UTF-8, GB18030, BOM and chapter markers without changing fenced code', () => {
  expect(parseWritingFile('book.txt', Buffer.from([0xb5, 0xda, 0xd2, 0xbb, 0xd5, 0xc2]))).toMatchObject({ encoding: 'gb18030', body: '# 第一章', chapters: [{ title: '第一章' }] })
  expect(parseWritingFile('book.md', Buffer.from('\uFEFF# Chapter\r\nHello'))).toMatchObject({ encoding: 'utf-8', body: '# Chapter\nHello', words: 2 })
  expect(detectChapterMarkers('第一章 清晨\nText\n```\n第二章\n```\n第三章：归来')).toBe('# 第一章 清晨\nText\n```\n第二章\n```\n# 第三章：归来')
})
it('extracts docx paragraphs, headings, split runs, entities, tabs and line breaks', () => {
  const xml = writingXml('<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>第一章 清晨</w:t></w:r></w:p><w:p><w:r><w:t>Hello &amp; </w:t></w:r><w:r><w:t>world&#x21;</w:t><w:tab/><w:t>Again</w:t><w:br/><w:t>Next</w:t></w:r></w:p>')
  expect(parseWritingFile('book.docx', writingDocx(xml))).toMatchObject({ encoding: 'docx', body: '# 第一章 清晨\n\nHello & world!\tAgain\nNext', chapters: [{ level: 1, title: '第一章 清晨' }] })
  expect(extractDocxXml(writingXml('<w:p><w:pPr><w:outlineLvl w:val="2"/></w:pPr><w:r><w:t>Deep</w:t></w:r></w:p>'))).toBe('### Deep')
})
it.each([
  ['book.pdf', Buffer.from('pdf')], ['book.md', Buffer.from([0xff])], ['book.txt', Buffer.from([0x81])],
  ['book.txt', Buffer.from('a\0b')], ['book.txt', Buffer.alloc(WRITING_LIMITS.uploadBytes + 1)],
  ['book.txt', Buffer.from('a'.repeat(WRITING_LIMITS.characters + 1))],
  ['book.docx', Buffer.from('not zip')], ['book.docx', writingZip([{ path: '../word/document.xml', body: 'x' }])],
  ['book.docx', writingZip([{ path: 'other.xml', body: 'x' }])],
  ['book.docx', writingDocx('<!DOCTYPE x [<!ENTITY x SYSTEM "file:///etc/passwd">]><x>&x;</x>')],
  ['book.docx', writingDocx(writingXml('<w:p><w:r><w:t>&unknown;</w:t></w:r></w:p>'))],
  ['book.docx', writingDocx(writingXml('<w:p><w:r><w:t>x</w:p>'))],
])('rejects malformed, unsupported or oversized input %s', (name, bytes) => {
  expect(() => parseWritingFile(name, bytes)).toThrow()
})
it('enforces expanded ZIP limits independently of upload size and validates CRC', () => {
  const oversized = writingDocx('x')
  const central = oversized.readUInt32LE(oversized.length - 6)
  oversized.writeUInt32LE(WRITING_LIMITS.expandedBytes + 1, central + 24)
  expect(() => parseWritingFile('book.docx', oversized)).toThrow('Declared decompressed size')
  const corrupt = writingDocx(writingXml('<w:p/>'))
  corrupt[48] = corrupt[48]! ^ 1
  expect(() => parseWritingFile('book.docx', corrupt)).toThrow()
})
it('reads regular files with a bounded daemon read', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vis-writing-'))
  try {
    const file = join(dir, 'book.txt')
    await writeFile(file, '第一章 清晨\n正文')
    expect((await previewWritingFile(file)).body).toBe('# 第一章 清晨\n正文')
    await expect(previewWritingFile(dir)).rejects.toThrow()
  } finally { await rm(dir, { recursive: true, force: true }) }
})
it('ignores XML comments and keeps CDATA text without expanding it', () => {
  expect(extractDocxXml(writingXml('<!-- &ignored; --><w:p><w:r><w:t><![CDATA[A & B < C]]></w:t></w:r></w:p>'))).toBe('A & B < C')
})

it('resolves numeric Chinese Word style ids by English or Chinese heading names', () => {
  const document = writingXml('<w:p><w:pPr><w:pStyle w:val="1"/></w:pPr><w:r><w:t>Morning</w:t></w:r></w:p><w:p><w:pPr><w:pStyle w:val="2"/></w:pPr><w:r><w:t>Letters</w:t></w:r></w:p>')
  const styles = writingStyles('<w:style w:type="paragraph" w:styleId="1"><w:name w:val="heading 1"/></w:style><w:style w:type="paragraph" w:styleId="2"><w:name w:val="标题 2"/></w:style>')
  expect(parseWritingFile('book.docx', writingZip([{ path: 'word/document.xml', body: document }, { path: 'word/styles.xml', body: styles }])).body).toBe('# Morning\n\n## Letters')
})
it('follows basedOn to inherited outline levels while direct paragraph outline levels take precedence', () => {
  const document = writingXml('<w:p><w:pPr><w:pStyle w:val="custom"/></w:pPr><w:r><w:t>Inherited</w:t></w:r></w:p><w:p><w:pPr><w:outlineLvl w:val="9"/><w:pStyle w:val="custom"/></w:pPr><w:r><w:t>Body</w:t></w:r></w:p>')
  const styles = writingStyles('<w:style w:styleId="custom"><w:basedOn w:val="base"/></w:style><w:style w:styleId="base"><w:pPr><w:outlineLvl w:val="2"/></w:pPr></w:style>')
  expect(parseWritingFile('book.docx', writingZip([{ path: 'word/document.xml', body: document }, { path: 'word/styles.xml', body: styles }])).body).toBe('### Inherited\n\nBody')
})
it('bounds basedOn cycles and inheritance depth without losing paragraph text', () => {
  const document = writingXml('<w:p><w:pPr><w:pStyle w:val="a"/></w:pPr><w:r><w:t>Cycle</w:t></w:r></w:p>')
  const cycle = writingStyles('<w:style w:styleId="a"><w:basedOn w:val="b"/></w:style><w:style w:styleId="b"><w:basedOn w:val="a"/></w:style>')
  expect(parseWritingFile('book.docx', writingZip([{ path: 'word/document.xml', body: document }, { path: 'word/styles.xml', body: cycle }])).body).toBe('Cycle')
  const chain = writingStyles(Array.from({ length: 40 }, (_, index) => `<w:style w:styleId="${index === 0 ? 'a' : index}"><w:basedOn w:val="${index + 1}"/>${index === 39 ? '<w:name w:val="Heading1"/>' : ''}</w:style>`).join(''))
  expect(parseWritingFile('book.docx', writingZip([{ path: 'word/document.xml', body: document }, { path: 'word/styles.xml', body: chain }])).body).toBe('Cycle')
})
it.each([undefined, '<w:styles>', '<!DOCTYPE x SYSTEM "https://example.invalid"><x/>'])('falls back to document.xml for absent or malformed styles metadata', styles => {
  const document = writingXml('<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Start</w:t></w:r></w:p>')
  expect(parseWritingFile('book.docx', writingZip([{ path: 'word/document.xml', body: document }, ...(styles === undefined ? [] : [{ path: 'word/styles.xml', body: styles }])])).body).toBe('# Start')
})
