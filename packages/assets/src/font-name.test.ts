import { describe, expect, it } from 'vitest'
import { MAX_FONT_BYTES, readAssFontFamily, readFontFamily } from './font-name'

function font(names: { text: string; id?: number; platform?: number; language?: number }[], cff = false) {
  const strings = names.map(name => {
    if (name.platform === 1) return Buffer.from(name.text, 'latin1')
    const bytes = Buffer.from(name.text, 'utf16le')
    return bytes.swap16()
  })
  const table = Buffer.alloc(6 + names.length * 12 + strings.reduce((n, bytes) => n + bytes.length, 0))
  table.writeUInt16BE(names.length, 2)
  table.writeUInt16BE(6 + names.length * 12, 4)
  let offset = 0
  names.forEach((name, i) => {
    const record = 6 + i * 12
    table.writeUInt16BE(name.platform ?? 3, record)
    table.writeUInt16BE(name.platform === 1 ? 0 : 1, record + 2)
    table.writeUInt16BE(name.language ?? (name.platform === 1 ? 0 : 0x409), record + 4)
    table.writeUInt16BE(name.id ?? 1, record + 6)
    table.writeUInt16BE(strings[i]!.length, record + 8)
    table.writeUInt16BE(offset, record + 10)
    strings[i]!.copy(table, 6 + names.length * 12 + offset)
    offset += strings[i]!.length
  })
  const bytes = Buffer.alloc(28 + table.length)
  if (cff) bytes.write('OTTO')
  else bytes.writeUInt32BE(0x00010000)
  bytes.writeUInt16BE(1, 4)
  bytes.write('name', 12)
  bytes.writeUInt32BE(28, 20)
  bytes.writeUInt32BE(table.length, 24)
  table.copy(bytes, 28)
  return bytes
}

describe('font family reader', () => {
  it.each([false, true])('reads UTF-16BE families for CFF=%s and prefers English typographic family', cff => {
    expect(readFontFamily(font([
      { text: 'Legacy English' },
      { text: 'Localized family', id: 16, language: 0x804 },
      { text: 'Preferred Family', id: 16 },
    ], cff))).toBe('Preferred Family')
  })
  it('prefers English legacy names over localized typographic names', () => {
    expect(readFontFamily(font([{ text: 'Localized', id: 16, language: 0x804 }, { text: 'English' }]))).toBe('English')
  })
  it('preserves typographic public metadata and resolves legacy aliases only for libass', () => {
    const bytes = font([{ text: 'Smiley Sans Oblique', id: 1 }, { text: 'Smiley Sans', id: 16 }])
    expect(readFontFamily(bytes)).toBe('Smiley Sans')
    expect(readAssFontFamily(bytes)).toBe('Smiley Sans Oblique')
    expect(readAssFontFamily(font([{ text: 'Typographic only', id: 16 }]))).toBe('Typographic only')
  })
  it('reads Mac Roman including characters outside ASCII', () => {
    expect(readFontFamily(font([{ text: 'Caf\x8e', platform: 1 }]))).toBe('Café')
  })
  it('handles an offset Uint8Array view', () => {
    const bytes = font([{ text: 'Family' }])
    const padded = Buffer.concat([Buffer.alloc(9), bytes])
    expect(readFontFamily(padded.subarray(9))).toBe('Family')
  })
  it('rejects unsupported containers, truncated tables, missing families and unsafe ASS names', () => {
    const bytes = font([{ text: 'Family' }])
    const badOffset = Buffer.from(bytes)
    badOffset.writeUInt32BE(0xffffffff, 20)
    for (const invalid of [Buffer.alloc(0), Buffer.from('not a font'), bytes.subarray(0, 24), bytes.subarray(0, bytes.length - 1), badOffset, font([{ text: 'Not a family', id: 4 }]), font([{ text: 'Injected,style' }])]) {
      expect(() => readFontFamily(invalid)).toThrow(expect.objectContaining({ details: expect.objectContaining({ reason: 'asset.font_invalid' }) }))
    }
  })
  it('rejects files above the font-specific size limit before parsing', () => {
    expect(() => readFontFamily(new Uint8Array(MAX_FONT_BYTES + 1))).toThrow(expect.objectContaining({ details: expect.objectContaining({ reason: 'asset.font_too_large' }) }))
  })
})
