import { FALLBACK_OUTPUT, type TimelineOutput } from '@vis/protocol'
import type { AssetInfo } from './resources'

/** Match the even output dimensions chosen by the renderer for implicit first-source output. */
export function outputFrame(output: Pick<TimelineOutput, 'width' | 'height'> | undefined, first: AssetInfo | undefined): Pick<TimelineOutput, 'width' | 'height'> {
  if (output) return { width: output.width, height: output.height }
  return first?.width && first.height ? { width: Math.floor(first.width / 2) * 2, height: Math.floor(first.height / 2) * 2 } : { width: FALLBACK_OUTPUT.width, height: FALLBACK_OUTPUT.height }
}

export function effectiveFps(output: TimelineOutput | undefined, first: AssetInfo | undefined): number {
  return output?.fps ?? first?.fps ?? 30
}

export function presetFps(output: TimelineOutput | undefined, first: AssetInfo | undefined): number {
  return Math.min(60, Math.max(1, Math.round(effectiveFps(output, first))))
}

export function outputFrameRates(output: TimelineOutput | undefined, first: AssetInfo | undefined): number[] {
  return [...new Set([24, 25, 30, 50, 60, output?.fps, first?.fps].filter((fps): fps is number => fps !== undefined && Number.isInteger(fps) && fps >= 1 && fps <= 60))].sort((a, b) => a - b)
}

export function outputDescription(output: TimelineOutput | undefined, first: AssetInfo | undefined, number: (value: number) => string, copy: { fps(value: string): string; matchFirst: string }): string {
  const size = output ?? (first?.width && first.height ? outputFrame(undefined, first) : undefined)
  const dimensions = size?.width && size.height ? `${number(size.width)}×${number(size.height)}` : undefined
  const rate = output || first?.fps !== undefined ? copy.fps(number(effectiveFps(output, first))) : undefined
  return [dimensions, rate, output ? undefined : copy.matchFirst].filter(Boolean).join(' · ')
}

export function outputWithFps(output: TimelineOutput | undefined, first: AssetInfo | undefined, fps: number): TimelineOutput | null {
  if (!output && !(first?.width && first.height)) return null
  return { ...outputFrame(output, first), fps }
}
