import { isUtf8 } from 'node:buffer'
import { crc32, inflateRawSync } from 'node:zlib'
import { SKILL_SOURCE_LIMITS } from '@vis/protocol'
import { VisError } from '@vis/domain'

function checkExtra(extra: Buffer, path: string, invalid: (reason: string, message: string, path?: string) => never) {
  for (let offset = 0; offset < extra.length;) {
    if (offset + 4 > extra.length) invalid('skill.zip.extra_incomplete', 'Incomplete extra field', path)
    const id = extra.readUInt16LE(offset)
    const size = extra.readUInt16LE(offset + 2)
    if (id === 1) invalid('skill.zip.zip64', 'ZIP64 is not supported', path)
    offset += 4 + size
    if (offset > extra.length) invalid('skill.zip.extra_incomplete', 'Incomplete extra field', path)
  }
}

/** Return only regular files; directories participate in path validation, but links are not created and additional permissions are not restored. */
export function readSkillZip(buffer: Buffer): Array<{ path: string, data: Buffer, mode: number }> {
  if (buffer.length > SKILL_SOURCE_LIMITS.maxArchiveBytes) throw VisError.of('invalid_params', 'skill.archive_size_limit', { path: '' }, 'Archive exceeds 256 MiB')
  return readZip(buffer, SKILL_SOURCE_LIMITS)
}

