import { BUILTIN_FONTS, type BuiltinFontId } from '@vis/protocol'
import { resolveBuiltinFontFile } from '../../../../resources/fonts/paths'

/** Resolve resources relative to either source or bundled host, independent of its launch cwd. */
export function builtinFontFile(id: string): string | undefined {
  if (!BUILTIN_FONTS.some(font => font === id)) return undefined
  return resolveBuiltinFontFile(id as BuiltinFontId, import.meta.url)
}
