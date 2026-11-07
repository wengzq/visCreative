/** Reject mismatched headers before probing an extension-named copy of the asset. */
export function sniffDashScopeMime(data: Uint8Array): string | undefined {
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  if (bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  if (bytes.length >= 16 && bytes.toString('ascii', 4, 8) === 'ftyp') {
    const size = bytes.readUInt32BE(0)
    const brands = [bytes.toString('ascii', 8, 12)]
    for (let offset = 16; offset + 4 <= Math.min(size, bytes.length); offset += 4) brands.push(bytes.toString('ascii', offset, offset + 4))
    if (size >= 16 && size <= bytes.length && brands.some(brand => /^(?:isom|iso[2-9]|mp4[12]|avc1|dash|M4V |MSNV)$/.test(brand))) return 'video/mp4'
  }
  return undefined
}

export function pngHasAlpha(bytes: Buffer): boolean {
  if ([4, 6].includes(bytes[25]!)) return true
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(offset)
    if (bytes.toString('ascii', offset + 4, offset + 8) === 'tRNS') return true
    offset += length + 12
  }
  return false
}
