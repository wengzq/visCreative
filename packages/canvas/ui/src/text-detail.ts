export const TEXT_DETAIL_ZOOM = 0.4
export const lowTextDetail = (zoom: number) => zoom < TEXT_DETAIL_ZOOM

export function textSummary(body: string, limit = 160): string {
  let prefix = '\u0000code'
  while (body.includes(prefix)) prefix += '_'
  const literals: string[] = []
  const literal = (value: string) => `${prefix}${literals.push(value) - 1}\u0000`
  // Code and escaped punctuation are content, even when they resemble emphasis.
  const text = body
    .replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n([\s\S]*?)^ {0,3}\1[ \t]*$/gm, (_match, _fence, code: string) => literal(code))
    .replace(/(?<!`)(`+)(?!`)([^\n]+?)\1(?!`)/g, (_match, _ticks, code: string) => literal(code))
    .replace(/\\([\\`*{}[\]()#+.!_>~-])/g, (_match, character: string) => literal(character))
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^ {0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/gm, '')
    .replace(/(\*{1,3})(?=\S)(.+?\S|\S)\1/g, '$2')
    .replace(/(?<![\p{L}\p{N}_])(_{1,3})(?=\S)(.+?\S|\S)\1(?![\p{L}\p{N}_])/gu, '$2')
    .replace(/~~(?=\S)(.+?\S|\S)~~/g, '$1')
    .replace(new RegExp(`${prefix}(\\d+)\u0000`, 'g'), (_match, index: string) => literals[Number(index)]!)
    .replace(/\s+/g, ' ')
    .trim()
  const characters = [...text]
  return characters.length > limit ? `${characters.slice(0, limit).join('')}…` : text
}

/** Zoomed-out cards show a title and a summary: the node title, else a leading Markdown heading, which then leaves the summary. */
export function textOverview(body: string, title?: string | null): { title: string; summary: string } {
  if (title?.trim()) return { title: title.trim(), summary: textSummary(body) }
  // A closing # run only counts after whitespace (CommonMark), so '# Learn C#' keeps its last character.
  const heading = /^\s*#{1,6}[ \t]+([^\n]*?)(?:[ \t]+#+)?[ \t]*(?:\n|$)/.exec(body)
  if (!heading) return { title: '', summary: textSummary(body) }
  return { title: textSummary(heading[1]!, 60), summary: textSummary(body.slice(heading[0].length)) }
}

/** Read only a bounded prefix; complete Markdown blocks retain their formatting on long cards. */
export function markdownOpening(body: string, limit = 2400): string {
  if (body.length <= limit) return body
  const prefix = body.slice(0, limit)
  let fence = ''
  let boundary = -1
  let offset = 0
  for (const line of prefix.split('\n')) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (marker) {
      if (!fence) fence = marker
      else if (marker[0] === fence[0] && marker.length >= fence.length && /^ {0,3}(?:`+|~+)\s*$/.test(line)) fence = ''
    }
    if (!fence && !line.trim() && offset < prefix.length) boundary = offset
    offset += line.length + 1
  }
  if (boundary > 0) return prefix.slice(0, boundary).trimEnd()
  // A single oversized block has no complete Markdown opening; display a bounded literal excerpt.
  return prefix.replace(/([\\`*_{}[\]<>])/g, '\\$1')
}
