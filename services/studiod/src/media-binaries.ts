import { basename, dirname, join } from 'node:path'

/**
 * RFC 0046: the desktop app ships its own LGPL ffmpeg and points studiod at it; development keeps the one on PATH.
 * Without VIS_FFPROBE_PATH, ffprobe is taken from the same directory as ffmpeg, as a bundled build ships both.
 */
export function mediaBinaries(env: Record<string, string | undefined>): { ffmpegPath?: string; ffprobePath?: string } {
  const ffmpegPath = env.VIS_FFMPEG_PATH?.trim() || undefined
  const explicitProbe = env.VIS_FFPROBE_PATH?.trim() || undefined
  const ffprobePath = explicitProbe ?? (ffmpegPath ? join(dirname(ffmpegPath), /\.exe$/i.test(basename(ffmpegPath)) ? 'ffprobe.exe' : 'ffprobe') : undefined)
  return { ...(ffmpegPath ? { ffmpegPath } : {}), ...(ffprobePath ? { ffprobePath } : {}) }
}
