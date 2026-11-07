import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createAssetStore } from '@vis/assets'
import { openSpaceDb, type SpaceDb } from '@vis/storage'
import { attachmentPath } from './attachment'

let directory: string
let db: SpaceDb
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'vis-attachment-'))
  db = openSpaceDb(':memory:')
})
afterEach(() => {
  db.$client.close()
  rmSync(directory, { recursive: true, force: true })
})

it('copies assets to project assets, preserving filenames and bytes without exposing blob paths', async () => {
  const assets = createAssetStore({ blobsDir: join(directory, 'private', 'blobs') })
  const root = join(directory, 'project')
  mkdirSync(root)
  const staged = await assets.stageBytes(Buffer.from('test image'))
  const { assetVersionId } = assets.registerVersion(db, { staged, kind: 'image', mime: 'image/png', origin: 'import', displayName: '../../参考.png' })
  const path = attachmentPath(db, assets, root, assetVersionId)
  expect(dirname(dirname(path))).toBe(realpathSync(join(root, 'assets')))
  expect(basename(path)).toBe('参考.png')
  expect(readFileSync(path).toString()).toBe('test image')
  expect(path).not.toBe(assets.blobPath(staged.hash))
  expect(() => attachmentPath(db, assets, root, 'missing')).toThrow(expect.objectContaining({ code: 'not_found', message: 'Asset version missing does not exist', details: { reason: 'asset.version_not_found', params: { assetVersionId: 'missing' } } }))
})

it('rejects copying when the assets symlink points outside the project', async () => {
  const assets = createAssetStore({ blobsDir: join(directory, 'blobs') })
  const root = join(directory, 'project')
  const outside = join(directory, 'outside')
  mkdirSync(root)
  mkdirSync(outside)
  symlinkSync(outside, join(root, 'assets'), process.platform === 'win32' ? 'junction' : 'dir')
  const staged = await assets.stageBytes(Buffer.from('image'))
  const { assetVersionId } = assets.registerVersion(db, { staged, kind: 'image', mime: 'image/png', origin: 'import' })
  expect(() => attachmentPath(db, assets, root, assetVersionId)).toThrow(expect.objectContaining({ code: 'forbidden', message: 'Project assets directory is out of bounds', details: { reason: 'asset.directory_outside_project', params: {} } }))
})
