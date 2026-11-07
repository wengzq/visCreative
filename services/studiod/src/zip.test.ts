import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32, deflateRawSync } from 'node:zlib'
import { expect, it } from 'vitest'
import { VisError } from '@vis/domain'
import { readSkillZip } from './zip'
import { createSkillService } from './skills'

type Entry = {
  name: string
  data?: string | Buffer
  method?: number
  mode?: number
  flags?: number
  extra?: Buffer
  descriptor?: 'signed' | 'unsigned'
}

function zip(entries: Entry[], comment = ''): Buffer {
  const locals: Buffer[] = []
  const central: Buffer[] = []
  let localOffset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name)
    const data = typeof entry.data === 'string' ? Buffer.from(entry.data) : entry.data ?? Buffer.alloc(0)
    const method = entry.method ?? 0
    const compressed = method === 8 ? deflateRawSync(data) : data
    const extra = entry.extra ?? Buffer.alloc(0)
    const flags = (entry.flags ?? 0x800) | (entry.descriptor ? 8 : 0)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(flags, 6)
    local.writeUInt16LE(method, 8)
    if (!entry.descriptor) {
      local.writeUInt32LE(crc32(data), 14)
      local.writeUInt32LE(compressed.length, 18)
      local.writeUInt32LE(data.length, 22)
    }
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(extra.length, 28)
    const descriptor = Buffer.alloc(entry.descriptor ? (entry.descriptor === 'signed' ? 16 : 12) : 0)
    if (entry.descriptor) {
      const start = entry.descriptor === 'signed' ? 4 : 0
      if (start) descriptor.writeUInt32LE(0x08074b50)
      descriptor.writeUInt32LE(crc32(data), start)
      descriptor.writeUInt32LE(compressed.length, start + 4)
      descriptor.writeUInt32LE(data.length, start + 8)
    }
    locals.push(local, name, extra, compressed, descriptor)
    const header = Buffer.alloc(46)
    header.writeUInt32LE(0x02014b50)
    header.writeUInt16LE(0x0314, 4)
    header.writeUInt16LE(20, 6)
    header.writeUInt16LE(flags, 8)
    header.writeUInt16LE(method, 10)
    header.writeUInt32LE(crc32(data), 16)
    header.writeUInt32LE(compressed.length, 20)
    header.writeUInt32LE(data.length, 24)
    header.writeUInt16LE(name.length, 28)
    header.writeUInt16LE(extra.length, 30)
    header.writeUInt32LE(((entry.mode ?? (entry.name.endsWith('/') ? 0o040755 : 0o100644)) * 65536) >>> 0, 38)
    header.writeUInt32LE(localOffset, 42)
    central.push(header, name, extra)
    localOffset += local.length + name.length + extra.length + compressed.length + descriptor.length
  }
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(localOffset, 16)
  end.writeUInt16LE(Buffer.byteLength(comment), 20)
  return Buffer.concat([...locals, directory, end, Buffer.from(comment)])
}

function centralOffset(buffer: Buffer) {
  return buffer.readUInt32LE(buffer.length - 6)
}

function rejected(buffer: Buffer, reason: string | RegExp) {
  expect(() => readSkillZip(buffer)).toThrow(VisError)
  expect(() => readSkillZip(buffer)).toThrow(reason)
  try { readSkillZip(buffer) } catch (error) { expect((error as VisError).code).toBe('invalid_params') }
}

it('reads stored and deflate entries, Chinese filenames and comments, retaining only executable bits', () => {
  const files = readSkillZip(zip([
    { name: '示例/' },
    { name: './示例//SKILL.md', data: '说明' },
    { name: '示例/scripts/run.sh', data: '#!/bin/sh\necho ok', method: 8, mode: 0o107751 },
    { name: '示例/private.txt', data: '正文', mode: 0o100600 },
  ], '压缩包注释'))
  expect(files).toEqual([
    { path: '示例/SKILL.md', data: Buffer.from('说明'), mode: 0o644 },
    { path: '示例/scripts/run.sh', data: Buffer.from('#!/bin/sh\necho ok'), mode: 0o755 },
    { path: '示例/private.txt', data: Buffer.from('正文'), mode: 0o644 },
  ])
  expect(readSkillZip(zip([]))).toEqual([])
})

it.each(['signed', 'unsigned'] as const)('supports %s data descriptors', descriptor => {
  expect(readSkillZip(zip([{ name: 'SKILL.md', data: '正文', method: 8, descriptor }]))[0]?.data.toString()).toBe('正文')
})

