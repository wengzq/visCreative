#!/usr/bin/env node
import { cp, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { availableParallelism } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { run, sha256 } from './ffmpeg/common.mjs'
import { assertImportClosure, builtUsingSources, isSystemDll, objdumpImports, peImports, redactPaths } from './ffmpeg/windows.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const args = process.argv.slice(2)
if (args.includes('--help')) {
  console.log('Usage: node scripts/build-ffmpeg-windows.mjs [--dry-run]\nUbuntu 24.04, mingw-w64 x64 MSVCRT. Environment: VIS_FFMPEG_OUT_DIR, VIS_FFMPEG_CACHE_DIR, VIS_FFMPEG_JOBS (at most 4 by default). Dry run downloads and verifies sources on any OS, then prints recipes without compiling.')
  process.exit(0)
}
if (args.some(arg => arg !== '--dry-run') || args.length > 1) throw new Error('Expected only --dry-run (see --help)')
const dry = args.includes('--dry-run')
if (!dry && process.platform !== 'linux') throw new Error('Build on Ubuntu 24.04 with the mingw-w64 MSVCRT toolchain')
const jobs = Number(process.env.VIS_FFMPEG_JOBS ?? Math.min(4, availableParallelism()))
if (!Number.isInteger(jobs) || jobs < 1 || jobs > 64) throw new Error('VIS_FFMPEG_JOBS must be an integer from 1 to 64')
const cache = resolve(process.env.VIS_FFMPEG_CACHE_DIR || join(root, 'artifacts/ffmpeg/cache'))
const target = resolve(process.env.VIS_FFMPEG_OUT_DIR || join(root, 'artifacts/ffmpeg/out'))
const work = join(cache, 'build-win32-x64')
const prefix = join(work, 'prefix')
const output = join(target, 'win32-x64')
if (/[\s']/.test(work)) throw new Error('VIS_FFMPEG_CACHE_DIR must not contain whitespace or single quotes')
const triple = 'x86_64-w64-mingw32'
const cc = `${triple}-gcc-posix`
const cxx = `${triple}-g++-posix`
const manifests = await Promise.all(['sources.json', 'sources-windows.json'].map(async name => JSON.parse(await readFile(join(root, 'scripts/ffmpeg', name), 'utf8'))))
// Hardware headers and dispatcher must be installed before FFmpeg configures.
const manifest = [...manifests[0].filter(item => item.id !== 'ffmpeg'), ...manifests[1], manifests[0].find(item => item.id === 'ffmpeg')]
await mkdir(cache, { recursive: true })
for (const source of manifest) {
  const path = join(cache, source.archive)
  let valid = false
  try { valid = await sha256(path) === source.sha256 } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (!valid) {
    const partial = `${path}.partial`
    await rm(partial, { force: true })
    run('curl', ['--fail', '--location', '--retry', '3', '--connect-timeout', '30', '--max-time', '900', '--output', partial, source.url], { stdio: 'inherit' })
    if (await sha256(partial) !== source.sha256) {
      await rm(partial, { force: true })
      throw new Error(`SHA-256 mismatch for ${source.archive}; no source was extracted`)
    }
    await rename(partial, path)
  }
  console.log(`Verified ${source.id} ${source.version} ${source.sha256}`)
}
if (!dry) {
  for (const tool of [cc, cxx, `${triple}-ar`, `${triple}-windres`, `${triple}-objdump`, 'make', 'pkg-config', 'nasm', 'meson', 'ninja', 'cmake', 'curl', 'tar', 'dpkg-query', 'apt-get']) run('which', [tool])
}
await rm(work, { recursive: true, force: true })
await mkdir(prefix, { recursive: true })
const env = { ...process.env }
for (const key of Object.keys(env)) {
  if (/^(?:CFLAGS|CXXFLAGS|CPPFLAGS|LDFLAGS|ARFLAGS|ASFLAGS|CFLAGS_FOR_BUILD|CXXFLAGS_FOR_BUILD|CPPFLAGS_FOR_BUILD|LDFLAGS_FOR_BUILD|LIBS|CC|CXX|AR|AS|LD|RC|STRIP|CROSS|CROSS_PREFIX|CPATH|C_INCLUDE_PATH|CPLUS_INCLUDE_PATH|LIBRARY_PATH|COMPILER_PATH|GCC_EXEC_PREFIX|CMAKE_.*|PKG_CONFIG_.*|LD_.*|DYLD_.*)$/.test(key)) delete env[key]
}
// A single linker argument prevents libtool from moving -lwinpthread outside a static-link group.
// Whole-archive also resolves pthread references introduced later by the compiler's static libstdc++.
const runtimeFlags = `-static-libgcc -static-libstdc++ -Wl,--whole-archive,/usr/${triple}/lib/libwinpthread.a,--no-whole-archive`
Object.assign(env, {
  // No global LD: libtool asks LD which linker it is, and the compiler driver makes it fall back to MSVC lib.exe archiving.
  CC: cc, CXX: cxx, CROSS: `${triple}-`, AR: `${triple}-ar`, RANLIB: `${triple}-ranlib`, RC: `${triple}-windres`, STRIP: `${triple}-strip`,
  CFLAGS: '-O2', CXXFLAGS: '-O2', LDFLAGS: runtimeFlags,
  PKG_CONFIG: 'pkg-config', PKG_CONFIG_PATH: '', PKG_CONFIG_LIBDIR: `${join(prefix, 'lib/pkgconfig')}:${join(prefix, 'share/pkgconfig')}`,
  PKG_CONFIG_SYSROOT_DIR: '', CMAKE_PREFIX_PATH: prefix,
})
if (!dry && /^#define _UCRT(?:\s|$)/m.test(run(cc, ['-dM', '-E', '-include', '_mingw.h', '-'], { env, input: '' }))) {
  throw new Error('This recipe requires the MSVCRT mingw-w64 compiler, not a UCRT variant')
}
const crossFile = join(work, 'meson-cross.ini')
const cmakeFile = join(work, 'cmake-cross.cmake')
// A cross build finds host tools only through this file, so nasm (libass, dav1d) must be named here.
const mesonText = `[binaries]\nc = '${cc}'\ncpp = '${cxx}'\nar = '${triple}-ar'\nstrip = '${triple}-strip'\nwindres = '${triple}-windres'\nnasm = 'nasm'\npkg-config = 'pkg-config'\n[host_machine]\nsystem = 'windows'\ncpu_family = 'x86_64'\ncpu = 'x86_64'\nendian = 'little'\n[properties]\nneeds_exe_wrapper = true\n`
const cmakeText = `set(CMAKE_SYSTEM_NAME Windows)\nset(CMAKE_SYSTEM_PROCESSOR x86_64)\nset(CMAKE_C_COMPILER ${cc})\nset(CMAKE_CXX_COMPILER ${cxx})\nset(CMAKE_RC_COMPILER ${triple}-windres)\nset(CMAKE_FIND_ROOT_PATH "${prefix}" "/usr/${triple}")\nset(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)\nset(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)\nset(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)\nset(CMAKE_FIND_ROOT_PATH_MODE_PACKAGE ONLY)\nset(CMAKE_FIND_USE_PACKAGE_REGISTRY OFF)\nset(CMAKE_FIND_USE_SYSTEM_PACKAGE_REGISTRY OFF)\n`
await writeFile(crossFile, mesonText)
await writeFile(cmakeFile, cmakeText)
const commands = []
let cwd = work
function build(command, parameters, extraEnv = {}) {
  const extra = Object.keys(extraEnv).length ? { env: extraEnv } : {}
  commands.push({ source: basename(cwd), command, args: parameters, ...extra })
  if (dry) console.log(JSON.stringify(redactPaths({ cwd, command, args: parameters, ...extra }, prefix, work)))
  else return run(command, parameters, { cwd, env: { ...env, ...extraEnv }, stdio: 'inherit' })
}
if (dry) {
  console.log('Cross-build environment:', JSON.stringify(redactPaths(Object.fromEntries(['CC', 'CXX', 'CFLAGS', 'CXXFLAGS', 'LDFLAGS', 'PKG_CONFIG_LIBDIR'].map(key => [key, env[key]])), prefix, work)))
  console.log(redactPaths(mesonText + cmakeText, prefix, work))
}
function meson(options) {
  build('meson', ['setup', 'build', '--prefix', prefix, '--libdir', 'lib', '--buildtype', 'release', '--default-library', 'shared', '--wrap-mode', 'nodownload', '--auto-features', 'disabled', '--cross-file', crossFile, ...options])
  build('meson', ['compile', '-C', 'build', '-j', String(jobs)])
  build('meson', ['install', '-C', 'build'])
}
function cmake(options) {
  build('cmake', ['-S', '.', '-B', 'build', '-G', 'Ninja', `-DCMAKE_TOOLCHAIN_FILE=${cmakeFile}`, `-DCMAKE_INSTALL_PREFIX=${prefix}`, '-DCMAKE_INSTALL_LIBDIR=lib', '-DCMAKE_INSTALL_BINDIR=bin', '-DCMAKE_BUILD_TYPE=Release', '-DBUILD_SHARED_LIBS=ON', '-DFETCHCONTENT_FULLY_DISCONNECTED=ON', ...options])
  build('cmake', ['--build', 'build', '--parallel', String(jobs)])
  build('cmake', ['--install', 'build'])
}
let configureFlags
for (const source of manifest) {
  cwd = join(work, source.id)
  if (!dry) await mkdir(cwd)
  build('tar', ['-xf', `${work}/../${source.archive}`, '-C', cwd, '--strip-components', '1'])
  switch (source.id) {
    case 'lame':
      build('./configure', [`--prefix=${prefix}`, '--build=x86_64-pc-linux-gnu', `--host=${triple}`, '--enable-shared', '--disable-static', '--disable-frontend', '--disable-decoder', '--disable-nasm', '--disable-dependency-tracking', 'CFLAGS=-O2 -std=gnu17 -Wno-implicit-function-declaration', 'ac_cv_prog_cc_c23=no'])
      build('make', [`-j${jobs}`])
      build('make', ['install'])
      break
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
      meson(['-Ddirectwrite=enabled', '-Dcoretext=disabled', '-Dfontconfig=disabled', '-Dasm=enabled'])
      break
    case 'openh264':
      build('make', [`-j${jobs}`, 'ARCH=x86_64', 'OS=mingw_nt', `PREFIX=${prefix}`, `CC=${cc}`, `CXX=${cxx}`, `AR=${triple}-ar`, `STRIP=${triple}-strip`, 'ASM=nasm', 'CFLAGS=-O2 -MMD -MP', 'CXXFLAGS=-O2 -std=c++17', `LDFLAGS=${runtimeFlags}`, 'USE_STACK_PROTECTOR=No', 'install-shared'])
      break
    case 'libvpx':
      // Upstream does not support shared libraries on win64. BSD libvpx can be embedded in shared avcodec.
      build('./configure', [`--prefix=${prefix}`, '--target=x86_64-win64-gcc', '--enable-static', '--disable-shared', '--disable-examples', '--disable-tools', '--disable-docs', '--disable-unit-tests', '--disable-webm-io', '--as=nasm'], { LD: cc })
      // libvpx links through the compiler driver; keep it on the posix-threads compiler rather than its ${CROSS}gcc default.
      build('make', [`-j${jobs}`], { LD: cc })
      build('make', ['install'], { LD: cc })
      break
    case 'opus':
      cmake(['-DOPUS_BUILD_TESTING=OFF', '-DOPUS_BUILD_PROGRAMS=OFF', '-DOPUS_DRED=OFF', '-DOPUS_OSCE=OFF', '-DOPUS_DEEP_PLC=OFF'])
      break
    case 'dav1d':
      meson(['-Denable_tools=false', '-Denable_tests=false'])
      break
    case 'nv-codec-headers':
      build('make', [`PREFIX=${prefix}`, 'LIBDIR=lib', 'install'])
      break
    case 'amf':
      build('mkdir', ['-p', join(prefix, 'include/AMF')])
      build('cp', ['-R', `${join(cwd, 'amf/public/include')}/.`, join(prefix, 'include/AMF')])
      break
    case 'libvpl':
      cmake(['-DBUILD_TESTS=OFF', '-DBUILD_EXAMPLES=OFF', '-DINSTALL_EXAMPLES=OFF', '-DBUILD_EXPERIMENTAL=OFF', '-DINSTALL_DEV=ON', '-DINSTALL_LIB=ON'])
      break
    case 'zlib':
      // Windows has no SDK zlib. PNG/APNG decoding and PNG encoding need this implementation.
      cmake(['-DZLIB_BUILD_SHARED=OFF', '-DZLIB_BUILD_STATIC=ON', '-DZLIB_BUILD_TESTING=OFF', '-DZLIB_INSTALL=ON'])
      // Upstream Windows CMake calls the archive libzs.a, while its pkg-config file requests -lz.
      build('cp', [join(prefix, 'lib/libzs.a'), join(prefix, 'lib/libz.a')])
      break
    case 'ffmpeg':
      configureFlags = [
        `--prefix=${prefix}`, '--target-os=mingw32', '--arch=x86_64', '--enable-cross-compile', `--cross-prefix=${triple}-`, `--cc=${cc}`, `--cxx=${cxx}`, '--pkg-config=pkg-config',
        `--extra-cflags=-O2 -I${prefix}/include`, `--extra-ldflags=-L${prefix}/lib`,
        '--enable-shared', '--disable-static', '--disable-autodetect', '--disable-gpl', '--disable-version3', '--disable-nonfree',
        '--disable-debug', '--disable-doc', '--disable-ffplay', '--disable-network',
        '--enable-zlib', '--disable-iconv',
        '--enable-mediafoundation', '--enable-ffnvcodec', '--enable-nvenc', '--enable-amf', '--enable-libvpl', '--enable-d3d11va', '--enable-dxva2',
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

// Capture the exact Ubuntu sources for statically linked GCC and mingw-w64 runtime code.
const toolchainPackages = ['gcc-mingw-w64-x86-64-posix', 'g++-mingw-w64-x86-64-posix', 'gcc-mingw-w64-x86-64-posix-runtime', 'mingw-w64-x86-64-dev', 'mingw-w64-common', 'gcc-13-base', 'gcc-13-source', 'binutils-mingw-w64-x86-64', 'make', 'pkg-config', 'nasm', 'meson', 'ninja-build', 'cmake', 'curl', 'xz-utils']
const runtimeSources = [
  ['gcc-mingw-w64-x86-64-posix-runtime', 'GPL-3.0-or-later WITH GCC-exception-3.1'],
  ['gcc-13-source', 'GPL-3.0-or-later WITH GCC-exception-3.1'],
  ['mingw-w64-common', 'mingw-w64 runtime licences (including ZPL-2.1, BSD, MIT and public domain)'],
]
const toolchain = {
  target: triple, cRuntime: 'msvcrt', threading: 'posix',
  runtimeLinkage: 'static libgcc, libstdc++ and winpthread; no compiler runtime DLLs',
  licenses: { gccRuntime: runtimeSources[0][1], mingwRuntime: runtimeSources[2][1] },
  packages: [], sourceIdentities: [],
}
const toolchainSources = []
cwd = join(work, 'toolchain-runtime')
if (!dry) await mkdir(cwd)
for (const pkg of toolchainPackages) {
  const query = ['-W', '-f=${Package}\\t${Version}\\t${source:Package}\\t${source:Version}\\t${Built-Using}\\n', pkg]
  if (dry) build('dpkg-query', query)
  else toolchain.packages.push(run('dpkg-query', query).trim())
}
for (const [pkg, license] of runtimeSources) {
  if (dry) {
    if (pkg === 'gcc-13-source') build('dpkg-query', ['-W', '-f=${Built-Using}', 'gcc-mingw-w64-x86-64-posix-runtime'])
    const identity = pkg === 'gcc-13-source' ? '<exact GCC source identity from compiler runtime Built-Using>' : `<exact source:Package=source:Version of ${pkg}>`
    build('apt-get', ['source', '--download-only', '--print-uris', identity])
    build('apt-get', ['source', '--download-only', identity])
    if (pkg === 'gcc-13-source') console.log('If apt no longer indexes the exact Built-Using GCC source, download its .dsc and SHA-256-verified payloads from the Ubuntu primary source archive.')
    continue
  }
  const identity = pkg === 'gcc-13-source'
    ? builtUsingSources(run('dpkg-query', ['-W', '-f=${Built-Using}', 'gcc-mingw-w64-x86-64-posix-runtime'])).find(item => item.startsWith('gcc-13='))
    : run('dpkg-query', ['-W', '-f=${source:Package}=${source:Version}', pkg]).trim()
  if (!identity) throw new Error('The compiler runtime must identify its exact GCC sources in Built-Using')
  toolchain.sourceIdentities.push(identity)
  let archives
  try {
    const uris = run('apt-get', ['source', '--download-only', '--print-uris', identity], { cwd })
    run('apt-get', ['source', '--download-only', identity], { cwd, stdio: 'inherit' })
    archives = [...uris.matchAll(/^'(https?:\/\/[^']+)'\s+(\S+)\s+/gm)].map(match => ({ url: match[1], archive: match[2] }))
  } catch (error) {
    if (pkg !== 'gcc-13-source') throw error
    // GCC can remain Built-Using after an apt index retires that source version.
    const [name, version] = identity.split('=')
    const directory = `https://launchpad.net/ubuntu/+archive/primary/+sourcefiles/${name}/${version}/`
    const dsc = `${name}_${version.replace(/^\d+:/, '')}.dsc`
    const download = (url, file) => run('curl', ['--fail', '--location', '--retry', '3', '--connect-timeout', '30', '--max-time', '900', '--output', join(cwd, file), url], { stdio: 'inherit' })
    download(directory + dsc, dsc)
    const contents = await readFile(join(cwd, dsc), 'utf8')
    const checksums = contents.match(/^Checksums-Sha256:\r?\n((?: [^\r\n]+\r?\n)+)/m)?.[1]
    if (!checksums) throw new Error(`Missing source checksums in ${dsc}`)
    archives = [{ url: directory + dsc, archive: dsc }]
    for (const line of checksums.trim().split(/\r?\n/)) {
      const match = /^([a-f0-9]{64})\s+\d+\s+([a-zA-Z0-9_.+~-]+)$/.exec(line.trim())
      if (!match) throw new Error(`Invalid source checksum in ${dsc}`)
      download(directory + match[2], match[2])
      if (await sha256(join(cwd, match[2])) !== match[1]) throw new Error(`Source checksum mismatch: ${match[2]}`)
      archives.push({ url: directory + match[2], archive: match[2] })
    }
  }
  const licenseDir = join(cwd, pkg)
  await mkdir(licenseDir)
  await cp(await realpath(`/usr/share/doc/${pkg}/copyright`), join(licenseDir, 'copyright'))
  for (const { archive, url } of archives) {
    toolchainSources.push({ id: `toolchain-runtime-${archive.replace(/[^a-zA-Z0-9-]/g, '-')}`, version: identity.split('=')[1], url, archive, license, licenseFiles: ['copyright'], sha256: await sha256(join(cwd, archive)), licenseDirectory: licenseDir })
  }
  if (!toolchainSources.some(source => source.version === identity.split('=')[1])) throw new Error(`No corresponding source archives for ${identity}`)
}
if (dry) {
  console.log(`DRY RUN: verified ${manifest.length} pinned archives; ${commands.length} commands; staging: ffmpeg.exe, ffprobe.exe and recursive PE import closure from <prefix>/bin or <prefix>/lib; reject toolchain DLLs; add runtime source archives, licence texts and exact recipes; write redacted BUILDINFO.json; rename win32-x64.partial to win32-x64.`)
  process.exit(0)
}
// Walk every DLL before replacing the last successful output.
const imports = {}
const binaries = new Map()
const pending = ['ffmpeg.exe', 'ffprobe.exe']
for (const name of pending) {
  if (binaries.has(name.toLowerCase())) continue
  const candidates = []
  for (const subdir of ['bin', 'lib']) {
    for (const entry of await readdir(join(prefix, subdir))) if (entry.toLowerCase() === name.toLowerCase()) candidates.push(join(prefix, subdir, entry))
  }
  if (!candidates.length) throw new Error(`Missing non-system dependency in the source prefix: ${name}`)
  const path = await realpath(candidates[0])
  binaries.set(name.toLowerCase(), { name, path })
  imports[name] = [...new Set([...objdumpImports(run(`${triple}-objdump`, ['-p', path])), ...peImports(await readFile(path))])]
  for (const dependency of imports[name]) if (!isSystemDll(dependency) && !binaries.has(dependency.toLowerCase())) pending.push(dependency)
}
assertImportClosure(imports, [...binaries.keys()])
const staging = `${output}.partial`
await rm(staging, { recursive: true, force: true })
await mkdir(join(staging, 'source/build-scripts/scripts'), { recursive: true })
for (const { name, path } of binaries.values()) await cp(path, join(staging, name))
for (const source of [...manifest, ...toolchainSources]) {
  const directory = join(staging, 'LICENSES', source.id)
  await mkdir(directory, { recursive: true })
  for (const file of source.licenseFiles) await cp(join(source.licenseDirectory ?? join(work, source.id), file), join(directory, basename(file)))
  await cp(join(source.licenseDirectory ? cwd : cache, source.archive), join(staging, 'source', source.archive))
}
await mkdir(join(staging, 'LICENSES/toolchain-runtime'), { recursive: true })
for (const [pkg] of runtimeSources) await cp(join(cwd, pkg, 'copyright'), join(staging, 'LICENSES/toolchain-runtime', `${pkg}.copyright`))
await cp(join(root, 'scripts/build-ffmpeg-windows.mjs'), join(staging, 'source/build-scripts/scripts/build-ffmpeg-windows.mjs'))
await cp(join(root, 'scripts/ffmpeg'), join(staging, 'source/build-scripts/scripts/ffmpeg'), { recursive: true })
await writeFile(join(staging, 'BUILDINFO.json'), JSON.stringify(redactPaths({
  platform: 'win32', arch: 'x64', builtAt: new Date().toISOString(), jobs,
  sources: [...manifest, ...toolchainSources.map(({ licenseDirectory, ...source }) => source)],
  configureFlags, commands, compiler: run(cc, ['--version']).split('\n')[0], toolchain, imports,
  crossFiles: { meson: mesonText, cmake: cmakeText },
  buildEnvironment: Object.fromEntries(['CC', 'CXX', 'CROSS', 'CFLAGS', 'CXXFLAGS', 'LDFLAGS', 'PKG_CONFIG_LIBDIR'].map(key => [key, env[key]])),
}, prefix, work), null, 2) + '\n')
await rm(output, { recursive: true, force: true })
await rename(staging, output)
console.log(`Built ${output}\nVerify on Windows: node scripts/ffmpeg/verify-windows.mjs ${JSON.stringify(output)}`)
