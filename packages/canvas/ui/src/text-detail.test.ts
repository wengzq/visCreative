import { describe, expect, it } from 'vitest'
import { lowTextDetail, TEXT_DETAIL_ZOOM, textSummary, markdownOpening } from './text-detail'

describe('Zoomed-out text detail', () => {
  it('Switches only when crossing the detail threshold and restores Markdown on zooming in', () => {
    expect(lowTextDetail(TEXT_DETAIL_ZOOM - 0.001)).toBe(true)
    expect(lowTextDetail(TEXT_DETAIL_ZOOM)).toBe(false)
    expect(lowTextDetail(1)).toBe(false)
    expect(lowTextDetail(0.2)).toBe(true)
    expect(lowTextDetail(1)).toBe(false)
  })

  it('Shows bounded plain text without splitting Unicode characters', () => {
    expect(textSummary('# Heading\n\n**bold** and [link](https://example.test)\n> quoted')).toBe('Heading bold and link quoted')
    expect(textSummary('abcdef', 3)).toBe('abc…')
    expect(textSummary('😀😀😀', 2)).toBe('😀😀…')
    expect(textSummary('short')).toBe('short')
  })

  it('Preserves placeholders, comparisons, filenames and unpaired punctuation', () => {
    const body = '<character name> x<5 file_name.png a*b x~y literal_underscore'
    expect(textSummary(body)).toBe(body)
    expect(textSummary('**bold** *word* _word_ ~~old~~ and file_name.png')).toBe('bold word word old and file_name.png')
    expect(textSummary('Use `file_name.png` and `**literal**`')).toBe('Use file_name.png and **literal**')
    expect(textSummary('```txt\n<character name> **literal**\n```\n- next')).toBe('<character name> **literal** next')
    expect(textSummary('\\*literal\\* and \\_literal\\_')).toBe('*literal* and _literal_')
    expect(textSummary('use `` to quote')).toBe('use `` to quote')
    expect(textSummary('use ``a ` tick`` to quote')).toBe('use a ` tick to quote')
  })
})

it('retains complete opening Markdown blocks without parsing the long body or cutting inside fences', () => {
  const opening = '# Heading\n\n**Bold** and *italic*.\n\n'
  expect(markdownOpening(opening + 'later '.repeat(40), 80)).toBe(opening.trimEnd())
  expect(markdownOpening('# Heading\n\n```txt\ncode\n\nstill code'.padEnd(300, 'x'), 60)).toBe('# Heading')
  expect(markdownOpening('**long '.repeat(1000), 50).startsWith('\\*\\*long')).toBe(true)
  expect(markdownOpening('x'.repeat(200_000), 50)).toBe('x'.repeat(50))
})
