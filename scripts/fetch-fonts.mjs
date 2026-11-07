import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractFontZip } from './font-zip.mjs'

// Node 24 enables proxy environment handling at startup, before its first fetch.
if ((process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy) &&
    process.env.NODE_USE_ENV_PROXY !== '1' && !process.execArgv.includes('--use-env-proxy')) {
  const child = spawnSync(process.execPath, ['--use-env-proxy', fileURLToPath(import.meta.url)], {
    stdio: 'inherit', shell: false, windowsHide: true, env: { ...process.env, NODE_USE_ENV_PROXY: '1' },
  })
  if (child.error) console.error(child.error.message)
  process.exit(child.status ?? 1)
}

const root = fileURLToPath(new URL('../resources/fonts/', import.meta.url))
const target = join(root, 'files')
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

async function download(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(90_000) })
  if (!response.ok) throw new Error(`Font download returned HTTP ${response.status}: ${url}`)
  const chunks = []
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.byteLength
    if (size > 64 * 1024 ** 2) throw new Error(`Font download exceeds 64 MB: ${url}`)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

async function verifiedFile(file, expected, url, archive) {
  const path = join(target, file)
  let bytes
  try { bytes = await readFile(path) } catch (error) { if (error.code !== 'ENOENT') throw error }
  const cached = !!bytes
  if (!bytes) {
    const downloaded = await download(url)
    if (archive) {
      if (sha256(downloaded) !== archive.archiveSha256) {
        await rm(path, { force: true })
        throw new Error(`${file}: archive SHA-256 mismatch; no font was extracted`)
      }
      bytes = extractFontZip(downloaded, archive.archiveEntry)
    } else bytes = downloaded
  }
  const actual = sha256(bytes)
  if (actual !== expected) {
    await rm(path, { force: true })
    throw new Error(`${file}: SHA-256 mismatch (expected ${expected}, received ${actual}); the file was deleted`)
  }
  if (!cached) await writeFile(path, bytes)
  console.log(`${cached ? 'Verified' : 'Downloaded'} ${file} (${bytes.length} bytes)`)
}

try {
  const manifest = JSON.parse(await readFile(join(root, 'fonts.json'), 'utf8'))
  await mkdir(target, { recursive: true })
  for (const font of manifest) {
    await verifiedFile(font.file, font.sha256, font.url, font.archiveEntry ? font : undefined)
    await verifiedFile(font.licenseFile, font.licenseSha256, font.licenseUrl)
  }
} catch (error) {
  console.error(`fonts:fetch: ${error.message}`)
  console.error('Use Node 24 with HTTPS_PROXY / HTTP_PROXY when required (for this machine: http://127.0.0.1:10808). Offline installs do not fetch fonts.')
  process.exitCode = 1
}
