import { join, relative } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import { distDir, stageDir } from './package-paths.mjs'
import { nativeFiles } from './stage.mjs'
import { iconDir } from './icons.mjs'
import { assertShellAsarContents, assertStagedTarget } from './packaging-helpers.mjs'
import { assertNoPackagedFFmpegSources } from './ffmpeg-source-offer.mjs'

const require = createRequire(import.meta.url)
const appBuilderRequire = createRequire(createRequire(require.resolve('electron-builder/package.json')).resolve('app-builder-lib/package.json'))
const { Arch } = require('electron-builder')
const target = assertStagedTarget(JSON.parse(await readFile(join(stageDir, 'target.json'), 'utf8')))

export default {
  appId: 'org.viscreative.desktop',
  productName: 'visCreative',
  electronVersion: target.electronVersion,
  directories: { app: join(stageDir, 'app'), output: distDir },
  files: ['dist/**/*', 'package.json'],
  asar: true,
  npmRebuild: false,
  beforePack: async context => {
    assertStagedTarget(target, { platform: context.electronPlatformName, arch: Arch[context.arch] })
  },
  afterPack: async context => {
    const resources = join(context.appOutDir, context.electronPlatformName === 'darwin' ? 'visCreative.app/Contents/Resources' : 'resources')
    assertNoPackagedFFmpegSources(join(resources, 'ffmpeg'))
    const files = appBuilderRequire('@electron/asar').listPackage(join(resources, 'app.asar'))
    assertShellAsarContents(files)
  },
  electronDownload: { cache: process.env.electron_config_cache },
  extraResources: [
    { from: join(stageDir, 'resources'), to: '.' },
    // electron-builder's generic copier skips a source root's node_modules directory, even in extraResources.
    { from: join(stageDir, 'resources/node_modules'), to: 'node_modules' },
  ],
  artifactName: 'visCreative-${version}-${arch}.${ext}',
  mac: {
    icon: join(iconDir, 'app.icns'),
    target: [{ target: 'dmg', arch: [target.arch] }],
    category: 'public.app-category.graphics-design',
    identity: '-',
    hardenedRuntime: false,
    entitlements: fileURLToPath(new URL('entitlements.mac.plist', import.meta.url)),
    entitlementsInherit: fileURLToPath(new URL('entitlements.mac.plist', import.meta.url)),
    preAutoEntitlements: false,
    notarize: false,
    // extraResources stay outside asar; explicitly include executable sidecars in the ad-hoc signature.
    binaries: (await nativeFiles(join(stageDir, 'resources'))).map(path => join('Contents/Resources', relative(join(stageDir, 'resources'), path))),
  },
  win: {
    icon: join(iconDir, 'app-win.png'),
    target: [{ target: 'nsis', arch: ['x64'] }],
    artifactName: 'visCreative-${version}-win-x64-setup.${ext}',
    signAndEditExecutable: true,
    forceCodeSigning: false,
  },
  nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true },
  dmg: { sign: false, icon: join(iconDir, 'app.icns') },
  publish: null,
}
