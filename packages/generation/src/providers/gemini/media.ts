import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { MediaTools } from '@vis/assets'
import { ProviderError, type DownloadedOutput } from '../types'

export const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp']

export function sniffMime(data: Uint8Array): string | undefined {
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  if (bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.toString('ascii', 12, 16) === 'IHDR') return 'image/png'
  if (bytes.length >= 12 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 30 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  if (bytes.length >= 16 && bytes.toString('ascii', 4, 8) === 'ftyp') {
    const size = bytes.readUInt32BE(0)
    const brands = [bytes.toString('ascii', 8, 12)]
    for (let offset = 16; offset + 4 <= Math.min(size, bytes.length); offset += 4) brands.push(bytes.toString('ascii', offset, offset + 4))
    if (size >= 16 && size <= bytes.length && brands.some(brand => /^(?:isom|iso[2-9]|mp4[12]|avc1|dash|M4V |MSNV)$/.test(brand))) return 'video/mp4'
  }
  return undefined
}

export function decodeBase64(value: unknown, maxBytes: number): Buffer | undefined {
  if (typeof value !== 'string' || !value.length || value.length > Math.ceil(maxBytes / 3) * 4 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return
  const bytes = Buffer.from(value, 'base64')
  if (bytes.length > maxBytes) return
  return bytes
}

export async function probeOutput(data: Uint8Array, mime: string, root: string, media: MediaTools): Promise<DownloadedOutput> {
  if (sniffMime(data) !== mime) throw new ProviderError('rejected', 'Gemini output bytes do not match the MIME type', 'generation.output_type_invalid')
  await mkdir(root, { recursive: true, mode: 0o700 })
  const dir = await mkdtemp(join(root, 'probe-'))
  try {
    const path = join(dir, `output.${mime === 'video/mp4' ? 'mp4' : mime === 'image/jpeg' ? 'jpg' : mime.slice(6)}`)
    await writeFile(path, data, { mode: 0o600 })
    const info = await media.probe(path)
    if (info.mime !== mime || !info.width || !info.height) throw new Error('Invalid media dimensions')
    return { data, mime, width: info.width, height: info.height, ...(info.durationMs !== undefined ? { durationMs: info.durationMs } : {}), ...(info.fps !== undefined ? { fps: info.fps } : {}) }
  } catch { throw new ProviderError('rejected', 'Gemini output media could not be validated', 'generation.output_type_invalid') }
  finally { await rm(dir, { recursive: true, force: true }) }
}
