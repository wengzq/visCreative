import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'

// Linux deliberately denies native permission expansion without an isolation sandbox; canvas/work-item RPCs still run.
export const supportsNativeApprovals = process.platform === 'darwin' || process.platform === 'win32'

export function chromePath() {
  if (process.env.VIS_CHROME_PATH) return process.env.VIS_CHROME_PATH
  if (process.platform === 'darwin') return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  const candidates = process.platform === 'win32'
    ? [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]
      .filter((root): root is string => !!root)
      .flatMap(root => [join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'), join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe')])
    : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']
  return candidates.find(existsSync) ?? candidates[0] ?? ''
}

/** Teardown removal. On Windows a stopped studiod or agent process can hold a handle for a moment after exit, so retry instead of failing the test. */
export function removeTempDir(path: string | undefined) {
  if (path) rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
