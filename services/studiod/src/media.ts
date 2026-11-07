import { readFileSync, realpathSync, statSync } from 'node:fs'
import { extname, isAbsolute, join, relative, sep } from 'node:path'
import { assetVersionView, MAX_FONT_BYTES, MAX_MODEL_BYTES, readFontFamily, validateGlb, mimeOf, type MediaTools } from '@vis/assets'
import { VisError } from '@vis/domain'
import type { AssetVersionView, MethodParams, MethodResult } from '@vis/protocol'
import { desc, eq, runIdempotent, spaceSchema as s, sql, type SpaceTx } from '@vis/storage'
import type { SpaceHost } from './space-host'

export function assetView(host: SpaceHost, tx: SpaceTx, assetVersionId: string): AssetVersionView {
  const v = host.assets.getVersion(tx, assetVersionId)
  if (!v) throw VisError.of('not_found', 'asset.version_not_found', { assetVersionId }, `Asset version ${assetVersionId} does not exist`)
  const displayName = tx.query.assets.findFirst({ where: (assets, { eq }) => eq(assets.id, v.assetId) }).sync()?.displayName
  return assetVersionView(v, { displayName: displayName ?? null }, hash => host.assets.blobPath(hash))
}

export function listModels(host: SpaceHost): MethodResult<'model.list'> {
  const versions = host.db.select({ assetVersionId: s.assetVersions.id }).from(s.assets)
    .innerJoin(s.assetVersions, eq(s.assets.id, s.assetVersions.assetId))
    .where(sql`${s.assets.kind} = 'model' and ${s.assetVersions.version} = (select max(av.version) from asset_versions av where av.asset_id = ${s.assets.id})`)
    .orderBy(desc(s.assets.createdAt), desc(s.assets.id)).all()
  return { models: versions.map(version => assetView(host, host.db, version.assetVersionId)) }
}

/** Probe and persist first (slow, outside the transaction), then register in an idempotent transaction; content-addressed blobs are not duplicated on retry. */
export async function importAsset(host: SpaceHost, media: MediaTools, p: MethodParams<'asset.import'>, method = 'asset.import'): Promise<MethodResult<'asset.import'>> {
  if (!isAbsolute(p.path)) throw VisError.of('invalid_params', 'asset.absolute_path_required', {}, 'path must be absolute')
  let isFile = false
  try {
    isFile = statSync(p.path).isFile()
  } catch {
    // Does not exist.
  }
  if (!isFile) throw VisError.of('not_found', 'asset.file_not_found', { path: p.path }, `File ${p.path} does not exist`)
  const ext = extname(p.path).toLowerCase()
  const isFont = ext === '.ttf' || ext === '.otf'
  const isModel = ext === '.glb'
  if (ext === '.gltf') throw VisError.of('invalid_params', 'asset.model_invalid', {}, 'Use one binary .glb model instead of .gltf')
  if (isFont && statSync(p.path).size > MAX_FONT_BYTES) throw VisError.of('invalid_params', 'asset.font_too_large', {}, 'Font files must be at most 50 MB')
  let modelBytes: Uint8Array | undefined
  if (isModel) {
    if (statSync(p.path).size > MAX_MODEL_BYTES) throw VisError.of('invalid_params', 'asset.model_too_large', {}, 'Model files must be at most 32 MiB')
    modelBytes = readFileSync(p.path)
    validateGlb(modelBytes)
  }
  const info: Pick<AssetVersionView, 'kind' | 'mime' | 'fontFamily' | 'width' | 'height' | 'durationMs' | 'fps' | 'hasAlpha'> = isFont
    ? { kind: 'font' as const, mime: ext === '.otf' ? 'font/otf' : 'font/ttf', fontFamily: readFontFamily(readFileSync(p.path)) }
    : isModel ? { kind: 'model' as const, mime: 'model/gltf-binary' }
    : await media.probe(p.path)
  // Stage the validated snapshot so a changing source file cannot introduce external model references.
  const staged = modelBytes ? await host.assets.stageBytes(modelBytes) : await host.assets.stageFile(p.path)
  if (p.contentHash && staged.hash !== p.contentHash) throw VisError.of('invalid_params', 'asset.hash_mismatch', {}, 'The uploaded content does not match its hash')
  const identity = p.contentHash ? { requestId: p.requestId, contentHash: p.contentHash } : p
  return runIdempotent(host.db, { requestId: p.requestId, method, params: identity }, tx => {
    const { assetVersionId } = host.assets.registerVersion(tx, {
      staged, kind: info.kind, mime: info.mime, origin: 'import',
      displayName: p.displayName ?? p.path.split(/[\\/]/).pop()!,
      ...(info.fontFamily !== undefined ? { fontFamily: info.fontFamily } : {}),
      ...(info.width !== undefined ? { width: info.width } : {}),
      ...(info.height !== undefined ? { height: info.height } : {}),
      ...(info.durationMs !== undefined ? { durationMs: info.durationMs } : {}),
      ...(info.hasAlpha !== undefined ? { hasAlpha: info.hasAlpha } : {}),
      ...(info.fps !== undefined ? { fps: info.fps } : {}),
    })
    return assetView(host, tx, assetVersionId)
  })
}

