import { expect, it } from 'vitest'
import { AgentDescriptor } from '@vis/protocol'
import { codebuddyDescriptor, codebuddySandbox } from './descriptor'
import { classifyCodebuddyTool, codebuddyProfile } from './profile'

it('declares the CodeBuddy identity, installation, capabilities and credential boundaries', () => {
  expect(AgentDescriptor.parse(codebuddyDescriptor)).toEqual(codebuddyDescriptor)
  expect(codebuddyDescriptor).toMatchObject({
    kind: 'codebuddy', label: 'CodeBuddy', homepage: 'https://www.codebuddy.ai/docs/cli/',
    install: { command: 'npm install -g @tencent-ai/codebuddy-code', hint: { zh: expect.any(String), en: expect.any(String) } },
    forbiddenPaths: ['~/.codebuddy', '~/.codebuddy.json', '~/.codebuddy.json.*'],
    capabilities: { resume: true, interrupt: true, models: true, effort: true, approvals: true },
  })
  expect(codebuddyDescriptor.icon.every(path => !path.includes('<'))).toBe(true)
  expect(codebuddySandbox).toMatchObject({ runtimeDirectory: '.codebuddy', runtimeHomeVariable: 'CODEBUDDY_CONFIG_DIR', envPassthrough: ['CODEBUDDY_API_KEY', 'CODEBUDDY_AUTH_TOKEN'] })
  expect(codebuddyProfile()).not.toHaveProperty('readOnlyEnforcedByAgent')
  expect(codebuddyProfile()).toMatchObject({ instructions: 'prompt', resume: 'session/resume', itemPrefix: 'cb', config: { model: 'model', effort: 'thought_level', permission: { id: 'mode', ask: 'default' } } })
})

it.each([
  ['Bash', 'execute'], ['PowerShell', 'execute'], ['BashOutput', 'execute'], ['KillShell', 'execute'],
  ['Write', 'edit'], ['Edit', 'edit'], ['MultiEdit', 'edit'],
  ['WebFetch', 'fetch'], ['WebSearch', 'fetch'], ['Read', 'read'], ['Glob', 'read'], ['Grep', 'read'], ['NotebookRead', 'read'],
])('classifies the native %s tool from its name when ACP reports other', (title, kind) => {
  expect(classifyCodebuddyTool({ title, kind: 'other' })).toEqual({ kind: 'other' })
  expect(classifyCodebuddyTool({ title: 'Human-readable title', kind: 'other', _meta: { 'codebuddy.ai/toolName': title } })).toEqual({ kind })
})

it.each(['execute', 'edit', 'delete', 'move', 'fetch', 'read', 'search'])('uses the reported ACP %s kind when native identity is absent', kind => {
  expect(classifyCodebuddyTool({ kind, title: 'Bash' })).toEqual({ kind: kind === 'search' ? 'read' : kind })
})

it.each(['Bash', 'Write', 'Edit', 'MultiEdit'].flatMap(nativeName => ['read', 'search', 'fetch'].map(reported => ({ nativeName, reported }))))('preserves native $nativeName permissions when ACP reports $reported', ({ nativeName, reported }) => {
  expect(classifyCodebuddyTool({ kind: reported, rawInput: { file_path: '/work/story.md' }, _meta: { 'codebuddy.ai/toolName': nativeName } })).toEqual(nativeName === 'Bash' ? { kind: 'execute' } : { kind: 'edit', paths: ['/work/story.md'] })
})

it('uses a reported read kind when the native name is unknown', () => {
  expect(classifyCodebuddyTool({ kind: 'read', _meta: { 'codebuddy.ai/toolName': 'CustomRead' } })).toEqual({ kind: 'read' })
})

it.each(['Write', 'Edit', 'MultiEdit'])('accepts only the complete native file_path for %s', name => {
  const tool = { kind: 'edit', title: 'Formatted edit', _meta: { 'codebuddy.ai/toolName': name }, rawInput: { file_path: '/work/story.md' } }
  expect(classifyCodebuddyTool(tool)).toEqual({ kind: 'edit', paths: ['/work/story.md'] })
  expect(classifyCodebuddyTool({ ...tool, locations: [{ path: '/work/story.md', line: 3 }] })).toEqual({ kind: 'edit', paths: ['/work/story.md'] })
  for (const rawInput of [{}, { file_path: '' }, { file_path: ' ' }, { file_path: null }, { file_path: ['a', 'b'] }, { file_path: '/work/a\0b' }]) {
    expect(classifyCodebuddyTool({ ...tool, rawInput })).toEqual({ kind: 'edit' })
  }
  expect(classifyCodebuddyTool({ ...tool, locations: [{ path: '/outside/also.md' }] })).toEqual({ kind: 'edit' })
})

