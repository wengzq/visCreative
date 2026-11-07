import { createHash, randomUUID } from 'node:crypto'
import { closeSync, createReadStream, fsyncSync, lstatSync, mkdirSync, openSync, renameSync, unlinkSync } from 'node:fs'
import { mkdir, open, readdir, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { newId, VisError } from '@vis/domain'
import type { AssetKind } from '@vis/protocol'
import { appendEvent, spaceSchema as s, type SpaceTx } from '@vis/storage'
import { videoFrameRate } from './frame-rate'

export type StagedBlob = { hash: string; byteSize: number }
export type RegisterVersionInput = {
  staged: StagedBlob
  kind: AssetKind
  mime: string
  origin: 'import' | 'generation' | 'derived'
  assetId?: string
  displayName?: string
  sourceJobId?: string
  width?: number
  height?: number
  durationMs?: number
  fps?: number
  hasAlpha?: boolean
  // 0024d: family name read from a font file's name table
  fontFamily?: string
  operationId?: string
}
export type RegisteredVersion = { assetId: string; assetVersionId: string; version: number }
export type AssetVersionRecord = typeof s.assetVersions.$inferSelect & { kind: AssetKind }

export interface AssetStore {
  stageBytes(data: Uint8Array): Promise<StagedBlob>
  stageFile(sourcePath: string): Promise<StagedBlob>
  registerVersion(tx: SpaceTx, input: RegisterVersionInput): RegisteredVersion
  getVersion(tx: SpaceTx, assetVersionId: string): AssetVersionRecord | undefined
  blobPath(hash: string): string
  findOrphanBlobs(tx: SpaceTx): Promise<string[]>
  /** Release staging ownership and remove an unregistered blob only when no other stage is using it. */
  discardStaged(tx: SpaceTx, staged: StagedBlob): void
}

function syncDirectory(path: string) {
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    fsyncSync(fd)
  } catch {
    // Some platforms do not support directory fsync; the file is already fsynced, so directory syncing is best effort.
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

export function createAssetStore(opts: { blobsDir: string; now?: () => number }): AssetStore {
  const blobsDir = resolve(opts.blobsDir)
  const tmpDir = join(blobsDir, '.tmp')
  const now = opts.now ?? Date.now
  const leases = new Map<string, number>()
  const released = new WeakSet<StagedBlob>()

  function release(staged: StagedBlob) {
    if (released.has(staged)) return
    released.add(staged)
    const remaining = (leases.get(staged.hash) ?? 0) - 1
    if (remaining > 0) leases.set(staged.hash, remaining)
    else leases.delete(staged.hash)
  }

  function blobPath(hash: string): string {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error(`Invalid blob hash: ${hash}`)
    return join(blobsDir, hash.slice(0, 2), hash)
  }

  async function stage(chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>): Promise<StagedBlob> {
    await mkdir(tmpDir, { recursive: true })
    const tempPath = join(tmpDir, randomUUID())
    const file = await open(tempPath, 'wx')
    try {
      const digest = createHash('sha256')
      let byteSize = 0
      for await (const chunk of chunks) {
        await file.writeFile(chunk)
        digest.update(chunk)
        byteSize += chunk.byteLength
      }
      await file.sync()
      await file.close()
      const hash = digest.digest('hex')
      const target = blobPath(hash)
      mkdirSync(dirname(target), { recursive: true })
      // studiod is the only writer; synchronous checks and rename prevent concurrent stage calls from interleaving between them.
      try {
        lstatSync(target)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        renameSync(tempPath, target)
      }
      const stat = lstatSync(target)
      if (!stat.isFile() || stat.size !== byteSize) throw new Error(`blob ${hash} size mismatch`)
      syncDirectory(dirname(target))
      syncDirectory(blobsDir)
      leases.set(hash, (leases.get(hash) ?? 0) + 1)
      return { hash, byteSize }
    } finally {
      await file.close()
      await unlink(tempPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
      })
    }
  }

  return {
    blobPath,
    stageBytes: data => stage([data]),
    stageFile: sourcePath => stage((async function* () {
      yield* createReadStream(sourcePath)
    })()),
    discardStaged(tx, staged) {
      release(staged)
      if (leases.has(staged.hash) || tx.query.blobs.findFirst({ where: (blobs, { eq }) => eq(blobs.hash, staged.hash) }).sync()) return
      try { unlinkSync(blobPath(staged.hash)) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    },
    registerVersion(tx, input) {
      const { staged } = input
      const stat = lstatSync(blobPath(staged.hash))
      if (!stat.isFile() || stat.size !== staged.byteSize) throw new Error(`blob ${staged.hash} does not exist or has a size mismatch`)
      const asset = input.assetId === undefined ? undefined : tx.query.assets.findFirst({
        where: (assets, { eq }) => eq(assets.id, input.assetId!),
      }).sync()
      if (input.assetId !== undefined && !asset) throw VisError.of('not_found', 'asset.not_found', { assetId: input.assetId }, `Asset ${input.assetId} does not exist`)
      if (asset && asset.kind !== input.kind) throw VisError.of('invalid_params', 'asset.kind_mismatch', { kind: asset.kind, versionKind: input.kind }, `Asset kind is ${asset.kind}; cannot register a ${input.kind} version`)
      const createdAt = now()
      const assetId = asset?.id ?? newId('asset', createdAt)
      const latest = tx.query.assetVersions.findFirst({
        where: (versions, { eq }) => eq(versions.assetId, assetId),
        orderBy: (versions, { desc }) => desc(versions.version),
      }).sync()
      const result = { assetId, assetVersionId: newId('assetVersion', createdAt), version: (latest?.version ?? 0) + 1 }
      tx.insert(s.blobs).values({ ...staged, createdAt }).onConflictDoNothing({ target: s.blobs.hash }).run()
      if (!asset) {
        tx.insert(s.assets).values({
          id: assetId, kind: input.kind, origin: input.origin,
          displayName: input.displayName ?? null, createdAt,
        }).run()
      }
      tx.insert(s.assetVersions).values({
        id: result.assetVersionId, assetId, version: result.version,
        blobHash: staged.hash, mime: input.mime, width: input.width ?? null,
        height: input.height ?? null, durationMs: input.durationMs ?? null,
        fps: input.kind === 'video' ? videoFrameRate(input.fps?.toString()) ?? null : null,
        hasAlpha: input.hasAlpha ?? null,
        fontFamily: input.fontFamily ?? null,
        sourceJobId: input.sourceJobId ?? null, createdAt,
      }).run()
      appendEvent(tx, {
        type: 'asset.versionAdded', entityType: 'asset', entityId: assetId, payload: result,
        ...(input.operationId === undefined ? {} : { operationId: input.operationId }),
      }, createdAt)
      release(staged)
      return result
    },
    getVersion(tx, assetVersionId) {
      const version = tx.query.assetVersions.findFirst({
        where: (versions, { eq }) => eq(versions.id, assetVersionId),
      }).sync()
      if (!version) return undefined
      const asset = tx.query.assets.findFirst({ where: (assets, { eq }) => eq(assets.id, version.assetId) }).sync()!
      return { ...version, kind: asset.kind }
    },
    async findOrphanBlobs(tx) {
      const registered = new Set(tx.select({ hash: s.blobs.hash }).from(s.blobs).all().map(row => row.hash))
      const orphans: string[] = []
      const dirs = await readdir(blobsDir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
        return []
      })
      for (const dir of dirs) {
        if (!dir.isDirectory() || !/^[a-f0-9]{2}$/.test(dir.name)) continue
        for (const file of await readdir(join(blobsDir, dir.name), { withFileTypes: true })) {
          if (file.isFile() && /^[a-f0-9]{64}$/.test(file.name) && file.name.startsWith(dir.name) && !registered.has(file.name)) {
            orphans.push(file.name)
          }
        }
      }
      return orphans.sort()
    },
  }
}
