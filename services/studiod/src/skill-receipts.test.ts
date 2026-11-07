import { expect, it } from 'vitest'
import { skillReceipt } from '@vis/workbench-core'
import { translate as codex } from '../../../packages/workbench/codex/src/translate'
import { translate as claude } from '../../../packages/workbench/claude/src/translate'
import { createTranslator } from '../../../packages/workbench/deepseek/src/translate'

it('retains skill draft card metadata in all adapters when the body exceeds the tool-log limit', () => {
  const draft = { draftId: 'd', revision: 1, name: 'method', description: 'My reasons', body: 'Long method.\n'.repeat(1000), spaceId: 'p', sessionId: 's', createdAt: 1 }
  const text = JSON.stringify({ draft, location: 'Settings > My skills' })
  const { body: _body, ...summary } = draft
  expect(skillReceipt(text)).toEqual({ skillDraft: summary })
  const results = [
    codex('completed', 't', { id: 'call', type: 'mcpToolCall', server: 'vis', tool: 'skill_proposeDraft', result: { content: [{ type: 'text', text }] } }).at(-1),
    claude({ type: 'user', uuid: 'u', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'call', content: text }] } } as unknown as Parameters<typeof claude>[0]).at(-1),
    createTranslator('s', 't')({ sessionUpdate: 'tool_call_update', toolCallId: 'call', status: 'completed', content: [{ type: 'content', content: { type: 'text', text } }] }).at(-1),
  ]
  for (const result of results) {
    expect(result?.payload).toMatchObject({ skillDraft: summary })
    expect((result?.payload as { text: string }).text.length).toBeLessThan(4100)
  }
})