export async function importAgentFile(host: SpaceHost, media: MediaTools, sessionId: string, p: MethodParams<'asset.importFile'>): Promise<MethodResult<'asset.importFile'>> {
  if (!isAbsolute(p.path)) throw VisError.of('invalid_params', 'asset.absolute_path_required', {}, 'path must be absolute')
  let path: string
  try { path = realpathSync(p.path) } catch { throw VisError.of('not_found', 'asset.file_not_found', { path: p.path }, `File ${p.path} does not exist`) }
  const allowed = [host.workDir(sessionId), join(host.rootPath, 'assets')].some(root => {
    const rel = relative(realpathSync(root), path)
    return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
  })
  if (!allowed) throw VisError.of('forbidden', 'asset.import_outside_root', {}, 'Only files within the current working directory or project assets directory can be imported')
  const stat = statSync(path)
  if (!stat.isFile()) throw VisError.of('invalid_params', 'asset.file_required', {}, 'path must be a file')
  if (/\.[ot]tf$/i.test(path) && stat.size > MAX_FONT_BYTES) throw VisError.of('invalid_params', 'asset.font_too_large', {}, 'Font files must be at most 50 MB')
  if (/\.glb$/i.test(path) && stat.size > MAX_MODEL_BYTES) throw VisError.of('invalid_params', 'asset.model_too_large', {}, 'Model files must be at most 32 MiB')
  if (/\.gltf$/i.test(path)) throw VisError.of('invalid_params', 'asset.model_invalid', {}, 'Use one binary .glb model instead of .gltf')
  if (stat.size > 2 * 1024 ** 3) throw VisError.of('invalid_params', 'asset.file_size_limit', {}, 'File exceeds the 2 GiB limit')
  if (!mimeOf(path) && !/\.(?:[ot]tf|glb)$/i.test(path)) throw VisError.of('invalid_params', 'asset.media_required', {}, 'Only image, video, audio, font and GLB model files are supported')
  return importAsset(host, media, { ...p, path }, 'asset.importFile')
}

export async function extractFrames(host: SpaceHost, media: MediaTools, p: MethodParams<'asset.extractFrames'>): Promise<MethodResult<'asset.extractFrames'>> {
  const register = await prepareFrameExtraction(host, media, p)
  return runIdempotent(host.db, { requestId: p.requestId, method: 'asset.extractFrames', params: p }, register)
}

/** Share staging and transactional registration with blockout writeback, so a revision conflict leaves no registered frames. */
export async function prepareFrameExtraction(host: SpaceHost, media: MediaTools, p: Pick<MethodParams<'asset.extractFrames'>, 'assetVersionId' | 'count' | 'atMs'>) {
  const video = host.assets.getVersion(host.db, p.assetVersionId)
  if (!video) throw VisError.of('not_found', 'asset.version_not_found', { assetVersionId: p.assetVersionId }, `Asset version ${p.assetVersionId} does not exist`)
  if (video.kind !== 'video') throw VisError.of('invalid_params', 'asset.video_required', { assetVersionId: p.assetVersionId }, `Asset version ${p.assetVersionId} is not a video`)
  const frames = await media.extractFrames(host.assets.blobPath(video.blobHash), p.atMs ?? p.count ?? 6)
  const staged = await Promise.all(frames.map(f => host.assets.stageBytes(f.data)))
  return (tx: SpaceTx): MethodResult<'asset.extractFrames'> => ({
    durationMs: video.durationMs ?? 0,
    frames: frames.map((f, i) => {
      const { assetVersionId } = host.assets.registerVersion(tx, {
        staged: staged[i]!, kind: 'image', mime: f.mime, origin: 'derived', width: f.width, height: f.height,
        displayName: `${video.assetId}@${f.atMs}ms`,
      })
      return { ...assetView(host, tx, assetVersionId), atMs: f.atMs }
    }),
  })
}
