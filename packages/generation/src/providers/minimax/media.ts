/** Validate the encoded type before asking the media probe to inspect it. */
export function minimaxMime(data: Uint8Array): string | undefined {
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  if (bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.toString('ascii', 12, 16) === 'IHDR') return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg'
  if (bytes.length >= 30 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  if (bytes.length >= 16 && bytes.toString('ascii', 4, 8) === 'ftyp') {
    const size = bytes.readUInt32BE(0)
    if (size < 16 || size > bytes.length) return
    const brands = [bytes.toString('ascii', 8, 12)]
    for (let offset = 16; offset + 4 <= size; offset += 4) brands.push(bytes.toString('ascii', offset, offset + 4))
    if (brands.some(brand => /^(?:isom|iso[2-9]|mp4[12]|avc1|dash|M4V |MSNV)$/.test(brand))) return 'video/mp4'
  }
}
