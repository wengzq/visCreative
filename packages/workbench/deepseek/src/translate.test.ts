import { expect, it } from 'vitest'
import { createTranslator } from './translate'

// Representative dsh 0.2.1-rc.2 payloads: dsh-acp/lib/index.js toolCallUpdate/toolResultUpdate
// wrap the registered tool name, raw arguments and model-facing text from the tool plugins.
it.each([
  { name: 'subagent', input: { description: 'Inspect references', prompt: 'Read the references' }, text: 'started subagent child-session-1' },
  { name: 'subagent_fork', input: { description: 'Inspect layout', prompt: 'Review the layout' }, text: 'started subagent child-session-2' },
  { name: 'send_message', input: { agent_id: 'child-session-1', message: 'Focus on composition' }, text: 'message delivered to agent child-session-1' },
  { name: 'workflow', input: { meta: { name: 'Reference review' }, script: 'return []' }, text: '{"results":[]}' },
  { name: 'job_list', input: {}, text: 'job-1 [workflow] running — Reference review' },
  { name: 'job_output', input: { job_id: 'job-1' }, text: 'Reference review complete' },
])('shows $name as generic tool activity, preserving nested identifiers in arguments and results', ({ name, input, text }) => {
  const translate = createTranslator('parent', 'turn')
  expect(translate({ sessionUpdate: 'tool_call', toolCallId: 'call-1', title: name, kind: 'other', status: 'in_progress', rawInput: input })).toEqual([
    { itemId: 'ds:parent:call-1:call', revision: 1, kind: 'tool_call', payload: { toolUseId: 'call-1', name, input } },
  ])
  expect(translate({ sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'in_progress' })).toEqual([])
  for (const status of ['completed', 'failed']) {
    expect(translate({ sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status, content: [{ type: 'content', content: { type: 'text', text } }] })).toEqual([
      { itemId: 'ds:parent:call-1:result', revision: 1, kind: 'tool_result', payload: { toolUseId: 'call-1', isError: status === 'failed', text } },
    ])
  }
})

it('Thinking and replies accumulate independently within a message; thinking revisions increment and are truncated', () => {
  const translate = createTranslator('s', 't')
  const thought = (text: string) => translate({ sessionUpdate: 'agent_thought_chunk', messageId: 'm', content: { type: 'text', text } })[0]
  expect(thought('思')).toMatchObject({ itemId: 'ds:s:m:thought', revision: 1, kind: 'reasoning', payload: { text: '思' } })
  expect(translate({ sessionUpdate: 'agent_message_chunk', messageId: 'm', content: { type: 'text', text: '回复' } })[0]).toMatchObject({ itemId: 'ds:s:m', revision: 1, payload: { text: '回复' } })
  expect(thought('考')).toMatchObject({ revision: 2, payload: { text: '思考' } })
  expect(thought('尾'.repeat(20_000))).toMatchObject({ revision: 3, payload: { text: `思考${'尾'.repeat(1998)}…（已省略）…${'尾'.repeat(18_000)}` } })
})

it('Plans replace wholesale with fixed per-turn entry IDs and increasing revisions, without crossing turns', () => {
  const translate = createTranslator('s', 't')
  expect(translate({ sessionUpdate: 'plan', entries: [{ content: '读画布', status: 'in_progress' }] })[0]).toEqual({ itemId: 'ds:s:t:plan', revision: 1, kind: 'plan', payload: { entries: [{ text: '读画布', status: 'in_progress' }] } })
  expect(translate({ sessionUpdate: 'plan', entries: [] })[0]).toMatchObject({ itemId: 'ds:s:t:plan', revision: 2, payload: { entries: [] } })
  expect(createTranslator('s', 'next')({ sessionUpdate: 'plan', entries: [] })[0]).toMatchObject({ itemId: 'ds:s:next:plan', revision: 1 })
})
