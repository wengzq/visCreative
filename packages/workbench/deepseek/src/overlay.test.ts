import { expect, it } from 'vitest'
import { dshOverlay } from './overlay'

const entries = ['tool-bash', 'tool-pwsh', 'tool-web', 'tool-subagent', 'tool-subagent-fork', 'tool-subagent-control', 'tool-workflow', 'tool-jobs']

it.each(['sandbox', 'none'] as const)('enables shell, web, subagents, workflows and jobs only in expanded mode (%s)', isolation => {
  const expanded = dshOverlay(undefined, undefined, true, undefined, isolation)
  const fallback = dshOverlay(undefined, undefined, false, undefined, isolation)
  for (const id of entries) {
    expect(expanded).not.toContain(`- id: ${id}\n  disabled: true`)
    expect(fallback).toContain(`- id: ${id}\n  disabled: true`)
  }
  expect(expanded).toContain('mode: danger-full-access')
  expect(expanded).toContain('policy: ask')
  expect(fallback).toContain('mode: read-only')
  expect(fallback).toContain('policy: never')
})
