/// <reference types="node" />
import { existsSync } from 'node:fs'
import { build } from 'esbuild'
import { chromium, type Browser, type Page } from 'playwright-core'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { chromePath } from '../../e2e/platform'

let browser: Browser
let page: Page
let bundle: string
const calls = () => page.evaluate('window.calls') as Promise<{ method: string; params: Record<string, unknown> }[]>
const mount = (mode: string, options: Record<string, unknown> = {}) => page.evaluate(({ mode, options }) => {
  (window as unknown as { mount(mode: string, options: Record<string, unknown>): void }).mount(mode, options)
}, { mode, options })

describe.skipIf(!existsSync(chromePath()))('series dialogs with fake hosts', () => {
  beforeAll(async () => {
    const result = await build({
      stdin: { contents: `
        import { createElement } from 'react'
        import { createRoot } from 'react-dom/client'
        import { flushSync } from 'react-dom'
        import { LocaleProvider } from '@vis/ui-kit'
        import { ProjectDialog } from '../../../../packages/workbench/ui/src/WorkspaceDialog'
        import { SeriesProjectDialog } from '../../../../packages/workbench/ui/src/SeriesProjectDialog'
        import { SeriesActionDialog, SeriesLink } from '../../../../packages/library/ui/src/settings/SeriesDialogs'
        import { SettingPicker } from '../../../../packages/library/ui/src/settings/SettingPicker'
        import { AgentsContext } from '../../../../packages/workbench/ui/src/agents'
        // ProjectDialog reads the Agent registry (RFC 0028); one available Agent keeps the create button enabled.
        const agents = [{ kind: 'codex', label: 'Codex', icon: [], homepage: '', install: { hint: { zh: '', en: '' } }, envPassthrough: [], forbiddenPaths: [], capabilities: { resume: true, interrupt: true, models: true, effort: true, approvals: true }, available: true }]
        const root = createRoot(document.getElementById('root'))
        const local = { id: 'hero', kind: 'character', name: 'Hero', description: 'Blue coat', refs: [], members: [],
          revision: 7, createdAt: 1, updatedAt: 2, usage: { scriptNodeIds: [], shotCount: 3 },
          series: { seriesEntityId: 'shared', revision: 1, latestRevision: 2, modifiedLocally: true } }
        const shared = { seriesEntityId: 'shared', kind: 'character', latest: { name: 'Hero', description: 'Red coat', revision: 2, refs: [], hasVoice: false, publishedAt: 2 } }
        window.mount = (mode, options) => {
          window.calls = []; window.dismissed = false
          const close = () => { window.dismissed = true }
          const record = (method, params) => window.calls.push({ method, params })
          const series = { seriesId: 'series', name: 'Voyagers', settingCount: options.populated ? 2 : 0, createdAt: 1,
            episodes: [{ spaceId: 'one', name: 'One', episode: 1 }, { spaceId: 'three', name: 'Three', episode: 3 }] }
          const projectHost = {
            list: async () => [series], settings: async () => [local],
            setSeries: async params => { record('space.setSeries', params); return { spaceId: 'project', series: null, published: [], failed: options.failed ? [{ entityId: 'hero', code: 'revision_conflict' }] : [] } },
            deleteSeries: async seriesId => record('series.delete', { seriesId }),
          }
          let conflict = options.conflict
          const host = {
            call: async (method, params) => {
              record(method, params)
              if (method === 'entity.list') return { items: options.picker ? [] : [local] }
              if (method === 'series.entityList') return { series: { seriesId: 'series', name: series.name }, items: [shared] }
              if (method === 'entity.seriesDiff') return { entity: local, pinned: { ...shared.latest, revision: 1, name: 'Pinned Hero', description: 'Blue coat' }, latest: shared.latest }
              if (method === 'entity.get') return local
              if (method === 'entity.publish' && conflict && !params.resolve) throw { code: 'revision_conflict', data: { reason: 'entity.series_moved' } }
              if (method === 'entity.publish') return { entity: local, seriesEntityId: 'shared', seriesRevision: 3 }
              if (method === 'entity.link' && options.collision && !params.replaceEntityId) throw { code: 'invalid_params', data: { reason: 'entity.name_taken', params: { entityId: 'hero' } } }
              return local
            },
            onEvent: () => () => {}, onSeriesChanged: () => () => {}, seriesRefUrl: (series, ref) => '/series-media/' + series + '/' + ref,
          }
          let element
          if (mode === 'project') element = createElement(ProjectDialog, { projectsDir: '/projects', seriesHost: projectHost, onClose: close, onPickDirectory: async () => undefined,
            onCreate: async (name, rootPath, agentKind, series) => record('space.create', { name, rootPath, agentKind, ...series }) })
          else if (mode === 'join') element = createElement(SeriesProjectDialog, { project: { spaceId: 'project', name: 'Episode', rootPath: '/project' }, action: 'join', host: projectHost, onClose: close })
          else if (mode === 'link') element = createElement(SeriesLink, { host, seriesEntityId: 'shared', onLinked: entity => record('linked', { entityId: entity.id }),
            children: (link, busy) => createElement('button', { onClick: link, disabled: busy }, 'Use setting') })
          else if (mode === 'picker') element = createElement(SettingPicker, { host, castIds: [], onClose: close,
            onPick: async entity => record('cast', { entityId: entity.id }) })
          else element = createElement(SeriesActionDialog, { host, entity: local, action: mode, onClose: close, onSaved: entity => record('saved', { entityId: entity.id }) })
          flushSync(() => root.render(createElement(LocaleProvider, { locale: 'en', setLocale: () => {} }, createElement(AgentsContext.Provider, { value: agents }, element))))
        }
      `, resolveDir: import.meta.dirname, loader: 'ts' },
      bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.css': 'empty' },
    })
    bundle = result.outputFiles[0]!.text
    browser = await chromium.launch({ executablePath: chromePath(), headless: true })
    page = await browser.newPage()
    // A localhost origin supplies secure-context APIs used by the real dialogs.
    await page.route('http://localhost/**', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }))
  }, 30_000)
  beforeEach(async () => {
    // A fresh document isolates React roots and globals without recreating Chrome's context.
    await page.goto('http://localhost/')
    await page.addScriptTag({ content: bundle })
  })
  // Closing Chrome on a loaded Windows machine has taken over the 10 s default.
  afterAll(async () => { await browser?.close() }, 30_000)

  it('creates an episode with the selected series and next episode number', async () => {
    await mount('project')
    await page.getByRole('textbox', { name: 'Project name', exact: true }).fill('Episode four')
    await page.getByRole('radio', { name: 'New episode of a series', exact: true }).check()
    await page.getByRole('combobox', { name: 'Series', exact: true }).selectOption('series')
    expect(await page.getByRole('spinbutton', { name: 'Episode number', exact: true }).inputValue()).toBe('4')
    await page.getByRole('button', { name: 'Create project', exact: true }).click()
    expect(await calls()).toContainEqual({ method: 'space.create', params: { name: 'Episode four', agentKind: 'codex', series: { seriesId: 'series' }, episode: 4 } })
  })

  it('defaults an empty series checklist to all settings and reports individual publish failures', async () => {
    await mount('join', { failed: true })
    await page.getByRole('textbox', { name: 'Series name', exact: true }).fill('New series')
    await page.getByRole('checkbox', { name: 'Hero', exact: true }).waitFor()
    expect(await page.getByRole('checkbox', { name: 'Hero', exact: true }).isChecked()).toBe(true)
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await page.getByRole('alert').getByText('Could not publish Hero: revision_conflict', { exact: true }).waitFor()
    expect((await calls()).find(item => item.method === 'space.setSeries')?.params).toMatchObject({ series: { name: 'New series' }, publishEntityIds: ['hero'] })
    expect(await page.evaluate('window.dismissed')).toBe(false)
  })

  it('clears the join checklist when choosing a populated series', async () => {
    await mount('join', { populated: true })
    await page.getByRole('combobox', { name: 'Series', exact: true }).selectOption('series')
    expect(await page.getByRole('checkbox', { name: 'Hero', exact: true }).isChecked()).toBe(false)
  })

  it.each(['overwrite', 'takeSeries'])('offers exactly two publish choices and sends the %s resolution', async resolve => {
    await mount('publish', { conflict: true })
    await page.getByRole('button', { name: 'Publish to series', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'The series has a newer version', exact: true })
    await dialog.getByRole('button', { name: 'Overwrite the series with this episode', exact: true }).waitFor()
    await dialog.getByRole('button', { name: 'Discard local edits and use the series version', exact: true }).waitFor()
    expect(await dialog.getByRole('button').count()).toBe(4)
    await dialog.getByRole('button', { name: resolve === 'overwrite' ? 'Overwrite the series with this episode' : 'Discard local edits and use the series version', exact: true }).click()
    expect((await calls()).filter(item => item.method === 'entity.publish').at(-1)?.params).toMatchObject({ entityId: 'hero', expectedRevision: 7, resolve })
  })

  it('compares pinned and latest settings, includes shot impact, and leaves updating explicit', async () => {
    await mount('update')
    await page.getByText('Pinned Hero', { exact: true }).waitFor()
    await page.getByText('Red coat', { exact: true }).waitFor()
    await page.getByText('3 shots in this episode use this setting. Updating marks their prompts stale.', { exact: true }).waitFor()
    await page.getByRole('button', { name: 'Not now', exact: true }).click()
    expect((await calls()).some(item => item.method === 'entity.updateFromSeries')).toBe(false)
  })

  it('replaces a same-name setting using its revision and keeps its ID', async () => {
    await mount('link', { collision: true })
    await page.getByRole('button', { name: 'Use setting', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'This episode has a setting with the same name', exact: true })
    await dialog.getByText('Using the series version keeps the local setting ID and all script cast references. Replacing its content marks related prompts stale.', { exact: true }).waitFor()
    await dialog.getByRole('button', { name: 'Use series version', exact: true }).click()
    expect((await calls()).filter(item => item.method === 'entity.link').at(-1)?.params).toMatchObject({ seriesEntityId: 'shared', replaceEntityId: 'hero', expectedRevision: 7 })
  })

  it('links an unused series setting before casting it through the script picker', async () => {
    await mount('picker', { picker: true })
    await page.getByRole('button', { name: 'Use in this episode', exact: true }).click()
    const methods = (await calls()).map(item => item.method)
    expect(methods.indexOf('entity.link')).toBeLessThan(methods.indexOf('cast'))
    expect(await page.evaluate('window.dismissed')).toBe(true)
  })

  it('resets through the pinned-version method without requesting a newer version', async () => {
    await mount('reset')
    await page.getByText('Discard local edits and restore the pinned series revision. Newer versions are not pulled in.', { exact: true }).waitFor()
    await page.getByRole('button', { name: 'Reset to series version', exact: true }).click()
    expect((await calls()).find(item => item.method === 'entity.resetToSeries')?.params).toMatchObject({ entityId: 'hero', expectedRevision: 7 })
    expect((await calls()).some(item => item.method === 'entity.updateFromSeries')).toBe(false)
  })
})