it.each(['../escape', 'a/../escape', '/absolute', '\\absolute', 'C:/absolute', './C:/absolute', 'C:\\absolute', 'a\\..\\escape', 'nul\0file', 'a\nfile'])('rejects dangerous paths %j', name => {
  rejected(zip([{ name }]), 'safe relative path')
})

it('rejects empty filenames and allows root and deflate directory entries', () => {
  rejected(zip([{ name: '' }]), 'Invalid directory entry')
  expect(readSkillZip(zip([{ name: './' }, { name: 'dir/', method: 8 }, { name: 'dir/file' }]))).toEqual([{ path: 'dir/file', data: Buffer.alloc(0), mode: 0o644 }])
})

it.each([
  ['a/file', 'a//./file'], ['a/file', 'a\\file'], ['a/File', 'a/file'], ['é/file', 'e\u0301/file'], ['a/', 'a//'],
])('rejects duplicate normalized names: %s and %s', (first, second) => {
  rejected(zip([{ name: first }, { name: second }]), 'Duplicate')
})

it.each([
  ['a', 'a/file'], ['a/file', 'a'], ['a/', 'a'], ['a', 'a/'],
])('rejects file-directory conflicts: %s and %s', (first, second) => {
  rejected(zip([{ name: first }, { name: second }]), /conflict|Duplicate/)
})

it('supports child files before explicit directory entries', () => {
  expect(readSkillZip(zip([{ name: 'a/file', data: 'ok' }, { name: 'a/' }])).map(entry => entry.path)).toEqual(['a/file'])
})

it.each([0o120777, 0o010600, 0o020600, 0o060600, 0o140600])('rejects symlinks and special file types %i and identifies the relative path', mode => {
  rejected(zip([{ name: 'scripts/unsafe', mode }]), /(?:symlinks|special files): scripts\/unsafe/)
})

it.each([1, 0x40, 0x2000])('rejects encryption flags %i', flags => {
  rejected(zip([{ name: 'SKILL.md', flags }]), 'Encrypted')
})

it('also rejects encryption flags set only in the local header', () => {
  const buffer = zip([{ name: 'SKILL.md' }])
  buffer.writeUInt16LE(0x801, 6)
  rejected(buffer, 'Encrypted')
})

it('rejects unsupported compression methods', () => {
  rejected(zip([{ name: 'SKILL.md', method: 12 }]), 'stored and deflate')
})

it('reads 9999 and 10000 files and rejects the 10001st; directories and ignored entries do not count', () => {
  const entries = Array.from({ length: 10000 }, (_, index) => ({ name: `files/${index}` }))
  expect(readSkillZip(zip(entries.slice(0, -1)))).toHaveLength(9999)
  expect(readSkillZip(zip([...entries, { name: 'files/' }, { name: '.git/config' }, { name: '__MACOSX/extra' }, { name: 'files/.DS_Store' }]))).toHaveLength(10000)
  rejected(zip([...entries, { name: 'files/extra' }]), '10000')
})

it('limits directory depth to 16 levels without counting filenames', () => {
  const prefix = 'd/'.repeat(16)
  expect(readSkillZip(zip([{ name: `${prefix}SKILL.md` }]))).toHaveLength(1)
  rejected(zip([{ name: `${prefix}d/SKILL.md` }]), '16 levels')
  rejected(zip([{ name: `${prefix}d/` }]), '16 levels')
})

it('skips .git, __MACOSX and .DS_Store; ignored entries do not consume byte or depth limits', () => {
  const buffer = zip([
    { name: '.git/large' }, { name: '__MACOSX/extra' }, { name: `${'deep/'.repeat(20)}.DS_Store` }, { name: 'SKILL.md', data: 'ok' },
  ])
  const central = centralOffset(buffer)
  buffer.writeUInt32LE(60 * 1024 ** 2, central + 24)
  buffer.writeUInt32LE(60 * 1024 ** 2, 22)
  expect(readSkillZip(buffer)).toEqual([{ path: 'SKILL.md', data: Buffer.from('ok'), mode: 0o644 }])
})

it('rejects declared totals exceeding 512 MiB before decompression', () => {
  const buffer = zip([{ name: 'a' }, { name: 'b' }])
  const central = centralOffset(buffer)
  buffer.writeUInt32LE(257 * 1024 ** 2, central + 24)
  buffer.writeUInt32LE(257 * 1024 ** 2, central + 47 + 24)
  rejected(buffer, 'Declared decompressed size exceeds 512 MiB: b')
})

