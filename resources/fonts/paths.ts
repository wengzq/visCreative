import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Keep filenames explicit so VIS_FONTS_DIR also works in packaged applications without a repo.
export const BUILTIN_FONT_FILES = {
  'noto-sans-sc': 'noto-sans-sc.otf',
  'smiley-sans': 'smiley-sans.ttf',
  'lxgw-wenkai': 'lxgw-wenkai.ttf',
  'zcool-kuaile': 'zcool-kuaile.ttf',
} as const

export function resolveBuiltinFontFile(id: keyof typeof BUILTIN_FONT_FILES, moduleUrl: string): string {
  const file = BUILTIN_FONT_FILES[id]
  if (process.env['VIS_FONTS_DIR']) return join(resolve(process.env['VIS_FONTS_DIR']), file)
  let dir = dirname(fileURLToPath(moduleUrl))
  while (dirname(dir) !== dir) {
    if (existsSync(join(dir, 'resources/fonts/fonts.json'))) return join(dir, 'resources/fonts/files', file)
    dir = dirname(dir)
  }
  return join(dir, 'resources/fonts/files', file)
}
