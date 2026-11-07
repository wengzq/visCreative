import { BUILTIN_FONT_FAMILIES, BUILTIN_FONTS, type BuiltinFontId, type FontView } from '@vis/protocol'
import { desc, eq, spaceSchema as s, type SpaceTx } from '@vis/storage'
import { resolveBuiltinFontFile } from '../../../resources/fonts/paths'

export function builtinFontPath(id: BuiltinFontId): string {
  return resolveBuiltinFontFile(id, import.meta.url)
}

export function listFonts(tx: SpaceTx): { fonts: FontView[] } {
  const fonts: FontView[] = BUILTIN_FONTS.map(id => ({ font: { builtin: id }, family: BUILTIN_FONT_FAMILIES[id], label: BUILTIN_FONT_FAMILIES[id] }))
  const seen = new Set<string>()
  const versions = tx.select({ assetId: s.assets.id, assetVersionId: s.assetVersions.id, family: s.assetVersions.fontFamily, label: s.assets.displayName })
    .from(s.assets).innerJoin(s.assetVersions, eq(s.assets.id, s.assetVersions.assetId))
    .where(eq(s.assets.kind, 'font')).orderBy(desc(s.assetVersions.version)).all()
  for (const v of versions) {
    if (seen.has(v.assetId)) continue
    seen.add(v.assetId)
    if (v.family) fonts.push({ font: { assetVersionId: v.assetVersionId }, family: v.family, label: v.label ?? v.family })
  }
  return { fonts }
}
