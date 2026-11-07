import type { DownloadedOutput } from '../types'

/** Read the encoded format and dimensions without trusting the requested output format. */
export function imageOutput(data: Buffer): DownloadedOutput | undefined {
  let mime: string
  let width = 0
  let height = 0
  if (data.length >= 33 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    data.readUInt32BE(8) === 13 && data.toString('ascii', 12, 16) === 'IHDR') {
    mime = 'image/png'
    width = data.readUInt32BE(16)
    height = data.readUInt32BE(20)
  } else if (data.length >= 12 && data[0] === 0xff && data[1] === 0xd8) {
    mime = 'image/jpeg'
    let offset = 2
    while (offset + 4 <= data.length) {
      if (data[offset++] !== 0xff) return
      while (data[offset] === 0xff) offset++
      const marker = data[offset++]!
      if (marker === 0xd9 || marker === 0xda) break
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
      if (offset + 2 > data.length) return
      const length = data.readUInt16BE(offset)
      if (length < 2 || offset + length > data.length) return
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        if (length < 8) return
        height = data.readUInt16BE(offset + 3)
        width = data.readUInt16BE(offset + 5)
        break
      }
      offset += length
    }
  } else if (data.length >= 30 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') {
    mime = 'image/webp'
    const chunk = data.toString('ascii', 12, 16)
    if (chunk === 'VP8X') {
      width = 1 + data.readUIntLE(24, 3)
      height = 1 + data.readUIntLE(27, 3)
    } else if (chunk === 'VP8 ' && data.subarray(23, 26).equals(Buffer.from([0x9d, 0x01, 0x2a]))) {
      width = data.readUInt16LE(26) & 0x3fff
      height = data.readUInt16LE(28) & 0x3fff
    } else if (chunk === 'VP8L' && data[20] === 0x2f) {
      const bits = data.readUInt32LE(21)
      width = (bits & 0x3fff) + 1
      height = ((bits >>> 14) & 0x3fff) + 1
    }
  } else return
  if (!width || !height) return
  return { data, mime, width, height }
}
