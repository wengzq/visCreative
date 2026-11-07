import { VisError } from '@vis/domain'

export const MAX_FONT_BYTES = 50 * 1024 ** 2

/** Read only the SFNT directory and name table; no font programs are executed. */
export function readFontFamily(bytes: Uint8Array): string {
  return familyName(bytes, false)
}

/** libass's external-font provider matches legacy families, including Smiley Sans Oblique. */
export function readAssFontFamily(bytes: Uint8Array): string {
  return familyName(bytes, true)
}

function familyName(bytes: Uint8Array, legacy: boolean): string {
  if (bytes.byteLength > MAX_FONT_BYTES) throw VisError.of('invalid_params', 'asset.font_too_large', {}, 'Font files must be at most 50 MB')
  const invalid = (): never => { throw VisError.of('invalid_params', 'asset.font_invalid', {}, 'The file has no valid OpenType font family') }
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const within = (offset: number, length: number) => Number.isSafeInteger(offset) && offset >= 0 && length >= 0 && offset + length <= data.length
  if (!within(0, 12) || (data.readUInt32BE(0) !== 0x00010000 && data.toString('ascii', 0, 4) !== 'OTTO')) return invalid()
  const count = data.readUInt16BE(4)
  if (!count || !within(12, count * 16)) return invalid()
  let table: Buffer | undefined
  for (let i = 0; i < count; i++) {
    const at = 12 + i * 16
    const offset = data.readUInt32BE(at + 8)
    const length = data.readUInt32BE(at + 12)
    if (!within(offset, length)) return invalid()
    if (data.toString('ascii', at, at + 4) === 'name') table = data.subarray(offset, offset + length)
  }
  if (!table || table.length < 6 || table.readUInt16BE(0) > 1) return invalid()
  const names = table.readUInt16BE(2)
  const strings = table.readUInt16BE(4)
  if (6 + names * 12 > table.length || strings < 6 + names * 12 || strings > table.length) return invalid()
  const candidates: { family: string; rank: number }[] = []
  for (let i = 0; i < names; i++) {
    const at = 6 + i * 12
    const platform = table.readUInt16BE(at)
    const encoding = table.readUInt16BE(at + 2)
    const language = table.readUInt16BE(at + 4)
    const name = table.readUInt16BE(at + 6)
    const length = table.readUInt16BE(at + 8)
    const offset = strings + table.readUInt16BE(at + 10)
    if (offset + length > table.length) return invalid()
    if ((name !== 16 && name !== 1) || !length) continue
    let family: string
    if (platform === 3 || platform === 0) {
      if (length % 2 || (platform === 3 && ![0, 1, 10].includes(encoding))) continue
      try { family = new TextDecoder('utf-16be', { fatal: true }).decode(table.subarray(offset, offset + length)) } catch { return invalid() }
    } else if (platform === 1 && encoding === 0) {
      family = new TextDecoder('macintosh').decode(table.subarray(offset, offset + length))
    } else continue
    family = family.trim()
    // ASS style fields are comma separated. Reject names that could inject a style or event.
    if (!family || /[,\\{}\u0000-\u001f\u007f]/.test(family) || family.length > 200) continue
    const english = platform === 3 ? (language & 0x3ff) === 9 : language === 0
    candidates.push({ family, rank: (english ? 0 : 100) + (name === (legacy ? 1 : 16) ? 0 : 10) + (platform === 3 ? 0 : platform === 0 ? 1 : 2) })
  }
  candidates.sort((a, b) => a.rank - b.rank)
  return candidates[0]?.family ?? invalid()
}
