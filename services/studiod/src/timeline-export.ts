import { readFile, stat } from 'node:fs/promises'
import { detectVideoEncoder, readAssFontFamily, renderTimeline, type AssetStore, type MediaRunOptions, type ProcessedMedia, type TimelineSource, type VideoEncoder } from '@vis/assets'
import { VisError } from '@vis/domain'
import { TEXT_PRESETS, fontKey, isMediaKind, overlayTracks, visibleTextTracks, TimelineDoc } from '@vis/protocol'
import { and, eq, spaceSchema as s, type SpaceTx } from '@vis/storage'
import { builtinFontPath } from './fonts'

export type TimelineExportTools = {
  ffmpegPath?: string
  ffprobePath?: string
  detectEncoder?: typeof detectVideoEncoder
  render?: typeof renderTimeline
}

const AUDIO_ONLY_ENCODER: VideoEncoder = { name: 'none', args: [], hardware: false }

/** Resolve the submitted revision in the project's own database, never the current slot content. */
export async function exportTimeline(tx: SpaceTx, assets: AssetStore, task: { slotId: string; expectedRevision: number }, opts: MediaRunOptions, tools: TimelineExportTools = {}): Promise<ProcessedMedia> {
  const revision = tx.select().from(s.slotRevisions).where(and(eq(s.slotRevisions.slotId, task.slotId), eq(s.slotRevisions.revision, task.expectedRevision))).get()
  const parsed = TimelineDoc.safeParse(revision?.timelineDoc)
  if (!parsed.success) throw VisError.of('invalid_params', 'timeline.invalid_doc', {}, 'The submitted timeline revision is invalid')
  const sources = new Map<string, TimelineSource>()
  for (const clip of parsed.data.tracks.flatMap(track => track.clips)) {
    opts.signal?.throwIfAborted()
    const id = clip.source.assetVersionId
    if (sources.has(id)) continue
    // Asset IDs are project scoped because each project has its own database and blob store.
    const version = assets.getVersion(tx, id)
    const path = version ? assets.blobPath(version.blobHash) : undefined
    if (!version || !path || !(await stat(path).catch(() => undefined))?.isFile()) {
      throw VisError.of('invalid_params', 'timeline.source_missing', { assetVersionId: id }, 'A referenced timeline asset version or blob no longer exists in this project')
    }
    if (!isMediaKind(version.kind)) throw VisError.of('invalid_params', 'timeline.source_kind', { assetVersionId: id, kind: version.kind }, 'Font assets cannot be timeline clip sources')
    sources.set(id, {
      kind: version.kind, path,
      ...(version.durationMs !== null ? { durationMs: version.durationMs } : {}),
      ...(version.width !== null ? { width: version.width } : {}),
      ...(version.height !== null ? { height: version.height } : {}),
    })
  }
  const fonts = new Map<string, { path: string; family: string }>()
  for (const track of visibleTextTracks(parsed.data)) for (const clip of track.clips) {
    const font = clip.style.font ?? { builtin: TEXT_PRESETS[clip.style.preset].font }
    const key = fontKey(font)
    if (fonts.has(key)) continue
    if ('builtin' in font) {
      const path = builtinFontPath(font.builtin)
      if (!(await stat(path).catch(() => undefined))?.isFile()) throw VisError.of('unavailable', 'media.font_missing', { font: font.builtin }, 'A bundled font is missing; run pnpm fonts:fetch')
      fonts.set(key, { path, family: readAssFontFamily(await readFile(path)) })
    } else {
      const version = assets.getVersion(tx, font.assetVersionId)
      const path = version ? assets.blobPath(version.blobHash) : undefined
      if (version?.kind !== 'font' || !version.fontFamily || !path || !(await stat(path).catch(() => undefined))?.isFile()) {
        throw VisError.of('invalid_params', 'timeline.font_missing', { assetVersionId: font.assetVersionId }, 'The caption font is not available in this project')
      }
      fonts.set(key, { path, family: readAssFontFamily(await readFile(path)) })
    }
  }
  const paths = {
    ...(tools.ffmpegPath ? { ffmpegPath: tools.ffmpegPath } : {}),
    ...(tools.ffprobePath ? { ffprobePath: tools.ffprobePath } : {}),
  }
  // Audio-only documents never reach the video encoder, so a machine without H.264 can still export them.
  const hasVideo = parsed.data.tracks.some(track => track.kind === 'video' && track.clips.length > 0) || overlayTracks(parsed.data).length > 0 || visibleTextTracks(parsed.data).length > 0
  const encoder = hasVideo ? await (tools.detectEncoder ?? detectVideoEncoder)(paths) : AUDIO_ONLY_ENCODER
  opts.signal?.throwIfAborted()
  // The renderer probes the resolved blobs, plans copy/encode, and owns its temporary files.
  const rendered = await (tools.render ?? renderTimeline)(parsed.data, sources, { ...paths, ...opts, encoder, fonts })
  return { outputs: [rendered], dispose: () => rendered.dispose() }
}
