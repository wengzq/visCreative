#!/usr/bin/env node
import { cp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { availableParallelism } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isSystemLibrary, linkedLibraries, rpaths, run, sha256 } from './ffmpeg/common.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const args = process.argv.slice(2)
if (args.includes('--help')) {
  console.log('Usage: node scripts/build-ffmpeg-macos.mjs --arch arm64|x64\nEnvironment: VIS_FFMPEG_OUT_DIR, VIS_FFMPEG_CACHE_DIR, VIS_FFMPEG_JOBS (default: at most 4)')
  process.exit(0)
}
const arch = args[1]
if (args.length !== 2 || args[0] !== '--arch' || !['arm64', 'x64'].includes(arch)) throw new Error('Expected --arch arm64|x64 (see --help)')
if (process.platform !== 'darwin') throw new Error('This build requires macOS and Xcode Command Line Tools (xcode-select --install)')
const cpu = arch === 'x64' ? 'x86_64' : 'arm64'
const jobs = Number(process.env.VIS_FFMPEG_JOBS ?? Math.min(4, availableParallelism()))
if (!Number.isInteger(jobs) || jobs < 1 || jobs > 64) throw new Error('VIS_FFMPEG_JOBS must be an integer from 1 to 64')
for (const tool of ['clang', 'clang++', 'make', 'pkg-config', 'nasm', 'meson', 'ninja', 'cmake', 'curl', 'tar', 'otool', 'install_name_tool', 'codesign']) {
  try { run('/usr/bin/which', [tool]) } catch {
    throw new Error(`Missing build tool ${tool}. Install Xcode Command Line Tools (xcode-select --install), then brew install pkg-config nasm meson ninja cmake. Homebrew supplies tools only.`)
  }
}
const sdk = run('xcrun', ['--sdk', 'macosx', '--show-sdk-path']).trim()
const target = resolve(process.env.VIS_FFMPEG_OUT_DIR || join(root, 'artifacts/ffmpeg/out'))
const cache = resolve(process.env.VIS_FFMPEG_CACHE_DIR || join(root, 'artifacts/ffmpeg/cache'))
const work = join(cache, `build-darwin-${arch}`)
const prefix = join(work, 'prefix')
const output = join(target, `darwin-${arch}`)
// Build systems tokenize these flags; refusing whitespace avoids silently linking against the host architecture.
if (/\s/.test(work) || /\s/.test(sdk)) throw new Error('The cache and SDK paths must not contain whitespace; set VIS_FFMPEG_CACHE_DIR to a path without spaces')
const manifest = JSON.parse(await readFile(join(root, 'scripts/ffmpeg/sources.json'), 'utf8'))
await mkdir(cache, { recursive: true })
for (const source of manifest) {
  const path = join(cache, source.archive)
  let valid = false
  try { valid = await sha256(path) === source.sha256 } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (!valid) {
    const partial = `${path}.partial`
    await rm(partial, { force: true })
    run('curl', ['--fail', '--location', '--retry', '3', '--connect-timeout', '30', '--max-time', '600', '--output', partial, source.url], { stdio: 'inherit' })
    if (await sha256(partial) !== source.sha256) {
      await rm(partial, { force: true })
      throw new Error(`SHA-256 mismatch for ${source.archive}; no source was extracted`)
    }
    await cp(partial, path)
    await rm(partial)
  }
  console.log(`Verified ${source.archive}`)
}
await rm(work, { recursive: true, force: true })
await mkdir(prefix, { recursive: true })
// No ambient compiler/search flags or Homebrew pkg-config libraries may enter a source build.
const env = { ...process.env }
for (const key of ['CFLAGS', 'CXXFLAGS', 'CPPFLAGS', 'LDFLAGS', 'CPATH', 'C_INCLUDE_PATH', 'CPLUS_INCLUDE_PATH', 'LIBRARY_PATH', 'CMAKE_PREFIX_PATH', 'CMAKE_INCLUDE_PATH', 'CMAKE_LIBRARY_PATH', 'DYLD_LIBRARY_PATH', 'DYLD_FALLBACK_LIBRARY_PATH', 'PKG_CONFIG_PATH', 'PKG_CONFIG_LIBDIR', 'PKG_CONFIG_SYSROOT_DIR']) delete env[key]
const flags = `-arch ${cpu} -isysroot ${sdk} -mmacosx-version-min=13.0`
Object.assign(env, {
  CC: 'clang', CXX: 'clang++', SDKROOT: sdk, MACOSX_DEPLOYMENT_TARGET: '13.0',
  CFLAGS: flags, CXXFLAGS: flags, LDFLAGS: `${flags} -Wl,-headerpad_max_install_names`,
  PKG_CONFIG_PATH: '', PKG_CONFIG_LIBDIR: join(prefix, 'lib/pkgconfig'),
  CMAKE_PREFIX_PATH: prefix,
})
const commands = []
let cwd
function build(command, parameters) {
  commands.push({ source: basename(cwd), command, args: parameters })
  run(command, parameters, { cwd, env, stdio: 'inherit' })
}
const crossFile = join(work, 'meson-cross.ini')
await writeFile(crossFile, `[binaries]\nc = 'clang'\ncpp = 'clang++'\nar = 'ar'\nstrip = 'strip'\npkg-config = 'pkg-config'\n[host_machine]\nsystem = 'darwin'\ncpu_family = '${arch === 'arm64' ? 'aarch64' : 'x86_64'}'\ncpu = '${cpu}'\nendian = 'little'\n[properties]\nneeds_exe_wrapper = true\n`)
function meson(options) {
  build('meson', ['setup', 'build', '--prefix', prefix, '--libdir', 'lib', '--buildtype', 'release', '--default-library', 'shared', '--wrap-mode', 'nodownload', '--auto-features', 'disabled', '--cross-file', crossFile, ...options])
  build('meson', ['compile', '-C', 'build', '-j', String(jobs)])
  build('meson', ['install', '-C', 'build'])
}
function cmake(options) {
  build('cmake', ['-S', '.', '-B', 'build', '-G', 'Ninja', `-DCMAKE_INSTALL_PREFIX=${prefix}`, '-DCMAKE_INSTALL_LIBDIR=lib', '-DCMAKE_BUILD_TYPE=Release', '-DBUILD_SHARED_LIBS=ON', '-DCMAKE_SYSTEM_NAME=Darwin', `-DCMAKE_SYSTEM_PROCESSOR=${cpu}`, `-DCMAKE_OSX_ARCHITECTURES=${cpu}`, `-DCMAKE_OSX_SYSROOT=${sdk}`, '-DCMAKE_OSX_DEPLOYMENT_TARGET=13.0', '-DCMAKE_FIND_FRAMEWORK=LAST', '-DCMAKE_FIND_USE_CMAKE_SYSTEM_PATH=OFF', '-DCMAKE_FIND_USE_PACKAGE_REGISTRY=OFF', '-DCMAKE_FIND_USE_SYSTEM_PACKAGE_REGISTRY=OFF', ...options])
  build('cmake', ['--build', 'build', '--parallel', String(jobs)])
  build('cmake', ['--install', 'build'])
}
let configureFlags
for (const source of manifest) {
  cwd = join(work, source.id)
  await mkdir(cwd)
  run('tar', ['-xf', join(cache, source.archive), '-C', cwd, '--strip-components', '1'])
  console.log(`Building ${source.id} ${source.version} (${arch}, ${jobs} jobs)`)
  switch (source.id) {
    case 'freetype':
      cmake(['-DFT_DISABLE_ZLIB=ON', '-DFT_DISABLE_BZIP2=ON', '-DFT_DISABLE_PNG=ON', '-DFT_DISABLE_HARFBUZZ=ON', '-DFT_DISABLE_BROTLI=ON'])
      break
    case 'harfbuzz':
      meson(['-Dfreetype=enabled', '-Dtests=disabled', '-Dutilities=disabled', '-Dsubset=disabled', '-Draster=disabled', '-Dvector=disabled', '-Dgpu=disabled'])
      break
    case 'fribidi':
      meson(['-Ddocs=false', '-Dbin=false', '-Dtests=false'])
      break
    case 'libass':
      meson(['-Dcoretext=enabled', '-Dfontconfig=disabled', '-Dasm=enabled'])
      break
    case 'openh264': {
      const options = [`ARCH=${cpu}`, 'OS=darwin', `PREFIX=${prefix}`, 'CC=clang', 'CXX=clang++', `CFLAGS=${flags} -O2 -fPIC -MMD -MP`, `CXXFLAGS=${flags} -O2 -fPIC -std=c++17 -stdlib=libc++`, `LDFLAGS=${flags} -stdlib=libc++ -Wl,-headerpad_max_install_names`]
      build('make', [`-j${jobs}`, ...options, 'install-shared'])
      break
    }
    case 'libvpx':
      build('./configure', [`--prefix=${prefix}`, `--target=${cpu}-darwin20-gcc`, '--enable-shared', '--disable-static', '--enable-pic', '--disable-examples', '--disable-tools', '--disable-docs', '--disable-unit-tests', '--disable-webm-io'])
      build('make', [`-j${jobs}`])
      build('make', ['install'])
      break
    case 'opus':
      cmake(['-DOPUS_BUILD_TESTING=OFF', '-DOPUS_BUILD_PROGRAMS=OFF', '-DOPUS_DRED=OFF', '-DOPUS_OSCE=OFF', '-DOPUS_DEEP_PLC=OFF'])
      break
    case 'dav1d':
      meson(['-Denable_tools=false', '-Denable_tests=false'])
      break
    case 'lame':
      // Upstream legacy ID3 declarations do not compile as C23: https://sourceforge.net/p/lame/bugs/517/
      build('./configure', [`--prefix=${prefix}`, `--build=${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-apple-darwin`, `--host=${arch === 'arm64' ? 'aarch64' : 'x86_64'}-apple-darwin`, '--enable-shared', '--disable-static', '--disable-frontend', '--disable-decoder', '--disable-nasm', '--disable-dependency-tracking', `CFLAGS=${flags} -std=gnu17 -Wno-implicit-function-declaration`, 'ac_cv_prog_cc_c23=no'])
      build('make', [`-j${jobs}`])
      build('make', ['install'])
      break
    case 'ffmpeg':
      configureFlags = [
        `--prefix=${prefix}`, '--target-os=darwin', `--arch=${cpu}`, '--enable-cross-compile', '--cc=clang', '--cxx=clang++',
        `--extra-cflags=${flags} -I${prefix}/include`, `--extra-ldflags=${flags} -L${prefix}/lib -Wl,-headerpad_max_install_names`,
        '--extra-libs=-liconv',
        '--enable-shared', '--disable-static', '--disable-autodetect', '--disable-gpl', '--disable-version3', '--disable-nonfree',
        '--disable-debug', '--disable-doc', '--disable-ffplay', '--disable-network',
        '--enable-videotoolbox', '--enable-audiotoolbox', '--enable-zlib', '--enable-iconv',
        '--enable-libass', '--enable-libfreetype', '--enable-libharfbuzz', '--enable-libfribidi',
        '--enable-libopenh264', '--enable-libvpx', '--enable-libopus', '--enable-libdav1d', '--enable-libmp3lame',
      ]
      build('./configure', configureFlags)
      build('make', [`-j${jobs}`])
      build('make', ['install'])
      break
    default: throw new Error(`No build recipe for ${source.id}`)
  }
}
// Stage separately, so a failed build never destroys the last bundle used by packaging.
const staging = `${output}.partial`
await rm(staging, { recursive: true, force: true })
await mkdir(staging, { recursive: true })
for (const name of ['ffmpeg', 'ffprobe']) await cp(join(prefix, 'bin', name), join(staging, name))
const pending = ['ffmpeg', 'ffprobe']
const bundled = new Set(pending)
// libvpx installs a bare dylib ID; resolve it only inside our source-built prefix before rewriting it.
const fromPrefix = lib => lib.startsWith(`${prefix}/`) || lib.startsWith('@rpath/') || lib.startsWith('@loader_path/') || (lib === basename(lib) && lib.endsWith('.dylib'))
for (const name of pending) {
  for (const lib of linkedLibraries(join(staging, name))) {
    if (isSystemLibrary(lib)) continue
    if (!fromPrefix(lib)) throw new Error(`Unbundled dependency: ${lib} in ${name}`)
    const dependency = basename(lib)
    if (bundled.has(dependency)) continue
    await cp(await realpath(join(prefix, 'lib', dependency)), join(staging, dependency))
    bundled.add(dependency)
    pending.push(dependency)
  }
}
const binaries = (await readdir(staging)).map(name => join(staging, name))
for (const binary of binaries) {
  const changes = []
  if (binary.endsWith('.dylib')) changes.push('-id', `@loader_path/${basename(binary)}`)
  for (const lib of linkedLibraries(binary)) {
    if (isSystemLibrary(lib)) continue
    if (!fromPrefix(lib)) throw new Error(`Unbundled dependency: ${lib} in ${basename(binary)}`)
    const local = join(staging, basename(lib))
    await realpath(local)
    changes.push('-change', lib, `@loader_path/${basename(lib)}`)
  }
  for (const path of rpaths(binary)) changes.push('-delete_rpath', path)
  changes.push('-add_rpath', '@loader_path')
  run('install_name_tool', [...changes, binary])
  run('codesign', ['--force', '--sign', '-', binary])
}
for (const source of manifest) {
  await mkdir(join(staging, 'LICENSES', source.id), { recursive: true })
  for (const file of source.licenseFiles) await cp(join(work, source.id, file), join(staging, 'LICENSES', source.id, basename(file)))
  await mkdir(join(staging, 'source'), { recursive: true })
  await cp(join(cache, source.archive), join(staging, 'source', source.archive))
}
await mkdir(join(staging, 'source/build-scripts/scripts'), { recursive: true })
await cp(join(root, 'scripts/build-ffmpeg-macos.mjs'), join(staging, 'source/build-scripts/scripts/build-ffmpeg-macos.mjs'))
await cp(join(root, 'scripts/ffmpeg'), join(staging, 'source/build-scripts/scripts/ffmpeg'), { recursive: true })
const portable = value => value.replaceAll(prefix, '<prefix>').replaceAll(work, '<work>').replaceAll(sdk, '<sdk>')
await writeFile(join(staging, 'BUILDINFO.json'), JSON.stringify({
  platform: 'darwin', arch, minimumMacOS: '13.0', builtAt: new Date().toISOString(), jobs,
  sources: manifest, configureFlags: configureFlags.map(portable),
  commands: commands.map(item => ({ ...item, args: item.args.map(portable) })),
  compiler: run('clang', ['--version']).split('\n')[0], sdkVersion: run('xcrun', ['--sdk', 'macosx', '--show-sdk-version']).trim(),
}, null, 2) + '\n')
await rm(output, { recursive: true, force: true })
await cp(staging, output, { recursive: true })
await rm(staging, { recursive: true, force: true })
console.log(`Built ${output}\nVerify: node scripts/ffmpeg/verify.mjs ${JSON.stringify(output)}`)