// Real payloads exercise both the parser and inflation; header-only fixtures missed the staging mismatch.
it('reads just below and at 512 MiB unpacked and rejects one byte over', () => {
  for (const size of [512 * 1024 ** 2 - 1, 512 * 1024 ** 2, 512 * 1024 ** 2 + 1]) {
    const buffer = zip([{ name: 'large', data: Buffer.alloc(size), method: 8 }])
    if (size <= 512 * 1024 ** 2) expect(readSkillZip(buffer)[0]?.data.length).toBe(size)
    else rejected(buffer, '512 MiB')
  }
}, 30_000)

it('reads real archives just below and at 256 MiB archived and rejects one byte over', () => {
  const overhead = zip([{ name: 'large' }]).length
  for (const size of [256 * 1024 ** 2 - 1, 256 * 1024 ** 2, 256 * 1024 ** 2 + 1]) {
    const buffer = zip([{ name: 'large', data: Buffer.alloc(size - overhead) }])
    expect(buffer.length).toBe(size)
    if (size <= 256 * 1024 ** 2) expect(readSkillZip(buffer)[0]?.data.length).toBe(size - overhead)
    else rejected(buffer, '256 MiB')
  }
}, 30_000)

it.each([0, 8])('rejects mismatches between declared and actual decompressed size, method=%i', method => {
  const buffer = zip([{ name: 'scripts/file', data: 'longer content', method }])
  buffer.writeUInt32LE(1, 22)
  buffer.writeUInt32LE(1, centralOffset(buffer) + 24)
  rejected(buffer, /[Dd]eclared|actual/)
})

it('stops inflate when output exceeds declared size to prevent compression bombs', () => {
  const buffer = zip([{ name: 'bomb', data: Buffer.alloc(8 * 1024 ** 2), method: 8 }])
  buffer.writeUInt32LE(0, 22)
  buffer.writeUInt32LE(0, centralOffset(buffer) + 24)
  rejected(buffer, 'Decompression failed or actual size exceeds the declared')
})

it('rejects CRC errors and corrupt deflate data', () => {
  const stored = zip([{ name: 'file', data: 'abc' }])
  stored[34] = 0
  rejected(stored, 'CRC')
  const deflated = zip([{ name: 'file', data: 'abc', method: 8 }])
  deflated[34] = 0xff
  rejected(deflated, 'Decompression failed')
})

it.each([Buffer.alloc(0), Buffer.from('not a zip'), zip([{ name: 'file' }]).subarray(0, -1)])('rejects missing or truncated end records', buffer => {
  rejected(buffer, 'ZIP end record')
})

it('rejects corrupt central directory positions, entry counts and entry lengths', () => {
  const badOffset = zip([{ name: 'file' }])
  badOffset.writeUInt32LE(0, badOffset.length - 6)
  rejected(badOffset, 'central directory')
  const badCount = zip([{ name: 'file' }])
  badCount.writeUInt16LE(2, badCount.length - 14)
  badCount.writeUInt16LE(2, badCount.length - 12)
  rejected(badCount, 'central directory')
  const badName = zip([{ name: 'file' }])
  badName.writeUInt16LE(0xffff, centralOffset(badName) + 28)
  rejected(badName, 'central directory')
})

it('rejects name, method and size mismatches between local headers and the central directory', () => {
  for (const [offset, value] of [[30, 0x78], [8, 8], [22, 99]]) {
    const buffer = zip([{ name: 'file', data: 'ok' }])
    buffer.writeUInt8(value!, offset!)
    rejected(buffer, /[Ll]ocal file header/)
  }
})

it('rejects corrupt data descriptors', () => {
  const buffer = zip([{ name: 'file', data: 'ok', descriptor: 'signed' }])
  buffer.writeUInt32LE(3, centralOffset(buffer) - 4)
  rejected(buffer, 'Data descriptor')
})

it('rejects overlapping local file data', () => {
  const nested = zip([{ name: 'b', data: 'ok' }])
  const buffer = zip([{ name: 'a', data: nested.subarray(0, centralOffset(nested)) }, { name: 'b', data: 'ok' }])
  buffer.writeUInt32LE(31, centralOffset(buffer) + 47 + 42)
  rejected(buffer, 'Local file entries overlap: b')
})

it('rejects non-UTF-8 filenames and incomplete extra fields', () => {
  const buffer = zip([{ name: 'a' }])
  buffer[30] = 0xff
  buffer[centralOffset(buffer) + 46] = 0xff
  rejected(buffer, 'UTF-8')
  rejected(zip([{ name: 'a', extra: Buffer.from([2, 0, 1]) }]), 'extra field')
})

