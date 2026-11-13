import assert from 'node:assert/strict'

// These are OS libraries, never redistributable compiler or vendor-driver DLLs.
export const systemDlls = {
  'kernel32.dll': 'Win32 process, memory, file and synchronization APIs',
  'ntdll.dll': 'Windows native runtime used by mingw-w64',
  'user32.dll': 'Win32 window and message APIs',
  'advapi32.dll': 'Registry and security APIs',
  'ole32.dll': 'COM initialization and activation',
  'oleaut32.dll': 'COM automation used by capture and Media Foundation',
  'shell32.dll': 'Windows shell paths',
  'bcrypt.dll': 'System random number generation',
  'ws2_32.dll': 'Winsock APIs used by Windows device support',
  'secur32.dll': 'Windows security support APIs',
  'mfplat.dll': 'Media Foundation platform',
  'mf.dll': 'Media Foundation encoder and media session APIs',
  'd3d11.dll': 'Direct3D 11 hardware frames',
  'dxgi.dll': 'Graphics adapter enumeration and surfaces',
  'dxva2.dll': 'DirectX video acceleration',
  'gdi32.dll': 'Windows graphics and font APIs',
  'dwrite.dll': 'DirectWrite font discovery for libass',
  'shlwapi.dll': 'Windows path helpers',
  'version.dll': 'Windows binary version queries',
  'winmm.dll': 'Windows audio capture and timers',
  'vfw32.dll': 'Video for Windows capture',
  'cfgmgr32.dll': 'Device enumeration in the oneVPL dispatcher',
  'psapi.dll': 'Process queries used by DirectShow capture',
  'msvcrt.dll': 'The selected mingw-w64 MSVCRT C runtime',
}

export function isSystemDll(name) {
  // Accept only basenames. A Windows API-set name is not permission to import arbitrary paths.
  return typeof name === 'string' && Object.hasOwn(systemDlls, name.toLowerCase())
}

export function assertImportClosure(imports, bundled) {
  const names = new Set([...bundled].map(name => name.toLowerCase()))
  for (const [binary, dependencies] of Object.entries(imports)) {
    for (const name of dependencies) {
      assert(!/[\\/:]/.test(name), `${binary}: dependency must be a basename: ${name}`)
      assert(!/^(?:libgcc|libstdc\+\+|libwinpthread|libssp|libatomic|libgomp)/i.test(name), `${binary}: toolchain runtime must be linked statically: ${name}`)
      assert(!/^(?:ucrtbase\.dll|api-ms-win-crt-)/i.test(name), `${binary}: UCRT cannot be mixed with MSVCRT: ${name}`)
      assert(isSystemDll(name) || names.has(name.toLowerCase()), `${binary}: missing non-system DLL ${name}`)
    }
  }
}

export function objdumpImports(output) {
  return [...output.matchAll(/^\s*DLL Name:\s*(\S+)\s*$/gm)].map(match => match[1])
}

export function builtUsingSources(value) {
  return value.split(',').map(item => item.trim()).filter(Boolean).map(item => {
    const match = /^([a-z0-9+.-]+) \(= ([a-zA-Z0-9+:~.-]+)\)$/.exec(item)
    assert(match, `Invalid Built-Using source identity: ${item}`)
    return `${match[1]}=${match[2]}`
  })
}

// Read both ordinary and delay imports so a deferred dependency cannot escape the closure check.
export function peImports(bytes) {
  const range = (offset, length) => {
    assert(Number.isInteger(offset) && offset >= 0 && offset + length <= bytes.length, 'Truncated PE file')
    return offset
  }
  assert.equal(bytes.toString('ascii', 0, 2), 'MZ', 'Expected a PE executable')
  const pe = bytes.readUInt32LE(range(0x3c, 4))
  assert.equal(bytes.toString('ascii', range(pe, 24), pe + 4), 'PE\0\0', 'Invalid PE signature')
  assert.equal(bytes.readUInt16LE(pe + 4), 0x8664, 'Expected Windows x64')
  const count = bytes.readUInt16LE(pe + 6)
  const optional = pe + 24
  const optionalSize = bytes.readUInt16LE(pe + 20)
  range(optional, optionalSize)
  assert.equal(bytes.readUInt16LE(optional), 0x20b, 'Expected PE32+')
  assert(optionalSize >= 112, 'Missing PE data directories')
  const directoryCount = bytes.readUInt32LE(optional + 108)
  const sections = []
  for (let index = 0; index < count; index++) {
    const start = range(optional + optionalSize + index * 40, 40)
    sections.push({ rva: bytes.readUInt32LE(start + 12), size: bytes.readUInt32LE(start + 16), offset: bytes.readUInt32LE(start + 20) })
  }
  const offsetOf = (rva, size) => {
    const section = sections.find(item => rva >= item.rva && rva + size <= item.rva + item.size)
    assert(section, `PE RVA outside file-backed sections: ${rva}`)
    return range(section.offset + rva - section.rva, size)
  }
  const stringAt = rva => {
    let value = ''
    for (let index = 0; index < 256; index++) {
      const char = bytes[offsetOf(rva + index, 1)]
      if (char === 0) {
        assert(/^[a-z0-9_.+-]+\.dll$/i.test(value), `Invalid PE DLL name: ${value}`)
        return value
      }
      value += String.fromCharCode(char)
    }
    throw new Error('Unterminated PE DLL name')
  }
  const imports = []
  for (const [index, stride, nameOffset] of [[1, 20, 12], [13, 32, 4]]) {
    if (directoryCount <= index) continue
    assert(optionalSize >= 112 + (index + 1) * 8, 'Truncated PE data directories')
    const directory = optional + 112 + index * 8
    const rva = bytes.readUInt32LE(directory)
    const size = bytes.readUInt32LE(directory + 4)
    if (!rva) continue
    let terminated = false
    for (let position = 0; position + stride <= size; position += stride) {
      const offset = offsetOf(rva + position, stride)
      if (bytes.subarray(offset, offset + stride).every(byte => byte === 0)) {
        terminated = true
        break
      }
      if (index === 13) assert.equal(bytes.readUInt32LE(offset) & 1, 1, 'Delay imports must use RVAs')
      imports.push(stringAt(bytes.readUInt32LE(offset + nameOffset)))
    }
    assert(terminated, 'Unterminated PE import table')
  }
  return [...new Set(imports)]
}

export function windowsRequirements(shared, overrides) {
  const result = structuredClone(shared)
  for (const [kind, changes] of Object.entries(overrides)) {
    assert(Array.isArray(result[kind]), `Unknown requirement kind: ${kind}`)
    for (const name of changes.remove ?? []) assert(result[kind].includes(name), `Unknown macOS requirement: ${name}`)
    result[kind] = [...new Set([...result[kind].filter(name => !(changes.remove ?? []).includes(name)), ...(changes.add ?? [])])]
  }
  return result
}

export function redactPaths(value, prefix, work) {
  const portable = text => {
    for (const [path, replacement] of [[prefix, '<prefix>'], [work, '<work>']]) {
      for (const variant of new Set([path, path.replaceAll('\\', '/')])) text = text.replaceAll(variant, replacement)
    }
    return text
  }
  if (typeof value === 'string') return portable(value)
  if (Array.isArray(value)) return value.map(item => redactPaths(item, prefix, work))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactPaths(item, prefix, work)]))
  return value
}
