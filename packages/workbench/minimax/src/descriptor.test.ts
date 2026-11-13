import { expect, it } from 'vitest'
import { minimaxDescriptor, minimaxSandbox } from './descriptor'

it('declares the MiniMax Code capabilities, original stroke icon and installation hints', () => {
  expect(minimaxDescriptor).toMatchObject({
    kind: 'minimax-code', label: 'MiniMax Code', homepage: 'https://github.com/MiniMax-AI/minimax-code',
    install: { command: 'npm install -g @minimax-ai/code', hint: { zh: expect.any(String), en: expect.any(String) } },
    envPassthrough: ['MCODE_PROVIDER_API_KEY'],
    forbiddenPaths: ['~/.minimax', '~/.mavis', '~/.mavis-*'],
    capabilities: { resume: true, interrupt: true, models: true, effort: true, approvals: true },
  })
  expect(minimaxDescriptor.icon.length).toBeGreaterThan(0)
  expect(minimaxDescriptor.icon.every(path => !/[<>]/.test(path))).toBe(true)
  expect(minimaxDescriptor.forbiddenPaths).not.toContain('~/.minimax-*')
  expect(minimaxSandbox).toEqual({ runtimeDirectory: '.minimax', envPassthrough: ['MCODE_PROVIDER_API_KEY'] })
})
