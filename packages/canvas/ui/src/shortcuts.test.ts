/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { EmptyShortcuts, formatShortcut, SHORTCUTS, ShortcutDialog } from './shortcuts'

describe('Canvas shortcut list', () => {
  it('The empty canvas shows only the eight most common shortcuts; the full panel shows all items in four groups', () => {
    const common = SHORTCUTS.filter(shortcut => shortcut.common)
    expect(common.map(shortcut => shortcut.id)).toEqual(['pan-zoom', 'select', 'undo', 'clipboard', 'delete', 'preview', 'session-panel', 'board'])
    expect(new Set(SHORTCUTS.map(shortcut => shortcut.id)).size).toBe(SHORTCUTS.length)
    const empty = renderToStaticMarkup(createElement(EmptyShortcuts))
    const full = renderToStaticMarkup(createElement(ShortcutDialog, { onClose() {}, onRestoreFocus() {} }))
    for (const shortcut of SHORTCUTS) {
      expect(empty.includes(`<dt>${shortcut.label}</dt>`)).toBe(Boolean(shortcut.common))
      expect(full).toContain(`<dt>${shortcut.label}</dt>`)
    }
    for (const group of ['画布', '节点', '会话', '视图']) expect(full).toContain(`<h3>${group}</h3>`)
    expect(empty).toContain('pointer-events:none')
    expect(empty).not.toContain('<button')
  })

  it('Replace modifiers for the platform while preserving other keys', () => {
    expect(formatShortcut('Mod C / Mod ⇧ Z / Ctrl Y', true)).toBe('⌘ C / ⌘ ⇧ Z / Ctrl Y')
    expect(formatShortcut('Mod C / Mod ⇧ Z / Ctrl Y', false)).toBe('Ctrl C / Ctrl ⇧ Z / Ctrl Y')
  })

  it.each([
    ['README.md', '## Keyboard shortcuts', true],
    ['README.zh-CN.md', '## 快捷键', false],
  ] as const)('%s actions and keys match the full list item by item', (file, heading, english) => {
    const readme = readFileSync(new URL(`../../../../${file}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
    const section = readme.split(`${heading}\n`)[1]?.split('\n## ')[0]
    expect(section).toBeDefined()
    const rows = section!.split('\n').filter(line => line.startsWith('| ')).slice(2)
    expect(rows).toEqual(SHORTCUTS.map(shortcut => `| ${english ? shortcut.labelEn : shortcut.label} | <kbd>${formatShortcut(english ? shortcut.keysEn ?? shortcut.keys : shortcut.keys, true)}</kbd> |`))
  })
})