it('explicitly rejects ZIP64 end records, entry sizes and extra fields', () => {
  const end = zip([])
  end.writeUInt16LE(0xffff, 10)
  rejected(end, 'ZIP64')
  const entry = zip([{ name: 'a' }])
  entry.writeUInt32LE(0xffffffff, centralOffset(entry) + 24)
  rejected(entry, 'ZIP64')
  rejected(zip([{ name: 'a', extra: Buffer.from([1, 0, 0, 0]) }]), 'ZIP64')
  const locator = Buffer.alloc(20)
  locator.writeUInt32LE(0x07064b50)
  rejected(Buffer.concat([locator, zip([])]), 'ZIP64')
})

it.runIf(process.platform !== 'win32')('POSIX: archive import preserves executable bits', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vis-skill-zip-mode-'))
  try {
    const root = join(dir, 'project')
    mkdirSync(root)
    const service = createSkillService(root, join(dir, 'data'))
    const source = join(dir, 'mode.zip')
    writeFileSync(source, zip([
      { name: 'SKILL.md', data: '---\nname: mode\ndescription: mode\n---\n' },
      { name: 'run', data: 'echo ok', mode: 0o100751 },
    ]))
    const staged = service.stage({ path: source })
    service.import({ stagingId: staged.stagingId, names: ['mode'] })
    expect(statSync(join(root, 'skills/mode/run')).mode & 0o777).toBe(0o755)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

it('rejects multi-volume ZIP files', () => {
  const buffer = zip([{ name: 'file' }])
  buffer.writeUInt16LE(1, buffer.length - 18)
  rejected(buffer, 'Multi-volume')
})

it('archive staging identifies root, wrapper, multiple and nested candidates; import preserves content and script hints', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vis-skill-zip-'))
  try {
    const root = join(dir, 'project')
    mkdirSync(root)
    const service = createSkillService(root, join(dir, 'data'))
    const skill = (name: string) => `---\nname: ${name}\ndescription: 压缩包技能\n---\n正文`
    const source = join(dir, 'root.zip')
    writeFileSync(source, zip([
      { name: 'SKILL.md', data: skill('根技能'), method: 8 },
      { name: 'nested/SKILL.md', data: skill('内嵌技能') },
      { name: 'run', data: 'echo ok', mode: 0o100751 },
      { name: 'script.py', data: 'print(1)' },
      { name: '.git/config', data: 'ignored' },
      { name: '__MACOSX/extra', data: 'ignored' },
      { name: '.DS_Store', data: 'ignored' },
    ]))
    const staged = service.stage({ path: source })
    expect(staged.candidates).toEqual([expect.objectContaining({ name: '根技能', fileCount: 4, executables: ['run', 'script.py'] })])
    expect(staged.skipped).toEqual([])
    service.import({ stagingId: staged.stagingId, names: ['根技能'] })
    expect(readFileSync(join(root, 'skills/根技能/SKILL.md'), 'utf8')).toBe(skill('根技能'))
    expect(readFileSync(join(root, 'skills/根技能/run'), 'utf8')).toBe('echo ok')
    expect(existsSync(join(root, 'skills/根技能/.git'))).toBe(false)

    const wrapped = join(dir, 'wrapped.skill')
    writeFileSync(wrapped, zip([{ name: 'outer/SKILL.md', data: skill('外包技能') }]))
    expect(service.stage({ path: wrapped }).candidates.map(candidate => candidate.name)).toEqual(['外包技能'])
    const many = join(dir, 'many.zip')
    writeFileSync(many, zip([
      { name: 'repo/skills/a/SKILL.md', data: skill('甲') },
      { name: 'repo/skills/b/SKILL.md', data: skill('乙') },
    ]))
    expect(service.stage({ path: many }).candidates.map(candidate => candidate.name).sort()).toEqual(['乙', '甲'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

it('archive errors provide stable reasons and paths with English messages', () => {
  expect(() => readSkillZip(Buffer.from('invalid'))).toThrow(expect.objectContaining({
    code: 'invalid_params', message: 'Archive: Missing a valid ZIP end record', details: { reason: 'skill.zip.end_record', params: { path: '' } },
  }))
  expect(() => readSkillZip(zip([{ name: '../outside' }]))).toThrow(expect.objectContaining({
    code: 'invalid_params', message: 'Entry must be a safe relative path: ../outside', details: { reason: 'skill.zip.unsafe_path', params: { path: '../outside' } },
  }))
})
