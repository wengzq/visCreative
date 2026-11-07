import { deflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { extractFontZip } from '../../../scripts/font-zip.mjs'

function archive(entries: { name: string; text: string; method?: number }[]) {
  const local: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name)
    const plain = Buffer.from(entry.text)
    const method = entry.method ?? 8
    const content = method === 8 ? deflateRawSync(plain) : plain
    const header = Buffer.alloc(30 + name.length)
    header.writeUInt32LE(0x04034b50)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(method, 8)
    header.writeUInt32LE(content.length, 18)
    header.writeUInt32LE(plain.length, 22)
    header.writeUInt16LE(name.length, 26)
    name.copy(header, 30)
    const directory = Buffer.alloc(46 + name.length)
    directory.writeUInt32LE(0x02014b50)
    directory.writeUInt16LE(20, 6)
    directory.writeUInt16LE(method, 10)
    directory.writeUInt32LE(content.length, 20)
    directory.writeUInt32LE(plain.length, 24)
    directory.writeUInt16LE(name.length, 28)
    directory.writeUInt32LE(offset, 42)
    name.copy(directory, 46)
    local.push(header, content)
    central.push(directory)
    offset += header.length + content.length
  }
  const size = central.reduce((n, entry) => n + entry.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(size, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, ...central, end])
}

describe('pinned font ZIP extraction', () => {
  it.each([0, 8])('reads exactly one entry with compression method %s', method => {
    const zip = archive([{ name: '../ignored-file', text: 'Never written' }, { name: 'font.ttf', text: 'Font bytes', method }])
    expect(extractFontZip(zip, 'font.ttf').toString()).toBe('Font bytes')
  })
  it('rejects missing, duplicate, truncated and oversized requested entries', () => {
    const zip = archive([{ name: 'font.ttf', text: 'Font bytes' }])
    expect(() => extractFontZip(zip, 'absent.ttf')).toThrow('was not found')
    expect(() => extractFontZip(archive([{ name: 'font.ttf', text: 'First' }, { name: 'font.ttf', text: 'Second' }]), 'font.ttf')).toThrow('duplicate')
    expect(() => extractFontZip(zip.subarray(0, zip.length - 1), 'font.ttf')).toThrow('central directory')
    expect(() => extractFontZip(zip, 'font.ttf', 4)).toThrow('size limit')
    expect(() => extractFontZip(Buffer.alloc(0), 'font.ttf')).toThrow('central directory')
  })
  it.each(['encrypted', 'zip64', 'multi-disk', 'unsupported-method', 'offset', 'size'] as const)('rejects %s archives', kind => {
    const zip = archive([{ name: 'font.ttf', text: 'Font bytes' }])
    const end = zip.length - 22
    const central = zip.readUInt32LE(end + 16)
    if (kind === 'encrypted') zip.writeUInt16LE(1, central + 8)
    if (kind === 'zip64') zip.writeUInt32LE(0xffffffff, central + 24)
    if (kind === 'multi-disk') zip.writeUInt16LE(1, end + 4)
    if (kind === 'unsupported-method') zip.writeUInt16LE(99, central + 10)
    if (kind === 'offset') zip.writeUInt32LE(0xfffffff0, central + 42)
    if (kind === 'size') zip.writeUInt32LE(1, central + 24)
    expect(() => extractFontZip(zip, 'font.ttf')).toThrow()
  })
  it('caps inflated output even when the central directory lies about the size', () => {
    const zip = archive([{ name: 'font.ttf', text: 'a'.repeat(100_000) }])
    const central = zip.readUInt32LE(zip.length - 6)
    zip.writeUInt32LE(1, central + 24)
    expect(() => extractFontZip(zip, 'font.ttf', 1000)).toThrow()
  })
  it.each([4, 18, 22])('rejects ZIP64 indicators in the local header at offset %s', offset => {
    const zip = archive([{ name: 'font.ttf', text: 'Font bytes' }])
    if (offset === 4) zip.writeUInt16LE(45, offset)
    else zip.writeUInt32LE(0xffffffff, offset)
    expect(() => extractFontZip(zip, 'font.ttf')).toThrow('ZIP64')
  })
})
