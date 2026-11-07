import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { BUILTIN_FONTS, BUILTIN_FONT_FAMILIES, type BuiltinFontId } from '@vis/protocol'
import { BUILTIN_FONT_FILES } from '../../../resources/fonts/paths'
import { readFontFamily } from './font-name'

const root = fileURLToPath(new URL('../../../resources/fonts/', import.meta.url))
const manifest = JSON.parse(readFileSync(join(root, 'fonts.json'), 'utf8')) as {
  id: BuiltinFontId; family: string; file: string; url: string; sha256: string; license: string; licenseUrl: string; licenseFile: string; licenseSha256: string; archiveEntry?: string; archiveSha256?: string
}[]
const pinned = (url: string) => /^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[a-f0-9]{40}\//.test(url) || /^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/download\/v[\d.]+\//.test(url)

it('keeps the manifest, contract IDs and runtime filenames aligned with pinned downloads', () => {
  expect(manifest.map(font => font.id)).toEqual([...BUILTIN_FONTS])
  for (const font of manifest) {
    expect(font.family).toBe(BUILTIN_FONT_FAMILIES[font.id])
    expect(font.file).toBe(BUILTIN_FONT_FILES[font.id])
    expect(basename(font.file)).toBe(font.file)
    expect(basename(font.licenseFile)).toBe(font.licenseFile)
    expect(font.license).toBe('OFL-1.1')
    expect(font.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(font.licenseSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(pinned(font.url)).toBe(true)
    expect(pinned(font.licenseUrl)).toBe(true)
    if (font.archiveEntry) {
      expect(font.id).toBe('smiley-sans')
      expect(font.archiveEntry).toBe('SmileySans-Oblique.ttf')
      expect(font.archiveSha256).toMatch(/^[a-f0-9]{64}$/)
    }
  }
})

for (const font of manifest) {
  const path = join(process.env['VIS_FONTS_DIR'] ?? join(root, 'files'), font.file)
  if (!existsSync(path)) console.info(`Skipping ${font.id} metadata: run pnpm fonts:fetch`)
  it.skipIf(!existsSync(path))(`reads the bundled ${font.id} family from its actual font file`, () => {
    const bytes = readFileSync(path)
    expect(readFontFamily(bytes)).toBe(font.family)
    if (font.id === 'noto-sans-sc') {
      // This static regular replaces a VF whose default axis differs between Chrome and libass.
      const tags = Array.from({ length: bytes.readUInt16BE(4) }, (_, i) => bytes.toString('ascii', 12 + i * 16, 16 + i * 16))
      expect(tags).not.toContain('fvar')
      const os2 = tags.indexOf('OS/2')
      expect(os2).toBeGreaterThanOrEqual(0)
      expect(bytes.readUInt16BE(bytes.readUInt32BE(12 + os2 * 16 + 8) + 4)).toBe(400)
    }
  })
}
