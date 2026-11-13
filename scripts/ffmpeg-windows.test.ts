import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { assertImportClosure, builtUsingSources, isSystemDll, objdumpImports, peImports, redactPaths, systemDlls, windowsRequirements } from './ffmpeg/windows.mjs'

const readJson = async (name: string) => JSON.parse(await readFile(new URL(`./ffmpeg/${name}`, import.meta.url), 'utf8'))

it('pins the Windows additions without changing or duplicating the ten macOS components', async () => {
  const shared = await readJson('sources.json')
  const windows = await readJson('sources-windows.json')
  expect(shared).toHaveLength(10)
  expect(windows.map((item: { id: string }) => item.id).sort()).toEqual(['amf', 'libvpl', 'nv-codec-headers', 'zlib'])
  const ids = new Set<string>()
  const archives = new Set<string>()
  for (const source of [...shared, ...windows]) {
    for (const field of ['id', 'version', 'license', 'url', 'archive', 'sha256']) expect(typeof source[field], `${source.id}.${field}`).toBe('string')
    expect(source.id).toMatch(/^[a-z0-9-]+$/)
    expect(source.version).toMatch(/^\d+(?:\.\d+)+$/)
    expect(source.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(source.url).toMatch(/^https:\/\//)
    expect(source.archive).toMatch(/^[a-z0-9.-]+\.tar\.(?:gz|xz)$/)
    expect(source.licenseFiles.length).toBeGreaterThan(0)
    for (const file of source.licenseFiles) expect(file).not.toMatch(/(?:^\/|\\|(?:^|\/)\.\.(?:\/|$))/)
    expect(ids.has(source.id)).toBe(false)
    expect(archives.has(source.archive)).toBe(false)
    ids.add(source.id)
    archives.add(source.archive)
  }
  expect(windows.filter((item: { id: string }) => item.id !== 'zlib').every((item: { license: string }) => item.license === 'MIT')).toBe(true)
  expect(windows.find((item: { id: string }) => item.id === 'zlib').license).toBe('Zlib')
})

it('retains every macOS requirement and changes only Windows hardware and AAC alternatives', async () => {
  const shared = await readJson('requirements.json')
  const before = structuredClone(shared)
  const windows = windowsRequirements(shared, await readJson('requirements-windows.json'))
  expect(shared).toEqual(before)
  expect(shared.encoders).toContain('h264_videotoolbox')
  expect(shared.encoders).toContain('aac_at')
  expect(windows.encoders).not.toContain('h264_videotoolbox')
  expect(windows.encoders).not.toContain('aac_at')
  for (const encoder of ['h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_mf', 'libopenh264', 'aac']) expect(windows.encoders).toContain(encoder)
  expect(windows.encoders.filter((name: string) => !['h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_mf'].includes(name))).toEqual(shared.encoders.filter((name: string) => !['h264_videotoolbox', 'aac_at'].includes(name)))
  for (const kind of ['decoders', 'muxers', 'demuxers', 'filters', 'protocols']) expect(windows[kind]).toEqual(shared[kind])
  expect(() => windowsRequirements(shared, { encoders: { remove: ['typo'] } })).toThrow('Unknown macOS requirement')
  expect(() => windowsRequirements(shared, { typo: { add: [] } })).toThrow('Unknown requirement kind')
})

it('allows only explicit system basenames and the complete case-insensitive DLL closure', () => {
  for (const [name, why] of Object.entries(systemDlls)) {
    expect(why.length).toBeGreaterThan(10)
    expect(isSystemDll(name.toUpperCase())).toBe(true)
  }
  for (const name of ['evil.dll', 'KERNEL32.dll/other.dll', '../kernel32.dll', 'C:\\Windows\\kernel32.dll', 'api-ms-win-crt-runtime-l1-1-0.dll', 'ucrtbase.dll', 'nvEncodeAPI64.dll', 'amfrt64.dll', 'libwinpthread-1.dll']) expect(isSystemDll(name)).toBe(false)
  expect(() => assertImportClosure({ 'ffmpeg.exe': ['KERNEL32.dll', 'avcodec-63.dll'], 'avcodec-63.dll': ['msvcrt.dll', 'libopenh264.dll'] }, ['ffmpeg.exe', 'AVCODEC-63.DLL', 'libopenh264.dll'])).not.toThrow()
  expect(() => assertImportClosure({ 'ffmpeg.exe': ['avcodec-63.dll'] }, ['ffmpeg.exe'])).toThrow('missing non-system DLL')
  expect(() => assertImportClosure({ 'avcodec.dll': ['../kernel32.dll'] }, [])).toThrow('basename')
  for (const name of ['libgcc_s_seh-1.dll', 'libstdc++-6.dll', 'libwinpthread-1.dll', 'libssp-0.dll', 'libatomic-1.dll', 'libgomp-1.dll']) expect(() => assertImportClosure({ 'avcodec.dll': [name] }, [name])).toThrow('linked statically')
  for (const name of ['ucrtbase.dll', 'api-ms-win-crt-runtime-l1-1-0.dll']) expect(() => assertImportClosure({ 'avcodec.dll': [name] }, [name])).toThrow('UCRT cannot be mixed')
  expect(objdumpImports('  DLL Name: KERNEL32.dll\n  DLL Name: avcodec-63.dll\n')).toEqual(['KERNEL32.dll', 'avcodec-63.dll'])
})

function image(delay = false) {
  const bytes = Buffer.alloc(0x800)
  bytes.write('MZ')
  bytes.writeUInt32LE(0x80, 0x3c)
  bytes.write('PE\0\0', 0x80)
  bytes.writeUInt16LE(0x8664, 0x84)
  bytes.writeUInt16LE(1, 0x86)
  bytes.writeUInt16LE(240, 0x94)
  const optional = 0x98
  bytes.writeUInt16LE(0x20b, optional)
  bytes.writeUInt32LE(16, optional + 108)
  bytes.writeUInt32LE(0x1000, optional + 120)
  bytes.writeUInt32LE(40, optional + 124)
  const section = optional + 240
  bytes.writeUInt32LE(0x1000, section + 12)
  bytes.writeUInt32LE(0x600, section + 16)
  bytes.writeUInt32LE(0x200, section + 20)
  bytes.writeUInt32LE(0x1060, 0x20c)
  bytes.write('KERNEL32.dll\0', 0x260)
  if (delay) {
    bytes.writeUInt32LE(0x1080, optional + 112 + 13 * 8)
    bytes.writeUInt32LE(64, optional + 116 + 13 * 8)
    bytes.writeUInt32LE(1, 0x280)
    bytes.writeUInt32LE(0x1100, 0x284)
    bytes.write('deferred.dll\0', 0x300)
  }
  return bytes
}

it('reads x64 PE ordinary and delay imports without external tools', () => {
  expect(peImports(image())).toEqual(['KERNEL32.dll'])
  const imports = peImports(image(true))
  expect(imports).toEqual(['KERNEL32.dll', 'deferred.dll'])
  expect(() => assertImportClosure({ 'ffmpeg.exe': imports }, ['ffmpeg.exe'])).toThrow('deferred.dll')
  expect(() => peImports(Buffer.from('not a PE'))).toThrow()
  expect(() => peImports(image().subarray(0, 0x220))).toThrow()
  const wrongArch = image()
  wrongArch.writeUInt16LE(0x14c, 0x84)
  expect(() => peImports(wrongArch)).toThrow('Windows x64')
  const escaped = image()
  escaped.writeUInt32LE(0xffffffff, 0x20c)
  expect(() => peImports(escaped)).toThrow('outside file-backed')
  const unterminated = image()
  unterminated.writeUInt32LE(20, 0x98 + 124)
  expect(() => peImports(unterminated)).toThrow('Unterminated PE import table')
  const absoluteDelay = image(true)
  absoluteDelay.writeUInt32LE(0, 0x280)
  expect(() => peImports(absoluteDelay)).toThrow('Delay imports must use RVAs')
})

it('redacts nested BUILDINFO paths in arguments, cross files and environment on both hosts', () => {
  const original = {
    commands: [{ args: ['--prefix=/cache/build/prefix', '-I/cache/build/prefix/include', '/cache/build/meson.ini'] }],
    compiler: 'compiler 13', cross: 'set(ROOT /cache/build/prefix)',
  }
  expect(redactPaths(original, '/cache/build/prefix', '/cache/build')).toEqual({
    commands: [{ args: ['--prefix=<prefix>', '-I<prefix>/include', '<work>/meson.ini'] }],
    compiler: 'compiler 13', cross: 'set(ROOT <prefix>)',
  })
  expect(original.cross).toContain('/cache/build')
  expect(redactPaths(['X:\\scratch\\prefix\\lib', 'X:/scratch/prefix/include', 'X:\\scratch\\cross.ini'], 'X:\\scratch\\prefix', 'X:\\scratch')).toEqual(['<prefix>\\lib', '<prefix>/include', '<work>\\cross.ini'])
})

it('uses the GCC source version recorded when the compiler runtime was built', () => {
  expect(builtUsingSources('gcc-13 (= 13.2.0-6ubuntu1)')).toEqual(['gcc-13=13.2.0-6ubuntu1'])
  expect(builtUsingSources('gcc-13 (= 13.2.0-6ubuntu1), mingw-w64 (= 11.0.1-3)')).toEqual(['gcc-13=13.2.0-6ubuntu1', 'mingw-w64=11.0.1-3'])
  expect(builtUsingSources('')).toEqual([])
  expect(() => builtUsingSources('gcc-13 (>= 13)')).toThrow('Invalid Built-Using')
  expect(() => builtUsingSources('gcc-13 (= $(anything))')).toThrow('Invalid Built-Using')
})
