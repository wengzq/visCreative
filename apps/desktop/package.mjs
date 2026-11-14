import { fileURLToPath } from 'node:url'
import { root, distDir, stageDir } from './package-paths.mjs'
import { join } from 'node:path'
import { run, stage } from './stage.mjs'
import { buildIcons } from './icons.mjs'
import { desktopVersion, packageManagerInvocation } from './packaging-helpers.mjs'

const platform = process.argv.includes('--win') ? 'win32' : 'darwin'
const arch = platform === 'win32' || process.argv.includes('--x64') ? 'x64' : 'arm64'
if (platform === 'darwin' && process.platform !== 'darwin') throw new Error('dist:mac must run on macOS')
if (platform === 'win32' && (process.platform !== 'win32' || process.arch !== 'x64')) throw new Error('dist:win must run on a Windows x64 host')
if (!process.env.npm_execpath) throw new Error('Run this script through pnpm --filter @vis/desktop dist:mac or dist:win')
const versionIndex = process.argv.indexOf('--version')
const version = versionIndex >= 0 ? desktopVersion(process.argv[versionIndex + 1]) : process.env.VIS_DESKTOP_VERSION === undefined ? undefined : desktopVersion(process.env.VIS_DESKTOP_VERSION)
const packageManager = packageManagerInvocation(process.env.npm_execpath, ['--dir', root, 'build'])
await run(packageManager.command, packageManager.args)
await run(process.execPath, [fileURLToPath(new URL('build.mjs', import.meta.url))], { cwd: fileURLToPath(new URL('.', import.meta.url)) })
await run(process.execPath, [fileURLToPath(new URL('../../scripts/fetch-fonts.mjs', import.meta.url))])
await stage(arch, { platform, version })
await buildIcons()
// Import after cache environment variables and the resource tree are ready.
const { build, Arch, Platform } = await import('electron-builder')
const { default: config } = await import('./electron-builder.config.mjs')
await build({
  projectDir: join(stageDir, 'app'), config,
  targets: platform === 'win32' ? Platform.WINDOWS.createTarget('nsis', Arch.x64) : Platform.MAC.createTarget('dmg', arch === 'arm64' ? Arch.arm64 : Arch.x64),
  ...(platform === 'win32' ? { publish: 'never' } : {}),
})
console.log(`Desktop ${arch} package: ${distDir}`)
