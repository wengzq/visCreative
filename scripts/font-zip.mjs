import { inflateRawSync } from 'node:zlib'

/** Read one approved entry in memory; archive paths never become filesystem paths. */
export function extractFontZip(input, archiveEntry, maxBytes = 50 * 1024 ** 2) {
  const zip = Buffer.from(input)
  const fail = message => { throw new Error(`Invalid font ZIP: ${message}`) }
  const inside = (at, length, end = zip.length) => Number.isSafeInteger(at) && at >= 0 && length >= 0 && at + length <= end
  let eocd = -1
  for (let at = zip.length - 22; at >= Math.max(0, zip.length - 22 - 65535); at--) {
    if (zip.readUInt32LE(at) === 0x06054b50 && at + 22 + zip.readUInt16LE(at + 20) === zip.length) { eocd = at; break }
  }
  if (eocd < 0) return fail('missing end of central directory')
  if (zip.readUInt16LE(eocd + 4) || zip.readUInt16LE(eocd + 6)) return fail('multi-disk archives are unsupported')
  const count = zip.readUInt16LE(eocd + 10)
  const size = zip.readUInt32LE(eocd + 12)
  const start = zip.readUInt32LE(eocd + 16)
  if (count === 0xffff || size === 0xffffffff || start === 0xffffffff || (eocd >= 20 && zip.readUInt32LE(eocd - 20) === 0x07064b50)) return fail('ZIP64 is unsupported')
  if (count !== zip.readUInt16LE(eocd + 8) || !inside(start, size, eocd)) return fail('invalid central directory')
  const end = start + size
  let at = start
  let found
  for (let i = 0; i < count; i++) {
    if (!inside(at, 46, end) || zip.readUInt32LE(at) !== 0x02014b50) return fail('invalid central directory entry')
    const flags = zip.readUInt16LE(at + 8)
    const method = zip.readUInt16LE(at + 10)
    const compressed = zip.readUInt32LE(at + 20)
    const uncompressed = zip.readUInt32LE(at + 24)
    const nameLength = zip.readUInt16LE(at + 28)
    const extraLength = zip.readUInt16LE(at + 30)
    const commentLength = zip.readUInt16LE(at + 32)
    const offset = zip.readUInt32LE(at + 42)
    if (flags & 0x41) return fail('encrypted entries are unsupported')
    if (method !== 0 && method !== 8) return fail('only stored and deflate entries are supported')
    if (zip.readUInt16LE(at + 6) >= 45 || compressed === 0xffffffff || uncompressed === 0xffffffff || offset === 0xffffffff) return fail('ZIP64 is unsupported')
    if (zip.readUInt16LE(at + 34)) return fail('multi-disk entries are unsupported')
    const next = at + 46 + nameLength + extraLength + commentLength
    if (!inside(at, next - at, end)) return fail('truncated central directory entry')
    const extraEnd = at + 46 + nameLength + extraLength
    for (let extra = at + 46 + nameLength; extra < extraEnd;) {
      if (!inside(extra, 4, extraEnd)) return fail('truncated extra field')
      if (zip.readUInt16LE(extra) === 1) return fail('ZIP64 is unsupported')
      const length = zip.readUInt16LE(extra + 2)
      if (!inside(extra + 4, length, extraEnd)) return fail('truncated extra field')
      extra += 4 + length
    }
    const name = zip.toString('utf8', at + 46, at + 46 + nameLength)
    if (name === archiveEntry) {
      if (found) return fail('duplicate requested entry')
      if (uncompressed > maxBytes) return fail('font exceeds the uncompressed size limit')
      if (!inside(offset, 30, start) || zip.readUInt32LE(offset) !== 0x04034b50) return fail('invalid local entry')
      if (zip.readUInt16LE(offset + 4) >= 45 || zip.readUInt32LE(offset + 18) === 0xffffffff || zip.readUInt32LE(offset + 22) === 0xffffffff) return fail('ZIP64 is unsupported')
      if (zip.readUInt16LE(offset + 6) !== flags || zip.readUInt16LE(offset + 8) !== method) return fail('local entry disagrees with central directory')
      const localNameLength = zip.readUInt16LE(offset + 26)
      const localExtraLength = zip.readUInt16LE(offset + 28)
      const data = offset + 30 + localNameLength + localExtraLength
      if (!inside(offset + 30, localNameLength + localExtraLength, start) || !inside(data, compressed, start)) return fail('truncated local entry')
      if (zip.toString('utf8', offset + 30, offset + 30 + localNameLength) !== archiveEntry) return fail('local filename disagrees with central directory')
      for (let extra = offset + 30 + localNameLength; extra < data;) {
        if (!inside(extra, 4, data)) return fail('truncated local extra field')
        if (zip.readUInt16LE(extra) === 1) return fail('ZIP64 is unsupported')
        const length = zip.readUInt16LE(extra + 2)
        if (!inside(extra + 4, length, data)) return fail('truncated local extra field')
        extra += 4 + length
      }
      const content = zip.subarray(data, data + compressed)
      found = method === 0 ? Buffer.from(content) : inflateRawSync(content, { maxOutputLength: maxBytes })
      if (found.length !== uncompressed) return fail('uncompressed size mismatch')
    }
    at = next
  }
  if (at !== end) return fail('central directory size mismatch')
  if (!found) return fail(`entry ${archiveEntry} was not found`)
  return found
}
