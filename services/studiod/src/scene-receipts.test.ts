import { expect, it, vi } from 'vitest'
import { SceneProposal } from '@vis/protocol'
import { toolReceipts } from '@vis/workbench-core'
import { createTranslator } from '../../../packages/workbench/core/src/acp/translate'
import { translate as codex } from '../../../packages/workbench/codex/src/translate'
import { translate as claude } from '../../../packages/workbench/claude/src/translate'

const proposal = SceneProposal.parse({ proposalId: 'proposal', nodeId: 'node', slotId: 'slot', baseRevision: 2, sessionId: 'session', summary: 'Review this scene', status: 'open', createdAt: 1,
  changes: [{ target: 'duration', durationS: 3, base: null, changeId: 'change', status: 'pending' }] })

it('extracts complete proposals before transcript truncation across all Agent adapters', () => {
  const full = { ...proposal, summary: 'A'.repeat(2000), changes: Array.from({ length: 97 }, (_, index) => ({ ...proposal.changes[0]!, changeId: `change${index}` })) }
  const text = JSON.stringify({ ...full, requestId: 'request' })
  expect(text.length).toBeGreaterThan(4000)
  const content = [{ type: 'text', text }]
  const items = [
    ...codex('completed', 'turn', { id: 'tool', type: 'mcpToolCall', server: 'vis', tool: 'scene_propose', result: { content } }),
    ...createTranslator('session', 'turn', 'acp')({ sessionUpdate: 'tool_call_update', toolCallId: 'tool', status: 'completed', content }),
    ...claude({ type: 'user', uuid: 'message', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'tool', content }] } } as unknown as Parameters<typeof claude>[0]),
  ].filter(item => item.kind === 'tool_result')
  expect(items).toHaveLength(3)
  for (const item of items) {
    expect(item.payload).toMatchObject({ sceneProposal: full })
    expect((item.payload as { text: string }).text.length).toBeLessThan(text.length)
  }
})

it('ignores invalid and failed results while retaining existing skill draft receipts', () => {
  expect(toolReceipts('{')).toEqual({})
  expect(toolReceipts(JSON.stringify({ ...proposal, changes: [] }))).toEqual({})
  expect(codex('completed', 'turn', { id: 'tool', type: 'mcpToolCall', status: 'failed', result: { content: [{ type: 'text', text: JSON.stringify(proposal) }] } }).at(-1)!.payload).not.toHaveProperty('sceneProposal')
  const draft = { draftId: 'draft', revision: 1, name: 'Method', description: 'Author method', spaceId: 'space', sessionId: 'session', createdAt: 1 }
  expect(toolReceipts(JSON.stringify({ draft, location: 'Settings > My skills' }))).toEqual({ skillDraft: draft })
})


it('parses tool JSON once for scene, skill and unrelated results', () => {
  const draft = { draftId: 'draft', revision: 1, name: 'Method', description: 'Author method', spaceId: 'space', sessionId: 'session', createdAt: 1 }
  for (const result of [proposal, { draft, location: 'Settings > My skills' }, { unrelated: true }, null]) {
    const text = JSON.stringify(result)
    const parse = vi.spyOn(JSON, 'parse')
    try { toolReceipts(text); expect(parse).toHaveBeenCalledExactlyOnceWith(text) } finally { parse.mockRestore() }
  }
})
