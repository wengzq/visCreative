import { memo } from 'react'
import Markdown, { type Options } from 'react-markdown'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'

type RemarkPlugin = Extract<NonNullable<Options['remarkPlugins']>[number], (...args: never[]) => unknown>
type MarkdownProcessor = ThisParameterType<RemarkPlugin>
type Tree = ReturnType<MarkdownProcessor['runSync']>
type File = Parameters<NonNullable<MarkdownProcessor['parser']>>[1]
type RunFile = Parameters<MarkdownProcessor['runSync']>[1]
type Done = (error: Error | undefined, tree?: Tree, file?: File) => void

function source(file: unknown): string | undefined {
  if (typeof file === 'string') return file
  if (file && typeof file === 'object' && 'value' in file && typeof file.value === 'string') return file.value
  return undefined
}

export function createMarkdownProcessorCache(capacity = 512) {
  const entries = new Map<string, { tree: Tree; file: File }>()
  // One cache belongs to one fixed plugin/options pipeline. Only transformed HAST is retained.
  return function cacheMarkdown(this: MarkdownProcessor) {
    const parse = this.parser
    const run = this.run.bind(this)
    if (parse) this.parser = (body, file) => {
      return entries.has(body) ? { type: 'root', children: [] } : parse(body, file)
    }
    this.run = ((tree: Tree, file?: RunFile | Done, done?: Done) => {
      if (typeof file === 'function') { done = file; file = undefined }
      const body = source(file)
      const cached = body === undefined ? undefined : entries.get(body)
      if (cached) {
        entries.delete(body!)
        entries.set(body!, cached)
        if (done) { done(undefined, cached.tree, cached.file); return }
        return Promise.resolve(cached.tree)
      }
      const execute = (complete: Done) => run(tree, file, (error, result, output) => {
        if (!error && result && output && body !== undefined) {
          entries.set(body, { tree: result, file: output })
          if (entries.size > capacity) entries.delete(entries.keys().next().value!)
        }
        complete(error, result, output)
      })
      if (done) return execute(done)
      return new Promise<Tree>((resolve, reject) => execute((error, result) => error ? reject(error) : resolve(result!)))
    }) as MarkdownProcessor['run']
  }
}

const PLUGINS = [remarkGfm, remarkBreaks, createMarkdownProcessorCache()]

export const MarkdownBody = memo(function MarkdownBody({ body }: { body: string }) {
  return <Markdown remarkPlugins={PLUGINS}>{body}</Markdown>
})
