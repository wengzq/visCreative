import Markdown, { defaultUrlTransform } from 'react-markdown'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'

const MARKDOWN_PLUGINS = [remarkGfm, remarkBreaks]

export function markdownImageLink(src: string | undefined): string | undefined {
  if (!src || !/^https?:\/\//i.test(src)) return undefined
  try {
    const url = new URL(src)
    return url.protocol === 'http:' || url.protocol === 'https:' ? src : undefined
  } catch { return undefined }
}

/** Agent text never fetches images automatically, including authenticated local URLs. */
export function AgentMarkdown({ children }: { children: string }) {
  return <Markdown skipHtml remarkPlugins={MARKDOWN_PLUGINS}
    urlTransform={(url, key, node) => node.tagName === 'img' ? url : defaultUrlTransform(url)}
    components={{ img: ({ src, alt }) => {
      const source = typeof src === 'string' ? src : undefined
      const label = alt || source
      const href = markdownImageLink(source)
      return href ? <a href={href} rel="noreferrer">{label}</a> : <>{label}</>
    } }}
  >{children}</Markdown>
}
