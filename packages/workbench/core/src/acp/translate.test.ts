import { expect, it } from 'vitest'
import { createTranslator } from './translate'

it('namespaces every ACP transcript item with the configured prefix and preserves revisions', () => {
  const translate = createTranslator('session', 'turn', 'custom')
  expect(translate({ sessionUpdate: 'agent_message_chunk', messageId: 'message', content: { type: 'text', text: 'Hello' } })).toEqual([
    { itemId: 'custom:session:message', revision: 1, kind: 'assistant_text', payload: { text: 'Hello' } },
  ])
  expect(translate({ sessionUpdate: 'agent_message_chunk', messageId: 'message', content: { type: 'text', text: ' again' } })).toEqual([
    { itemId: 'custom:session:message', revision: 2, kind: 'assistant_text', payload: { text: 'Hello again' } },
  ])
  expect(translate({ sessionUpdate: 'agent_thought_chunk', messageId: 'message', content: { type: 'text', text: 'Reasoning' } })).toEqual([
    { itemId: 'custom:session:message:thought', revision: 1, kind: 'reasoning', payload: { text: 'Reasoning' } },
  ])
  expect(translate({ sessionUpdate: 'plan', entries: [{ content: 'Inspect', status: 'pending' }] })).toEqual([
    { itemId: 'custom:session:turn:plan', revision: 1, kind: 'plan', payload: { entries: [{ text: 'Inspect', status: 'pending' }] } },
  ])
  expect(translate({ sessionUpdate: 'plan', entries: [] })[0]).toMatchObject({ itemId: 'custom:session:turn:plan', revision: 2 })
  expect(translate({ sessionUpdate: 'tool_call', toolCallId: 'tool', title: 'read', rawInput: { path: 'notes' } })).toEqual([
    { itemId: 'custom:session:tool:call', revision: 1, kind: 'tool_call', payload: { toolUseId: 'tool', name: 'read', input: { path: 'notes' } } },
  ])
  expect(translate({ sessionUpdate: 'tool_call_update', toolCallId: 'tool', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'Notes' } }] })).toEqual([
    { itemId: 'custom:session:tool:result', revision: 1, kind: 'tool_result', payload: { toolUseId: 'tool', isError: false, text: 'Notes' } },
  ])
  expect(translate({ sessionUpdate: 'tool_call_update', toolCallId: 'tool', status: 'in_progress' })).toEqual([])
})
