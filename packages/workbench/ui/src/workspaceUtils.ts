export function shortenDirectory(path: string): string {
  return path.length > 44 ? `${path.slice(0, 18)}…${path.slice(-23)}` : path
}

/** @ word before the cursor: reference canvas nodes in the input; @ without preceding whitespace, as in email addresses, does not trigger */
export function mentionQuery(text: string, cursor: number): { query: string; start: number; end: number } | null {
  const match = /(?:^|\s)@([^\s@]*)$/.exec(text.slice(0, cursor))
  return match ? { query: match[1]!, start: cursor - match[1]!.length - 1, end: cursor } : null
}

export function slashSkillQuery(text: string, cursor: number): { query: string; start: number; end: number } | null {
  const match = /(?:^|\s)\/([^\s/]*)$/.exec(text.slice(0, cursor))
  return match ? { query: match[1]!, start: cursor - match[1]!.length - 1, end: cursor } : null
}

/** Summaries preserve text and newlines; operators in code fragments are not treated as emphasis markers. */
export function plainTextSummary(text: string): string {
  return text.split(/(`{3,}[^\n]*\n[\s\S]*?`{3,}|~{3,}[^\n]*\n[\s\S]*?~{3,}|`[^`\n]+`)/g).map((part, index) => {
    if (index % 2) return part.replace(/^(`{3,}|~{3,})[^\n]*\n|(`{3,}|~{3,})$/g, '').replace(/^`|`$/g, '')
    return part
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-+*]\s+|\d+[.)]\s+)(?:\[[ xX]\]\s+)?/gm, '')
      .replace(/(\*\*|__|~~)(?=\S)(.*?\S)\1/g, '$2')
      .replace(/\*(\S(?:[^*\n]*\S)?)\*/g, '$1')
      .replace(/(^|\s)_([^_\n]+)_(?=\s|$|[.,!?])/g, '$1$2')
  }).join('').trim()
}

/** The Agent needs message and batch IDs to reply; the author reading the session does not. */
export function workMessageText(text: string): string {
  return text.replace(/ · wmsg_\S+ · \S+ dlv_[^\]\s]+\]/g, ']')
}
