import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { buildSandboxPolicy, prepareSandbox } from '@vis/workbench-core'
import { codebuddyDescriptor, codebuddySandbox } from './descriptor'

it('filters the environment and denies other Agents and CodeBuddy home-root files using a fake home', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'vis-codebuddy-sandbox-')))
  try {
    const home = join(dir, 'home')
    const cwd = join(dir, 'work')
    mkdirSync(home)
    mkdirSync(cwd)
    writeFileSync(join(home, '.codebuddy.json.backup'), 'fake backup')
    const forbiddenPaths = [...codebuddyDescriptor.forbiddenPaths, '~/.codex', '~/.dsh', '~/.claude', '~/.minimax']
    const env = { HOME: home, PATH: '/fake/bin', CODEBUDDY_API_KEY: 'fake-api-key', CODEBUDDY_AUTH_TOKEN: 'fake-auth-token', ARK_API_KEY: 'fake-provider-key', VIS_AGENT_TOKEN: 'fake-admin-token', NODE_OPTIONS: '--require=fake' }
    const prepared = prepareSandbox({ cwd, dataDir: join(dir, 'data'), env, platform: 'darwin', available: () => true, agent: { ...codebuddySandbox, forbiddenPaths } })
    expect(prepared.isolation).toBe('sandbox')
    expect(prepared.env).toMatchObject({ HOME: home, PATH: '/fake/bin', CODEBUDDY_CONFIG_DIR: join(home, '.codebuddy'), CODEBUDDY_API_KEY: 'fake-api-key', CODEBUDDY_AUTH_TOKEN: 'fake-auth-token' })
    for (const key of ['ARK_API_KEY', 'VIS_AGENT_TOKEN', 'NODE_OPTIONS']) expect(prepared.env).not.toHaveProperty(key)
    const deny = prepared.policy!.split('\n').find(line => line.startsWith('(deny file-read*'))!
    for (const name of ['.codex', '.dsh', '.claude', '.minimax', '.codebuddy.json', '.codebuddy.json.backup']) expect(deny).toContain(`(subpath ${JSON.stringify(join(home, name))})`)
    expect(deny).not.toContain(`(subpath ${JSON.stringify(join(home, '.codebuddy'))})`)
    const other = buildSandboxPolicy(cwd, join(dir, 'data'), home, join(home, '.other'), { runtimeDirectory: '.other', envPassthrough: [], forbiddenPaths: codebuddyDescriptor.forbiddenPaths })
    expect(other).toContain(`(subpath ${JSON.stringify(join(home, '.codebuddy'))})`)
    expect(other).toContain('/[.]codebuddy[.]json[.][^/]*$')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
