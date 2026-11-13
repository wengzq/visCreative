import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { defaultDataDir } from '../../../runtime/app-paths'

export type AppLayout = {
  dataDir: string
  /** Node-compatible binary and environment that run studiod */
  studiodCommand: string
  studiodEnv: Record<string, string>
  studiodEntry: string
  cliBinDir: string
  /** Browser build served by the in-process web host */
  staticDir: string
}

export type LayoutInput = {
  packaged: boolean
  platform: NodeJS.Platform
  env: Record<string, string | undefined>
  home: string
  /** The Electron binary */
  execPath: string
  /** Electron's resources directory; used when packaged */
  resourcesPath: string
  /** Repository root; used when running from source */
  repoRoot: string
  exists?: (path: string) => boolean
}

/**
 * Where the app finds its parts (RFC 0046). A packaged app carries everything under its resources directory and runs
 * studiod through its own binary. From source it uses the repository builds and a system Node: the repository's
 * better-sqlite3 is built for Node's ABI, not Electron's, until packaging rebuilds it (step c).
 */
export function appLayout(input: LayoutInput): AppLayout {
  const exists = input.exists ?? existsSync
  const override = input.env.VIS_DATA_DIR?.trim()
  if (!input.packaged) {
    return {
      dataDir: override || join(input.home, '.vis-dev'),
      studiodCommand: input.env.VIS_DESKTOP_NODE?.trim() || input.env.npm_node_execpath?.trim() || 'node',
      studiodEnv: {},
      studiodEntry: join(input.repoRoot, 'services', 'studiod', 'dist', 'studiod.mjs'),
      cliBinDir: join(input.repoRoot, 'apps', 'cli', 'dist'),
      staticDir: join(input.repoRoot, 'apps', 'web', 'dist', 'client'),
    }
  }
  const resources = input.resourcesPath
  const ffmpeg = join(resources, 'ffmpeg', input.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
  const fonts = join(resources, 'fonts')
  return {
    dataDir: override || defaultDataDir(input.platform, input.env, input.home),
    studiodCommand: input.execPath,
    studiodEnv: {
      ELECTRON_RUN_AS_NODE: '1',
      // Only point studiod at bundled media tools and fonts that are really there, so a partial build still finds the ones on PATH.
      ...(exists(ffmpeg) ? { VIS_FFMPEG_PATH: ffmpeg } : {}),
      ...(exists(fonts) ? { VIS_FONTS_DIR: fonts } : {}),
    },
    studiodEntry: join(resources, 'studiod', 'dist', 'studiod.mjs'),
    cliBinDir: join(resources, 'cli'),
    staticDir: join(resources, 'web', 'client'),
  }
}