it('leaves unknown and ambiguous tools without paths or an inferred command directory', () => {
  for (const title of ['CustomWrite', 'NotebookEdit', 'LS', 'Read', 'Glob', 'Grep', 'NotebookRead', 'Agent', 'REPL', '__proto__', 'constructor']) {
    expect(classifyCodebuddyTool({ title, kind: 'other', rawInput: { file_path: '/work/story.md' }, locations: [{ path: '/work/story.md' }] })).toEqual({ kind: 'other' })
  }
  expect(classifyCodebuddyTool({ title: 'UnknownWrite', kind: 'edit', rawInput: { file_path: '/work/story.md' } })).toEqual({ kind: 'edit' })
  expect(classifyCodebuddyTool({ title: 'Write', kind: 'edit', rawInput: { file_path: '/work/story.md' } })).toEqual({ kind: 'edit' })
  expect(classifyCodebuddyTool({ title: 'Write', kind: 'edit', rawInput: { file_path: '/work/story.md' }, _meta: { 'codebuddy.ai/toolName': 'CustomWrite' } })).toEqual({ kind: 'edit' })
  expect(classifyCodebuddyTool({ title: 'Bash', _meta: { 'codebuddy.ai/toolName': 'Bash' }, rawInput: { command: 'pwd', cwd: '/work', workdir: '/work' } })).toEqual({ kind: 'execute' })
  expect(classifyCodebuddyTool({ title: 'Grep', kind: 'search' })).toEqual({ kind: 'read' })
  expect(classifyCodebuddyTool({ title: 'Write', kind: 'think' })).toEqual({ kind: 'other' })
})


it('identifies vis MCP tools only from native tool-name metadata, never display titles or arguments', () => {
  expect(classifyCodebuddyTool({ title: 'Create a canvas node', kind: 'other', _meta: { 'codebuddy.ai/toolName': 'mcp__vis__canvas_create' } })).toEqual({ kind: 'other', visTool: true })
  for (const tool of [
    { title: 'mcp__vis__canvas_create', kind: 'other' },
    { title: 'mcp__vis__canvas_create', kind: 'other', _meta: { 'codebuddy.ai/toolName': 'CustomTool' } },
    { title: 'mcp__vis__canvas_create', kind: 'other', _meta: { 'codebuddy.ai/toolName': 'mcp__other__canvas_create' } },
    { title: 'CustomTool', rawInput: { name: 'mcp__vis__canvas_create', server: 'vis' } },
    ...['mcp__vis__', 'mcp__vis__canvas-create', 'mcp__vis__canvas_create extra', 'mcp__visitor__canvas_create'].map(name => ({ _meta: { 'codebuddy.ai/toolName': name } })),
  ]) expect(classifyCodebuddyTool(tool)).not.toHaveProperty('visTool')
})

it('identifies vis tools called through DeferExecuteTool only when its metadata names the wrapper', () => {
  const defer = (toolName: unknown, meta: unknown = 'DeferExecuteTool') => ({ title: 'DeferExecuteTool', kind: 'other', rawInput: { toolName, params: {} }, _meta: { 'codebuddy.ai/toolName': meta } })
  expect(classifyCodebuddyTool(defer('mcp__vis__canvas_get'))).toEqual({ kind: 'other', visTool: true })
  for (const tool of [
    defer('ShareLink'), defer('Bash'), defer('mcp__visitor__canvas_get'), defer('mcp__vis__canvas-get'), defer(undefined), defer(['mcp__vis__canvas_get']),
    defer('mcp__vis__canvas_get', 'CustomTool'), defer('mcp__vis__canvas_get', null),
  ]) expect(classifyCodebuddyTool(tool)).not.toHaveProperty('visTool')
})