/** Shared bounded ZIP validation; callers specify their source-specific limits. */
export function readZip(buffer: Buffer, options: { maxBytes?: number; maxFiles?: number; reasonPrefix?: string } = {}): Array<{ path: string, data: Buffer, mode: number }> {
  const maxBytes = options.maxBytes ?? 50 * 1024 ** 2
  const maxFiles = options.maxFiles ?? 2000
  function invalid(reason: string, message: string, path?: string): never {
    const mapped = options.reasonPrefix ? reason.replace('skill.zip', options.reasonPrefix) : reason
    throw VisError.of('invalid_params', mapped, { path: path ?? '' }, path ? `${message}: ${path}` : `Archive: ${message}`)
  }
  let end = -1
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 22 - 65535); offset--) {
    if (buffer.readUInt32LE(offset) === 0x06054b50 && offset + 22 + buffer.readUInt16LE(offset + 20) === buffer.length) {
      end = offset
      break
    }
  }
  if (end < 0) invalid('skill.zip.end_record', 'Missing a valid ZIP end record')
  const count = buffer.readUInt16LE(end + 10)
  const directorySize = buffer.readUInt32LE(end + 12)
  const directoryOffset = buffer.readUInt32LE(end + 16)
  if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff ||
      (end >= 20 && buffer.readUInt32LE(end - 20) === 0x07064b50)) invalid('skill.zip.zip64', 'ZIP64 is not supported')
  if (buffer.readUInt16LE(end + 4) !== 0 || buffer.readUInt16LE(end + 6) !== 0 ||
      buffer.readUInt16LE(end + 8) !== count) invalid('skill.zip.multi_volume', 'Multi-volume ZIP is not supported')
  if (directoryOffset + directorySize !== end) invalid('skill.zip.directory_location', 'Invalid central directory position or size')

  const entries: Array<{
    path: string, mode: number, flags: number, method: number, crc: number,
    size: number, compressedSize: number, localOffset: number, name: Buffer,
    directory: boolean, ignored: boolean,
  }> = []
  const paths = new Set<string>()
  const files = new Set<string>()
  const directories = new Set<string>()
  let declaredBytes = 0
  let fileCount = 0
  let offset = directoryOffset
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || buffer.readUInt32LE(offset) !== 0x02014b50) invalid('skill.zip.directory_incomplete', 'Incomplete central directory entry')
    const flags = buffer.readUInt16LE(offset + 8)
    const method = buffer.readUInt16LE(offset + 10)
    const crc = buffer.readUInt32LE(offset + 16)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const size = buffer.readUInt32LE(offset + 24)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const disk = buffer.readUInt16LE(offset + 34)
    const attributes = buffer.readUInt32LE(offset + 38)
    const localOffset = buffer.readUInt32LE(offset + 42)
    const next = offset + 46 + nameLength + extraLength + commentLength
    if (next > end) invalid('skill.zip.directory_incomplete', 'Incomplete central directory entry')
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength)
    if (!isUtf8(name)) invalid('skill.zip.filename_encoding', 'Filenames must use UTF-8 encoding')
    const original = name.toString('utf8')
    const slashPath = original.replaceAll('\\', '/')
    const parts = slashPath.split('/').filter(part => part !== '' && part !== '.')
    if (slashPath.startsWith('/') || parts.includes('..') || /^[a-z]:/i.test(parts[0] ?? '') || /[\x00-\x1f\x7f]/.test(original)) {
      invalid('skill.zip.unsafe_path', 'Entry must be a safe relative path', original || '.')
    }
    const path = parts.join('/').normalize('NFC')
    const unixMode = attributes >>> 16
    const type = unixMode & 0o170000
    if (type === 0o120000) invalid('skill.zip.symlink', 'Cannot import symlinks', path || '.')
    if ((type !== 0 && type !== 0o100000 && type !== 0o040000) || (attributes & 0x08) !== 0) invalid('skill.zip.special_file', 'Cannot import special files', path || '.')
    const directory = slashPath.endsWith('/') || type === 0o040000 || (attributes & 0x10) !== 0
    if ((!path && !directory) || (directory && size !== 0) || (directory && type === 0o100000)) invalid('skill.zip.directory_invalid', 'Invalid directory entry', path || '.')
    if ((flags & 0x2041) !== 0) invalid('skill.zip.encrypted', 'Encrypted ZIP is not supported', path || '.')
    if (method !== 0 && method !== 8) invalid('skill.zip.compression', 'Only stored and deflate compression are supported', path || '.')
    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff || disk === 0xffff) invalid('skill.zip.zip64', 'ZIP64 is not supported', path || '.')
    if (disk !== 0) invalid('skill.zip.multi_volume', 'Multi-volume ZIP is not supported', path || '.')
    checkExtra(buffer.subarray(offset + 46 + nameLength, offset + 46 + nameLength + extraLength), path || '.', invalid)

    // The default macOS filesystem merges case- and Unicode-equivalent paths; reject overwrites in advance.
    const key = path.toLowerCase()
    if (paths.has(key)) invalid('skill.zip.path_duplicate', 'Duplicate normalized entry paths', path || '.')
    paths.add(key)
    const ignored = !path || parts.some(part => ['.git', '__macosx', '.ds_store'].includes(part.toLowerCase()))
    if (!ignored) {
      if (parts.length - (directory ? 0 : 1) > 16) invalid('skill.zip.depth_limit', 'Directory depth exceeds 16 levels', path)
      const parents = key.split('/').slice(0, -1)
      for (let depth = 1; depth <= parents.length; depth++) {
        const parent = parents.slice(0, depth).join('/')
        if (files.has(parent)) invalid('skill.zip.path_conflict', 'File and directory paths conflict', path)
        directories.add(parent)
      }
      if ((!directory && directories.has(key)) || (directory && files.has(key))) invalid('skill.zip.path_conflict', 'File and directory paths conflict', path)
      if (directory) directories.add(key)
      else files.add(key)
      if (!directory) {
        if (++fileCount > maxFiles) invalid('skill.zip.file_limit', `File count exceeds ${maxFiles}`, path)
        declaredBytes += size
        if (declaredBytes > maxBytes) invalid('skill.zip.declared_size_limit', `Declared decompressed size exceeds ${maxBytes / 1024 ** 2} MiB`, path)
      }
    }
    entries.push({ path, mode: 0o644 | (unixMode & 0o111), flags, method, crc, size, compressedSize, localOffset, name, directory, ignored })
    offset = next
  }
  if (offset !== end) invalid('skill.zip.directory_count', 'Invalid central directory entry count or size')

  const ranges: Array<{ start: number, end: number, path: string }> = []
  const result: Array<{ path: string, data: Buffer, mode: number }> = []
  let actualBytes = 0
  for (const entry of entries) {
    const { path, localOffset, flags, method, compressedSize, size, crc, name } = entry
    if (localOffset + 30 > directoryOffset || buffer.readUInt32LE(localOffset) !== 0x04034b50) invalid('skill.zip.local_header_incomplete', 'Incomplete local file header', path)
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength
    let dataEnd = dataOffset + compressedSize
    if (dataEnd > directoryOffset || !buffer.subarray(localOffset + 30, localOffset + 30 + localNameLength).equals(name)) invalid('skill.zip.local_header_path', 'Invalid local file header path or size', path)
    const localFlags = buffer.readUInt16LE(localOffset + 6)
    if ((localFlags & 0x2041) !== 0) invalid('skill.zip.encrypted', 'Encrypted ZIP is not supported', path)
    if (localFlags !== flags || buffer.readUInt16LE(localOffset + 8) !== method) invalid('skill.zip.local_header_mismatch', 'Local file header does not match the central directory', path)
    checkExtra(buffer.subarray(localOffset + 30 + localNameLength, dataOffset), path, invalid)
    const localCrc = buffer.readUInt32LE(localOffset + 14)
    const localCompressedSize = buffer.readUInt32LE(localOffset + 18)
    const localSize = buffer.readUInt32LE(localOffset + 22)
    if (localCompressedSize === 0xffffffff || localSize === 0xffffffff) invalid('skill.zip.zip64', 'ZIP64 is not supported', path)
    if ((flags & 8) === 0) {
      if (localCrc !== crc || localCompressedSize !== compressedSize || localSize !== size) invalid('skill.zip.local_size_mismatch', 'Local file header size does not match the central directory', path)
    } else {
      if ((localCrc !== 0 && localCrc !== crc) || (localCompressedSize !== 0 && localCompressedSize !== compressedSize) || (localSize !== 0 && localSize !== size)) invalid('skill.zip.local_size_mismatch', 'Local file header size does not match the central directory', path)
      if (dataEnd + 12 > directoryOffset) invalid('skill.zip.descriptor_incomplete', 'Incomplete data descriptor', path)
      const signed = dataEnd + 16 <= directoryOffset && buffer.readUInt32LE(dataEnd) === 0x08074b50 &&
        buffer.readUInt32LE(dataEnd + 4) === crc && buffer.readUInt32LE(dataEnd + 8) === compressedSize && buffer.readUInt32LE(dataEnd + 12) === size
      const descriptor = dataEnd + (signed ? 4 : 0)
      if (descriptor + 12 > directoryOffset || buffer.readUInt32LE(descriptor) !== crc || buffer.readUInt32LE(descriptor + 4) !== compressedSize || buffer.readUInt32LE(descriptor + 8) !== size) invalid('skill.zip.descriptor_mismatch', 'Data descriptor does not match the central directory', path)
      dataEnd = descriptor + 12
    }
    ranges.push({ start: localOffset, end: dataEnd, path })
    if (entry.ignored) continue
    const compressed = buffer.subarray(dataOffset, dataOffset + compressedSize)
    let data: Buffer
    if (method === 0) data = compressed
    else {
      try {
        data = inflateRawSync(compressed, { maxOutputLength: Math.min(size + 1, maxBytes - actualBytes + 1) })
      } catch {
        invalid('skill.zip.decompression', `Decompression failed or actual size exceeds the declared size and ${maxBytes / 1024 ** 2} MiB limit`, path)
      }
    }
    actualBytes += data.length
    if (actualBytes > maxBytes) invalid('skill.zip.actual_size_limit', `Actual decompressed size exceeds ${maxBytes / 1024 ** 2} MiB`, path)
    if (data.length !== size) invalid('skill.zip.size_mismatch', 'Declared size does not match actual decompressed size', path)
    if (crc32(data) !== crc) invalid('skill.zip.crc_mismatch', 'File CRC validation failed', path)
    if (!entry.directory) result.push({ path, data, mode: entry.mode })
  }
  ranges.sort((a, b) => a.start - b.start)
  for (let index = 1; index < ranges.length; index++) {
    if (ranges[index]!.start < ranges[index - 1]!.end) invalid('skill.zip.entries_overlap', 'Local file entries overlap', ranges[index]!.path)
  }
  return result
}
