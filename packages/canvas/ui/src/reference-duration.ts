export function referenceTimecode(seconds: number | null | undefined, number: (value: number) => string): string | undefined {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return undefined
  return `${number(Math.floor(seconds / 60))}:${number(Math.floor(seconds % 60)).padStart(2, '0')}`
}
