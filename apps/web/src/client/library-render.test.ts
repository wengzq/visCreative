/// <reference types="node" />
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { expect, it } from 'vitest'
import { chromePath } from '../../e2e/platform'

it.skipIf(!existsSync(chromePath()))('virtualizes one thousand media assets, supports keyboard navigation and debounces event bursts', async () => {
  const bundle = await build({
    stdin: { resolveDir: import.meta.dirname, loader: 'tsx', contents: `
      import { createRoot } from 'react-dom/client'
      import { flushSync } from 'react-dom'
      import { LibraryPanel } from '@vis/library-ui'
      import { LocaleProvider } from '@vis/ui-kit'
      const listeners = new Set()
      window.reads = 0
      window.emit = type => listeners.forEach(listener => listener({ type, seq: 1, entityId: 'asset-1' }))
      const host = {
        call: async (method, params) => {
          if (method === 'entity.list') return { items: [] }
          if (method === 'library.state') return { sessionId: null, unlabeled: { total: 1000, needsViewing: 1000 }, pendingProposals: 0 }
          if (method === 'library.runList') return { runs: [] }
          if (method === 'asset.list') {
            window.reads++
            return { items: params.kind === 'image' ? Array.from({ length: 1000 }, (_, index) => ({
              assetId: 'asset-' + index, kind: 'image', displayName: 'Portrait ' + index, category: null, effectiveCategory: null,
              archived: false, revision: 1, tags: ['dawn'], entityIds: [], labeledBy: 'agent', userFields: [], origin: 'import',
              latest: { assetVersionId: 'v-' + index, version: 1, kind: 'image', url: '', mime: 'image/png' },
              usage: { count: 0, nodeIds: [] }, createdAt: 1, versionCount: 1,
            })) : [], facets: { categories: params.kind === 'image' ? [{ name: null, count: 1000 }] : [], tags: [] } }
          }
        },
        onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener) },
        sessions: async () => [], assetUrl: () => 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="16" height="16"/%3E',
        posterUrl: () => '', onClose() {}, importFiles: async () => {}, focusNode() {}, nodeTitle() {}, versions: async () => [],
        showMedia() {}, openSession() {}, sendLibraryTask: async () => {},
      }
      window.longTasks = []
      new PerformanceObserver(list => window.longTasks.push(...list.getEntries().map(entry => entry.duration))).observe({ type: 'longtask', buffered: false })
      window.started = performance.now()
      const root = createRoot(document.getElementById('root'))
      flushSync(() => root.render(<LocaleProvider locale="en" setLocale={() => {}}><LibraryPanel host={host} tab="media" onTabChange={() => {}} /></LocaleProvider>))
    ` },
    bundle: true, write: false, format: 'iife', jsx: 'automatic',
    // Component stylesheets do not affect what this probe measures.
    loader: { '.css': 'empty' },
    define: { 'process.env.NODE_ENV': '"production"' },
  })
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.setContent('<div id="root" style="height:100vh;display:flex"></div>')
    await page.addStyleTag({ content: readFileSync(join(import.meta.dirname, '../../../../packages/ui-kit/src/theme.css'), 'utf8') + readFileSync(join(import.meta.dirname, '../../../../packages/library/ui/src/library.css'), 'utf8') })
    await page.addScriptTag({ content: bundle.outputFiles[0]!.text })
    await page.getByRole('button', { name: 'Portrait 0', exact: true }).waitFor()
    const openedMs = await page.evaluate(() => performance.now() - (window as any).started)
    expect(await page.getByRole('listitem').count()).toBeLessThanOrEqual(30)
    await page.getByRole('button', { name: 'Portrait 0', exact: true }).press('End')
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('Portrait 999')
    expect(await page.getByRole('listitem').count()).toBeLessThanOrEqual(30)
    const reads = await page.evaluate(() => (window as any).reads)
    await page.evaluate(() => { for (let index = 0; index < 100; index++) (window as any).emit('asset.updated') })
    await expect.poll(() => page.evaluate(() => (window as any).reads)).toBe(reads + 3)
    const metrics = await page.evaluate(async () => {
      const viewport = document.querySelector<HTMLElement>('.library-kind-section[aria-label="Images"] .library-virtual-media')!
      const browserWindow = window as any
      browserWindow.longTasks = []
      for (let index = 0; index < 24; index++) {
        viewport.scrollTop = index * 900
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
      }
      return { scrollLongTasks: (window as any).longTasks }
    })
    const report = { assets: 1000, openedMs, maxScrollLongTaskMs: Math.max(0, ...metrics.scrollLongTasks), renderedItems: await page.getByRole('listitem').count() }
    writeFileSync(join(tmpdir(), 'A2-library-perf.json'), JSON.stringify(report, null, 2))
    console.info(`Library UI performance: ${JSON.stringify(report)}`)
    expect(errors).toEqual([])
    await page.close()
  } finally { await browser.close() }
}, 45_000)
