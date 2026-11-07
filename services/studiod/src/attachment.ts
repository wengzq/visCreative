import { constants, copyFileSync, mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { basename, isAbsolute, join, relative, sep } from 'node:path'
import { VisError } from '@vis/domain'
import type { AssetStore } from '@vis/assets'
import { eq, spaceSchema as s, type SpaceDb } from '@vis/storage'

/** Private blobs must not be exposed to Agents; attachments are only copied to the public project assets directory. */
export function attachmentPath(db: SpaceDb, assets: AssetStore, rootPath: string, assetVersionId: string): string {
  const version = assets.getVersion(db, assetVersionId)
  if (!version) throw VisError.of('not_found', 'asset.version_not_found', { assetVersionId }, `Asset version ${assetVersionId} does not exist`)
  const root = realpathSync(rootPath)
  const directory = join(root, 'assets')
  mkdirSync(directory, { recursive: true })
  const realDirectory = realpathSync(directory)
  const rel = relative(root, realDirectory)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw VisError.of('forbidden', 'asset.directory_outside_project', {}, 'Project assets directory is out of bounds')
  const name = db.select({ name: s.assets.displayName }).from(s.assets).where(eq(s.assets.id, version.assetId)).get()?.name
  const filename = basename(name || assetVersionId)
  const destination = join(mkdtempSync(join(realDirectory, 'attachment-')), filename === '.' || filename === '..' ? assetVersionId : filename)
  copyFileSync(assets.blobPath(version.blobHash), destination, constants.COPYFILE_EXCL)
  return destination
}
