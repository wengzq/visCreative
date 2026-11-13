import { delimiter } from 'node:path'
import { expect, it } from 'vitest'
import { agentPath } from './agent-path'

it('keeps vis first, user tools next and bundled media last', () => {
  expect(agentPath({ cliBinDir: '/app/cli', base: ['/user/bin', '/usr/bin'].join(delimiter), fallbackDirs: ['/app/ffmpeg'] }))
    .toBe(['/app/cli', '/user/bin', '/usr/bin', '/app/ffmpeg'].join(delimiter))
})

it('leaves the base unchanged without configured paths and omits unconfigured media', () => {
  expect(agentPath({ base: '/user/bin' })).toBe('/user/bin')
  expect(agentPath({})).toBeUndefined()
  expect(agentPath({ cliBinDir: '/app/cli', base: '/user/bin' })).toBe(['/app/cli', '/user/bin'].join(delimiter))
})

it('does not duplicate media already on PATH or a repeated fallback', () => {
  expect(agentPath({ cliBinDir: '/app/cli', base: ['/user/bin', '/app/ffmpeg', '/app/cli'].join(delimiter), fallbackDirs: ['/app/ffmpeg', '/other', '/other'] }))
    .toBe(['/app/cli', '/user/bin', '/app/ffmpeg', '/other'].join(delimiter))
})

it('uses the Windows delimiter without splitting drive letters', () => {
  expect(agentPath({ cliBinDir: 'C:\\App\\cli', base: 'C:\\User\\bin;C:\\Windows', fallbackDirs: ['C:\\App\\ffmpeg'], pathDelimiter: ';' }))
    .toBe('C:\\App\\cli;C:\\User\\bin;C:\\Windows;C:\\App\\ffmpeg')
})
