import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { codebuddyAvailability, codebuddyDescriptor } from '@vis/agent-codebuddy'
import { listAgents, registerAgents } from './agents'
import { codebuddyRuntime } from './codebuddy'

it('registers the CodeBuddy factory and probes executable availability without launching or inspecting login state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vis-codebuddy-registration-'))
  try {
    const env = { HOME: dir, PATH: dir }
    const factory = codebuddyRuntime({ socketPath: join(dir, 'vis.sock'), visMcp: { command: '/fake/vis', args: ['mcp'] }, env })
    const agents = registerAgents([{ descriptor: codebuddyDescriptor, runtime: factory, availability: () => codebuddyAvailability({ env }) }])
    expect(factory.descriptor).toEqual(codebuddyDescriptor)
    expect(Object.keys(agents)).toEqual(['codebuddy'])
    expect(listAgents(agents)).toEqual([{ ...codebuddyDescriptor, available: false, reason: 'executable_missing' }])
    const path = join(dir, process.platform === 'win32' ? 'codebuddy.exe' : 'codebuddy')
    writeFileSync(path, 'Fake executable; never run')
    chmodSync(path, 0o755)
    expect(listAgents(agents)).toEqual([{ ...codebuddyDescriptor, available: true }])
    expect(listAgents({ codebuddy: factory })[0]!.capabilities.models).toBe(true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
