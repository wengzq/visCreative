import { join } from 'node:path'

/**
 * RFC 0046: where the desktop app keeps its data when it starts studiod. Development keeps ~/.vis-dev and
 * VIS_DATA_DIR still overrides both. Project folders should stay outside this directory (see known issues).
 */
export function defaultDataDir(platform: NodeJS.Platform, env: Record<string, string | undefined>, home: string): string {
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'visCreative')
  if (platform === 'win32') return join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'visCreative')
  return join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'visCreative')
}
