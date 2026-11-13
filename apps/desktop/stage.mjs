import { spawn } from 'node:child_process'
import { chmod, cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { outputDir, root, stageDir } from './package-paths.mjs'
import { assertStagedTarget, visLauncher } from './packaging-helpers.mjs'
import { ffmpegSourceOffer, includeFFmpegResource } from './ffmpeg-source-offer.mjs'

const desktop = fileURLToPath(new URL('.', import.meta.url))
const require = createRequire(import.meta.url)
const studiodRequire = createRequire(join(root, 'services/studiod/package.json'))

export async function run(command, args, options = {}) {
  const child = spawn(command, args, { stdio: 'inherit', shell: false, ...options })
  await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${basename(command)} exited with ${code}`)))
  })
}

function packageRoot(name, resolver = studiodRequire) {
  let dir = dirname(resolver.resolve(name))
  while (dir !== dirname(dir)) {
    try {
      if (require(join(dir, 'package.json')).name === name) return dir
    } catch { /* the entry may be below the package root */ }
    dir = dirname(dir)
  }
  throw new Error(`Cannot locate runtime package ${name}`)
}

const copy = (from, to, options = {}) => cp(from, to, { recursive: true, dereference: true, ...options })
const withoutModules = path => basename(path) !== 'node_modules'

export async function stage(arch) {
  const target = assertStagedTarget({ arch, platform: 'darwin', electronVersion: require('electron/package.json').version })
  const app = join(stageDir, 'app')
  const resources = join(stageDir, 'resources')
  const modules = join(resources, 'node_modules')
  await rm(stageDir, { recursive: true, force: true })
  await mkdir(app, { recursive: true })
  await mkdir(join(app, 'node_modules'))
  await mkdir(modules, { recursive: true })
  const metadata = JSON.parse(await readFile(join(desktop, 'package.json'), 'utf8'))
  await writeFile(join(app, 'package.json'), JSON.stringify({ name: 'vis-creative-desktop', version: metadata.version, description: metadata.description, main: 'dist/main.mjs', type: 'module', author: 'visCreative contributors', dependencies: {} }, null, 2) + '\n')
  await copy(join(desktop, 'dist'), join(app, 'dist'))
  await copy(join(root, 'services/studiod/dist'), join(resources, 'studiod/dist'))
  await copy(join(root, 'services/studiod/migrations'), join(resources, 'studiod/migrations'))
  await copy(join(root, 'apps/web/dist/client'), join(resources, 'web/client'))
  await copy(join(root, 'apps/cli/dist/vis.mjs'), join(resources, 'cli/vis.mjs'))
  // Resolve from the installed app at invocation time, including spaces and a renamed .app directory.
  await writeFile(join(resources, 'cli/vis'), visLauncher, { mode: 0o755 })
  await chmod(join(resources, 'cli/vis'), 0o755)
  await copy(join(root, 'resources/fonts/files'), join(resources, 'fonts'))

  const ffmpeg = process.env.VIS_PACKAGE_FFMPEG_DIR
  if (ffmpeg) {
    const bundleRoot = resolve(ffmpeg)
    const buildInfo = JSON.parse(await readFile(join(bundleRoot, 'BUILDINFO.json'), 'utf8'))
    if (buildInfo.platform !== target.platform || buildInfo.arch !== target.arch) throw new Error('The ffmpeg bundle does not match the staged platform and architecture')
    const sourceUrl = process.env.VIS_FFMPEG_SOURCE_URL?.trim() ?? ''
    const offer = ffmpegSourceOffer(buildInfo, sourceUrl)
    await copy(bundleRoot, join(resources, 'ffmpeg'), { filter: path => includeFFmpegResource(bundleRoot, path) })
    await writeFile(join(resources, 'ffmpeg/SOURCE-OFFER.txt'), offer)
    if (!sourceUrl) console.warn('WARNING: VIS_FFMPEG_SOURCE_URL is unset; this local preview offers sources on request. The d1 release script must require a hosted source URL.')
    for (const name of ['ffmpeg', 'ffprobe']) await chmod(join(resources, 'ffmpeg', name), 0o755)
  } else console.warn('WARNING: VIS_PACKAGE_FFMPEG_DIR is unset; ffmpeg is omitted and this app requires ffmpeg/ffprobe on PATH for media operations.')

  const sqliteSource = packageRoot('better-sqlite3')
  const sqlite = join(modules, 'better-sqlite3')
  await copy(sqliteSource, sqlite, { filter: path => withoutModules(path) && !['prebuilds', 'build'].includes(basename(path)) })
  // Build only the staged copy, never pnpm's shared source dependency. Remove its build-time headers afterwards.
  await copy(packageRoot('node-addon-api', createRequire(join(sqliteSource, 'package.json'))), join(sqlite, 'node_modules/node-addon-api'), { filter: withoutModules })
  const builderRequire = createRequire(require.resolve('electron-builder/package.json'))
  const appBuilderRequire = createRequire(builderRequire.resolve('app-builder-lib/package.json'))
  const rebuildRequire = createRequire(appBuilderRequire.resolve('@electron/rebuild'))
  const nodeGyp = rebuildRequire.resolve('node-gyp/bin/node-gyp.js')
  const electronVersion = require('electron/package.json').version
  await run(process.execPath, [nodeGyp, 'rebuild', '--release', '--force_build=1', '--runtime=electron', `--target=${electronVersion}`, `--arch=${arch}`, '--dist-url=https://www.electronjs.org/headers', `--devdir=${join(outputDir, 'cache/headers')}`], { cwd: sqlite })
  const native = await readFile(join(sqlite, 'build/Release/better_sqlite3.node'))
  for (const name of ['node_modules', 'build', 'src', 'deps', 'binding.gyp']) await rm(join(sqlite, name), { recursive: true, force: true })
  await mkdir(join(sqlite, 'build/Release'), { recursive: true })
  await writeFile(join(sqlite, 'build/Release/better_sqlite3.node'), native)

  const sdkName = '@anthropic-ai/claude-agent-sdk'
  const sdkSource = packageRoot(sdkName)
  const sdk = join(modules, sdkName)
  await copy(sdkSource, sdk, { filter: withoutModules })
  const nativeName = `${sdkName}-darwin-${arch}`
  const sdkRequire = createRequire(join(sdkSource, 'package.json'))
  const binarySource = dirname(sdkRequire.resolve(`${nativeName}/claude`))
  await copy(binarySource, join(sdk, 'node_modules', nativeName), { filter: withoutModules })
  await copy(packageRoot('playwright-core'), join(modules, 'playwright-core'), { filter: withoutModules })
  await writeFile(join(stageDir, 'target.json'), JSON.stringify(target, null, 2) + '\n')

  return { app, resources }
}

export async function nativeFiles(dir) {
  const paths = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) paths.push(...await nativeFiles(path))
    else if (entry.name.endsWith('.node') || entry.name.endsWith('.dylib') || ['claude', 'ffmpeg', 'ffprobe'].includes(entry.name)) paths.push(path)
  }
  return paths
}
