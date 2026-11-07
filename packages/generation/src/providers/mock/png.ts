import { createHash } from 'node:crypto'
import { deflateSync } from 'node:zlib'

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type), data])
  let crc = 0xffffffff
  for (const byte of body) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  const result = Buffer.alloc(data.length + 12)
  result.writeUInt32BE(data.length, 0)
  body.copy(result, 4)
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4)
  return result
}

export function createPng(width: number, height: number, prompt: string, outputIndex: number, label?: string, metadata?: Record<string, unknown>): Buffer {
  const hash = createHash('sha256').update(prompt).digest()
  const row = Buffer.alloc(1 + width * 3)
  for (let x = 0; x < width; x++) {
    row[1 + x * 3] = (hash[0]! + outputIndex * 61) & 255
    row[2 + x * 3] = hash[1]!
    row[3 + x * 3] = hash[2]!
  }
  const pixels = Buffer.alloc(row.length * height)
  for (let y = 0; y < height; y++) row.copy(pixels, y * row.length)
  if (label) {
    const columns = Math.max(1, Math.floor((width - 8) / 6))
    for (const [i, char] of [...label.toUpperCase()].entries()) {
      const glyph = FONT[char] ?? FONT['.']!
      const left = 4 + (i % columns) * 6
      const top = 4 + Math.floor(i / columns) * 9
      for (let y = 0; y < 7 && top + y < height; y++) for (let x = 0; x < 5 && left + x < width; x++) {
        const offset = (top + y) * row.length + 1 + (left + x) * 3
        const value = (glyph[y]! & (1 << (4 - x))) ? 255 : 16
        pixels.fill(value, offset, offset + 3)
      }
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    ...(label ? [chunk('tEXt', Buffer.from(`Operation\0${label}`))] : []),
    ...Object.entries(metadata ?? {}).map(([key, value]) => chunk('tEXt', Buffer.from(`${key}\0${JSON.stringify(value)}`))),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const FONT: Record<string, number[]> = {
  A: [14, 17, 17, 31, 17, 17, 17], B: [30, 17, 17, 30, 17, 17, 30],
  C: [14, 17, 16, 16, 16, 17, 14], D: [30, 17, 17, 17, 17, 17, 30],
  E: [31, 16, 16, 30, 16, 16, 31], G: [14, 17, 16, 23, 17, 17, 15],
  H: [17, 17, 17, 31, 17, 17, 17], I: [31, 4, 4, 4, 4, 4, 31],
  L: [16, 16, 16, 16, 16, 16, 31], M: [17, 27, 21, 21, 17, 17, 17],
  N: [17, 25, 25, 21, 19, 19, 17], O: [14, 17, 17, 17, 17, 17, 14],
  P: [30, 17, 17, 30, 16, 16, 16], R: [30, 17, 17, 30, 20, 18, 17],
  S: [15, 16, 16, 14, 1, 1, 30], T: [31, 4, 4, 4, 4, 4, 4],
  U: [17, 17, 17, 17, 17, 17, 14], V: [17, 17, 17, 17, 17, 10, 4],
  W: [17, 17, 17, 21, 21, 21, 10], '.': [0, 0, 0, 0, 0, 12, 12],
}
