import { expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { generation } from './generation'

it('explains video references through discovered model limits, hosting readiness and model-specific prompt naming', () => {
  for (const text of ['referenceInputs.video', 'requiresHosting', 'videoReferences', 'hosting_required', 'minMs', 'maxMs', 'totalMs', 'Seedance 2.0', 'Seedance 2.5', '视频1', '图片1', '音频1', '@视频1', 'per media type', 'content order', 'first-frame', 'real faces', 'billed tokens']) expect(generation).toContain(text)
  expect(generation).not.toMatch(/video inputs.*(?:rejected|not supported)/i)
  expect(generation).not.toMatch(/(?:15|30) (?:s|seconds)/)
})

it('records the literal-identifier lesson with the standard symptom, cause, alternative and source structure', () => {
  const lessons = readFileSync(new URL('../../../../../../docs/lessons/agents.md', import.meta.url), 'utf8')
  const entry = lessons.split(/^## /m).find(section => section.startsWith('Literal vendor prompt identifiers'))
  expect(entry).toBeDefined()
  for (const label of ['Symptom', 'Cause', 'Instead', 'Found in']) expect(entry).toContain(`- **${label}:**`)
  expect(entry).toContain('../rfc/0043-video-references-and-media-hosting.md#3-')
})

it('asks Agents to really try reading model docs before calling them unavailable (RFC 0048)', () => {
  for (const text of ['web tool', 'curl -sL', 'JavaScript notice', 'only after trying', 'name the URL', 'no network access']) expect(generation).toContain(text)
  expect(generation).not.toContain('If a page cannot be opened, say so briefly')
})
