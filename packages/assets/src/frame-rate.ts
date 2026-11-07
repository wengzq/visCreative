/** Prefer the average rate, falling back to the nominal rate when it is unavailable. */
export function videoFrameRate(average?: string, nominal?: string): number | undefined {
  const value = (rate: string | undefined) => {
    if (!rate) return NaN
    const [numerator, denominator = '1'] = rate.split('/')
    return Number(numerator) / Number(denominator)
  }
  const averageFps = value(average)
  const fps = Number.isFinite(averageFps) && averageFps > 0 ? averageFps : value(nominal)
  return Number.isFinite(fps) && fps >= 1 && fps <= 240 ? Math.round(fps * 1000) / 1000 : undefined
}
