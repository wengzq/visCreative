import { writingCardSize } from './writing'
import { expect, it } from 'vitest'
import { writingChapters, writingWordCount } from './writing'

it('counts Han individually, words in other scripts, numbers and astral Han', () => {
  expect(writingWordCount('你好 world café 2026。𠀀 a中文b don’t')).toBe(11)
  expect(writingWordCount('# **...**')).toBe(0)
})
it('finds nested chapters with offsets, excluding fenced code', () => {
  const body = '# One\nIntro\n## Sub\nBody\n```md\n# Fake\n```\n# Two\nEnd'
  expect(writingChapters(body)).toEqual([
    { title: 'One', level: 1, from: 0, to: body.indexOf('# Two') },
    { title: 'Sub', level: 2, from: body.indexOf('## Sub'), to: body.indexOf('# Two') },
    { title: 'Two', level: 1, from: body.indexOf('# Two'), to: body.length },
  ])
})
it('recognizes setext headings without treating horizontal rules or indented code as chapters', () => {
  expect(writingChapters('Title\n===\n\n---\n    Code\n    ---\n\nSub\n---')).toEqual([
    { title: 'Title', level: 1, from: 0, to: 40 },
    { title: 'Sub', level: 2, from: 33, to: 40 },
  ])
})
it('keeps literal trailing hashes while removing whitespace-delimited closing heading markers', () => {
  expect(writingChapters('# C#\n# Title ###').map(chapter => chapter.title)).toEqual(['C#', 'Title'])
})

it('sizes only new long text and manuscripts, bounding huge documents and preserving short notes', () => {
  expect(writingCardSize('note')).toEqual({ w: 320, h: 200 })
  expect(writingCardSize('', true)).toEqual({ w: 560, h: 420 })
  expect(writingCardSize('text '.repeat(220))).toEqual({ w: 560, h: 652 })
  expect(writingCardSize('x'.repeat(200_000))).toEqual({ w: 640, h: 720 })
})
