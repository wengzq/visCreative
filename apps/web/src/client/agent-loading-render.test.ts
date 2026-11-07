import { existsSync, readFileSync } from 'node:fs'
import { build } from 'esbuild'
import { chromium, type Browser, type Page } from 'playwright-core'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { chromePath } from '../../e2e/platform'

let browser: Browser
let page: Page
let bundle: string

describe.skipIf(!existsSync(chromePath()))('Agent registry loading and script retries', () => {
  beforeAll(async () => {
    const result = await build({
      stdin: { contents: `
        import { createElement, useRef } from 'react'
        import { createRoot } from 'react-dom/client'
        import { flushSync } from 'react-dom'
        import { LocaleProvider } from '@vis/ui-kit'
        import { AgentsContext } from '../../../../packages/workbench/ui/src/agents'
        import { WorkspaceDialog, ProjectDialog } from '../../../../packages/workbench/ui/src/WorkspaceDialog'
        import { Composer } from '../../../../packages/workbench/ui/src/SessionPanel'
        import { useScriptAgent } from '../../../../packages/canvas/ui/src/ScriptAgentControls'
        const root = createRoot(document.getElementById('root'))
        const noop = () => {}
        const descriptor = { kind: 'example', label: 'Example', icon: ['M1 1h2'], available: true, install: { hint: { en: 'Install Example', zh: 'Install Example' } }, capabilities: {} }
        const preferences = new Map([['vis.workspace.agent', 'example']])
        Object.defineProperty(window, 'localStorage', { value: { getItem: key => preferences.get(key), setItem: (key, value) => preferences.set(key, value) } })
        let mode, agents, running, doc
        window.counts = { creates: 0, patches: 0, stops: 0 }
        window.canvasState = { actions: {}, scriptSessions: [] }
        function ScriptHarness() {
          const agent = useScriptAgent({ doc, view: { nodeId: 'script' }, onPatch: async () => {
            window.counts.patches++
            if (window.counts.patches === 1) throw new Error('Retry patch')
          } })
          return createElement('div', null, createElement('button', { onClick: () => agent.choose() }, 'Choose session'), agent.feedback)
        }
        function ComposerHarness() {
          const inputRef = useRef(null)
          return createElement(Composer, { inputRef, sessions: [{ sessionId: 'session', agentKind: 'example', activeTurnId: running ? 'turn' : null }], openSessionId: 'session', text: '', onTextChange: noop,
            attachments: [], skills: [], selectedSkills: [], mentionNodes: [], refs: [], onStop: () => window.counts.stops++ })
        }
        function render() {
          const shared = { onClose: noop, onCreate: async () => {}, onPickDirectory: async () => null, projectsDir: '/projects', projectId: 'project', projects: [{ spaceId: 'project', name: 'Project', rootPath: '/projects/project' }], onListSkills: async () => [], onValidateDirectory: async () => ({ valid: true }) }
          const child = mode === 'project' ? createElement(ProjectDialog, shared) : mode === 'workspace' ? createElement(WorkspaceDialog, shared) : mode === 'script' ? createElement(ScriptHarness) : createElement(ComposerHarness)
          flushSync(() => root.render(createElement(LocaleProvider, { locale: 'en', setLocale: noop }, createElement(AgentsContext.Provider, { value: agents }, child))))
        }
        window.reset = (next, active = false) => {
          mode = next; agents = undefined; running = active; doc = { rev: 1 }
          window.canvasState = { scriptSessions: [], actions: { onCreateScriptSession: async () => { window.counts.creates++; return { sessionId: 'new-session' } } } }
          render()
        }
        window.loadAgents = (missing = false) => {
          agents = missing ? [] : [descriptor]
          window.canvasState.actions.agents = agents
          render()
        }
      `, resolveDir: import.meta.dirname, loader: 'ts' },
      bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.css': 'empty' },
      plugins: [{ name: 'test-component-access', setup(builder) {
        builder.onLoad({ filter: /[/\\]SessionPanel\.tsx$/ }, args => ({ contents: readFileSync(args.path, 'utf8').replace('function Composer(', 'export function Composer('), loader: 'tsx' }))
        builder.onLoad({ filter: /[/\\]CanvasView\.tsx$/ }, () => ({ contents: 'export const useCanvasSelector = selector => selector(window.canvasState)', loader: 'js' }))
      } }],
    })
    bundle = result.outputFiles[0]!.text
    browser = await chromium.launch({ executablePath: chromePath(), headless: true })
  })
  beforeEach(async () => {
    page = await browser.newPage()
    await page.setContent('<div id="root"></div>')
    await page.addScriptTag({ content: bundle })
  })
  afterEach(async () => { await page?.close() })
  // Closing Chrome on a loaded Windows machine has taken over the 10 s default.
  afterAll(async () => { await browser?.close() }, 30_000)

  it.each(['workspace', 'project'])('applies saved preferences when the %s dialog receives descriptors', async mode => {
    await page.evaluate('window.reset(' + JSON.stringify(mode) + ')')
    await page.evaluate('window.loadAgents()')
    await expect.poll(() => page.getByRole('button', { name: 'Example', exact: true }).getAttribute('aria-pressed')).toBe('true')
  })

  it('preserves an explicit empty-project choice while descriptors load', async () => {
    await page.evaluate('window.reset("project")')
    const empty = page.getByRole('button', { name: 'Skip for now', exact: true })
    await empty.click()
    await page.evaluate('window.loadAgents()')
    expect(await empty.getAttribute('aria-pressed')).toBe('true')
    expect(await page.getByRole('button', { name: 'Example', exact: true }).getAttribute('aria-pressed')).toBe('false')
  })

  it('keeps Stop usable while the registry loads and only marks a loaded missing adapter read-only', async () => {
    await page.evaluate('window.reset("composer", true)')
    expect(await page.getByRole('button', { name: 'Stop', exact: true }).isEnabled()).toBe(true)
    expect(await page.locator('.vis-composer-hint').count()).toBe(0)
    await page.getByRole('button', { name: 'Stop', exact: true }).click()
    expect(await page.evaluate('window.counts.stops')).toBe(1)
    await page.evaluate('window.loadAgents(true)')
    expect(await page.getByRole('textbox', { name: 'Message the Agent' }).isDisabled()).toBe(true)
    expect(await page.locator('.vis-composer-hint').count()).toBe(1)
  })

  it('retries saving a new script session before it arrives in the session list without creating another', async () => {
    await page.evaluate('window.reset("script")')
    await page.evaluate('window.loadAgents()')
    await page.getByRole('button', { name: 'Choose session', exact: true }).click()
    await page.getByRole('combobox', { name: 'Agent kind', exact: true }).selectOption('example')
    const confirm = page.getByRole('button', { name: 'Confirm', exact: true })
    await confirm.click()
    await page.getByRole('alert').waitFor()
    expect(await confirm.isEnabled()).toBe(true)
    await confirm.click()
    await expect.poll(() => page.getByRole('dialog').count()).toBe(0)
    expect(await page.evaluate('window.counts.creates')).toBe(1)
    expect(await page.evaluate('window.counts.patches')).toBe(2)
  })
})
