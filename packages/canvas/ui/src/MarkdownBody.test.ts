import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import Markdown from 'react-markdown'
import { createMarkdownProcessorCache, MarkdownBody } from './MarkdownBody'

describe('Canvas Markdown cache', () => {
  it('Parses and transforms once across component remounts through public unified plugin APIs', () => {
    let parses = 0
    let transforms = 0
    const cache = createMarkdownProcessorCache()
    const count = function (this: { parser: ((body: string, file: never) => unknown) | undefined }) {
      const parse = this.parser!
      this.parser = (body, file) => { parses++; return parse(body, file) }
    }
    const transform = () => () => { transforms++ }
    const rehype = () => () => { transforms++ }
    const render = () => renderToStaticMarkup(createElement(Markdown, { children: '**cached**', remarkPlugins: [count, transform, cache], rehypePlugins: [rehype] }))
    expect(render()).toContain('<strong>cached</strong>')
    expect(render()).toContain('<strong>cached</strong>')
    expect(parses).toBe(1)
    expect(transforms).toBe(2)
  })

  it('Retains transformed results, skips mutable transforms on cache hits and evicts the oldest body', () => {
    const transforms = vi.fn()
    const cache = createMarkdownProcessorCache(2)
    const mutate = () => (tree: { children: { children: { value: string }[] }[] }) => {
      transforms()
      tree.children[0]!.children[0]!.value += '!'
    }
    const render = (body: string) => renderToStaticMarkup(createElement(Markdown, { children: body, remarkPlugins: [mutate, cache] }))
    const first = render('first')
    expect(first).toBe('<p>first!</p>')
    render('second')
    expect(render('first')).toBe(first)
    expect(transforms).toHaveBeenCalledTimes(2)
    render('third')
    expect(render('first')).toBe(first)
    render('second')
    expect(transforms).toHaveBeenCalledTimes(4)
  })

  it('Preserves GFM, line breaks and safe raw HTML handling', () => {
    const body = '**bold**\nnext\n\n~~removed~~\n\n<script>alert(1)</script>'
    const html = renderToStaticMarkup(createElement(MarkdownBody, { body }))
    expect(html).toContain('<strong>bold</strong><br/>')
    expect(html).toContain('<del>removed</del>')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
    expect(renderToStaticMarkup(createElement(MarkdownBody, { body }))).toBe(html)
  })

  it('Keeps tables, task lists, autolinks and unsafe URLs consistent across remounts', () => {
    const body = '| name | value |\n| --- | --- |\n| test | 1 |\n\n- [x] done\n\nhttps://example.test\n\n[unsafe](javascript:alert%281%29)'
    const render = () => renderToStaticMarkup(createElement(MarkdownBody, { body }))
    const first = render()
    expect(first).toContain('<table>')
    expect(first).toContain('type="checkbox"')
    expect(first).toContain('checked=""')
    expect(first).toContain('href="https://example.test"')
    expect(first).not.toContain('javascript:')
    expect(render()).toBe(first)
  })
})
