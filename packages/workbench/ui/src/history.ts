export function anchoredScrollTop(scrollTop: number, previousOffset: number, nextOffset: number): number {
  return Math.max(0, scrollTop + nextOffset - previousOffset)
}
