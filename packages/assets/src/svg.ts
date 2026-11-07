import { readFile, stat } from 'node:fs/promises'
import { VisError } from '@vis/domain'
import type { MediaInfo } from './media'

const MAX_SVG_BYTES = 10 * 1024 * 1024

export async function probeSvg(path: string): Promise<MediaInfo> {
  if ((await stat(path)).size > MAX_SVG_BYTES) throw VisError.of('invalid_params', 'asset.svg_too_large', {}, 'SVG file exceeds the 10 MiB limit')
  const bytes = await readFile(path)
  if (bytes.length > MAX_SVG_BYTES) throw VisError.of('invalid_params', 'asset.svg_too_large', {}, 'SVG file exceeds the 10 MiB limit')
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch {
    throw VisError.of('invalid_params', 'asset.svg_invalid_encoding', {}, 'SVG must be UTF-8 text')
  }
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(text)) throw VisError.of('invalid_params', 'asset.svg_unsafe_declaration', {}, 'SVG does not allow DOCTYPE or ENTITY')
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) throw VisError.of('invalid_params', 'asset.svg_invalid_encoding', {}, 'SVG must be UTF-8 text')
  const declaration = text.match(/^\s*<\?xml\s[\s\S]*?\?>/)
  if (declaration) {
    const encoding = declaration[0].match(/\bencoding\s*=\s*(['"])(.*?)\1/i)?.[2]
    if (encoding && encoding.toLowerCase() !== 'utf-8') throw VisError.of('invalid_params', 'asset.svg_invalid_encoding', {}, 'SVG must be UTF-8 text')
    text = text.slice(declaration[0].length)
  }
  text = text.replace(/^(?:\s|<!--[\s\S]*?-->)+/, '').trim()
  while (text.endsWith('-->')) {
    const start = text.lastIndexOf('<!--')
    if (start < 0) break
    text = text.slice(0, start).trimEnd()
  }
  const root = text.match(/^<svg(?=\s|\/?>)((?:[^<>"']|"[^"]*"|'[^']*')*)>/)
  if (!root || (!root[1]!.trimEnd().endsWith('/') && !/<\/svg\s*>\s*$/.test(text))) throw VisError.of('invalid_params', 'asset.extension_mismatch', {}, 'File content does not match its extension')
  if (root[1]!.trimEnd().endsWith('/') && text.slice(root[0].length).trim()) throw VisError.of('invalid_params', 'asset.extension_mismatch', {}, 'File content does not match its extension')
  const attributes = new Map<string, string>()
  const remainder = root[1]!.replace(/\s+([\w:.-]+)\s*=\s*(["'])(.*?)\2/gs, (_match, name: string, _quote: string, value: string) => {
    attributes.set(name, value)
    return ''
  }).trim()
  if (remainder && remainder !== '/') throw VisError.of('invalid_params', 'asset.svg_invalid_attributes', {}, 'Invalid SVG root element attributes')
  const dimension = (name: string) => {
    const value = attributes.get(name)?.trim()
    if (!value || !/^(?:\d+(?:\.\d*)?|\.\d+)(?:px)?$/.test(value)) return undefined
    const number = Number.parseFloat(value)
    return Number.isFinite(number) && number > 0 ? number : undefined
  }
  const viewBox = attributes.get('viewBox')?.trim().split(/[\s,]+/).map(Number)
  const validViewBox = viewBox?.length === 4 && viewBox.every(Number.isFinite) && viewBox[2]! > 0 && viewBox[3]! > 0
  const width = Math.max(1, Math.round(dimension('width') ?? (validViewBox ? viewBox[2]! : NaN)))
  const height = Math.max(1, Math.round(dimension('height') ?? (validViewBox ? viewBox[3]! : NaN)))
  return {
    kind: 'image', mime: 'image/svg+xml',
    ...(Number.isSafeInteger(width) ? { width } : {}),
    ...(Number.isSafeInteger(height) ? { height } : {}),
  }
}
