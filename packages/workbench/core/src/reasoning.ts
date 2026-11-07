/** Retain the beginning and latest thinking content; truncate by Unicode code point to avoid splitting emoji. */
export function truncateReasoning(text: string): string {
  const chars = Array.from(text)
  return chars.length > 20_000
    ? `${chars.slice(0, 2000).join('')}…（已省略）…${chars.slice(-18_000).join('')}`
    : text
}
